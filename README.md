# Omni-CRM

**CRM de vendas com governança de agentes de IA.** Agentes (Claude Code, Cursor, automações) captam, qualificam e escrevem; pessoas aprovam; tudo fica auditável — e a cobrança é por resultado comprovado.

> Status `0.1.0` · produção em instância única (SQLite). 41 testes unitários + 18 E2E em browser real. Ver [docs/ROADMAP-0-100.md](./docs/ROADMAP-0-100.md).

## Por que existe

CRMs com IA já expõem MCP (HubSpot, Attio, Salesforce, Pipedrive). O que nenhum resolve bem é **quem pode o quê**: um agente que escreve a mensagem não pode ser o mesmo que aprova o envio, move o negócio para "ganho" ou gera cobrança. O Omni-CRM faz disso o produto. Análise completa: [docs/MERCADO.md](./docs/MERCADO.md).

## O que funciona hoje

| Área | O que faz |
| :--- | :--- |
| **Governança** | Papel amarrado à credencial (agent key, harness key, sessão humana, master). Agente move Quanta até `in_review`, nunca `done`; não aprova copy/ICP, não move funil, não fatura. Matriz em `src/lib/auth.ts`. |
| **Painel humano** | Login e-mail/senha (scrypt, cookie httpOnly, CSRF por Origin), papéis **owner / closer / copy**. Operação, funil, leads, Quantas, Human Review, ICP, memória, agentes, faturamento, integrações. |
| **Human Review** | Peça mostrada no formato do canal (balão de WhatsApp, e-mail com assunto) e com as fontes. Teclado: **A** aprova, **R** rejeita, **J/K** navega, **U** desfaz nos 5 s antes de ir ao servidor. Aviso "N peças aguardando você" no topo. |
| **MCP** | Streamable HTTP (JSON), versões `2024-11-05` a `2025-11-25`, 14 tools. Testado com o cliente oficial `@modelcontextprotocol/sdk`. |
| **Captação** | Formulário público embutível (funciona sem JS, honeypot, rate limit, consentimento obrigatório), WhatsApp Cloud API (webhook assinado, dedupe de reentrega), importação CSV de RD/Ploomes/Kommo. |
| **LGPD** | Base legal por lead (`consent`, `inbound_contact`, `import`), exportação (art. 18, II) e anonimização (art. 18, VI) do titular. |
| **Copy** | Gerada de ICP aprovado + memória, com citações. Rascunho pelo agente via MCP, por Claude (opcional) ou template. Sempre cai em Human Review. |
| **RESaaS** | Faturamento por evento auditável e idempotente: lead qualificado com consentimento, peça aprovada, negócio ganho. Extrato com o que foi cobrado, referente a quê e quem decidiu; barras por dia. Preços por env. |
| **Operação** | Request id, log JSON por request, healthcheck real, rate limit, CAS em transição de status, backup online, imagem Docker não-root. |

## Rodar

```bash
npm install
cp .env.example .env
npm run dev            # http://localhost:3000
```

Demo (seed automático): `owner@acme.demo`, `closer@acme.demo`, `copy@acme.demo`, `owner@beta.demo` — senha `omni-demo-2026`. A tela de login tem atalhos.

### Produção (Docker)

```bash
cp .env.example .env   # OMNI_SEED_DEMO=0 + OMNI_BOOTSTRAP_* + MCP_API_KEY forte
docker compose up -d --build
```

Coloque atrás de um proxy TLS que defina `X-Real-IP`. Passo a passo, backup, rotação de chaves e incidentes: [docs/RUNBOOK.md](./docs/RUNBOOK.md).

### Conectar um agente (MCP)

Pegue a chave de agente em **Integrações** (owner) e:

```bash
claude mcp add --transport http omni-crm https://SEU_DOMINIO/api/mcp-server \
  --header "Authorization: Bearer <agent key>"
```

Cursor: `{"mcpServers":{"omni-crm":{"url":"https://SEU_DOMINIO/api/mcp-server","headers":{"Authorization":"Bearer <agent key>"}}}}`

## Testes

```bash
npm test                                   # 43 unitários (store, RBAC, LGPD, CSV, WhatsApp, MCP, copywriter)
npm run build && npx playwright test       # 19 E2E: browser real + HTTP + cliente MCP oficial
npm run verify                             # tudo, na ordem do CI
npm run simulate                           # roteiro da demo contra um servidor rodando (agente + harness via MCP)
```

Teste simulado, prompt para pedir a um agente (Cursor, Claude Code) testar e telas: [docs/TESTES.md](./docs/TESTES.md).

Em ambiente com Chromium pré-instalado de outra versão: `E2E_CHROMIUM_PATH=/caminho/chrome npx playwright test`.

## Limites conhecidos (honestos)

- **Instância única.** SQLite + rate limit em memória. Escala horizontal exige Postgres (o alvo está em `schema.sql`) e Redis.
- **Embeddings locais** (`hash-bow-1536`): busca lexical, não semântica de vendor.
- **WhatsApp só inbound.** Envio de mensagem aprovada pela Cloud API é o próximo passo.
- **MCP sem OAuth** — Bearer por org. Suficiente para Claude Code/Cursor; OAuth é exigido para conectores de diretório.

## Documentação

[SPEC.md](./SPEC.md) (API e schema) · [AGENTS.md](./AGENTS.md) (protocolo para agentes) · [docs/RUNBOOK.md](./docs/RUNBOOK.md) · [docs/TESTES.md](./docs/TESTES.md) · [docs/MERCADO.md](./docs/MERCADO.md) · [docs/AUDITORIA.md](./docs/AUDITORIA.md) · [docs/ROADMAP-0-100.md](./docs/ROADMAP-0-100.md)
