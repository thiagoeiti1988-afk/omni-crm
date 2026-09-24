import type { SupabaseClient } from '@supabase/supabase-js';
import {
  appendAgentLog,
  getTask,
  listTasks,
  updateTaskStatusAsAgent,
  InvalidTransitionError,
  TaskNotFoundError,
  type TaskStatus,
} from './db';
import packageJson from '../../package.json';

// Implementação mínima e correta do protocolo MCP oficial (JSON-RPC 2.0):
// `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
// Substitui o mock `mcp.initialize` / `mcp.tools.list` (fora do protocolo,
// nenhum cliente MCP real conecta nisso).

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const SERVER_NAME = 'omni-crm-mcp';
// Sincronizado com package.json — nunca hardcoded à parte (era 1.0.0 no mock).
const SERVER_VERSION: string = packageJson.version;

const TOOLS = [
  {
    name: 'list_tasks',
    description: 'Lista tarefas (Quanta) do Omni-CRM, opcionalmente filtradas por projeto.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
    },
  },
  {
    name: 'get_task',
    description: 'Busca uma tarefa específica pelo id.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'update_task_status',
    description:
      "Atualiza o status de uma tarefa. Não permite transicionar para 'done' " +
      '— essa transição é exclusiva de humano / Harness Agent (ver AGENTS.md).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'in_review'] },
      },
      required: ['taskId', 'status'],
    },
  },
  {
    name: 'append_agent_log',
    description: 'Registra um log de agente (agent_logs) para memória/auditoria.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        projectId: { type: 'string' },
        agentId: { type: 'string' },
        actionType: {
          type: 'string',
          enum: ['CODE_COMMIT', 'REFACTOR', 'BUGFIX', 'ANALYSIS', 'PLANNING', 'ERROR'],
        },
        logContent: { type: 'string' },
      },
      required: ['projectId', 'agentId', 'actionType', 'logContent'],
    },
  },
] as const;

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function toolError(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolResult(value: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

async function callTool(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  try {
    switch (name) {
      case 'list_tasks': {
        const projectId = typeof args.projectId === 'string' ? args.projectId : undefined;
        return toolResult(await listTasks(client, projectId));
      }
      case 'get_task': {
        if (typeof args.taskId !== 'string') return toolError('taskId é obrigatório.');
        return toolResult(await getTask(client, args.taskId));
      }
      case 'update_task_status': {
        if (typeof args.taskId !== 'string' || typeof args.status !== 'string') {
          return toolError('taskId e status são obrigatórios.');
        }
        return toolResult(
          await updateTaskStatusAsAgent(client, args.taskId, args.status as TaskStatus)
        );
      }
      case 'append_agent_log': {
        const { projectId, agentId, actionType, logContent, taskId } = args;
        if (
          typeof projectId !== 'string' ||
          typeof agentId !== 'string' ||
          typeof actionType !== 'string' ||
          typeof logContent !== 'string'
        ) {
          return toolError('projectId, agentId, actionType e logContent são obrigatórios.');
        }
        await appendAgentLog(client, {
          taskId: typeof taskId === 'string' ? taskId : null,
          projectId,
          agentId,
          actionType: actionType as AgentLogActionType,
          logContent,
        });
        return toolResult({ ok: true });
      }
      default:
        return toolError(`Tool desconhecida: ${name}`);
    }
  } catch (error) {
    if (error instanceof TaskNotFoundError || error instanceof InvalidTransitionError) {
      return toolError(error.message);
    }
    throw error;
  }
}

type AgentLogActionType = 'CODE_COMMIT' | 'REFACTOR' | 'BUGFIX' | 'ANALYSIS' | 'PLANNING' | 'ERROR';

export async function handleMcpRequest(
  request: JsonRpcRequest,
  client: SupabaseClient
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = request;

  // Notificação: sem resposta (protocolo MCP).
  if (method === 'notifications/initialized') {
    return null;
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'tools/list':
      return ok(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') {
        return fail(id, -32602, 'Invalid params: "name" é obrigatório.');
      }
      const result = await callTool(client, name, args);
      return ok(id, result);
    }

    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
