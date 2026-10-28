import { NextResponse } from "next/server";
import { api, enforceRateLimit, hasBearer, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";
import { handleJsonRpc, PROTOCOL_VERSION, SERVER_VERSION } from "@/lib/mcp";
import { sha256 } from "@/lib/security";

export const runtime = "nodejs";

// Streamable HTTP sem stream servidor→cliente: GET com Accept SSE recebe 405, como o spec permite.
export const GET = api(async (req) => {
  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
  }
  getStore();
  return NextResponse.json({
    ok: true,
    transport: "streamable-http (json responses)",
    protocol: PROTOCOL_VERSION,
    serverInfo: { name: "omni-crm-mcp", version: SERVER_VERSION },
  });
});

export const DELETE = api(async () => new NextResponse(null, { status: 405, headers: { Allow: "POST" } }));

export const POST = api(async (req) => {
  if (!hasBearer(req)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="omni-crm"' } },
    );
  }
  const auth = requireAuth(req);
  enforceRateLimit(`mcp:${sha256(req.headers.get("authorization") ?? "")}`, 600, 60_000);
  let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }
  if (Array.isArray(body)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } },
      { status: 400 },
    );
  }
  const { status, payload } = handleJsonRpc(getStore(), body, auth);
  if (payload === null) return new NextResponse(null, { status });
  return NextResponse.json(payload, { status });
});
