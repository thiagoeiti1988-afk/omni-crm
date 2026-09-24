# AGENTS.md: Diretrizes de Integração de IA para o Omni-CRM

Este documento define os protocolos, comportamentos e padrões de chamada esperados para qualquer Agente de IA que interaja com o sistema **Omni-CRM**.

---

## 🤖 Agentes Suportados

1. **Cursor IDE / Claude Code**
   - Conexão via protocolo MCP (`/api/mcp-server`).
   - Papel: Leitura de tarefas, atualização de status (`in_progress`, `done`) e submissão de logs de código.
2. **OpenClaw / Harness Agents**
   - Conexão via Webhook REST (`/api/tasks`).
   - Papel: Execução assíncrona de tarefas de background, auditorias de segurança e builds.
3. **Grok Bot / Headless Agents**
   - Conexão via MCP ou REST.
   - Papel: Varredura de dados, sintese de relatórios e embeddings de conhecimento.

---

## 📡 Convenção de Status de Tarefas (Quanta)

Cada tarefa no Omni-CRM deve respeitar o seguinte ciclo de vida:

| Status | Descrição | Quem Atualiza |
| :--- | :--- | :--- |
| `todo` | Tarefa criada aguardando alocação | Humano / Agente Planejador |
| `in_progress` | Tarefa sob execução por um agente | Agente Executor (Cursor / Codex) |
| `in_review` | Bloqueado aguardando aprovação humana | Agente Executor ao concluir a lógica |
| `done` | Tarefa verificada e concluída | Humano / Harness Agent |

---

## 🧠 Protocolo de Registro de Logs & RAG

Sempre que um agente concluir uma alteração significativa, ele deve registrar um log na tabela `agent_logs` contendo:

- `agent_id`: Identificador único do agente (ex: `cursor-sonnet-3.5`).
- `action_type`: Tipo de ação (`CODE_COMMIT`, `REFACTOR`, `BUGFIX`, `ANALYSIS`).
- `log_content`: Resumo sucinto do que foi alterado.
- `embedding`: Vetor de 1536 dimensões (gerado via OpenAI Text-Embedding-3 ou similar) para habilitar buscas semânticas futuras por outros agentes.

---

## ⚡ Regras de Conduta para Agentes

1. **JEV (Just Enough Validation)**: Não realize refatorações desnecessárias em arquivos que não pertencem ao escopo da tarefa atual.
2. **Idempotência**: Todas as atualizações de status via MCP devem ser idempotentes.
3. **Preservação de Contexto**: Registre logs detalhados para evitar que o próximo agente retrabalhe o código existente.
