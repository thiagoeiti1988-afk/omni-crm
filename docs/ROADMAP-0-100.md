# Roadmap Omni-CRM: 0 → 100

Este plano assume o kernel atual (Quanta + MCP + pgvector) e o produto pedido (ICP, lead, copy). Cada fase tem **saída verificável**, não só intenção.

Legenda: **Z** = zero (hoje). **2Z** = segundo ciclo de execução (piloto interno). **100** = produto usável com cliente real.

---

## Fase 0 — Congelar a verdade (Z)

**Saída:** docs e UI não mentem.

- README com badge `prototype` e lista “implementado / mock / planejado”.
- `serverInfo.version` alinhado a `package.json` (`0.1.0`).
- Metadata do Next.js = Omni-CRM.
- Indicador MCP Online só verde se healthcheck passar.
- `.env.example` com `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MCP_API_KEY`, `EMBEDDING_MODEL`.

**Critério:** um agente novo lê o README e não tenta `tools/call` como se existisse.

---

## Fase 1 — Repair do kernel (P0)

**Saída:** um agente Cursor consegue ler e atualizar uma tarefa real.

1. Instanciar `@modelcontextprotocol/sdk` (Streamable HTTP ou o transporte que o Cursor do time usa).
2. Métodos oficiais: `initialize`, `tools/list`, `tools/call`.
3. Tools mínimas, idempotentes:
   - `list_tasks` / `get_task`
   - `update_task_status` (transição válida + `updated_at`)
   - `append_agent_log`
4. Cliente Postgres/Supabase de verdade; seed de 1 projeto + 4 tarefas.
5. Auth: header `Authorization: Bearer <MCP_API_KEY>` (depois JWT por org).
6. Rota `POST /api/tasks` (webhook Harness/OpenClaw) com o mesmo contrato de status.
7. Kanban lendo `tasks` (Server Component ou route handler); counts reais.
8. Testes: JSON-RPC initialize, list, call, transição ilegal, request sem token.

**Critério:** `curl` + um cliente MCP devolvem o mesmo status que a UI.

---

## Fase 2 — Tenancy, invariantes, RAG mínimo (2Z interno)

**Saída:** dois workspaces não se enxergam; logs viram memória.

- `organizations` + `org_id` em todas as tabelas.
- CHECK em `tasks.status`; trigger `updated_at`; `project_id` NOT NULL.
- RLS no Supabase (policy por `org_id`).
- Job/sync: ao inserir `agent_logs`, gerar embedding e gravar modelo/dimensão.
- Tool `search_agent_memory` (cosine, filtro org + project).
- Índice HNSW **parcial** (`WHERE embedding IS NOT NULL`).
- Auditoria de quem mudou status (já é `agent_logs`; tornar obrigatório no `update_task_status`).

**Critério:** busca semântica devolve o log certo; query de org A não vê org B.

---

## Fase 3 — Domínio comercial (CRM de verdade)

**Saída:** o nome “CRM” passa a ser verdadeiro.

Tabelas novas (mínimo):

- `icp_profiles` — persona, dores, linguagem, canais, oferta, exclusões.
- `companies` — conta.
- `contacts` / `leads` — PII, origem, consentimento, score, estágio do funil.
- `pipelines` + `pipeline_stages` — separado do Quanta de engenharia.
- `copy_assets` — peça, canal, tom, ICP alvo, versão, embedding.
- `lead_events` — form, webhook, WhatsApp, UTM.

Funil comercial (exemplo): `new → qualified → nurturing → proposal → won/lost`.  
Quanta continua para **trabalho de agente** (“escrever sequência de e-mail para lead X”), não substitui o estágio do lead.

Tools MCP novas: `upsert_lead`, `get_icp`, `search_copy`, `create_copy_job`.

**Critério:** um projeto de venda tem ICP + 10 leads + 1 pipeline visível no painel.

---

## Fase 4 — Captação e copy (produto 2Z → ~70)

**Saída:** lead entra, agente escreve, humano aprova.

- Form público / webhook (Meta, site, WhatsApp) → `leads` + evento.
- Scoring simples (regras + depois modelo).
- Agente `icp`: gera/atualiza perfil a partir de conversas e wins.
- Agente `copywriter`: gera peça com RAG (ICP + logs + assets aprovados); grava em `copy_assets` com status `in_review`.
- UI: inbox de leads + editor de copy + botão “aprovar / rejeitar” (Human Review já existe no Kanban).
- LGPD: consentimento na captura, retenção, endpoint de exclusão.

**Critério:** fluxo E2E interno em um projeto real do time, sem dado de cliente final em ambiente compartilhado aberto.

---

## Fase 5 — Produção (100)

**Saída:** piloto com cliente, não demo.

