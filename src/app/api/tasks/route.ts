import { NextResponse } from 'next/server';
import {
  getSupabaseClient,
  updateTaskStatusAsHarness,
  DbNotConfiguredError,
  InvalidTransitionError,
  TaskNotFoundError,
  type TaskStatus,
} from '@/lib/db';
import { isAuthorized } from '@/lib/mcp-auth';

// Webhook REST para Harness/OpenClaw (AGENTS.md: "Conexão via Webhook REST
// /api/tasks"). Mesma auth Bearer do MCP; único caminho autorizado a fechar
// um Quanta como `done`.

interface UpdateStatusBody {
  taskId?: unknown;
  status?: unknown;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: UpdateStatusBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { taskId, status } = body;
  const validStatuses: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

  if (typeof taskId !== 'string' || typeof status !== 'string' || !validStatuses.includes(status as TaskStatus)) {
    return NextResponse.json(
      { error: 'Body inválido: esperado { taskId: string, status: todo|in_progress|in_review|done }' },
      { status: 400 }
    );
  }

  try {
    const client = getSupabaseClient();
    const task = await updateTaskStatusAsHarness(client, taskId, status as TaskStatus);
    return NextResponse.json({ task });
  } catch (error) {
    if (error instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof TaskNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
