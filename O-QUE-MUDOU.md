# ✅ O que mudou nesta atualização

## 1. Tela escura corrigida (index.html e landing.html)
**Causa:** o conteúdo abaixo do menu usava animações (`fadeDown` e `.reveal`)
que começam invisíveis (`opacity:0`) e só aparecem quando a animação roda.
Em alguns navegadores/situações (aba anônima, reduced-motion, falha de JS) a
animação não rodava e o conteúdo ficava preso invisível = tela escura.

**Correção:** o conteúdo agora é **visível por padrão**. A animação só "esconde
para revelar" quando o JavaScript confirma que está pronto (classe `js-ready`
no `<html>`). Se o JS falhar, nada some — a página aparece normalmente.

## 2. index.html agora é o SITE oficial
- É o que abre em `consultorplatinum.com.br`.
- Adicionado botão **"Entrar"** no menu do topo (ao lado de "Começar agora").
- Já tinha links de login/cadastro/painel — tudo mantido.

## 3. landing.html = página de campanha separada
- Mesma correção da tela escura aplicada.
- Acesse por `consultorplatinum.com.br/oferta` (use esse link nos anúncios).

## 4. Proteção de custo da IA (consultor-ia.js) — IMPORTANTE
- Antes: planos pagos tinham limite "ilimitado" (99999) = risco de gasto alto.
- Agora: limites reais por plano (Starter 20/dia, Platinum 200/dia, Enterprise 1000/dia).
- Adicionado **TETO GLOBAL diário** (disjuntor de custo): se o total de chamadas
  de IA no dia passar do teto, a IA pausa para todos até o dia seguinte.
  Configurável pela variável `IA_TETO_GLOBAL_DIA` (padrão: 2000).

> ⚠️ Observação técnica: esse limite vive na memória da função e pode resetar
> em cold starts. O teto global é a sua principal proteção de orçamento.
> Para um controle 100% à prova de abuso, o ideal futuro é gravar o contador
> no Firestore (peça quando o faturamento justificar o esforço).

---

# 🚀 Como subir (Netlify, custo zero)

1. Acesse https://app.netlify.com → **Add new site → Deploy manually**
2. Arraste **a pasta inteira** (esta, com a subpasta `netlify/`)
3. Configure as variáveis de ambiente (Site settings → Environment variables) —
   veja a tabela no arquivo `SUBIR-NO-AR.md` original.
4. Variável nova opcional: `IA_TETO_GLOBAL_DIA` (ex.: `2000`)

# 💰 Resumo de custo (estimativa)
- Netlify, Firebase, Mercado Pago: **R$ 0/mês fixo** até ter volume real.
- Único custo variável: **a IA** (~R$ 0,02–0,08 por mensagem com Claude Haiku 4.5).
- Cada cliente pagante (Starter R$ 97) cobre o próprio custo de IA com folga enorme.
- Você só "coloca mais dinheiro" lá pelos ~300 sellers (Firebase) — bem depois de ter receita.
- O maior risco é IA grátis sem controle → resolvido com o teto global acima.
