#!/usr/bin/env node
// Teste simulado de ponta a ponta contra um servidor rodando (dev, Docker ou produção com demo).
// Reproduz o roteiro da demo: lead chega → agente escreve via MCP → agente tenta se aprovar e é barrado
// → harness aprova → funil anda → fatura registra uma vez só.
//
//   npm run simulate                      # http://localhost:3000, org demo Acme
//   OMNI_URL=https://crm.exemplo.com npm run simulate
//
// Variáveis: OMNI_URL, OMNI_AGENT_KEY, OMNI_HARNESS_KEY, OMNI_CAPTURE_KEY, OMNI_OWNER_EMAIL, OMNI_OWNER_PASSWORD,
// WHATSAPP_APP_SECRET + OMNI_WHATSAPP_PHONE_ID (se presentes, o lead entra pelo webhook assinado do WhatsApp).
import { createHmac, randomUUID } from "node:crypto";

const BASE = (process.env.OMNI_URL ?? "http://localhost:3000").replace(/\/$/, "");
const AGENT = process.env.OMNI_AGENT_KEY ?? "omni_org_acme_demo";
const HARNESS = process.env.OMNI_HARNESS_KEY ?? "omni_org_acme_harness_demo";
const CAPTURE = process.env.OMNI_CAPTURE_KEY ?? "omni_pub_acme_demo";
const OWNER = process.env.OMNI_OWNER_EMAIL ?? "owner@acme.demo";
const OWNER_PW = process.env.OMNI_OWNER_PASSWORD ?? "omni-demo-2026";
const WA_SECRET = process.env.WHATSAPP_APP_SECRET;
const WA_PHONE_ID = process.env.OMNI_WHATSAPP_PHONE_ID ?? "100000000000001";

const results = [];
let rpcId = 0;

function step(ok, title, detail = "") {
  results.push(ok);
  console.log(`${ok ? "✔" : "✘"} ${title}${detail ? `\n    ${detail}` : ""}`);
}

async function mcp(key, name, args) {
  const res = await fetch(`${BASE}/api/mcp-server`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Agent-Id": "simulador",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (body.error) return { isError: true, message: body.error.message };
  const r = body.result;
  const text = r.content?.[0]?.text ?? "";
  let message = "";
  if (r.isError) {
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      message = text;
    }
  }
  return { isError: Boolean(r.isError), data: r.structuredContent, message };
}

async function ownerSession() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER, password: OWNER_PW }),
  });
  if (res.status !== 200) throw new Error(`login do owner falhou (${res.status})`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function billing(cookie) {
  const month = new Date().toISOString().slice(0, 7);
  const res = await fetch(`${BASE}/api/billing/usage?month=${month}`, { headers: { Cookie: cookie } });
  const usage = await res.json();
  return Object.fromEntries(usage.lines.map((l) => [l.kind, l.count]));
}

async function main() {
  console.log(`Omni-CRM · teste simulado contra ${BASE}\n`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  step(Boolean(health?.ok), "Servidor no ar", health ? `db=${health.db} llm=${health.llm}` : "sem resposta em /api/health");
  if (!health?.ok) return;

  const cookie = await ownerSession();
  const before = await billing(cookie);
  const tag = randomUUID().slice(0, 6);
  const name = `Marina Simulada ${tag}`;
  let leadId;

  // 1. Lead chega.
  if (WA_SECRET) {
    const from = `55119${Date.now().toString().slice(-8)}`;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp",
        metadata: { phone_number_id: WA_PHONE_ID },
        contacts: [{ profile: { name }, wa_id: from }],
        messages: [{ from, id: `wamid.sim.${tag}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text",
          text: { body: "Oi! Vocês atendem clínica com 3 unidades?" } }],
      } }] }],
    });
    const sig = `sha256=${createHmac("sha256", WA_SECRET).update(body).digest("hex")}`;
    const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body,
    }).then((r) => r.json());
    step(res.processed === 1, "Lead chega pelo WhatsApp (webhook assinado)", JSON.stringify(res));
  } else {
    const res = await fetch(`${BASE}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: CAPTURE, name, email: `marina.${tag}@clinica.com.br`, consent: true, utm_source: "simulador" }),
    });
    step(res.status === 201, "Lead chega pelo formulário do site (com consentimento)", `HTTP ${res.status}`);
  }

  const leads = await mcp(AGENT, "list_leads", {});
  const lead = leads.data?.items?.find((l) => l.name === name);
  leadId = lead?.id;
  step(Boolean(lead), "Agente encontra o lead via MCP", lead ? `base legal: ${lead.consentBasis}` : leads.message);
  if (!lead) return;

  // 2. Agente escreve.
  const copy = await mcp(AGENT, "create_copy_job", {
    projectId: lead.projectId,
    leadId,
    channel: "whatsapp",
    title: `WhatsApp para ${name}`,
    body: "Oi, Marina! Atendemos sim, e 3 unidades é o nosso caso mais comum. Posso te mostrar em 15 minutos amanhã?",
  });
  step(
    copy.data?.status === "in_review",
    "Agente escreve a resposta e ela entra em Human Review",
    copy.data ? `fontes: ${copy.data.citations.split(",").map((c) => c.split(":")[0]).join(", ")}` : copy.message,
  );
  if (!copy.data) return;

  // 3. Governança: agente não se aprova, não move funil.
  const selfApprove = await mcp(AGENT, "review_copy", { copyId: copy.data.id, decision: "approved" });
  step(selfApprove.isError, "Agente tenta se aprovar e é bloqueado", selfApprove.message);
  const selfStage = await mcp(AGENT, "update_lead_stage", { leadId, stage: "won" });
  step(selfStage.isError, "Agente tenta marcar negócio ganho e é bloqueado", selfStage.message);

  // 4. Harness (ou pessoa) decide.
  const approve = await mcp(HARNESS, "review_copy", { copyId: copy.data.id, decision: "approved" });
  step(approve.data?.status === "approved", "Harness aprova a peça", approve.message || `status: ${approve.data?.status}`);
  const again = await mcp(HARNESS, "review_copy", { copyId: copy.data.id, decision: "approved" });
  step(true, "Segunda aprovação da mesma peça", again.isError ? `recusada: ${again.message}` : "aceita sem efeito novo");
  const qualified = await mcp(HARNESS, "update_lead_stage", { leadId, stage: "qualified" });
  step(qualified.data?.stage === "qualified", "Harness qualifica o lead", qualified.message || `estágio: ${qualified.data?.stage}`);

  // 5. Fatura.
  const after = await billing(cookie);
  const delta = (k) => (after[k] ?? 0) - (before[k] ?? 0);
  step(delta("copy_approved") === 1, "Fatura: exatamente 1 peça aprovada a mais", `antes ${before.copy_approved} → depois ${after.copy_approved}`);
  step(
    delta("lead_qualified") === (lead.consent ? 1 : 0),
    "Fatura: lead qualificado só cobra com consentimento",
    `consentimento=${lead.consent} · delta ${delta("lead_qualified")}`,
  );
}

main()
  .catch((err) => step(false, "Erro inesperado", err instanceof Error ? err.message : String(err)))
  .finally(() => {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} passos ok`);
    process.exitCode = failed ? 1 : 0;
  });
