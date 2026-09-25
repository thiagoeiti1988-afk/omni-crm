# Omni-CRM: Hub de agentes + CRM de vendas

> **Status: 0.1.0 runtime real (SQLite).** Kanban, MCP, leads, ICP e copy leem/gravam o mesmo banco. Postgres/`pgvector` está no `schema.sql` para migração; o processo local usa `node:sqlite`.

Omni-CRM junta **orquestração de agentes** (Quanta / Kanban / MCP) com **domínio comercial** (organização, pipeline, ICP, lead, copy com Human Review), **console de operação** (funil, atribuição de canal, valor esperado, tendência linear/parabólica) e **memória vetorial** para busca entre agentes.

---

## O que está implementado

- MCP JSON-RPC 2.0 em `POST /api/mcp-server`: `initialize`, `tools/list`, `tools/call`, `ping` (aliases `mcp.*` ainda respondem).
- Auth obrigatória: `Authorization: Bearer <org api key>`. Writes sem token → 401.
- Tenancy: duas orgs seed (`Acme` / `Beta`) isoladas.
- Kanban = tabela `tasks` (counts reais; ponto MCP verde só com `/api/health`).
- `POST /api/tasks` webhook de status (mesmo contrato de transição).
- Captura `POST /api/leads` com consentimento e dedupe por e-mail.
- Copy `POST /api/copy` a partir de ICP aprovado + memória; revisão humana.
- Console Ops: funil, EV por canal, série 14d com ajuste linear e parabólico, próxima jogada, hook `POST /api/agents/run` / tools `get_insights` + `run_ops_agent`.
- Testes: `npm test`.

## O que ainda não é produção SaaS

- Auth de usuário (e-mail/senha) — hoje a UI usa API keys de demo.
- Postgres vivo + RLS no Supabase (schema preparado, runtime SQLite).
- Embeddings de vendor (OpenAI); o RAG local é hash bag-of-words 1536d.
- Transporte MCP Streamable HTTP/SSE do SDK; o Cursor deve POSTar JSON-RPC com Bearer.

---

## Tecnologias

- Next.js 16, React 19, Tailwind 4, TypeScript
- Persistência: SQLite (`node:sqlite`) · alvo: PostgreSQL + pgvector (`schema.sql`)
- MCP JSON-RPC 2.0

---

## Como rodar

```bash
git clone https://github.com/thiagoeiti1988-afk/omni-crm.git
cd omni-crm
npm install
cp .env.example .env
npm test
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000). Troque a org no seletor (Acme vs Beta) para ver isolamento.

Chaves de demo (seed automático):

| Org | Bearer |
| :--- | :--- |
| Acme Vendas | `omni_org_acme_demo` |
| Beta Labs | `omni_org_beta_demo` |

Headers extras: `X-Actor-Role: agent|human|harness`, `X-Agent-Id: ...`.  
`done` e aprovação de copy só com `human` ou `harness`.

### MCP (Cursor)

```json
{
  "mcpServers": {
    "omni-crm": {
      "url": "http://localhost:3000/api/mcp-server",
      "headers": {
        "Authorization": "Bearer omni_org_acme_demo",
        "X-Actor-Role": "agent",
        "X-Agent-Id": "cursor-agent"
      }
    }
  }
}
```

Exemplo:

```bash
curl -s http://localhost:3000/api/mcp-server \
  -H 'Authorization: Bearer omni_org_acme_demo' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

---

## Documentação

- [SPEC.md](./SPEC.md) — API, schema, tools
- [AGENTS.md](./AGENTS.md) — ciclo Quanta e papéis
- [docs/AUDITORIA.md](./docs/AUDITORIA.md) — leitura do pack original
- [docs/ROADMAP-0-100.md](./docs/ROADMAP-0-100.md) — critérios de 100%
- [agents/](./agents/) — auditor, repair, icp, lead-capture, copywriter
