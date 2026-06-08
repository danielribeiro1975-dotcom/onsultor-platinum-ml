# 🚀 Subir no Ar — Passo a passo único

## Sobre o cadeado (HTTPS / SSL)

O SSL **já está incluído automaticamente pelo Netlify** — você não precisa comprar nada.
O problema do "sem cadeado" acontece por **uma das 3 razões** abaixo:

### ❌ Causa 1 — Domínio personalizado não configurado no Netlify
Se você está acessando pelo domínio `consultorplatinum.com.br` mas ele não está apontado corretamente:

1. No Netlify: **Site settings → Domain management → Add custom domain**
2. Digite `consultorplatinum.com.br` e `www.consultorplatinum.com.br`
3. O Netlify mostra os **nameservers** ou o **registro CNAME/A** que você precisa configurar no seu registrador de domínio (Registro.br, GoDaddy, etc.)
4. Após configurar o DNS, o Netlify emite o certificado SSL automaticamente (Let's Encrypt) — leva até 24h mas geralmente é em minutos

### ❌ Causa 2 — Você está acessando via HTTP (sem o S)
Verifique se a URL começa com `https://` — não `http://`.
O `netlify.toml` já inclui `Strict-Transport-Security` para forçar HTTPS.

### ❌ Causa 3 — Conteúdo misto (mixed content)
Se algum recurso na página carrega via `http://` (imagens, scripts), o navegador exibe "não seguro".
→ Abra o DevTools (F12) → aba Console → procure por avisos de "Mixed Content" e troque os links para `https://`.

---

## 📦 Como subir TUDO de uma vez (método mais fácil)

### Opção A — Arrastar e soltar no Netlify (sem Git)
1. Acesse https://app.netlify.com
2. Clique em **Add new site → Deploy manually**
3. Arraste a **pasta inteira** (com a subpasta `netlify/`) para a área de upload
4. Aguarde o deploy (1–2 minutos)

### Opção B — Conectar ao GitHub (recomendado para atualizações contínuas)
1. Crie um repositório no GitHub e envie todos os arquivos
2. No Netlify: **Add new site → Import an existing project → GitHub**
3. Selecione o repositório
4. Build settings: deixe vazio (site estático)
5. **Deploy**

### Estrutura obrigatória que deve estar na pasta:
```
📁 Sua pasta/
├── index.html
├── landing.html
├── login.html
├── cadastro.html
├── obrigado.html
├── onboarding.html
├── app.html
├── pendente.html
├── ml-oauth-callback.html
├── og-image.jpg          ← copie do upload original
├── logo.png              ← copie do upload original
├── robots.txt
├── sitemap.xml
├── netlify.toml
└── 📁 netlify/
    └── 📁 functions/
        ├── consultor-ia.js   ← NOVO — porteiro da IA
        ├── mp-webhook.js      ← NOVO — cobrança automática
        ├── ml-oauth.js        ← NOVO — conexão ML
        └── ml-conta.js        ← NOVO — dados reais ML
```

---

## ⚙️ Variáveis de ambiente (configurar ANTES do deploy funcionar)

**Netlify → Site settings → Environment variables**

| Variável | Valor | Urgência |
|---|---|---|
| `ANTHROPIC_API_KEY` | Nova chave (console.anthropic.com) | 🔴 Obrigatória |
| `FIREBASE_WEB_API_KEY` | `AIzaSyBQO4D_j8qeuE-M94FUgpqpG9rvyYUlM-M` | 🔴 Obrigatória |
| `FIREBASE_PROJECT_ID` | `seller-guardian` | 🔴 Obrigatória |
| `FIREBASE_SA_EMAIL` | Do JSON da conta de serviço Firebase | 🔴 Obrigatória |
| `FIREBASE_SA_PRIVATE_KEY` | Do JSON da conta de serviço (com `\n`) | 🔴 Obrigatória |
| `MP_ACCESS_TOKEN` | Mercado Pago → Credenciais de produção | 🟡 Para cobrança |
| `MP_WEBHOOK_SECRET` | Mercado Pago → Webhooks | 🟡 Para cobrança |
| `ML_CLIENT_ID` | ML Developers → App ID | 🟡 Para ML OAuth |
| `ML_CLIENT_SECRET` | ML Developers → Secret Key | 🟡 Para ML OAuth |
| `TELEGRAM_BOT_TOKEN` | @BotFather no Telegram | 🟢 Opcional |
| `TELEGRAM_CHAT_ID` | @userinfobot no Telegram | 🟢 Opcional |

> Após salvar: **Deploys → Trigger deploy → Deploy site**

---

## ✅ Checklist rápido pós-deploy

- [ ] Site abre com cadeado 🔒 na barra do navegador
- [ ] `/login.html` carrega sem erro
- [ ] Login com usuário Firebase funciona
- [ ] Chat com IA no painel responde (não dá erro de API)
- [ ] Webhook MP configurado em: `https://SEU-DOMINIO/.netlify/functions/mp-webhook`
