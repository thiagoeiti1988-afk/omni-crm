import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Cliente único de acesso a dados do kernel (projects/tasks/agent_logs).
// JEV: uma função por operação, sem ORM, sem camada extra.
// Fase 1 do roadmap não cobre RLS/tenancy — isso é Fase 2.

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  assigned_agent: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentLogInput {
  taskId: string | null;
  projectId: string;
  agentId: string;
  actionType: 'CODE_COMMIT' | 'REFACTOR' | 'BUGFIX' | 'ANALYSIS' | 'PLANNING' | 'ERROR';
  logContent: string;
}

// Transições permitidas via ferramenta de agente (MCP `update_task_status`).
// `done` fica de fora de propósito: AGENTS.md reserva essa transição para
// humano / Harness Agent (ver POST /api/tasks), nunca para o agente executor.
const AGENT_ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress'],
  in_progress: ['in_review', 'todo'],
  in_review: ['in_progress'],
  done: [],
};

// Transições permitidas via webhook Harness/OpenClaw (`POST /api/tasks`),
// que é o único caminho autorizado a fechar um Quanta como `done`.
const HARNESS_ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress'],
  in_progress: ['in_review', 'todo', 'done'],
  in_review: ['in_progress', 'done'],
  done: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Transição inválida: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task não encontrada: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class DbNotConfiguredError extends Error {
  constructor() {
    super('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configurados.');
    this.name = 'DbNotConfiguredError';
  }
}

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new DbNotConfiguredError();
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cachedClient;
}

export async function listTasks(
  client: SupabaseClient,
  projectId?: string
): Promise<Task[]> {
  let query = client.from('tasks').select('*').order('updated_at', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Task[];
}

export async function getTask(client: SupabaseClient, taskId: string): Promise<Task> {
  const { data, error } = await client.from('tasks').select('*').eq('id', taskId).maybeSingle();
  if (error) throw error;
  if (!data) throw new TaskNotFoundError(taskId);
  return data as Task;
}

async function transitionTaskStatus(
  client: SupabaseClient,
  taskId: string,
  nextStatus: TaskStatus,
  allowedTransitions: Record<TaskStatus, TaskStatus[]>
): Promise<Task> {
  const current = await getTask(client, taskId);

  if (current.status !== nextStatus && !allowedTransitions[current.status].includes(nextStatus)) {
    throw new InvalidTransitionError(current.status, nextStatus);
  }

  const { data, error } = await client
    .from('tasks')
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new TaskNotFoundError(taskId);
  return data as Task;
}

// Usado pela tool MCP `update_task_status` (agente executor). Nunca fecha `done`.
export function updateTaskStatusAsAgent(
  client: SupabaseClient,
  taskId: string,
  nextStatus: TaskStatus
): Promise<Task> {
  return transitionTaskStatus(client, taskId, nextStatus, AGENT_ALLOWED_TRANSITIONS);
}

// Usado pelo webhook `POST /api/tasks` (Harness/OpenClaw). Único caminho para `done`.
export function updateTaskStatusAsHarness(
  client: SupabaseClient,
  taskId: string,
  nextStatus: TaskStatus
): Promise<Task> {
  return transitionTaskStatus(client, taskId, nextStatus, HARNESS_ALLOWED_TRANSITIONS);
}

export async function appendAgentLog(client: SupabaseClient, input: AgentLogInput): Promise<void> {
  const { error } = await client.from('agent_logs').insert({
    task_id: input.taskId,
    project_id: input.projectId,
    agent_id: input.agentId,
    action_type: input.actionType,
    log_content: input.logContent,
    // embedding fica NULL nesta passada (Fase 2 preenche o pipeline RAG).
  });
  if (error) throw error;
}
