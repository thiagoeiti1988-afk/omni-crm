# SPEC.md: Especificação Técnica do Omni-CRM

## 1. Arquitetura

```
UI (Next.js dashboard)
        |
        v
HTTP: /api/mcp-server  /api/tasks  /api/leads  /api/copy  /api/state  /api/health
        |
        v
OmniStore (SQLite runtime)  —  schema.sql = alvo Postgres + pgvector + RLS
```

Toda escrita exige `Authorization: Bearer`. Escopo = organização da chave. Header `X-Actor-Role` define se o ator pode marcar `done` / aprovar copy.

---

## 2. Banco

Runtime: tabelas criadas em `src/lib/store.ts`. Equivalente Postgres: `schema.sql`.

Núcleo: `organizations`, `projects`, `tasks`, `agent_logs`  
Comercial: `pipelines`, `pipeline_stages`, `companies`, `icp_profiles`, `leads`, `lead_events`, `copy_assets`

- `tasks.status` CHECK `todo|in_progress|in_review|done`
- `project_id` e `org_id` NOT NULL nas entidades de trabalho
- embedding 1536d (JSON no SQLite; `VECTOR(1536)` no Postgres) gerado no insert do log/copy
- Funil de lead separado do Quanta: `new → qualified → nurturing → proposal → won|lost`

---

## 3. MCP `POST /api/mcp-server`

JSON-RPC 2.0. Sem Bearer → HTTP 401.

| Method | Resultado |
| :--- | :--- |
| `initialize` | `protocolVersion` `2024-11-05`, `serverInfo` `omni-crm-mcp` / `0.1.0` |
| `tools/list` | catálogo abaixo |
| `tools/call` | `{ name, arguments }` |
| `ping` | `{}` |

Aliases de legado: `mcp.initialize`, `mcp.tools.list`.

### Tools

| Tool | Notas |
| :--- | :--- |
| `list_tasks` / `get_task` | org-scoped |
| `update_task_status` | agente: até `in_review`; `done` só human/harness |
| `append_agent_log` | gera embedding |
| `search_agent_memory` | cosine no org |
| `upsert_lead` | `consent: true` obrigatório; dedupe e-mail/external_id |
| `list_leads` / `get_icp` | |
| `create_copy_job` | exige ICP `approved`; status `in_review`; cita `icp:` / `log:` / `lead:` |
| `search_copy` / `review_copy` | review só human/harness |

---

## 4. HTTP auxiliar

| Rota | Uso |
| :--- | :--- |
| `GET /api/health` | público; UI usa para o ponto Online |
| `GET /api/state` | dashboard autenticado |
| `POST /api/tasks` | webhook `{ taskId, status }` |
| `POST /api/leads` | captura |
| `POST /api/copy` | gera ou `{ copyId, decision }` |

---

## 5. JEV

Payloads de tool leves. Invariantes rígidos: auth, tenant, consentimento, transições de status.
