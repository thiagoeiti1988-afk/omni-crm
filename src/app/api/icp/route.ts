import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";
import type { IcpStatus } from "@/lib/types";

export const runtime = "nodejs";

const FIELDS = ["persona", "pains", "language", "channels", "offer", "exclusions"] as const;

export const PUT = api(async (req) => {
  const auth = requireAuth(req);
  const body = await readJson<Partial<Record<(typeof FIELDS)[number], string>> & { projectId?: string; status?: IcpStatus }>(req);
  const store = getStore();
  const projectId = body.projectId ?? store.listProjects(auth.org.id)[0]?.id;
  if (!projectId) return NextResponse.json({ error: "No project" }, { status: 400 });
  const current = store.getIcp(auth.org.id, projectId);
  const merged = Object.fromEntries(
    FIELDS.map((f) => [f, (body[f] ?? current?.[f] ?? "").toString().slice(0, 2000)]),
  ) as Record<(typeof FIELDS)[number], string>;
  if (body.status === "approved" && (!merged.persona.trim() || !merged.offer.trim())) {
    return NextResponse.json({ error: "Persona e oferta são obrigatórias para aprovar o ICP" }, { status: 400 });
  }
  return NextResponse.json({ icp: store.upsertIcp(auth, { projectId, ...merged, status: body.status }) });
});
