// ══════════════════════════════════════════════════════════════════════
// mp-webhook.js — Webhook Mercado Pago para controle de inadimplência
// Recebe notificações de assinaturas e pagamentos do Mercado Pago,
// valida a assinatura do webhook, atualiza acesso_liberado no Firestore
// e envia alerta no Telegram.
// ══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const https  = require('https');

// ── Helpers ──────────────────────────────────────────────────────────

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Validar assinatura HMAC do Mercado Pago ──────────────────────────
function validarAssinatura(event) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sem secret configurado → aceita (dev mode)

  // MP envia: x-signature: ts=TIMESTAMP,v1=HASH
  const xSig = event.headers['x-signature'] || event.headers['X-Signature'] || '';
  const xReqId = event.headers['x-request-id'] || event.headers['X-Request-Id'] || '';

  const parts = {};
  xSig.split(',').forEach(p => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });

  const ts = parts['ts'] || '';
  const v1 = parts['v1'] || '';
  if (!ts || !v1) return false;

  // Extrair data.id da query
  const qs = new URLSearchParams(event.queryStringParameters || {});
  const dataId = qs.get('data.id') || qs.get('data_id') || '';

  const manifest = `id:${dataId};request-id:${xReqId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
}

// ── Obter access token do Firebase via conta de serviço ──────────────
async function getFirebaseToken() {
  const email  = process.env.FIREBASE_SA_EMAIL;
  const rawKey = process.env.FIREBASE_SA_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error('Credenciais Firebase não configuradas');

  const privateKey = rawKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email, sub: email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {}, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  if (!r.body.access_token) throw new Error('Falha ao obter token Firebase');
  return r.body.access_token;
}

// ── Atualizar seller no Firestore ─────────────────────────────────────
async function atualizarFirestore(email, liberado) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'seller-guardian';
  const token = await getFirebaseToken();

  // 1. Buscar UID pelo email via Identity Toolkit
  const searchResp = await httpsRequest('POST', 'identitytoolkit.googleapis.com',
    `/v1/projects/${projectId}/accounts:lookup`,
    { Authorization: `Bearer ${token}` },
    { email: [email] }
  );

  const users = searchResp.body && searchResp.body.users;
  if (!users || users.length === 0) {
    console.log(`Seller não encontrado para email: ${email}`);
    return false;
  }

  const uid = users[0].localId;

  // 2. Atualizar campo acesso_liberado no Firestore
  const updatePath = `/v1/projects/${projectId}/databases/(default)/documents/sellers/${uid}`;
  const updateResp = await httpsRequest('PATCH', 'firestore.googleapis.com',
    `${updatePath}?updateMask.fieldPaths=acesso_liberado&updateMask.fieldPaths=updated_at`,
    { Authorization: `Bearer ${token}` },
    {
      fields: {
        acesso_liberado: { booleanValue: liberado },
        updated_at: { stringValue: new Date().toISOString() },
      },
    }
  );

  return updateResp.status === 200;
}

// ── Enviar alerta no Telegram ─────────────────────────────────────────
async function enviarTelegram(msg) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  await httpsRequest('POST', 'api.telegram.org',
    `/bot${botToken}/sendMessage`,
    {},
    { chat_id: chatId, text: msg, parse_mode: 'HTML' }
  ).catch(e => console.log('Telegram error:', e.message));
}

// ── Buscar detalhes do pagamento/assinatura no MP ──────────────────────
async function buscarDetalhesMP(tipo, id) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token || !id) return null;

  const path = tipo === 'payment'
    ? `/v1/payments/${id}`
    : `/preapproval/${id}`;

  const r = await httpsRequest('GET', 'api.mercadopago.com', path,
    { Authorization: `Bearer ${token}` }
  ).catch(() => null);

  return r && r.status === 200 ? r.body : null;
}

// ── Handler principal ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Aceitar apenas POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  // Validar assinatura
  if (!validarAssinatura(event)) {
    console.log('Assinatura inválida:', event.headers['x-signature']);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Assinatura inválida' }) };
  }

  // Parse do body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  const tipo  = payload.type || payload.action || '';
  const datId = payload.data && payload.data.id;

  console.log(`Webhook recebido: tipo=${tipo} id=${datId}`);

  // ── Processar eventos relevantes ─────────────────────────────────
  // Assinaturas: subscription_preapproval
  // Pagamentos: subscription_authorized_payment

  let email = null;
  let liberado = true;
  let acao = tipo;
  let detalhes = null;

  if (tipo === 'subscription_preapproval' && datId) {
    detalhes = await buscarDetalhesMP('preapproval', datId);
    if (detalhes) {
      email = detalhes.payer_email || (detalhes.payer && detalhes.payer.email);
      const status = detalhes.status || '';
      // authorized = ativo, paused/cancelled = bloquear
      liberado = status === 'authorized';
      acao = `preapproval:${status}`;
      console.log(`Assinatura ${datId} — status: ${status} — email: ${email}`);
    }
  } else if (tipo === 'subscription_authorized_payment' && datId) {
    detalhes = await buscarDetalhesMP('payment', datId);
    if (detalhes) {
      email = detalhes.payer && detalhes.payer.email;
      const status = detalhes.status || '';
      // approved = liberar, rejected/cancelled = bloquear
      liberado = status === 'approved';
      acao = `payment:${status}`;
      console.log(`Pagamento ${datId} — status: ${status} — email: ${email}`);
    }
  } else if (['payment.created', 'payment.updated'].includes(tipo) && datId) {
    // Fallback para eventos genéricos de pagamento
    detalhes = await buscarDetalhesMP('payment', datId);
    if (detalhes && detalhes.description && detalhes.description.includes('Consultor Platinum')) {
      email = detalhes.payer && detalhes.payer.email;
      const status = detalhes.status || '';
      liberado = status === 'approved';
      acao = `payment_generic:${status}`;
    }
  }

  // Se não identificou email, apenas loga e responde OK (não bloquear ninguém por engano)
  if (!email) {
    console.log('Email não encontrado nos dados. Tipo:', tipo, 'Payload:', JSON.stringify(payload).slice(0, 500));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Evento recebido (email não identificado)' }) };
  }

  // ── Atualizar Firestore ───────────────────────────────────────────
  let firestoreOk = false;
  try {
    firestoreOk = await atualizarFirestore(email, liberado);
  } catch (e) {
    console.log('Erro Firestore:', e.message);
  }

  // ── Alerta Telegram ───────────────────────────────────────────────
  const emoji = liberado ? '🟢' : '🔴';
  const statusTxt = liberado ? 'LIBERADO' : 'BLOQUEADO';
  const telegramMsg = `${emoji} <b>Acesso ${statusTxt}</b>\n📧 ${email}\n📋 Ação: ${acao}\n💾 Firestore: ${firestoreOk ? '✅ atualizado' : '⚠️ falhou'}\n🕐 ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
  await enviarTelegram(telegramMsg);

  console.log(`Processado: ${email} → acesso_liberado=${liberado} (${acao})`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, email, liberado, acao, firestore: firestoreOk }),
  };
};
