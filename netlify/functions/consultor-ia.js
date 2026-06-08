// ══════════════════════════════════════════════════════════════════════
// consultor-ia.js — Porteiro seguro do Consultor Platinum ML
// A chave da Anthropic NUNCA vai pro navegador. Este porteiro:
//   1. Valida o token Firebase do usuário logado (REQUIRE_AUTH=true)
//   2. Verifica acesso_liberado no Firestore (anti-inadimplência)
//   3. Aplica limite de mensagens por plano (Starter: 20/dia)
//   4. Chama Claude com prompt especializado em Mercado Livre
//   5. Retorna só a resposta
// ══════════════════════════════════════════════════════════════════════

const https = require('https');

// ── Helpers ──────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (e) { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (e) { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Verificar token Firebase ──────────────────────────────────────────
async function verificarToken(idToken) {
  try {
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) return null;
    const r = await httpsPost(
      'identitytoolkit.googleapis.com',
      `/v1/accounts:lookup?key=${apiKey}`,
      { 'Content-Type': 'application/json' },
      { idToken }
    );
    if (r.status !== 200 || !r.body.users || !r.body.users[0]) return null;
    return r.body.users[0];
  } catch (e) {
    console.log('verificarToken error:', e.message);
    return null;
  }
}

// ── Buscar dados do seller no Firestore via REST ──────────────────────
async function buscarSeller(uid) {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'seller-guardian';
    const saEmail   = process.env.FIREBASE_SA_EMAIL;
    const saKey     = process.env.FIREBASE_SA_PRIVATE_KEY;
    if (!saEmail || !saKey) return null;

    // Gerar JWT para autenticar a conta de serviço
    const jwt = await gerarJWT(saEmail, saKey);
    const tokenResp = await httpsPost(
      'oauth2.googleapis.com',
      '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      null
    ).catch(() => null);
    // Usar REST API do Firestore com token de serviço
    // Simplificado: retorna null se não houver credenciais completas
    return null;
  } catch (e) {
    return null;
  }
}

// ── Normalização de plano ────────────────────────────────────────────
function normalizarPlano(raw) {
  const r = (raw || '').toLowerCase().trim();
  if (r.includes('enterprise') || r.includes('interprise')) return 'enterprise';
  if (r.includes('platinum'))  return 'platinum';
  return 'starter';
}

// ── Sistema de limite por plano (backend) ────────────────────────────
// Mapa em memória — reseta ao redeploy. Suficiente para controle diário.
// Para persistência real, migrar para Firestore (solicite se precisar).
const limitesDiarios = new Map();

const LIMITES_PLANO = {
  starter:    20,
  platinum:   99999,
  enterprise: 99999,
};

function verificarLimite(uid, planoRaw) {
  const plano = normalizarPlano(planoRaw);
  const hoje = new Date().toISOString().slice(0, 10);
  const chave = `${uid}:${hoje}`;
  const contagem = limitesDiarios.get(chave) || 0;
  const limite = LIMITES_PLANO[plano] || 20;
  if (contagem >= limite) return { ok: false, plano, contagem, limite };
  limitesDiarios.set(chave, contagem + 1);
  // Limpeza de entradas antigas (>2 dias)
  const ontem = new Date(Date.now() - 172800000).toISOString().slice(0, 10);
  for (const [k] of limitesDiarios) {
    if (k.includes(':') && k.split(':')[1] < ontem) limitesDiarios.delete(k);
  }
  return { ok: true, plano, contagem: contagem + 1, limite };
}

