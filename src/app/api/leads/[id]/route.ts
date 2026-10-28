import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = api<Ctx>(async (req, ctx) => {
  const auth = requireAuth(req);
  const { id } = await ctx.params;
  const body = await readJson<{ stage?: string; amount?: number }>(req);
  if (!body.stage) return NextResponse.json({ error: "stage required" }, { status: 400 });
  return NextResponse.json({ lead: getStore().updateLeadStage(auth, id, body.stage, body.amount) });
});
