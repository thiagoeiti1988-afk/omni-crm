import { NextResponse } from "next/server";
import { api, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** LGPD art. 18, VI: eliminação/anonimização a pedido do titular. */
export const POST = api<Ctx>(async (req, ctx) => {
  const auth = requireAuth(req);
  const { id } = await ctx.params;
  return NextResponse.json({ lead: getStore().eraseLead(auth, id) });
});
