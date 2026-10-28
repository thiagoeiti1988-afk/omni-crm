# Mercado e posicionamento (out/2026)

Pesquisa de 27/10/2026 em fontes secundárias (blogs, imprensa, páginas de preço citadas por terceiros). **Nenhum preço foi confirmado na página oficial do fornecedor** — trate números como indicativos e confirme antes de usá-los em proposta.

## 1. Concorrência

| Concorrente | IA / agentes | MCP oficial | Entrada (indicativa) | Fraqueza para o nosso ICP |
| :--- | :--- | :--- | :--- | :--- |
| HubSpot (Breeze) | Customer e Prospecting Agents | Sim (GA abr/2026); escrita só com confirmação do usuário | créditos, ~US$10/1.000 | custo opaco, lock-in, pesado para PME |
| Salesforce Agentforce | agentes por ação/conversa | Sim (Enterprise+) | US$0,10/ação ou US$2/conversa + licença | caro e complexo para PME |
| Attio | Ask Attio, agentes por crédito | Sim, hospedado, OAuth | US$29–79/usuário | sem WhatsApp, LGPD ou PT-BR nativos |
| Pipedrive | AI Sales Assistant | Sim (jun/2026) | ~US$14/usuário | foco em pipeline, não em governança de agente |
| Folk · Twenty (OSS) | assistente / pouca IA | Sim | US$24 · US$9/usuário | CRM leve, sem forecast nem domínio de copy |
| Clay | enriquecimento e prospecção | Sim | US$185/mês | não é sistema de registro |
| Day.ai · Lightfield | CRM que se preenche sozinho | não verificado | não divulgado · ~US$89/mês | foco em startups dos EUA |
| RD Station CRM | copiloto no WhatsApp | não encontrado | grátis (4 usuários); R$65–118/usuário | IA como copiloto, sem trilha de aprovação |
| Kommo | "Kommo IA", até 3 agentes | não encontrado | US$20–30/usuário | preço em dólar |
| Ploomes · Moskit | IA como add-on | não encontrado | R$79–269 · R$89–179/usuário | WhatsApp por integração |

**Leitura:** MCP em CRM virou commodity entre os globais. Entre os brasileiros pesquisados, nenhum mostrou MCP. Ninguém trata como produto a pergunta "qual agente pode fazer o quê, e quem aprovou".

## 2. Preço por resultado (referências)

| Produto | Unidade cobrada | Valor reportado |
| :--- | :--- | :--- |
| Intercom Fin | resolução de atendimento | US$0,99 |
| HubSpot Customer Agent | conversa resolvida | US$0,50 (era US$1 por conversa) |
| HubSpot Prospecting Agent | lead recomendado | US$1,00 |
| Salesforce Agentforce | ação / conversa | US$0,10 / US$2 |
| 11x, Artisan (AI SDR) | assinatura por volume | US$7–120 mil/ano |

Outcome-based real existe em suporte; em vendas está começando (HubSpot por lead recomendado). AI SDRs ainda vendem assinatura.

## 3. Posicionamento do Omni-CRM

**"O CRM onde agentes trabalham e pessoas aprovam — e você paga pelo que fecha."**

Três diferenciais defensáveis, todos já no código:

1. **Governança de agentes como produto.** Papel amarrado à credencial; agente não fecha trabalho, não aprova peça, não move funil (`src/lib/auth.ts`). Cada decisão tem autor em `agent_logs`.
2. **LGPD by design + WhatsApp-first em PT-BR.** Base legal por lead, exportação e anonimização do titular, consentimento obrigatório na captura, ingestão oficial da Cloud API.
3. **Cobrança por resultado auditável.** O mesmo registro que prova a governança sustenta a fatura: só ação humana/harness gera evento, e cada evento é único. Difícil de copiar sem a camada de governança.

## 4. Modelo RESaaS sugerido

| Componente | Default no código | Racional |
| :--- | :--- | :--- |
| Plataforma | R$199/mês por org | cobre infra e suporte; abaixo de 2 licenças de RD Pro |
| Lead qualificado com consentimento | R$15 | abaixo do custo de um lead pago em ads B2B |
| Peça aprovada no Human Review | R$9 | trabalho de copy que deixa de ser feito à mão |
| Negócio ganho | R$99 | alinha preço com receita do cliente |

Tudo configurável por env (`OMNI_*_CENTS`). Antes de vender: validar disposição a pagar com 3–5 clientes do ICP e fechar em contrato a definição de cada evento.

**Risco de margem:** a Meta cobra por mensagem no WhatsApp e passou a cobrar chatbots de IA por uso (~R$0,33 por mensagem não padronizada, segundo imprensa). Quando houver envio outbound, esse custo entra no preço por resultado.

## 5. O que falta para competir (prioridade)

1. Envio outbound no WhatsApp da peça aprovada (hoje: inbound).
2. Postgres + Redis para multi-instância (alvo em `schema.sql`).
3. OAuth no MCP (exigido por diretórios de conectores).
4. Embeddings de vendor opcionais (hoje: lexical local).
5. Cobrança integrada (Stripe/Pagar.me) lendo `billable_events`.

## Fontes

[Pipedrive MCP](https://www.pipedrive.com/en/newsroom/pipedrive-launches-native-mcp-server-bringing-crm-workflows-directly-into-ai-assistants) · [Attio MCP](https://docs.attio.com/mcp/overview) · [Salesforce MCP](https://developer.salesforce.com/blogs/2025/10/salesforce-hosted-mcp-servers-are-in-beta-today) · [Agentforce pricing](https://www.eesel.ai/blog/agentforce-pricing) · [Fin US$0,99](https://dev.to/omar_bni_f6856a8bb0e021e9/intercom-fin-pricing-in-2026-the-real-math-behind-099-62j) · [Breeze pricing](https://www.eesel.ai/blog/hubspot-ai-agent-pricing-2026) · [11x/Artisan](https://www.11x.ai/guides/artisan-pricing) · [Kommo](https://www.kommo.com/br/blog/atualizacao-precos-kommo/) · [RD Station](https://www.rdstation.com/planos/crm/encontre-seu-plano-ideal/) · [Ploomes](https://pricingsaas.com/companies/ploomes) · [Lightfield](https://a16z.com/announcement/investing-in-lightfield/) · [Cade × Meta](https://startups.com.br/negocios/cade-manda-meta-suspender-regra-que-barra-chatbots-de-ia-no-whatsapp/) · [Meta cobra IA no WhatsApp](https://tecnoblog.net/noticias/meta-vai-cobrar-chatbots-de-ia-por-uso-do-whatsapp/)

Não verificado: todos os preços em fonte primária; MCP de Day.ai, Lightfield, Clay; dados do Agendor; existência de MCP em RD/Kommo/Ploomes/Moskit; situação atual da decisão do Cade.
