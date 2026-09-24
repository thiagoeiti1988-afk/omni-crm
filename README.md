# Omni-CRM: Hub Central Multivetorial para Agentes de IA

Omni-CRM é uma plataforma de gerenciamento e centralização de tarefas, projetos e memórias para múltiplos agentes de IA (Cursor, Codex, OpenClaw, Grok). 

Construído com Next.js 15 (App Router), TypeScript, TailwindCSS e PostgreSQL (`pgvector`), o Omni-CRM funciona como um **Servidor MCP (Model Context Protocol)** e um painel visual Kanban E2E.

---

## 🚀 Funcionalidades

- **MCP Server Integrado (`/api/mcp-server`)**: Permite que IDEs e agentes (como Cursor, Claude Code) leiam e atualizem tarefas diretamente via JSON-RPC.
- **RAG & Suporte a Vetores (`pgvector`)**: Armazena logs de execução de agentes vetorizados (embeddings 1536d) para permitir busca semântica do histórico de código e ações entre agentes.
- **Painel Kanban em Tempo Real**: Dashboard em Next.js com TailwindCSS otimizado para acompanhar o progresso das tarefas (*To Do*, *In Progress*, *Human Review*, *Done*).
- **Arquitetura JEV (Just Enough Validation)**: Foco em alta performance, minimalismo e zero paralisia por análise.

---

## 🛠️ Tecnologias

- **Framework**: Next.js 15 (React 19, App Router)
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

- Consulte [SPEC.md](./SPEC.md) para especificações de API, banco de dados e arquitetura.
- Consulte [AGENTS.md](./AGENTS.md) para diretrizes de integração de cada plataforma de IA.
