# Auditoria Omni-CRM (IntHub)

**Data:** 2026-09-24  
**Escopo:** repositório `thiagoeiti1988-afk/omni-crm` (pack README + AGENTS + SPEC + protótipo Next.js)  
**Objetivo desta leitura:** separar o que o pack promete, o que o código realmente faz, o que é risco agora, o que já é infraestrutura útil, e o que falta para o produto de vendas (ICP, lead, copy) ir de 0 a 100.

---

## 1. Veredito em uma frase

O repositório é um **protótipo de control plane para agentes de IA** (Kanban + MCP + pgvector), **não** um CRM de vendas. A documentação está à frente do código; o código ainda é mock. Dá para evoluir, mas o produto comercial (público-alvo, captação, copy) ainda não tem modelo de dados nem fluxo.

**Maturidade atual (honesta):**

| Camada | Score | Notas |
| :--- | :--- | :--- |
| Documentação de intenção (README / SPEC / AGENTS) | 65/100 | Clara, mas descreve um sistema ainda não implementado |
| Código executável | 15/100 | UI estática; MCP mock; SDK e Supabase não usados |
| Segurança / multi-tenant | 5/100 | Endpoint aberto, sem auth, sem RLS, sem tenancy |
| Produto CRM de vendas (leads / ICP / copy) | 0/100 | Fora do schema e da UI |
| Pronto para piloto com cliente | 10/100 | Só demo visual |

---

## 2. O que o pack descreve vs. o que existe

| Promessa (README / SPEC / AGENTS) | Realidade no código |
| :--- | :--- |
| Next.js 15 + Kanban E2E em tempo real | Next **16.3.5**; Kanban **hardcoded** em `src/app/page.tsx` |
| MCP Server em `/api/mcp-server` | POST mock JSON-RPC; **não** usa `@modelcontextprotocol/sdk` |
| Ferramentas `get_task_status` / `update_task_status` | Apenas listadas; **não há `tools/call`** nem persistência |
| RAG com embeddings 1536d em `agent_logs` | Tabela no `schema.sql`; **nenhum pipeline** gera embedding |
| Webhook REST `/api/tasks` (OpenClaw / Harness) | **Rota inexistente** |
| PostgreSQL / Supabase | Dependência `@supabase/supabase-js` instalada e **nunca importada**; sem `.env.example` |
| Painel “MCP Server: Online” | Indicador **estático** (sempre verde) |
| Metadata do app | Ainda “Create Next App” em `layout.tsx` |

Commits no `master`: scaffold Create Next App → feat do motor mock → docs do pack. Isso confirma o papel do IntGravity: **subir o envelope** (docs + casca), não o produto.

---

## 3. Pontos mais sensíveis (corrigir agora)

Ordenados por dano se alguém ligar isso em produção ou em um agente de verdade.

### P0 — Bloqueiam uso real

1. **MCP incompatível com o protocolo**  
   O SPEC e o route usam `mcp.initialize` e `mcp.tools.list`. O MCP oficial (e o Cursor) falam `initialize`, `tools/list`, `tools/call`, `notifications/initialized`. Um cliente MCP padrão **não conecta**.  
   Arquivo: `src/app/api/mcp-server/route.ts`.

2. **MCP sem persistência e sem `tools/call`**  
   O endpoint não lê `tasks`, não atualiza status, não grava `agent_logs`. AGENTS.md manda agentes marcarem `in_progress` / `done` — isso é **teatro** até existir o método de chamada.

3. **Superfície HTTP sem autenticação**  
   Qualquer POST em `/api/mcp-server` seria aceito. Quando o mock virar banco, isso vira escrita arbitrária de status (e, depois, PII de leads). Precisa de API key / JWT **antes** de ligar o Postgres.

4. **Nome “CRM” sem domínio de cliente**  
   Não existem `contacts`, `leads`, `companies`, `pipelines`, `campaigns`, `copy_assets`, `icp_profiles`. Sem isso, o produto de vendas pedido (entender público, captar lead, gerar copy) **não tem onde viver**.

