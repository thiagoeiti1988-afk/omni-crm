import React from 'react';

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8 font-sans">
      <header className="flex justify-between items-center mb-8 border-b border-gray-700 pb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Omni-CRM</h1>
          <p className="text-gray-400 mt-1 text-sm">Painel de Gerenciamento Multivetorial de Agentes</p>
        </div>
        <div className="flex gap-4">
          <div className="px-4 py-2 bg-gray-800 rounded text-sm border border-gray-700">
            <span className="text-green-400 mr-2">●</span>MCP Server: Online
          </div>
        </div>
      </header>

      <main>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {/* TO DO COLUMN */}
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
            <h2 className="font-semibold text-gray-300 mb-4 flex justify-between">
              To Do <span className="text-gray-500">3</span>
            </h2>
            <div className="space-y-3">
              <TaskCard title="Setup PostgreSQL vector extension" project="Omni-CRM" agent="-" />
              <TaskCard title="Refactor OpenClaw integration" project="OpenClaw" agent="-" />
              <TaskCard title="Generate synthetic data for testing" project="Codex" agent="-" />
            </div>
          </div>

          {/* IN PROGRESS COLUMN */}
          <div className="bg-gray-800/50 rounded-lg p-4 border border-blue-900/30">
            <h2 className="font-semibold text-blue-400 mb-4 flex justify-between">
              In Progress <span className="text-gray-500">2</span>
            </h2>
            <div className="space-y-3">
              <TaskCard title="Implement JEV validation loop" project="Codex" agent="Cursor-Agent" active />
              <TaskCard title="Build premium graphics UI component" project="Omni-CRM" agent="Antigravity" active />
            </div>
          </div>

          {/* IN REVIEW COLUMN */}
          <div className="bg-gray-800/50 rounded-lg p-4 border border-yellow-900/30">
            <h2 className="font-semibold text-yellow-400 mb-4 flex justify-between">
              Human Review <span className="text-gray-500">1</span>
            </h2>
            <div className="space-y-3">
              <TaskCard title="Approve RAG architecture" project="Omni-CRM" agent="Claude-3.5" />
            </div>
          </div>

          {/* DONE COLUMN */}
          <div className="bg-gray-800/50 rounded-lg p-4 border border-green-900/30">
            <h2 className="font-semibold text-green-400 mb-4 flex justify-between">
              Done <span className="text-gray-500">4</span>
            </h2>
            <div className="space-y-3 opacity-60">
              <TaskCard title="Analyze graphics skills" project="Omni-CRM" agent="Antigravity" />
              <TaskCard title="Install superpower skills" project="Omni-CRM" agent="Antigravity" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TaskCard({ title, project, agent, active = false }: { title: string, project: string, agent: string, active?: boolean }) {
  return (
    <div className={`p-4 rounded border ${active ? 'bg-blue-900/20 border-blue-500/50' : 'bg-gray-800 border-gray-700'} transition-all hover:border-gray-500`}>
      <div className="text-xs text-gray-400 mb-1 font-mono uppercase tracking-wider">{project}</div>
      <h3 className="text-sm font-medium text-gray-200 mb-3 leading-snug">{title}</h3>
      <div className="flex justify-between items-center text-xs">
        <span className="text-gray-500 flex items-center gap-1">
          {active && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>}
          {agent}
        </span>
        <span className="text-gray-600">agora</span>
      </div>
    </div>
  );
}
