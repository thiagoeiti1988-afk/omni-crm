# AGENTS.md: Diretrizes de Integração de IA para o Omni-CRM

Este documento define os protocolos, comportamentos e padrões de chamada esperados para qualquer Agente de IA que interaja com o sistema **Omni-CRM**.

**Estado do runtime (0.1.0):** MCP oficial (`initialize` / `tools/list` / `tools/call`) persiste no SQLite, Kanban lê o banco, captura de lead e copy com Human Review estão ligados. Auditoria do pack original: [`docs/AUDITORIA.md`](./docs/AUDITORIA.md). Roadmap: [`docs/ROADMAP-0-100.md`](./docs/ROADMAP-0-100.md). Playbooks: [`agents/`](./agents/).

O Omni-CRM tem dois domínios que **não** devem ser fundidos num único status:

| Domínio | Unidade | Status |
| :--- | :--- | :--- |
| Engenharia / agentes (kernel) | Quanta (`tasks`) | `todo` → `in_progress` → `in_review` → `done` |
| Vendas (ainda não no schema) | Lead / copy | funil comercial + Human Review da peça |

---

## 🤖 Agentes Suportados

### Plataformas (transporte)

1. **Cursor IDE / Claude Code**
    - Conexão via protocolo MCP (`/api/mcp-server`).
   - Papel: Leitura de tarefas, atualização de status (`in_progress`, `in_review`) e submissão de logs de código.
2. **OpenClaw / Harness Agents**
    - Conexão via Webhook REST (`/api/tasks`).
   - Papel: Execução assíncrona de tarefas de background, auditorias de segurança e builds.
3. **Grok Bot / Headless Agents**
    - Conexão via MCP ou REST.
   - Papel: Varredura de dados, síntese de relatórios e embeddings de conhecimento.

### Papéis de produto (playbooks)

| Agente | Arquivo | Papel |
| :--- | :--- | :--- |
| `auditor` | [`agents/auditor.md`](./agents/auditor.md) | Spec vs código, segurança, drift de docs |
| `repair` | [`agents/repair.md`](./agents/repair.md) | Ligar MCP oficial ↔ banco ↔ UI; auth; testes |
| `icp` | [`agents/icp.md`](./agents/icp.md) | Público-alvo por projeto de venda |
| `lead-capture` | [`agents/lead-capture.md`](./agents/lead-capture.md) | Ingestão e dedupe de leads |
| `copywriter` | [`agents/copywriter.md`](./agents/copywriter.md) | Peças com Human Review |

Ordem obrigatória: **auditor → repair (P0)** antes de icp / lead-capture / copywriter.

---

## 📡 Convenção de Status de Tarefas (Quanta)

Cada tarefa no Omni-CRM deve respeitar o seguinte ciclo de vida:

| Status | Descrição | Quem Atualiza |
| :--- | :--- | :--- |
| `todo` | Tarefa criada aguardando alocação | Humano / Agente Planejador |
| `in_progress` | Tarefa sob execução por um agente | Agente Executor (Cursor / Codex) |
| `in_review` | Bloqueado aguardando aprovação humana | Agente Executor ao concluir a lógica (**não** marcar `done` sozinho) |
| `done` | Tarefa verificada e concluída | Humano / Harness Agent após review |

O executor **não** transiciona `in_review` → `done`. Isso evita dois agentes fecharem o mesmo Quanta e alinha SPEC com este arquivo.

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
