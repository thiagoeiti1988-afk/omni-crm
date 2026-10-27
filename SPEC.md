# SPEC.md — Contrato técnico do Omni-CRM

## 1. Arquitetura

```
Navegador (painel)      Agentes (MCP)        Site / WhatsApp / CSV
      │ cookie               │ Bearer               │ capture key · HMAC · sessão
      ▼                      ▼                      ▼
 Next.js App Router ── api() envelope: request id · log JSON · erros tipados · rate limit
      │
 auth.ts  ── credencial → papel → matriz de permissões (can / assertCan)
      │
 store.ts ── OmniStore (SQLite, node:sqlite, WAL, migrações por PRAGMA user_version)
```

Instância única. `schema.sql` documenta o alvo Postgres + pgvector + RLS para escala horizontal.

## 2. Autenticação e autorização

| Credencial | Header | Papel resultante |
| :--- | :--- | :--- |
| Agent key | `Authorization: Bearer omni_org_…` | `agent` (header `X-Actor-Role` ignorado) |
| Harness key | `Authorization: Bearer omni_hns_…` | `harness` |
| Master | `Authorization: Bearer $MCP_API_KEY` + `X-Org-Id` | `human` ou `harness` (via `X-Actor-Role`) |
| Sessão | cookie `omni_session` (httpOnly, SameSite=Lax, Secure em prod) | `human` + `owner` / `closer` / `copy` |
| Capture key | campo `key` ou `X-Capture-Key` | só `/api/capture` |

Escrita autenticada por cookie exige `Origin` do próprio host (e `Sec-Fetch-Site` same-origin quando presente).

Permissões (`src/lib/auth.ts`):

| Permissão | owner | closer | copy | harness | agent |
| :--- | :-: | :-: | :-: | :-: | :-: |
| `task.done` (fechar/reabrir Quanta) | ✓ | ✓ | | ✓ | |
| `copy.review` | ✓ | | ✓ | ✓ | |
| `icp.approve` | ✓ | | | ✓ | |
| `lead.stage` (mover funil) | ✓ | ✓ | | ✓ | |
| `lead.export` | ✓ | ✓ | | | |
| `lead.erase`, `lead.import`, `org.keys` | ✓ | | | | |
| `billing.view` | ✓ | ✓ | | | |

## 3. Banco (v2)

Núcleo: `organizations` (api_key, harness_key, capture_key, whatsapp_phone_id), `projects`, `tasks`, `agent_logs`.
Comercial: `pipelines`, `pipeline_stages`, `companies`, `icp_profiles`, `leads`, `lead_events`, `copy_assets`.
Plataforma: `users` (scrypt), `sessions` (sha256 do token), `billable_events`.

Invariantes:

- `tasks.status` CHECK `todo|in_progress|in_review|done`; transição com compare-and-swap (409 em corrida).
- `leads`: `email` opcional (WhatsApp traz só telefone), `UNIQUE(org_id,email)`, `UNIQUE(org_id,external_id)`, `consent_basis` CHECK `consent|inbound_contact|import`, `erased_at`.
- `lead_events.dedupe_key` único por org (idempotência de webhook).
- `billable_events` `UNIQUE(org_id, kind, ref_id)`: cada resultado é cobrado uma vez.
- Recaptura de lead existente **não** altera estágio; estágio só muda por `updateLeadStage`.

## 4. MCP — `POST /api/mcp-server`

Streamable HTTP com respostas JSON. `GET` com `Accept: text/event-stream` → 405; notificações → 202 sem corpo; batch → 400. Versões: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (sem `protocolVersion` no request: `2024-11-05`). `structuredContent` é sempre objeto (listas em `{ items }`). Limite: 600 req/min por credencial.

| Tool | Regra |
| :--- | :--- |
| `list_tasks`, `get_task` | org da credencial |
| `update_task_status` | `done`/reabrir exige `task.done` |
| `append_agent_log`, `search_agent_memory` | embedding gerado no servidor |
| `upsert_lead` | `consent: true` obrigatório; dedupe e-mail / externalId |
| `list_leads`, `get_icp`, `search_copy`, `get_insights` | leitura |
| `create_copy_job` | ICP aprovado; `title`/`body` opcionais (agente como copywriter); sempre `in_review` |
| `review_copy` | `copy.review`; aprovar fecha a Quanta e fatura `copy_approved` |
| `update_lead_stage` | `lead.stage`; fatura `lead_qualified` / `deal_won` |
| `run_ops_agent` | analyst · scout · icp · copywriter |

## 5. HTTP

| Rota | Auth | Uso |
| :--- | :--- | :--- |
| `GET /api/health` | pública | DB ping, versão, uptime, `llm` |
| `POST /api/auth/login` · `logout` · `GET me` | — / sessão | sessão do painel (10 tentativas/15 min por e-mail) |
| `GET /api/state` | qualquer | dashboard da org |
| `POST /api/tasks` | qualquer | `{ taskId, status }` (webhook harness) |
| `POST /api/leads` | qualquer | captura autenticada |
| `PATCH /api/leads/:id` | `lead.stage` | `{ stage, amount? }` |
| `GET /api/leads/:id/export` | `lead.export` | JSON do titular (LGPD art. 18, II) |
| `POST /api/leads/:id/erase` | `lead.erase` | anonimização (art. 18, VI) |
| `POST /api/leads/import` | `lead.import` | corpo `text/csv`, cabeçalhos PT/EN, `,` ou `;` |
| `POST /api/capture` | capture key | JSON ou form HTML; CORS `*`; honeypot `website`; 20/min por IP |
| `GET/POST /api/webhooks/whatsapp` | verify token / `X-Hub-Signature-256` | handshake e mensagens inbound |
| `POST /api/copy` | qualquer / `copy.review` | gera peça ou `{ copyId, decision }` |
| `PUT /api/icp` | aprovar exige `icp.approve` | edita ICP |
| `GET /api/billing/usage?month=YYYY-MM` | `billing.view` | linhas, total, extrato |
| `GET/POST /api/org/keys` | `org.keys` | chaves, rotação, `whatsappPhoneId` |
| `POST /api/admin/orgs` | master | provisiona org + owner; chaves retornam uma vez |
| `GET /api/memory?q=` · `POST /api/agents/run` | qualquer | memória e agentes de operação |

Toda resposta traz `x-request-id`. Erros: `{ error }` com 400/401/403/404/409/413/429 (`Retry-After`)/500.

## 6. Copy

Ordem: `body` explícito do agente → Claude (`ANTHROPIC_API_KEY`, modelo `OMNI_COPY_MODEL`, default `claude-opus-5-5`, saída estruturada `{title, body}`, effort `medium`, timeout 45 s) → template. Recusa, erro ou JSON inválido caem no template. Dados do CRM vão ao modelo delimitados como dados; e-mail do lead não é enviado. O corpo contém só a mensagem ao cliente; briefing fica em `citations`.

## 7. Faturamento por resultado

`total = OMNI_BASE_FEE_CENTS + Σ count(kind) × OMNI_PRICE_<KIND>_CENTS` no mês. Eventos: `lead_qualified` (lead com consentimento entra em `qualified` ou além), `copy_approved`, `deal_won`. Só atores com permissão humana/harness disparam eventos.