5. **Documentação afirma capacidades que o código não tem**  
   README (“tempo real”, “interfaces with Supabase”), badge Online, versão 1.0.0 no `serverInfo` vs `package.json` 0.1.0. Agentes e humanos vão assumir um sistema pronto e falhar.

### P1 — Quebram o caminho até um piloto

6. **Schema sem invariantes**  
   `tasks.project_id` é nullable; `status` e `platform` são TEXT livres (sem CHECK); sem UNIQUE de negócio; sem `updated_at` trigger. Lixo entra fácil.

7. **Sem Row Level Security / tenancy**  
   CRM de vários projetos de vendas precisa de `org_id` / `workspace_id`. `schema.sql` é single-tenant implícito. No Supabase isso é obrigatório antes de expor a API.

8. **Índice HNSW em coluna que começa nula**  
   `agent_logs.embedding` é opcional, mas o índice HNSW já é criado. Sem política de “só indexar vetores preenchidos” e sem job de embed, RAG vira custo vazio + queries quebradas.

9. **AGENTS.md vs SPEC no ciclo `done`**  
   AGENTS: `done` = humano / Harness. SPEC: executor atualiza status incluindo `done`. Sem regra única, dois agentes vão pisar no mesmo Quanta.

10. **Zero testes, zero CI, zero `.env.example`**  
    `npm run lint` existe; não há testes, workflow GitHub, seed, nem variáveis `DATABASE_URL` / `SUPABASE_*` / `OPENAI_API_KEY` documentadas.

11. **Erro JSON-RPC fora do envelope**  
    O `catch` devolve `{ error: 'Invalid Request' }` com HTTP 400, sem `jsonrpc`/`id`/`code`. Clientes MCP tratam isso como transporte morto.

### P2 — Dívida que explode na evolução

12. Dependências mortas (`@modelcontextprotocol/sdk`, `@supabase/supabase-js`) aumentam superfície de supply-chain sem benefício.  
13. UI sem acessibilidade (Kanban só visual, sem teclado/DnD real, `lang="en"` num produto PT).  
14. Sem observabilidade (logs estruturados, request id, métricas de tool call).  
15. Embeddings fixos em 1536 amarram o vendor (OpenAI ada/3-small). Precisa de `embedding_model` + dimensão configurável.  
16. Sem LGPD: base legal, consentimento, retenção, direito de exclusão — inaceitável assim que entrar lead real.

---

## 4. Infraestrutura positiva (manter de propósito)

Estas escolhas **não** são acidentes. Valem como fundação se o produto for um hub, não um CRM monolítico genérico.

1. **Três camadas desacopladas (UI → MCP/API → Postgres+pgvector)**  
   Caminho certo para SaaS de agentes: o Kanban é um cliente; o contrato é o protocolo.

2. **Quanta (tarefa) como unidade de trabalho**  
   Status `todo → in_progress → in_review → done` é um ciclo operacional claro para Cursor / Codex / Grok / Harness. Serve de **orquestração**; o funil de vendas deve ser **outra** máquina de estados ao lado, não no lugar.

3. **`agent_logs` + embedding como memória compartilhada**  
   A ideia de RAG entre agentes evita retrabalho. É o diferencial vs. um CRM comum. Manter; só implementar de verdade (gerar vetor no write, buscar no read).

4. **JEV (Just Enough Validation)**  
   Bom para não paralisar agentes. Ruim se for desculpa para pular auth e invariantes. A regra correta: JEV no **payload de ferramenta**; rigor no **tenant, auth e PII**.

5. **Stack TypeScript strict + Next App Router + Tailwind**  
   Adequada para um painel SaaS e rotas MCP no mesmo deploy. Não precisa trocar de framework agora.

6. **Pack de docs (README + SPEC + AGENTS + CLAUDE.md)**  
   Onboarding de agente já existe. Falta honestidade de status (`prototype`) e contratos executáveis (OpenAPI / JSON Schema das tools).

