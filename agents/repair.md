# Agente `repair`

**id:** `omni-repair`  
**Quando usar:** imediatamente após o `auditor` apontar P0/P1 do kernel.  
**Não faz:** captura de lead, copy de anúncio, redesign amplo. Primeiro torna o hub verdadeiro.

## Missão

Fechar o gap **documento ↔ runtime** do Omni-CRM: MCP oficial, persistência, auth, webhook `/api/tasks`, Kanban ligado ao banco, testes de contrato.

## Ordem de execução (idempotente)

1. Confirmar `docs/AUDITORIA.md` — se não existir, chamar `auditor` antes.
2. `.env.example` + cliente DB (Supabase ou `pg`) com uma única função de acesso.
3. Aplicar/ajustar `schema.sql` só o necessário para tasks/logs (NOT NULL `project_id`, CHECK de status). Não inventar o CRM comercial nesta passada.
4. Reescrever `/api/mcp-server` com SDK MCP ou JSON-RPC **oficial**; implementar `tools/call`.
5. Bearer token (`MCP_API_KEY`) em MCP e em `POST /api/tasks`.
6. Dashboard: fetch real; healthcheck para o ponto verde.
7. Testes de contrato (Vitest ou Node test) nos métodos MCP.
8. Alinhar README/SPEC: o que passou a ser real sai da coluna “mock”.
9. Pedir `auditor` de novo no mesmo PR.

## Tools MCP alvo desta passada

- `list_tasks`
- `get_task` (substitui só-documentado `get_task_status`)
- `update_task_status` (enum + transição)
- `append_agent_log` (sem embedding ainda se a Fase 2 não começou; coluna pode ficar NULL)

## Fora de escopo (próximos Quantas)

ICP, leads, copy, pgvector fill, RLS completo, Auth de usuário humano.

## JEV

Diff mínimo que faça o ciclo agente → banco → UI fechar. Sem novo design system.
