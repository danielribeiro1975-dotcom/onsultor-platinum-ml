# 🎚️ Limites de uso da IA — como funciona e como ajustar

## Como ficou (dia + mês, por plano)

| Plano | Limite/dia | Limite/mês | Objetivo |
|---|---|---|---|
| **Starter** | 30 | 300 | Generoso, mas o usuário pesado sente — vira gatilho de upgrade |
| **Platinum** | 300 | 3.000 | "Ilimitado na prática" — ninguém esbarra no uso normal |
| **Enterprise** | 1.500 | 15.000 | Teto alto + rede de segurança |

Mais um **teto global diário** (padrão 2.000 chamadas/dia somando todos os
usuários) que funciona como disjuntor de custo: se estourar, a IA pausa para
todos até o dia seguinte. É a sua proteção final contra bug/abuso.

## Por que dia E mês?
- **Dia**: evita que alguém dispare centenas de chamadas num dia só (pico/abuso).
- **Mês**: casa com o ciclo de cobrança — o cliente paga por mês, o limite é por mês.

## Onde isso é controlado (importante)
O contador agora é **gravado no Firestore** (coleção `uso_ia`), por usuário.
Isso significa que o limite é **real e confiável** — não reseta sozinho quando
a função reinicia (era o bug da versão anterior). O plano do usuário é lido do
**Firestore (servidor)**, não do navegador — ninguém consegue burlar enviando
"plano: enterprise" pelo navegador.

> Custo disso no Firestore: ~2 operações a mais por mensagem. Continua dentro
> do plano gratuito com folga para centenas de sellers.

## Como mudar os números (sem mexer no código)
No Netlify → Site settings → Environment variables, você pode sobrescrever
qualquer limite criando variáveis assim:

| Variável | Exemplo | O que faz |
|---|---|---|
| `IA_LIMITE_STARTER_DIA` | `40` | Limite diário do Starter |
| `IA_LIMITE_STARTER_MES` | `400` | Limite mensal do Starter |
| `IA_LIMITE_PLATINUM_DIA` | `300` | Limite diário do Platinum |
| `IA_LIMITE_PLATINUM_MES` | `3000` | Limite mensal do Platinum |
| `IA_LIMITE_ENTERPRISE_DIA` | `1500` | Limite diário do Enterprise |
| `IA_LIMITE_ENTERPRISE_MES` | `15000` | Limite mensal do Enterprise |
| `IA_TETO_GLOBAL_DIA` | `2000` | Teto global de segurança (todos os usuários) |

Se não criar nenhuma, valem os números da tabela do topo.

## Pré-requisito para o limite persistente funcionar
Precisa das credenciais da conta de serviço do Firebase configuradas
(você já tem essas para o login funcionar):
- `FIREBASE_SA_EMAIL`
- `FIREBASE_SA_PRIVATE_KEY`
- `FIREBASE_PROJECT_ID`

Se essas credenciais faltarem, o sistema **não fica desprotegido**: ele cai
automaticamente para um limite diário conservador em memória + o teto global.

## Mensagens que o usuário vê ao bater o limite
- Limite diário: "Você atingiu o limite diário do plano X... tente amanhã ou faça upgrade."
- Limite mensal: "Você atingiu o limite mensal do plano X... faça upgrade."
- Teto global: "O sistema atingiu o limite de uso de hoje e volta amanhã."
