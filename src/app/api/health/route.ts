import { NextResponse } from "next/server";
import { api } from "@/lib/http";
import { getStore } from "@/lib/store";
import { SERVER_VERSION } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startedAt = Date.now();

export const GET = api(async () => {
  try {
    const db = getStore().ping();
    return NextResponse.json({
      ok: db,
      db: "sqlite",
      mcp: true,
      version: SERVER_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      llm: Boolean(process.env.ANTHROPIC_API_KEY),
    });
  } catch {
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
});