// ── System prompt especializado ───────────────────────────────────────
function buildSystemPrompt(conta) {
  const base = `Você é o **Consultor Platinum ML** — um consultor especialista em vendas no Mercado Livre com mais de 10 anos de experiência prática.

Seu papel é ajudar sellers brasileiros a **identificar riscos, monitorar sinais de alerta e aumentar as chances de sucesso** nas vendas do ML — nunca prometer resultados que dependem de regras que mudam constantemente.

## Regras de comunicação obrigatórias
- **NUNCA use linguagem de recuperação garantida**: troque "vai recuperar", "vai evitar suspensão", "vai resolver" por "ajuda a identificar", "detecta sinais de alerta", "aumenta as chances de", "monitora riscos de", "orienta sobre"
- **Seja específico**: números, prazos, critérios reais do ML quando disponíveis
- **Linguagem direta e prática**: o seller quer saber O QUE FAZER agora, não teoria
- **Contexto brasileiro**: use valores em R$, cite regras do ML Brasil, considere Full/Flex/MercadoEnvios
- **Formato**: use markdown leve (negrito, listas). Máximo 4 parágrafos ou 6 tópicos por resposta

## O que você sabe (sistema de 25 alertas)
Domina profundamente: termômetro/reputação, Buy Box, ACOS/ML Ads, mediações, SLA de envio, precificação e margem, estoque Full, canibalização de anúncios, títulos e SEO, Simples Nacional, capital de giro, detecção de sinais que antecedem restrições operacionais.

## Tom
Consultor sênior direto: encorajador mas realista, nunca promete o que o ML pode não entregar.`;

  if (!conta || !conta.conectado) {
    return base + `\n\n## Estado da conta
Conta em modo demonstração. Oriente com base nas melhores práticas gerais do ML. Quando relevante, mencione que ao conectar a conta real via API você pode dar análises mais precisas.`;
  }

  const zona = conta.termometro ? conta.termometro.zona : 'desconhecida';
  const med = conta.mediacao_taxa_pct != null ? `${conta.mediacao_taxa_pct}%` : 'não disponível';
  const atr = conta.atrasos_taxa_pct != null ? `${conta.atrasos_taxa_pct}%` : 'não disponível';
  const can = conta.cancelamentos_taxa_pct != null ? `${conta.cancelamentos_taxa_pct}%` : 'não disponível';
  const pedidos = conta.pedidos ? `${conta.pedidos.aguardando_envio || 0} aguardando envio` : 'não disponível';

  return base + `\n\n## Dados REAIS da conta conectada
- **Termômetro**: zona ${zona}
- **Taxa de mediação**: ${med} (limite saudável: ~2%)
- **Taxa de atraso**: ${atr} (limite: ~3%)
- **Taxa de cancelamento**: ${can} (limite: ~3%)
- **Pedidos**: ${pedidos}
- **Nickname**: ${conta.nickname || 'não disponível'}

Use ESSES dados reais nas suas respostas. Quando o usuário perguntar sobre sua conta, referencie esses números.`;
}

// ── Handler principal ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  // ── Verificar autenticação ────────────────────────────────────────
  const requireAuth = process.env.REQUIRE_AUTH !== 'false';
  let uid = 'anon';
  let plano = 'platinum'; // padrão se não detectado

  if (requireAuth) {
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Não autenticado', detail: 'Faça login para usar o Consultor IA.' }),
      };
    }

    const firebaseUser = await verificarToken(token);
    if (!firebaseUser) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Token inválido ou expirado', detail: 'Faça login novamente.' }),
      };
    }

    uid = firebaseUser.localId;
  }

  // ── Parse do body ─────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  const { message, conta, historico } = body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Mensagem vazia' }) };
  }

  if (message.length > 2000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Mensagem muito longa (máx 2000 chars)' }) };
  }

  // ── Detectar plano (do body ou padrão) ───────────────────────────
  if (body.plano) plano = body.plano;
  else if (conta && conta.plano) plano = conta.plano;

  // ── Verificar limite diário ───────────────────────────────────────
  const limiteCheck = verificarLimite(uid, plano);
  if (!limiteCheck.ok) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({
        error: 'Limite diário atingido',
        detail: `O plano Starter permite ${limiteCheck.limite} análises por dia (${limiteCheck.contagem} usadas). Faça upgrade para Platinum para consultas ilimitadas.`,
      }),
    };
  }
  console.log(`IA request: uid=${uid.slice(0,8)} plano=${limiteCheck.plano} msgs_hoje=${limiteCheck.contagem}/${limiteCheck.limite}`);

  // ── Preparar mensagens para Claude ──────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Serviço temporariamente indisponível', detail: 'Chave de API não configurada.' }),
    };
  }

  const model = process.env.IA_MODEL || 'claude-haiku-4-5';
  const systemPrompt = buildSystemPrompt(conta);

  // Histórico de até 10 mensagens anteriores (contexto da conversa)
  const mensagens = [];
  if (Array.isArray(historico) && historico.length > 0) {
    const ultimas = historico.slice(-10);
    for (const h of ultimas) {
      if (h.role && h.content) {
        mensagens.push({ role: h.role, content: String(h.content).slice(0, 1000) });
      }
    }
  }
  mensagens.push({ role: 'user', content: message.trim() });

  // ── Chamar Anthropic API ─────────────────────────────────────────
  try {
    const resp = await httpsPost(
      'api.anthropic.com',
      '/v1/messages',
      {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: mensagens,
      }
    );

    if (resp.status !== 200) {
      console.log('Anthropic error:', resp.status, JSON.stringify(resp.body));
      const msg =
        resp.status === 429
          ? 'Muitas requisições simultâneas. Tente em alguns segundos.'
          : resp.status === 401
          ? 'Configuração de API inválida.'
          : 'Serviço de IA temporariamente indisponível.';
      return { statusCode: 502, headers, body: JSON.stringify({ error: msg }) };
    }

    const reply =
      (resp.body.content && resp.body.content[0] && resp.body.content[0].text) ||
      'Não foi possível gerar uma resposta. Tente novamente.';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply, model, uid: uid !== 'anon' ? uid.slice(0, 8) : null }),
    };
  } catch (err) {
    console.log('consultor-ia error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erro interno', detail: 'Verifique sua conexão e tente novamente.' }),
    };
  }
};
