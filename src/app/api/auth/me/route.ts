import { NextResponse } from "next/server";
import { api, requireAuth } from "@/lib/http";

export const runtime = "nodejs";

export const GET = api(async (req) => {
  const auth = requireAuth(req);
  return NextResponse.json({ user: auth.user ?? null, org: { id: auth.org.id, name: auth.org.name }, role: auth.role });
});
