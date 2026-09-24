import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, type JsonRpcResponse, type JsonRpcSuccess } from '../mcp';
import { createFakeClient } from './fake-supabase';

function seededClient() {
  return createFakeClient({
    tasks: [
      {
        id: 'task-1',
        project_id: 'proj-1',
        title: 'Ligar MCP oficial',
        status: 'todo',
        assigned_agent: null,
        description: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    agent_logs: [],
  });
}

function assertSuccess(response: JsonRpcResponse | null): JsonRpcSuccess {
  assert.ok(response !== null, 'esperava resposta, recebeu null');
  assert.ok('result' in response, `esperava sucesso, recebeu erro: ${JSON.stringify(response)}`);
  return response;
}

function toolText(response: JsonRpcSuccess): string {
  const result = response.result as { content: { type: 'text'; text: string }[]; isError?: boolean };
  return result.content[0].text;
}

function toolIsError(response: JsonRpcSuccess): boolean {
  const result = response.result as { isError?: boolean };
  return result.isError === true;
}

test('initialize retorna protocolo e serverInfo oficiais', async () => {
  const client = seededClient();
  const response = assertSuccess(
    await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, client)
  );
  const result = response.result as { serverInfo: { name: string }; capabilities: { tools: unknown } };
  assert.equal(result.serverInfo.name, 'omni-crm-mcp');
  assert.ok(result.capabilities.tools);
});

test('notifications/initialized não gera resposta', async () => {
  const client = seededClient();
  const response = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, client);
  assert.equal(response, null);
});

test('tools/list expõe as 4 tools alvo da Fase 1', async () => {
  const client = seededClient();
  const response = assertSuccess(
    await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, client)
  );
  const result = response.result as { tools: { name: string }[] };
  const tools = result.tools.map((t) => t.name);
  assert.deepEqual(tools.sort(), [
    'append_agent_log',
    'get_task',
    'list_tasks',
    'update_task_status',
  ]);
});

test('tools/call get_task devolve a tarefa seedada', async () => {
  const client = seededClient();
  const response = assertSuccess(
    await handleMcpRequest(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_task', arguments: { taskId: 'task-1' } } },
      client
    )
  );
  const task = JSON.parse(toolText(response));
  assert.equal(task.id, 'task-1');
  assert.equal(task.status, 'todo');
});

test('tools/call update_task_status aplica transição válida', async () => {
  const client = seededClient();
  const response = assertSuccess(
    await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'update_task_status', arguments: { taskId: 'task-1', status: 'in_progress' } },
      },
      client
    )
  );
  const task = JSON.parse(toolText(response));
  assert.equal(task.status, 'in_progress');
});

test('tools/call update_task_status rejeita transição ilegal (todo -> in_review)', async () => {
  const client = seededClient();
  const response = assertSuccess(
    await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'update_task_status', arguments: { taskId: 'task-1', status: 'in_review' } },
      },
      client
    )
  );
  assert.equal(toolIsError(response), true);
  assert.match(toolText(response), /Transição inválida/);
});

test('tools/call update_task_status nunca aceita "done" (reservado a humano/Harness)', async () => {
  const client = seededClient();
  const response = assertSuccess(
    await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'update_task_status', arguments: { taskId: 'task-1', status: 'done' } },
      },
      client
    )
  );
  // 'done' não faz parte do enum aceito pela tool; o schema documenta isso,
  // mas o handler também precisa recusar em runtime caso o schema seja ignorado.
  assert.equal(toolIsError(response), true);
});

test('method desconhecido devolve erro JSON-RPC -32601', async () => {
  const client = seededClient();
  const response = await handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'mcp.initialize' }, client);
  assert.ok(response && 'error' in response);
  assert.equal(response.error.code, -32601);
});
