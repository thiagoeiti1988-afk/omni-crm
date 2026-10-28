import { NextResponse } from "next/server";
import { api, clientIp, enforceRateLimit, HttpError } from "@/lib/http";
import { getStore } from "@/lib/store";
import { isTruthy } from "@/lib/csv";

export const runtime = "nodejs";

// Endpoint público: chave de captura é pública por natureza (vai no HTML do site)
// e só autoriza upsert_lead com consentimento. Sem cookie, então CORS aberto é seguro.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Capture-Key",
  "Access-Control-Max-Age": "86400",
};

const SOURCES = new Set(["form", "ads", "referral", "whatsapp"]);

function thanksPage(ok: boolean, message: string): Response {
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Recebido" : "Não enviado"}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111">
<h1 style="font-size:1.25rem">${ok ? "Recebemos seu contato." : "Não foi possível enviar."}</h1>
<p>${message.replace(/[<>&"]/g, "")}</p></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
}

export const OPTIONS = api(async () => new Response(null, { status: 204, headers: CORS }));

export const POST = api(async (req) => {
  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const raw = await req.text();
  if (raw.length > 20_000) throw new HttpError(413, "Body too large");
  const fields: Record<string, string> = isForm
    ? Object.fromEntries(new URLSearchParams(raw))
    : Object.fromEntries(
        Object.entries((JSON.parse(raw || "{}") as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? "")]),
      );

  const key = req.headers.get("x-capture-key") ?? fields.key ?? "";
  enforceRateLimit(`capture:ip:${clientIp(req)}`, 20, 60_000);
  enforceRateLimit(`capture:key:${key}`, 1000, 60 * 60_000);

  const respond = (status: number, body: Record<string, unknown>) =>
    isForm
      ? thanksPage(status < 300, String(body.error ?? "Em breve entraremos em contato."))
      : NextResponse.json(body, { status, headers: CORS });

  // Honeypot: bots preenchem tudo. Fingimos sucesso para não ensinar o bot.
  if (fields.website) return respond(202, { ok: true });

  const store = getStore();
  const org = key ? store.getOrgByCaptureKey(key) : undefined;
  if (!org) return respond(401, { error: "Chave de captura inválida" });
  if (!isTruthy(fields.consent) && fields.consent !== "on") {
    return respond(400, { error: "É preciso aceitar o uso dos seus dados para contato (LGPD)." });
  }
  const project = store.listProjects(org.id).find((p) => p.id === fields.projectId) ?? store.listProjects(org.id)[0];
  if (!project) return respond(500, { error: "Organização sem projeto" });

  const utm = ["utm_source", "utm_medium", "utm_campaign"]
    .filter((k) => fields[k])
    .map((k) => `${k}=${encodeURIComponent(fields[k].slice(0, 100))}`)
    .join("&");
  const source = SOURCES.has(fields.source) ? fields.source : fields.utm_source?.includes("ads") ? "ads" : "form";
  const lead = store.upsertLead(
    { org, role: "agent", agentId: "capture-form", isMaster: false, via: "capture" },
    {
      projectId: project.id,
      name: fields.name ?? "",
      email: fields.email,
      phone: fields.phone,
      source,
      utm: utm || fields.utm || "",
      consent: true,
      consentBasis: "consent",
    },
  );
  return respond(201, { ok: true, leadId: lead.id });
});
