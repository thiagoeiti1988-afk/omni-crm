# Runbook — Omni-CRM em produção

## Subir pela primeira vez

1. `.env` a partir de `.env.example`:
   - `OMNI_SEED_DEMO=0`
   - `OMNI_BOOTSTRAP_ORG_NAME`, `OMNI_BOOTSTRAP_OWNER_EMAIL`, `OMNI_BOOTSTRAP_OWNER_PASSWORD` (≥ 10 caracteres)
   - `MCP_API_KEY`: `openssl rand -base64 36`
2. `docker compose up -d --build`
3. Proxy TLS na frente (Caddy: `reverse_proxy omni-crm:3000` já envia `X-Forwarded-For`; configure `header_up X-Real-IP {remote_host}`). Sem proxy, o rate limit por IP é contornável.
4. `curl https://SEU_DOMINIO/api/health` → `{"ok":true}`.
5. Entre como owner → **ICP** → preencha e **Salvar e aprovar** (copy só sai de ICP aprovado).
6. **Integrações**: copie o snippet do formulário para o site e a config MCP para os agentes.

O bootstrap só roda com o banco vazio. Remova as variáveis `OMNI_BOOTSTRAP_*` do `.env` depois do primeiro boot.

## Nova organização (cliente)

```bash
docker compose exec -e MCP_API_KEY="$MCP_API_KEY" omni-crm \
  node scripts/create-org.mjs "Empresa X" dona@empresax.com.br 'senha-inicial-forte'
```

A resposta traz as três chaves uma única vez.

## WhatsApp Cloud API

1. Meta for Developers → app → WhatsApp → Configuração → Webhook: `https://SEU_DOMINIO/api/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`. Assine o campo `messages`.
2. `WHATSAPP_APP_SECRET` = App Secret do app (valida `X-Hub-Signature-256`). Sem ele o endpoint responde 503 de propósito.
3. Owner → Integrações → `phone_number_id` do número. Mensagens de números não cadastrados são ignoradas (contadas em `ignored`).

## Backup e restauração

```bash
docker compose exec omni-crm node scripts/backup.mjs /data/backup-$(date +%F).sqlite
docker compose cp omni-crm:/data/backup-$(date +%F).sqlite ./backups/
```

`VACUUM INTO` é consistente com o app rodando e o script roda `integrity_check`. Agende diariamente e copie para fora do host.

Restaurar: pare o serviço, substitua `/data/omni-crm.sqlite` pelo backup (apague `-wal`/`-shm`), suba de novo. Migrações rodam sozinhas no boot (`PRAGMA user_version`).

## Incidentes

| Sintoma | Ação |
| :--- | :--- |
| Chave vazou | Owner → Integrações → **Rotacionar**. A antiga para na hora. Revise `agent_logs` com `action_type = SECURITY`. |
| Agente "fechou" algo indevido | Impossível com agent key (`done` exige harness/humano). Procure em `agent_logs` a credencial: `status … by harness:` ou `user:`. Reabra a Quanta como owner/closer. |
| Pedido de titular (LGPD) | Leads → **Exportar** (acesso) ou **Apagar** (eliminação). O apagamento remove PII, eventos e peças; mantém o evento faturável sem PII. |
| 429 em massa na captura | Confirme que o proxy envia `X-Real-IP`; sem ele todo mundo cai no mesmo balde. |
| Healthcheck falhando | `docker compose logs omni-crm`; cada linha tem `requestId`. `GET /api/health` com `db: down` = arquivo do banco inacessível ou volume cheio. |
| Copy só sai em template | `GET /api/health` → `llm:false` = sem `ANTHROPIC_API_KEY`. Com chave, procure `copywriter fallback to template` no log (recusa ou erro de API). |

## Faturamento

Owner/closer → **Faturamento** mostra o mês com extrato. Preços por env (`OMNI_PRICE_*_CENTS`, `OMNI_BASE_FEE_CENTS`). Cada evento é único por (org, tipo, referência): reprocessar ou clicar duas vezes não duplica cobrança.

## Escala

Uma instância aguenta o volume de PMEs (SQLite em WAL). Para mais de uma réplica: Postgres (`schema.sql`) e rate limit em Redis — `src/lib/store.ts` e `src/lib/security.ts` são os dois pontos de troca.
