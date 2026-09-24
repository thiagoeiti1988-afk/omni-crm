import { NextResponse } from 'next/server';
import { getSupabaseClient, DbNotConfiguredError } from '@/lib/db';
import { handleMcpRequest, type JsonRpcRequest } from '@/lib/mcp';
import { isAuthorized } from '@/lib/mcp-auth';

// Omni-CRM MCP Server — protocolo oficial (initialize, tools/list, tools/call)
// sobre JSON-RPC 2.0. Ver docs/AUDITORIA.md P0-1/P0-2 para o que isto substitui.

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  let body: JsonRpcRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 }
    );
  }

  if (!body || typeof body.method !== 'string') {
    return NextResponse.json(
      { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request' } },
      { status: 400 }
    );
  }

  try {
    const client = getSupabaseClient();
    const response = await handleMcpRequest(body, client);
    // Notificação JSON-RPC (ex.: notifications/initialized): sem corpo, 204.
    if (response === null) {
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof DbNotConfiguredError) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32001, message: error.message } },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: 'Internal error' },
      },
      { status: 500 }
    );
  }
}

// Healthcheck simples para o indicador "MCP Server: Online" do Kanban.
export async function GET() {
  try {
    getSupabaseClient();
    return NextResponse.json({ status: 'ok' });
  } catch {
    return NextResponse.json({ status: 'not_configured' }, { status: 503 });
  }
}
