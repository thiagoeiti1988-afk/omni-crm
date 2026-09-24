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

O endpoint `/api/mcp-server` implementa o protocolo JSON-RPC 2.0.

### Métodos Suportados

#### `initialize` (hoje no mock: `mcp.initialize` — **não** é o nome oficial MCP)

Contrato **alvo** (Fase 1 do roadmap): métodos JSON-RPC MCP `initialize`, `tools/list`, `tools/call`.

O protótipo atual em `src/app/api/mcp-server/route.ts` ainda responde a `mcp.initialize` / `mcp.tools.list` e **não** implementa `tools/call`.

- **Request alvo**: `{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { ... } }`
- **Response alvo**: `serverInfo` (`omni-crm-mcp`, versão = `package.json`, hoje `0.1.0`).

#### `tools/list` (hoje no mock: `mcp.tools.list`)

Ferramentas **alvo**:
  - `get_task` / `get_task_status`: Consulta o estado de uma tarefa pelo `taskId`.
  - `update_task_status`: Atualiza o status (`todo` \| `in_progress` \| `in_review`). Transição para `done` é humana / Harness (ver AGENTS.md).
  - `append_agent_log`: (Fase 1) persiste memória; embedding na Fase 2.

---

## 4. Filosofia de Design JEV (Just Enough Validation)

- **Desempenho**: Renderização estática com revalidação dinâmica no Next.js App Router.
- **Payloads Leves**: Respostas de API contendo apenas os campos estritamente necessários para os agentes trabalharem.
- **Zero Lock-in**: Compatível com qualquer cliente de banco de dados PostgreSQL relacional ou vetorial.
