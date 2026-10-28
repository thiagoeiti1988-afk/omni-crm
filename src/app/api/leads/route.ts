import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

/** Captura autenticada (agente, painel, integrações server-side). Formulário público usa /api/capture. */
export const POST = api(async (req) => {
  const auth = requireAuth(req);
  const body = await readJson<{
    projectId?: string;
    name?: string;
    email?: string;
    phone?: string;
    source?: string;
    utm?: string;
    consent?: boolean;
    externalId?: string;
  }>(req);
  const store = getStore();
  const projectId = body.projectId ?? store.listProjects(auth.org.id)[0]?.id;
  if (!projectId || !body.name || (!body.email && !body.phone) || !body.source) {
    return NextResponse.json({ error: "name, email or phone, source required" }, { status: 400 });
  }
  const lead = store.upsertLead(auth, {
    projectId,
    name: body.name,
    email: body.email,
    phone: body.phone,
    source: body.source,
    utm: body.utm,
    consent: body.consent === true,
    externalId: body.externalId,
  });
  return NextResponse.json({ lead }, { status: 201 });
});
