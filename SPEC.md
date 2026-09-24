# SPEC.md: Especificação Técnica do Omni-CRM

## 1. Visão Geral da Arquitetura

O Omni-CRM é arquitetado sob o paradigma de **Motor Multivetorial SaaS**, composto por 3 camadas desacopladas:

```
+-------------------------------------------------------------+
|                  UI Layer (Next.js Dashboard)               |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|         API & MCP Gateway Layer (/api/mcp-server)           |
+-------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|    Database & RAG Storage Layer (PostgreSQL + pgvector)     |
+-------------------------------------------------------------+
```

---

## 2. Especificação do Banco de Dados (Schema)

O banco de dados é estruturado relacionalmente com extensão vetorial habilitada.

### Tabelas Primárias

- **`projects`**: Registra os produtos/projetos monitorados.
  - `id`: `UUID` (PK)
  - `name`: `TEXT`
  - `description`: `TEXT`
  - `platform`: `TEXT` (`Codex`, `OpenClaw`, `Cursor`, `Grok`)
  - `status`: `TEXT` (`active`, `archived`)

- **`tasks`**: Registra cada unidade de trabalho (*Quanta*).
  - `id`: `UUID` (PK)
  - `project_id`: `UUID` (FK -> `projects.id`)
  - `title`: `TEXT`
  - `status`: `TEXT` (`todo`, `in_progress`, `in_review`, `done`)
  - `assigned_agent`: `TEXT`

- **`agent_logs`**: Registra logs e embeddings de auditoria.
  - `id`: `UUID` (PK)
  - `task_id`: `UUID` (FK -> `tasks.id`)
  - `project_id`: `UUID` (FK -> `projects.id`)
  - `agent_id`: `TEXT`
  - `action_type`: `TEXT`
  - `log_content`: `TEXT`
  - `embedding`: `VECTOR(1536)` (Índice HNSW com métrica Cosine)

---

## 3. Especificação da API MCP (`/api/mcp-server`)

O endpoint `/api/mcp-server` implementa o protocolo JSON-RPC 2.0 **oficial** (Fase 1 do roadmap, entregue): `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. Requer `Authorization: Bearer <MCP_API_KEY>`; sem a env var configurada, o servidor recusa toda requisição (fail-closed).

### Métodos Suportados

#### `initialize`

- **Request**: `{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }`
- **Response**: `protocolVersion`, `capabilities.tools`, `serverInfo` (`omni-crm-mcp`, versão sincronizada com `package.json`).

#### `tools/list` / `tools/call`

Tools implementadas (persistem em Supabase; `src/lib/mcp.ts` + `src/lib/db.ts`):
  - `list_tasks(projectId?)`
  - `get_task(taskId)`
  - `update_task_status(taskId, status)`: aceita apenas `todo` \| `in_progress` \| `in_review`. Transição para `done` é exclusiva do webhook `POST /api/tasks` (humano / Harness, ver AGENTS.md) — a tool de agente rejeita `done` em runtime, não só por schema.
  - `append_agent_log(projectId, agentId, actionType, logContent, taskId?)`: persiste memória; `embedding` fica `NULL` até a Fase 2 (pipeline RAG).

---

## 4. Filosofia de Design JEV (Just Enough Validation)

- **Desempenho**: Renderização estática com revalidação dinâmica no Next.js App Router.
- **Payloads Leves**: Respostas de API contendo apenas os campos estritamente necessários para os agentes trabalharem.
- **Zero Lock-in**: Compatível com qualquer cliente de banco de dados PostgreSQL relacional ou vetorial.
