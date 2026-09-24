import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  getStore();
  return NextResponse.json({ ok: true, db: "sqlite", mcp: true });
}
