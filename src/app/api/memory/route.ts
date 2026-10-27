import { NextResponse } from "next/server";
import { api, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const GET = api(async (req) => {
  const auth = requireAuth(req);
  const q = new URL(req.url).searchParams.get("q")?.slice(0, 500) ?? "";
  if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });
  const hits = getStore().searchMemory(auth.org.id, q, 8);
  return NextResponse.json({
    query: q,
    hits: hits.map((h) => ({
      id: h.id,
      score: h.score,
      agentId: h.agentId,
      actionType: h.actionType,
      logContent: h.logContent,
      createdAt: h.createdAt,
    })),
  });
});
