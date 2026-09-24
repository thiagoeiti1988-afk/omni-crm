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

#### `mcp.initialize`
Retorna os detalhes e capacidades do servidor.
- **Request**: `{ "jsonrpc": "2.0", "id": 1, "method": "mcp.initialize" }`
- **Response**: Retorna metadados `serverInfo` (`omni-crm-mcp`, v1.0.0).

#### `mcp.tools.list`
Lista todas as ferramentas disponíveis para os agentes chamarem.
- Ferramentas expostas:
  - `get_task_status`: Consulta o estado de uma tarefa pelo `taskId`.
  - `update_task_status`: Atualiza o status de uma tarefa.

---

## 4. Filosofia de Design JEV (Just Enough Validation)

- **Desempenho**: Renderização estática com revalidação dinâmica no Next.js App Router.
- **Payloads Leves**: Respostas de API contendo apenas os campos estritamente necessários para os agentes trabalharem.
- **Zero Lock-in**: Compatível com qualquer cliente de banco de dados PostgreSQL relacional ou vetorial.
