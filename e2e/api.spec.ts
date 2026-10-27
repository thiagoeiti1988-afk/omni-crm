import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { E2E_ENV } from "../playwright.config";
import { apiLogin, uniq } from "./helpers";

test.describe("MCP com o cliente oficial (@modelcontextprotocol/sdk)", () => {
  test("conecta, lista tools, chama e respeita a governança", async ({ baseURL }) => {
    const transport = new StreamableHTTPClientTransport(new URL("/api/mcp-server", baseURL), {
      requestInit: { headers: { Authorization: "Bearer omni_org_acme_demo", "X-Agent-Id": "e2e-sdk-agent" } },
    });
    const client = new Client({ name: "omni-e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("omni-crm-mcp");
      expect(client.getInstructions()).toContain("Human Review");

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["list_tasks", "update_task_status", "upsert_lead", "create_copy_job", "update_lead_stage"]) {
        expect(names).toContain(n);
      }

      const listed = await client.callTool({ name: "list_tasks", arguments: {} });
      const tasks = (listed.structuredContent as { items: Array<{ id: string; status: string }> }).items;
      expect(tasks.length).toBeGreaterThan(0);

      // Agente não fecha Quanta, mesmo pedindo.
      const inReview = tasks.find((t) => t.status === "in_review")!;
      const done = await client.callTool({ name: "update_task_status", arguments: { taskId: inReview.id, status: "done" } });
      expect(done.isError).toBe(true);

      // Agente capta e escreve a própria peça; ela entra em Human Review.
      const lead = await client.callTool({
        name: "upsert_lead",
        arguments: { projectId: "proj-acme-outbound", name: "Lead do Agente", email: `${uniq("ag")}@x.com`, source: "form", consent: true },
      });
      const leadId = (lead.structuredContent as { id: string }).id;
      const copy = await client.callTool({
        name: "create_copy_job",
        arguments: { projectId: "proj-acme-outbound", leadId, channel: "whatsapp", title: "Oi", body: "Escrito pelo agente via MCP" },
      });
      expect((copy.structuredContent as { status: string }).status).toBe("in_review");

      // Agente não move funil (não fatura sozinho).
      const won = await client.callTool({ name: "update_lead_stage", arguments: { leadId, stage: "won" } });
      expect(won.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("sem Bearer é 401; GET com SSE é 405; notificação é 202", async ({ request }) => {
    const unauth = await request.post("/api/mcp-server", { data: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(unauth.status()).toBe(401);
    const sse = await request.get("/api/mcp-server", { headers: { Accept: "text/event-stream" } });
    expect(sse.status()).toBe(405);
    const note = await request.post("/api/mcp-server", {
      headers: { Authorization: "Bearer omni_org_acme_demo" },
      data: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(note.status()).toBe(202);
    expect(note.headers()["x-request-id"]).toBeTruthy();
  });

  test("header X-Actor-Role forjado não promove a agent key", async ({ request }) => {
    const res = await request.post("/api/tasks", {
      headers: { Authorization: "Bearer omni_org_acme_demo", "X-Actor-Role": "harness" },
      data: { taskId: "task-org-acme-3", status: "done" },
    });
    expect(res.status()).toBe(403);
  });

  test("master key (operador) exige X-Org-Id", async ({ request }) => {
    const noOrg = await request.get("/api/state", { headers: { Authorization: `Bearer ${E2E_ENV.MCP_API_KEY}` } });
    expect(noOrg.status()).toBe(401);
    const ok = await request.get("/api/state", {
      headers: { Authorization: `Bearer ${E2E_ENV.MCP_API_KEY}`, "X-Org-Id": "org-beta" },
    });
    expect((await ok.json()).org.name).toBe("Beta Labs");
  });
});

test.describe("WhatsApp Cloud API webhook", () => {
  const sign = (body: string) => `sha256=${createHmac("sha256", E2E_ENV.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
  const payload = (msgId: string, from: string) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "100000000000001" },
                contacts: [{ profile: { name: "Cliente WhatsApp" }, wa_id: from }],
                messages: [{ from, id: msgId, timestamp: "1730000000", type: "text", text: { body: "Oi, quero orçamento" } }],
              },
            },
          ],
        },
      ],
    });

  test("handshake de verificação", async ({ request }) => {
    const ok = await request.get(
      `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${E2E_ENV.WHATSAPP_VERIFY_TOKEN}&hub.challenge=4242`,
    );
    expect(await ok.text()).toBe("4242");
    const bad = await request.get("/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1");
    expect(bad.status()).toBe(403);
  });

  test("rejeita assinatura inválida; aceita válida e deduplica reentrega", async ({ request }) => {
    const from = `55119${Date.now().toString().slice(-8)}`;
    const body = payload(`wamid.${from}`, from);
    const forged = await request.post("/api/webhooks/whatsapp", {
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef" },
      data: body,
    });
    expect(forged.status()).toBe(401);

    const first = await request.post("/api/webhooks/whatsapp", {
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      data: body,
    });
    expect(await first.json()).toMatchObject({ ok: true, processed: 1, duplicates: 0 });
    const again = await request.post("/api/webhooks/whatsapp", {
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
      data: body,
    });
    expect(await again.json()).toMatchObject({ processed: 0, duplicates: 1 });

    const state = await request.get("/api/state", { headers: { Authorization: "Bearer omni_org_acme_demo" } });
    const leads = (await state.json()).leads as Array<{ phone: string; consentBasis: string; source: string }>;
    const lead = leads.find((l) => l.phone === `+${from}`);
    expect(lead).toMatchObject({ source: "whatsapp", consentBasis: "inbound_contact" });
  });
});

test.describe("captura pública", () => {
  test("CORS, honeypot, consentimento obrigatório e chave inválida", async ({ request }) => {
    const pre = await request.fetch("/api/capture", { method: "OPTIONS", headers: { Origin: "https://site-do-cliente.com" } });
    expect(pre.status()).toBe(204);
    expect(pre.headers()["access-control-allow-origin"]).toBe("*");

    const bot = await request.post("/api/capture", {
      data: { key: "omni_pub_acme_demo", name: "Bot", email: "bot@spam.com", consent: true, website: "http://spam" },
    });
    expect(bot.status()).toBe(202);

    const noConsent = await request.post("/api/capture", { data: { key: "omni_pub_acme_demo", name: "Sem", email: "sem@x.com" } });
    expect(noConsent.status()).toBe(400);

    const badKey = await request.post("/api/capture", { data: { key: "omni_org_acme_demo", name: "X", email: "x@x.com", consent: true } });
    expect(badKey.status()).toBe(401);

    const state = await request.get("/api/state", { headers: { Authorization: "Bearer omni_org_acme_demo" } });
    const emails = ((await state.json()).leads as Array<{ email: string }>).map((l) => l.email);
    expect(emails).not.toContain("bot@spam.com");
  });

  test("rate limit por IP devolve 429 com Retry-After", async ({ request }) => {
    const headers = { "X-Real-IP": `203.0.113.${Math.floor(Math.random() * 200)}` };
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 25; i++) {
      const res = await request.post("/api/capture", { headers, data: { key: "omni_pub_acme_demo", name: "Flood", email: `flood${i}@x.com`, consent: true } });
      last = res.status();
      retryAfter = res.headers()["retry-after"];
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

test.describe("sessão, CSRF e LGPD via HTTP", () => {
  test("escrita com cookie e Origin estrangeiro é bloqueada", async ({ request }) => {
    await apiLogin(request, "owner@acme.demo");
    const res = await request.post("/api/copy", {
      headers: { Origin: "https://atacante.example" },
      data: { channel: "email" },
    });
    expect(res.status()).toBe(403);
  });

  test("owner exporta e apaga titular; closer não apaga", async ({ playwright, baseURL }) => {
    const owner = await playwright.request.newContext({ baseURL });
    const closer = await playwright.request.newContext({ baseURL });
    await apiLogin(owner, "owner@acme.demo");
    await apiLogin(closer, "closer@acme.demo");
    const email = `${uniq("titular")}@x.com`;
    const created = await owner.post("/api/leads", { data: { name: "Titular Teste", email, source: "form", consent: true } });
    const leadId = (await created.json()).lead.id as string;

    const exported = await owner.get(`/api/leads/${leadId}/export`);
    expect(exported.headers()["content-disposition"]).toContain("attachment");
    expect((await exported.json()).lead.email).toBe(email);

    expect((await closer.post(`/api/leads/${leadId}/erase`)).status()).toBe(403);
    const erased = await owner.post(`/api/leads/${leadId}/erase`);
    expect((await erased.json()).lead).toMatchObject({ name: "Titular removido", email: "" });
    const after = await owner.get(`/api/leads/${leadId}/export`);
    expect(JSON.stringify(await after.json())).not.toContain(email);
    await owner.dispose();
    await closer.dispose();
  });

  test("importação CSV pelo owner", async ({ request }) => {
    await apiLogin(request, "owner@acme.demo");
    const tag = uniq("csv");
    const csv = `nome;e-mail;origem;etapa;consentimento\nImportado ${tag};${tag}@x.com;indicação;proposta;sim\nSem ${tag};sem${tag}@x.com;site;;não\n`;
    const res = await request.post("/api/leads/import", { headers: { "Content-Type": "text/csv" }, data: csv });
    expect(await res.json()).toMatchObject({ imported: 1, updated: 0 });
  });

  test("health expõe estado real", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(await res.json()).toMatchObject({ ok: true, db: "sqlite", mcp: true });
  });
});
