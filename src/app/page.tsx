import React from 'react';
import { getSupabaseClient, listTasks, DbNotConfiguredError, type Task, type TaskStatus } from '@/lib/db';

export const dynamic = 'force-dynamic';

const COLUMNS: { status: TaskStatus; label: string; accent: string }[] = [
  { status: 'todo', label: 'To Do', accent: 'border-gray-700/50' },
  { status: 'in_progress', label: 'In Progress', accent: 'border-blue-900/30' },
  { status: 'in_review', label: 'Human Review', accent: 'border-yellow-900/30' },
  { status: 'done', label: 'Done', accent: 'border-green-900/30' },
];

async function loadBoard(): Promise<{ tasks: Task[]; online: boolean }> {
  try {
    const client = getSupabaseClient();
    const tasks = await listTasks(client);
    return { tasks, online: true };
  } catch (error) {
    if (error instanceof DbNotConfiguredError) {
      return { tasks: [], online: false };
    }
    // Banco configurado mas indisponível: mostra o board vazio, não derruba a página.
    return { tasks: [], online: false };
  }
}

export default async function Dashboard() {
  const { tasks, online } = await loadBoard();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8 font-sans">
      <header className="flex justify-between items-center mb-8 border-b border-gray-700 pb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Omni-CRM</h1>
          <p className="text-gray-400 mt-1 text-sm">Painel de Gerenciamento Multivetorial de Agentes</p>
        </div>
        <div className="flex gap-4">
          <div className="px-4 py-2 bg-gray-800 rounded text-sm border border-gray-700">
            <span className={online ? 'text-green-400 mr-2' : 'text-red-400 mr-2'}>●</span>
            MCP Server: {online ? 'Online' : 'Offline (DB não configurado)'}
          </div>
        </div>
      </header>

      <main>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {COLUMNS.map((column) => {
            const columnTasks = tasks.filter((t) => t.status === column.status);
            return (
              <div key={column.status} className={`bg-gray-800/50 rounded-lg p-4 border ${column.accent}`}>
                <h2 className="font-semibold text-gray-300 mb-4 flex justify-between">
                  {column.label} <span className="text-gray-500">{columnTasks.length}</span>
                </h2>
                <div className="space-y-3">
                  {columnTasks.length === 0 && (
                    <p className="text-xs text-gray-600 italic">Sem tarefas.</p>
                  )}
                  {columnTasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  const active = task.status === 'in_progress';
  return (
    <div
      className={`p-4 rounded border ${
        active ? 'bg-blue-900/20 border-blue-500/50' : 'bg-gray-800 border-gray-700'
      } transition-all hover:border-gray-500`}
    >
      <h3 className="text-sm font-medium text-gray-200 mb-3 leading-snug">{task.title}</h3>
      <div className="flex justify-between items-center text-xs">
        <span className="text-gray-500 flex items-center gap-1">
          {active && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>}
          {task.assigned_agent ?? '-'}
        </span>
        <span className="text-gray-600">{new Date(task.updated_at).toLocaleString('pt-BR')}</span>
      </div>
    </div>
  );
}
