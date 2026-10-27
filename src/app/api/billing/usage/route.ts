import { NextResponse } from "next/server";
import { api, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const GET = api(async (req) => {
  const auth = requireAuth(req);
  const month = new URL(req.url).searchParams.get("month") ?? undefined;
  return NextResponse.json(getStore().billingUsage(auth, month));
});