- Auth de usuário (Supabase Auth ou equivalente) no painel, não só API key de agente.
- RBAC: owner / closer / copy / agent-bot.
- Observabilidade: request id, taxa de tool error, lag de embed.
- CI: lint, typecheck, testes de contrato MCP, migration check.
- Backup + restore testado; rate limit no MCP.
- Dimensão de embedding configurável; sem vendor hardcode.
- Runbook: o que fazer quando o agente marcar `done` errado.
- Acordo de identidade: `agent_id` estável (`cursor-grok-4.6`, etc.) igual ao AGENTS.md.

**Critério:** um vendedor usa o painel sem o time de engenharia no Zoom; um agente não consegue ler outra org.

---

## Ordem que **não** pular

```
docs honestas → MCP real + DB + auth
              → tenancy + RAG
              → schema de lead/ICP/copy
              → captura + geração
              → produção
```

Pular para copy/lead agora grava PII num POST público e treina o time no hábito errado.

---

## Métricas de “100%”

Não é “mais telas”. É:

1. Contrato MCP oficial passando em teste automatizado.  
2. Kanban = banco.  
3. Dois tenants isolados.  
4. Lead criado por captura, não por SQL manual.  
5. Copy gerada com citação de ICP + memória, aprovada por humano.  
6. Log de agente pesquisável por similaridade.  
7. Zero endpoint de escrita sem auth.  
8. README descreve só o que o `main` faz.

---

## Placar (27/10/2026)

| Critério de 100% | Estado | Evidência |
| :--- | :-: | :--- |
| 1. Contrato MCP oficial em teste automatizado | ✅ | `e2e/api.spec.ts` conecta com `@modelcontextprotocol/sdk` (Streamable HTTP, `2025-11-25`) |
| 2. Kanban = banco | ✅ | aba Quantas lê `tasks`; E2E confirma Quanta indo para Done após aprovação |
| 3. Dois tenants isolados | ✅ | E2E "isolamento de tenant"; toda query filtra `org_id` |
| 4. Lead criado por captura, não SQL | ✅ | formulário público, WhatsApp Cloud API, CSV — todos com teste |
| 5. Copy com citação de ICP + memória, aprovada por humano | ✅ | `citations` em toda peça; só `copy.review` aprova; E2E ponta a ponta |
| 6. Log pesquisável por similaridade | ✅ | `search_agent_memory` / aba Memória (lexical local; vendor é opcional futuro) |
| 7. Zero escrita sem credencial | ✅ | captura exige capture key; webhook exige HMAC; resto exige Bearer ou sessão + Origin |
| 8. README descreve só o que o `main` faz | ✅ | README reescrito com seção "Limites conhecidos" |

Fase 5 (produção):

| Item | Estado |
| :--- | :-: |
| Auth de usuário no painel | ✅ e-mail/senha, sessão httpOnly |
| RBAC owner / closer / copy / agent-bot | ✅ `src/lib/auth.ts` |
| Observabilidade (request id, log por request) | ✅ |
| CI: lint, typecheck, contrato MCP, E2E browser, imagem Docker | ✅ `.github/workflows/ci.yml` |
| Backup + restore testado | ✅ `scripts/backup.mjs` com `integrity_check`, validado em container |
| Rate limit no MCP e na captura | ✅ |
| Runbook | ✅ `docs/RUNBOOK.md` |
| Embedding configurável sem vendor hardcode | ✅ `EMBEDDING_MODEL`; default local |
| Multi-instância (Postgres + Redis) | ⏳ próximo ciclo — ver `docs/MERCADO.md` §5 |

## Fase 6 — Experiência de aprovação e prova de valor (28/10/2026)

Padrões de interface pesquisados no Mobbin (Higgsfield, Cofounder, AirOps, ManyChat, Vercel, Pipedrive).

| Item | Estado | Evidência |
| :--- | :-: | :--- |
| Human Review como cartão de decisão: prévia no formato do canal, fontes legíveis | ✅ | `Review` / `ChannelPreview` em `OpsConsole.tsx` |
| Teclado (A/R/J/K/U) e desfazer de 5 s antes de cobrar | ✅ | E2E "Human Review por teclado" |
| Aviso "N peças aguardando você" fora da aba de review | ✅ | E2E fluxo completo |
| Extrato da fatura: o quê, referente a quem, quem decidiu, barras por dia | ✅ | E2E confere a linha com `owner@acme.demo` |
| Teste simulado contra servidor real (`npm run simulate`) | ✅ | 11/11 passos via formulário e via WhatsApp assinado |
| MCP e painel sem vetor de embedding no payload | ✅ | teste unitário; `/api/state` da demo caiu de 37,8 KB para 21 KB |
| Confiança progressiva (liberar tipo de peça para harness após N aprovações) | ⏳ | exige política por org no servidor |
| Envio outbound da peça aprovada no WhatsApp | ⏳ | maior pedido de cliente; custo por mensagem da Meta entra no preço |
| Postgres + Redis (multi-instância) | ⏳ | `schema.sql` já espelha o v2 |
