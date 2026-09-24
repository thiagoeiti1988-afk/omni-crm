# Omni-CRM: Hub Central Multivetorial para Agentes de IA

> **Status: protótipo (0.1.0).** README, SPEC e AGENTS descrevem o contrato alvo. O runtime atual tem Kanban estático e MCP mock — ver [`docs/AUDITORIA.md`](./docs/AUDITORIA.md) e [`docs/ROADMAP-0-100.md`](./docs/ROADMAP-0-100.md).

Omni-CRM é uma plataforma de gerenciamento e centralização de tarefas, projetos e memórias para múltiplos agentes de IA (Cursor, Codex, OpenClaw, Grok), com evolução prevista para CRM comercial (ICP, leads, copy).

Construído com Next.js (App Router), TypeScript, TailwindCSS e PostgreSQL (`pgvector`). O alvo é funcionar como **Servidor MCP** e painel Kanban ligado ao banco; isso ainda não está persistido.

---

## 🚀 Funcionalidades

- **MCP Server Integrado (`/api/mcp-server`)**: Permite que IDEs e agentes (como Cursor, Claude Code) leiam e atualizem tarefas diretamente via JSON-RPC.
- **RAG & Suporte a Vetores (`pgvector`)**: Armazena logs de execução de agentes vetorizados (embeddings 1536d) para permitir busca semântica do histórico de código e ações entre agentes.
- **Painel Kanban em Tempo Real**: Dashboard em Next.js com TailwindCSS otimizado para acompanhar o progresso das tarefas (*To Do*, *In Progress*, *Human Review*, *Done*).
- **Arquitetura JEV (Just Enough Validation)**: Foco em alta performance, minimalismo e zero paralisia por análise.

---

## 🛠️ Tecnologias

- **Framework**: Next.js 16 (React 19, App Router)
- **Estilização**: TailwindCSS
- **Linguagem**: TypeScript
- **Banco de Dados**: PostgreSQL com extensão `pgvector`
- **Protocolos**: Model Context Protocol (MCP) da Anthropic / Linux Foundation

---

## 🚦 Como Rodar o Projeto

### 1. Clonar e Instalar Dependências

```bash
git clone https://github.com/thiagoeiti1988-afk/omni-crm.git
cd omni-crm
npm install
```

### 2. Configurar o Banco de Dados

Execute o arquivo `schema.sql` no seu PostgreSQL / Supabase para habilitar o `pgvector` e criar as tabelas base.

```bash
psql -h <host> -U <user> -d <database> -f schema.sql
```

### 3. Rodar o Servidor de Desenvolvimento

```bash
npm run dev
```

Acesse [http://localhost:3000](http://localhost:3000) para visualizar o Dashboard Kanban.

---

## 🔌 Conectando Agentes de IA via MCP

Para conectar o **Cursor**, adicione no arquivo de configuração do MCP:

```json
{
  "mcpServers": {
    "omni-crm": {
      "url": "http://localhost:3000/api/mcp-server"
    }
  }
}
```

---

## 📄 Documentação Técnica

- [SPEC.md](./SPEC.md) — API, banco e arquitetura (contrato alvo).
- [AGENTS.md](./AGENTS.md) — plataformas, ciclo Quanta e papéis de agente.
- [docs/AUDITORIA.md](./docs/AUDITORIA.md) — o que é real, o que é risco, o que manter.
- [docs/ROADMAP-0-100.md](./docs/ROADMAP-0-100.md) — execução do kernel até o CRM de vendas.
- [agents/](./agents/) — playbooks `auditor`, `repair`, `icp`, `lead-capture`, `copywriter`.
