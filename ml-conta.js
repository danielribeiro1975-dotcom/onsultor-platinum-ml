// ══════════════════════════════════════════════════════════════════════
// ml-conta.js — Lê dados reais da conta ML do seller
// Renova o access_token automaticamente via refresh_token.
// Retorna: termômetro, pedidos, reputação, mediações, atrasos.
// ══════════════════════════════════════════════════════════════════════

const https  = require('https');
const crypto = require('crypto');

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const isForm = typeof body === 'string';
    const data = body ? (isForm ? body : JSON.stringify(body)) : '';
    const req = https.request({
      hostname, path, method,
      headers: {
        'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        Accept: 'application/json',
        'User-Agent': 'ConsultorPlatinumML/1.0',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
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

async function verificarToken(idToken) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await httpsRequest('POST', 'identitytoolkit.googleapis.com',
      `/v1/accounts:lookup?key=${apiKey}`,
      { 'Content-Type': 'application/json' },
      { idToken }
    );
    return r.status === 200 && r.body.users && r.body.users[0] ? r.body.users[0] : null;
  } catch { return null; }
}

async function getAdminToken() {
  const email  = process.env.FIREBASE_SA_EMAIL;
  const rawKey = process.env.FIREBASE_SA_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error('Firebase SA não configurado');
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pld = Buffer.from(JSON.stringify({
    iss: email, sub: email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${hdr}.${pld}`);
  const jwt = `${hdr}.${pld}.${sign.sign(privateKey, 'base64url')}`;
  const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {},
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );
  if (!r.body.access_token) throw new Error('Token admin não obtido');
  return r.body.access_token;
}

async function lerFirestore(uid, adminToken) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'seller-guardian';
  const r = await httpsRequest('GET', 'firestore.googleapis.com',
    `/v1/projects/${projectId}/databases/(default)/documents/sellers/${uid}`,
    { Authorization: `Bearer ${adminToken}` }
  );
  if (r.status !== 200 || !r.body.fields) return null;
  const fields = r.body.fields;
  const get = (k) => {
    if (!fields[k]) return null;
    return fields[k].stringValue ?? fields[k].booleanValue ?? fields[k].integerValue ?? null;
  };
  return {
    ml_connected:     get('ml_connected') === true || get('ml_connected') === 'true',
    ml_user_id:       get('ml_user_id'),
    ml_access_token:  get('ml_access_token'),
    ml_refresh_token: get('ml_refresh_token'),
    ml_token_expires: get('ml_token_expires'),
  };
}

async function atualizarToken(uid, refreshToken, adminToken) {
  const clientId     = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const r = await httpsRequest('POST', 'api.mercadolibre.com', '/oauth/token', {},
    `grant_type=refresh_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(refreshToken)}`
  ).catch(() => null);

  if (!r || r.status !== 200 || !r.body.access_token) return null;

  const expiresAt = new Date(Date.now() + (r.body.expires_in || 21600) * 1000).toISOString();

  // Salvar novo token no Firestore
  const projectId = process.env.FIREBASE_PROJECT_ID || 'seller-guardian';
  const path = `/v1/projects/${projectId}/databases/(default)/documents/sellers/${uid}?updateMask.fieldPaths=ml_access_token&updateMask.fieldPaths=ml_token_expires&updateMask.fieldPaths=ml_refresh_token`;
  await httpsRequest('PATCH', 'firestore.googleapis.com', path,
    { Authorization: `Bearer ${adminToken}` },
    { fields: {
      ml_access_token:  { stringValue: r.body.access_token },
      ml_token_expires: { stringValue: expiresAt },
      ml_refresh_token: { stringValue: r.body.refresh_token || refreshToken },
    }}
  ).catch(e => console.log('Token update error:', e.message));

  return r.body.access_token;
}

async function chamarML(path, accessToken) {
  const r = await httpsRequest('GET', 'api.mercadolibre.com', path,
    { Authorization: `Bearer ${accessToken}` }
  ).catch(() => null);
  return r && r.status === 200 ? r.body : null;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  // Verificar auth
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const idToken = authHeader.replace('Bearer ', '').trim();
  const firebaseUser = await verificarToken(idToken);
  if (!firebaseUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Não autenticado' }) };
  }

  const uid = firebaseUser.localId;

  // Buscar dados do seller
  let adminToken;
  try { adminToken = await getAdminToken(); }
  catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Configuração incompleta', detail: e.message }) };
  }

  const seller = await lerFirestore(uid, adminToken);
  if (!seller || !seller.ml_connected || !seller.ml_access_token) {
    return { statusCode: 200, headers, body: JSON.stringify({ conectado: false }) };
  }

  // Verificar e renovar token se próximo do vencimento
  let accessToken = seller.ml_access_token;
  if (seller.ml_token_expires) {
    const exp = new Date(seller.ml_token_expires).getTime();
    const agora = Date.now();
    if (exp - agora < 900000) { // menos de 15 min → renovar
      const novoToken = await atualizarToken(uid, seller.ml_refresh_token, adminToken);
      if (novoToken) accessToken = novoToken;
    }
  }

  const mlUserId = seller.ml_user_id;
  if (!mlUserId) {
    return { statusCode: 200, headers, body: JSON.stringify({ conectado: false, error: 'ml_user_id não encontrado' }) };
  }

  // ── Buscar dados do ML em paralelo ──────────────────────────────
  const [userInfo, reputation, orders, items] = await Promise.all([
    chamarML(`/users/${mlUserId}`, accessToken),
    chamarML(`/users/${mlUserId}/seller_reputation`, accessToken),
    chamarML(`/orders/search?seller=${mlUserId}&order.status=paid&limit=50&sort=date_desc`, accessToken),
    chamarML(`/users/${mlUserId}/items/search?status=active&limit=1`, accessToken),
  ]);

  // ── Processar reputação / termômetro ─────────────────────────────
  let termometro = null;
  let mediacao_taxa_pct = null;
  let atrasos_taxa_pct = null;
  let cancelamentos_taxa_pct = null;

  if (reputation) {
    const level = reputation.level_id || '';
    // ML levels: 1_red, 2_orange, 3_yellow, 4_light_green, 5_green
    const zona =
      level.includes('green')  ? 'verde' :
      level.includes('yellow') || level.includes('orange') ? 'amarelo' :
      level.includes('red')    ? 'vermelho' : 'cinza';

    termometro = { zona, level };

    const trans = reputation.transactions || {};
    const ratings = trans.ratings || {};
    const total = trans.total || 0;
    const negativo = ratings.negative || 0;
    const neutro   = ratings.neutral  || 0;

    if (total > 0) {
      mediacao_taxa_pct  = Math.round((negativo / total) * 1000) / 10;
    }

    const metrics = reputation.metrics || {};
    const delayed   = metrics.delayed_handling_time || {};
    const cancels   = metrics.cancellations || {};

    if (delayed.rate != null)   atrasos_taxa_pct       = Math.round(delayed.rate * 1000) / 10;
    if (cancels.rate != null)   cancelamentos_taxa_pct = Math.round(cancels.rate * 1000) / 10;
  }

  // ── Processar pedidos ─────────────────────────────────────────────
  let pedidosData = null;
  if (orders && orders.results) {
    const agora = Date.now();
    const em48h = agora - 172800000;
    const recentes = orders.results.filter(o => new Date(o.date_created).getTime() > em48h);

    // Pedidos aguardando envio
    let aguardando = 0;
    for (const o of orders.results) {
      if (o.order_status === 'paid' || o.shipping_status === 'to_be_agreed') aguardando++;
    }

    pedidosData = {
      pagos_recentes: recentes.length,
      total: orders.results.length,
      aguardando_envio: aguardando,
    };
  }

  // ── Contar anúncios ativos ────────────────────────────────────────
  let anuncios = null;
  if (items) {
    anuncios = {
      ativos: items.paging ? items.paging.total : 0,
      pausados: 0, // requer chamada adicional
    };
  }

  const resultado = {
    conectado: true,
    nickname:  userInfo ? userInfo.nickname : null,
    termometro,
    mediacao_taxa_pct,
    atrasos_taxa_pct,
    cancelamentos_taxa_pct,
    pedidos: pedidosData,
    anuncios,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(resultado),
  };
};