7. **pgvector + HNSW cosine**  
   Escolha correta para busca semântica de logs/copy/ICP. Evoluir para índices parciais e modelo versionado, não abandonar.

8. **Idempotência declarada nas regras de agente**  
   Essencial quando vários executores atualizam o mesmo Quanta. Precisa virar `If-Match` / `updated_at` no banco, não só texto.

---

## 5. Desalinhamento de produto (o pedido vs. o repo)

Pedido de negócio: **entender público-alvo, captar lead, gerar copy para o cliente final**, em um contexto de vários projetos de venda.

O que o IntHub subiu: **orquestrador de agentes de código**.

Isso não é erro fatal — é um **kernel**. O CRM comercial deve sentar **em cima** desse kernel:

```
[ Captura (forms, WhatsApp, ads) ]
        ↓
[ Leads + ICP + Empresas ]  ← domínio vendas (ainda não existe)
        ↓
[ Quanta / tasks para agentes ] ← já esboçado
        ↓
[ Copy, playbooks, RAG ]      ← agent_logs é o germe
        ↓
[ Kanban humano + MCP ]
```

Se o time tratar Omni-CRM só como Jira de agentes, o comercial nunca nasce. Se tratar só como Pipedrive, perde o diferencial (agentes + memória vetorial).

---

## 6. Agentes que devem existir daqui para frente

Definidos em `AGENTS.md` e em `agents/*.md`:

| Agente | Papel | Quando chamar |
| :--- | :--- | :--- |
| `auditor` | Spec vs código, segurança, drift de docs | Todo PR e todo “está pronto?” |
| `repair` | Ligar MCP ↔ DB, auth, testes, fechar P0 | Imediatamente após esta auditoria |
| `icp` | Perfis de público-alvo por projeto de venda | Depois do schema comercial |
| `lead-capture` | Ingestão e scoring de leads | Depois de auth + tenancy |
| `copywriter` | Peças a partir de ICP + lead + memória RAG | Depois de RAG mínimo |

Não subir agente de copy/lead **antes** de `repair` fechar persistência e auth: geraria PII em um POST aberto.

---

## 6.1 Addendum — Fase 1 (`repair`) executada

Este PR fechou o kernel:

- MCP fala protocolo oficial (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) — `mcp.initialize`/`mcp.tools.list` foram removidos.
- `tools/call` persiste de verdade: `list_tasks`, `get_task`, `update_task_status`, `append_agent_log` (Supabase, sem embedding ainda).
- `update_task_status` via agente **não aceita `done`** (matriz de transição em `src/lib/db.ts`); só `POST /api/tasks` (Harness/OpenClaw) fecha o Quanta.
- Bearer auth (`MCP_API_KEY`) em ambas as rotas, fail-closed: sem a env var, tudo é 401/503 — nunca "modo aberto".
- `schema.sql`: `tasks.project_id NOT NULL`, `CHECK` de status, trigger `updated_at`.
- Kanban é Server Component lendo `tasks`; indicador "Online" reflete healthcheck real, não mais estático.
- Testes de contrato (`npm test`, `node:test` via `tsx`): initialize, tools/list, tools/call, transição ilegal, `done` bloqueado para agente, method desconhecido, auth (sem env, sem header, token errado, token certo).

**Ainda não fechado nesta passada (fora de escopo do `repair`, conforme `agents/repair.md`):** tenancy/RLS, pipeline de embedding, domínio comercial (ICP/leads/copy), CI, auth de usuário humano no painel — seguem no roadmap Fase 2+.

---

## 7. Recomendação de execução

1. Congelar o discurso de “v1.0.0 / MCP Online” até `tools/call` persistir de verdade.  
2. Rodar o agente `repair` nos P0 (protocolo MCP, DB, auth, webhook `/api/tasks`).  
3. Expandir o schema com o domínio comercial (org, lead, ICP, copy) sem jogar fora `projects/tasks/agent_logs`.  
4. Só então ligar captura e geração de copy, com LGPD e RLS.

Detalhamento faseado: [`ROADMAP-0-100.md`](./ROADMAP-0-100.md).
