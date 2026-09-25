import { NextResponse } from "next/server";
import { errorResponse, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = requireAuth(req);
    const q = new URL(req.url).searchParams.get("q") ?? "";
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
  } catch (err) {
    return errorResponse(err);
  }
}
