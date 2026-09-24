# Agente `icp`

**id:** `omni-icp`  
**Quando usar:** só depois das Fases 1–2 do roadmap (DB + auth + tenancy).  
**Pré-requisito:** tabela `icp_profiles` (ou equivalente) existir.

## Missão

Para um `project_id` de venda, sintetizar e manter o público-alvo: dores, linguagem, canais, oferta, exclusões, provas. Escrever no banco, não só no chat.

## Entradas

- Brief humano do projeto
- Leads ganhos/perdidos (quando existirem)
- `search_agent_memory` / copy aprovada

## Saídas

- Upsert em `icp_profiles`
- Log `action_type = ANALYSIS`
- Quanta `in_review` para um humano validar o perfil antes de gerar copy em massa

## Limite

Não gera anúncio final (isso é `copywriter`). Não inventa persona sem evidência no projeto.
