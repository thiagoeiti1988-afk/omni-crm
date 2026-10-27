import { NextResponse } from "next/server";
import { api, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** LGPD art. 18, II: acesso aos dados do titular, em JSON portável. */
export const GET = api<Ctx>(async (req, ctx) => {
  const auth = requireAuth(req);
  const { id } = await ctx.params;
  const data = getStore().exportLead(auth, id);
  return NextResponse.json(data, {
    headers: { "Content-Disposition": `attachment; filename="titular-${id}.json"`, "Cache-Control": "no-store" },
  });
});
