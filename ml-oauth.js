// ══════════════════════════════════════════════════════════════════════
// ml-oauth.js — Troca código OAuth do ML por tokens (SERVER-SIDE)
// O CLIENT_SECRET nunca vai ao navegador — fica só aqui.
// Guarda access_token + refresh_token no Firestore do seller.
// ══════════════════════════════════════════════════════════════════════

const https  = require('https');
const crypto = require('crypto');

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const isForm = typeof body === 'string';
    const data = body ? (isForm ? body : JSON.stringify(body)) : '';
    const req = https.request(
      {
        hostname, path, method,
        headers: {
          'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Verificar token Firebase ─────────────────────────────────────────
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

// ── Obter token Firebase Admin ───────────────────────────────────────
async function getAdminToken() {
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
  const jwt = `${header}.${payload}.${sign.sign(privateKey, 'base64url')}`;

  const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {},
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );
  if (!r.body.access_token) throw new Error('Token Firebase não obtido');
  return r.body.access_token;
}

// ── Salvar tokens no Firestore ───────────────────────────────────────
async function salvarTokensFirestore(uid, dados) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'seller-guardian';
  const adminToken = await getAdminToken();

  const path = `/v1/projects/${projectId}/databases/(default)/documents/sellers/${uid}`;
  const mask = Object.keys(dados).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');

  const fields = {};
  for (const [k, v] of Object.entries(dados)) {
    if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
    else fields[k] = { stringValue: String(v) };
  }

  const r = await httpsRequest('PATCH', 'firestore.googleapis.com',
    `${path}?${mask}`,
    { Authorization: `Bearer ${adminToken}` },
    { fields }
  );
  return r.status === 200;
}

// ── Handler ───────────────────────────────────────────────────────────
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

  // Verificar auth Firebase
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const idToken = authHeader.replace('Bearer ', '').trim();
  const firebaseUser = await verificarToken(idToken);
  if (!firebaseUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Não autenticado. Faça login novamente.' }) };
  }

  const uid = firebaseUser.localId;

  // Parse body
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'JSON inválido' }) }; }

  const { code, redirectUri } = body;
  if (!code || !redirectUri) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'code e redirectUri são obrigatórios' }) };
  }

  const clientId     = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'ML_CLIENT_ID ou ML_CLIENT_SECRET não configurados no servidor.' }) };
  }

  // ── Trocar code por tokens no ML ─────────────────────────────────
  const formData = `grant_type=authorization_code&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  let mlResp;
  try {
    mlResp = await httpsRequest('POST', 'api.mercadolibre.com', '/oauth/token', {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ConsultorPlatinumML/1.0',
    }, formData);
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Falha ao conectar ao Mercado Livre: ' + e.message }) };
  }

  if (mlResp.status !== 200 || !mlResp.body.access_token) {
    console.log('ML OAuth error:', mlResp.status, JSON.stringify(mlResp.body));
    const mlError = mlResp.body && (mlResp.body.message || mlResp.body.error_description || mlResp.body.error);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: mlError || 'Autorização negada pelo Mercado Livre.' }),
    };
  }

  const { access_token, refresh_token, user_id, expires_in } = mlResp.body;
  const expiresAt = new Date(Date.now() + (expires_in || 21600) * 1000).toISOString();

  // ── Salvar no Firestore ───────────────────────────────────────────
  let saved = false;
  try {
    saved = await salvarTokensFirestore(uid, {
      ml_connected:    true,
      ml_user_id:      String(user_id),
      ml_access_token: access_token,
      ml_refresh_token: refresh_token || '',
      ml_token_expires: expiresAt,
      ml_connected_at:  new Date().toISOString(),
    });
  } catch (e) {
    console.log('Firestore save error:', e.message);
  }

  console.log(`ML OAuth sucesso: uid=${uid.slice(0,8)} ml_user=${user_id} firestore=${saved}`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, ml_user_id: user_id, saved }),
  };
};
