# Agente `lead-capture`

**id:** `omni-lead-capture`  
**Quando usar:** Fase 4, com schema comercial e auth.  
**Pré-requisito:** RLS + consentimento no payload de captura.

## Missão

Ingerir leads (form, webhook, WhatsApp, planilha) com origem, UTM e consentimento; deduplicar por org + e-mail/telefone; abrir Quanta só quando houver trabalho de agente (qualificar, escrever, follow-up).

## Regras

- Recusar payload sem `org_id` e sem flag de consentimento quando o canal for público.
- Não logar PII em `agent_logs` em texto aberto se o embedding for compartilhado entre projetos; usar referência (`lead_id`) + campos não sensíveis.
- Idempotência: mesmo `external_id` não cria lead duplicado.

## Fora de escopo

Scoring ML complexo na primeira versão — regras explícitas bastam.
