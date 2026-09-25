import { NextResponse } from "next/server";
import { errorResponse, hasBearer, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";
import { handleJsonRpc } from "@/lib/mcp";

export const runtime = "nodejs";

export async function GET() {
  // Healthcheck público: nenhum detalhe de infra (ex.: caminho do arquivo
  // SQLite no disco) deve vazar sem autenticação.
  getStore();
  return NextResponse.json({
    ok: true,
    transport: "jsonrpc-2.0-post",
    protocol: "2024-11-05",
    serverInfo: { name: "omni-crm-mcp", version: "0.1.0" },
  });
}

export async function POST(req: Request) {
  try {
    if (!hasBearer(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const auth = requireAuth(req);
    let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 },
      );
    }
    const { status, payload } = handleJsonRpc(getStore(), body, auth);
    return NextResponse.json(payload, { status });
  } catch (err) {
    return errorResponse(err);
  }
}
