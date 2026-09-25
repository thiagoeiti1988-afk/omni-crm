"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CopyAsset, DashboardState, Lead, Task, TaskStatus } from "@/lib/types";

const ORGS = [
  { label: "Acme Vendas", key: "omni_org_acme_demo" },
  { label: "Beta Labs", key: "omni_org_beta_demo" },
];

const COLUMNS: Array<{ status: TaskStatus; title: string; tint: string }> = [
  { status: "todo", title: "To Do", tint: "border-gray-700/50" },
  { status: "in_progress", title: "In Progress", tint: "border-blue-900/30" },
  { status: "in_review", title: "Human Review", tint: "border-yellow-900/30" },
  { status: "done", title: "Done", tint: "border-green-900/30" },
];

export default function Home() {
  const [apiKey, setApiKey] = useState(ORGS[0].key);
  const [role, setRole] = useState<"human" | "agent">("human");
  const [health, setHealth] = useState(false);
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadSource, setLeadSource] = useState("form");
  const [consent, setConsent] = useState(true);

  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${apiKey}`,
      "X-Actor-Role": role,
      "X-Agent-Id": role === "human" ? "dashboard-human" : "dashboard-agent",
      "Content-Type": "application/json",
    }),
    [apiKey, role],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health").then((res) => {
      if (!cancelled) setHealth(res.ok);
    });
    fetch("/api/state", { headers })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState(null);
          setError((await res.json()).error ?? res.statusText);
          return;
        }
        setError(null);
        setState(await res.json());
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Falha de rede");
      });
    return () => {
      cancelled = true;
    };
  }, [headers]);

  async function reload() {
    setError(null);
    const healthRes = await fetch("/api/health");
    setHealth(healthRes.ok);
    const res = await fetch("/api/state", { headers });
    if (!res.ok) {
      setState(null);
      setError((await res.json()).error ?? res.statusText);
      return;
    }
    setState(await res.json());
  }

  async function captureLead(e: FormEvent) {
    e.preventDefault();
    if (!state?.projects[0]) return;
    const res = await fetch("/api/leads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: state.projects[0].id,
        name: leadName,
        email: leadEmail,
        source: leadSource,
        consent,
        utm: "utm_source=dashboard",
      }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Falha ao captar lead");
      return;
    }
    setLeadName("");
    setLeadEmail("");
    await reload();
  }

  async function createCopy(lead: Lead) {
    if (!state?.projects[0]) return;
    const res = await fetch("/api/copy", {
      method: "POST",
      headers: { ...headers, "X-Actor-Role": "agent", "X-Agent-Id": "omni-copywriter" },
      body: JSON.stringify({
        projectId: state.projects[0].id,
        leadId: lead.id,
        channel: "email",
      }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Falha ao gerar copy");
    await reload();
  }

  async function review(copy: CopyAsset, decision: "approved" | "rejected") {
    const res = await fetch("/api/copy", {
      method: "POST",
      headers,
      body: JSON.stringify({ copyId: copy.id, decision }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Falha na revisão");
    await reload();
  }

  const tasksByStatus = (status: TaskStatus): Task[] =>
    state?.tasks.filter((task) => task.status === status) ?? [];

  return (
    <div className="min-h-screen p-6 md:p-8 font-sans">
      <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-center mb-8 border-b border-gray-800 pb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Omni-CRM</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Agentes, ICP, leads e copy — Kanban = banco
          </p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <select
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-label="Organização"
          >
            {ORGS.map((org) => (
              <option key={org.key} value={org.key}>
                {org.label}
              </option>
            ))}
          </select>
          <select
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as "human" | "agent")}
            aria-label="Papel"
          >
            <option value="human">Humano (review)</option>
            <option value="agent">Agente</option>
          </select>
          <div className="px-4 py-2 bg-gray-900 rounded text-sm border border-gray-700">
            <span className={health ? "text-green-400" : "text-red-400"}>●</span>{" "}
            MCP {health ? "Online" : "Offline"}
          </div>
        </div>
      </header>

      {error && (
        <p className="mb-4 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      <section className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-10">
        {COLUMNS.map((col) => (
          <div key={col.status} className={`bg-gray-900/80 rounded-lg p-4 border ${col.tint}`}>
            <h2 className="font-semibold text-gray-300 mb-4 flex justify-between">
              {col.title}
              <span className="text-gray-500">{tasksByStatus(col.status).length}</span>
            </h2>
            <div className="space-y-3">
              {tasksByStatus(col.status).map((task) => (
                <article key={task.id} className="p-4 rounded border bg-gray-800 border-gray-700">
                  <div className="text-xs text-gray-400 mb-1 font-mono uppercase">
                    {state?.projects.find((p) => p.id === task.projectId)?.name}
                  </div>
                  <h3 className="text-sm font-medium mb-2">{task.title}</h3>
                  <div className="text-xs text-gray-500 flex justify-between">
                    <span>{task.assignedAgent || "—"}</span>
                    <span>{task.status}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h2 className="font-semibold mb-3">ICP</h2>
          {state?.icp ? (
            <dl className="text-sm space-y-2 text-gray-300">
              <div>
                <dt className="text-gray-500">Persona</dt>
                <dd>{state.icp.persona}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Dores</dt>
                <dd>{state.icp.pains}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Oferta</dt>
                <dd>{state.icp.offer}</dd>
              </div>
              <div className="text-xs text-emerald-400">status: {state.icp.status}</div>
            </dl>
          ) : (
            <p className="text-gray-500 text-sm">Sem ICP</p>
          )}
          <p className="text-xs text-gray-500 mt-3">
            Pipeline: {state?.pipelines[0]?.name} · {state?.pipelineStages.length ?? 0} estágios ·{" "}
            {state?.leads.length ?? 0} leads
          </p>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h2 className="font-semibold mb-3">Captura de lead</h2>
          <form onSubmit={captureLead} className="space-y-2 text-sm">
            <input
              className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2"
              placeholder="Nome"
              value={leadName}
              onChange={(e) => setLeadName(e.target.value)}
              required
            />
            <input
              className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2"
              placeholder="E-mail"
              type="email"
              value={leadEmail}
              onChange={(e) => setLeadEmail(e.target.value)}
              required
            />
            <select
              className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2"
              value={leadSource}
              onChange={(e) => setLeadSource(e.target.value)}
            >
              <option value="form">form</option>
              <option value="whatsapp">whatsapp</option>
              <option value="ads">ads</option>
            </select>
            <label className="flex items-center gap-2 text-gray-400">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Consentimento LGPD
            </label>
            <button className="w-full bg-blue-600 hover:bg-blue-500 rounded py-2 font-medium" type="submit">
              Captar
            </button>
          </form>
          <ul className="mt-4 max-h-64 overflow-auto space-y-2 text-sm">
            {state?.leads.map((lead) => (
              <li key={lead.id} className="border border-gray-800 rounded p-2 flex justify-between gap-2">
                <div>
                  <div>{lead.name}</div>
                  <div className="text-xs text-gray-500">
                    {lead.stage} · {lead.source} · {lead.email}
                  </div>
                </div>
                <button
                  className="text-xs text-blue-400 shrink-0"
                  type="button"
                  onClick={() => void createCopy(lead)}
                >
                  Gerar copy
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h2 className="font-semibold mb-3">Copy em review</h2>
          <ul className="space-y-3 text-sm max-h-[28rem] overflow-auto">
            {state?.copies.length ? (
              state.copies.map((copy) => (
                <li key={copy.id} className="border border-gray-800 rounded p-3">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>{copy.channel}</span>
                    <span>{copy.status}</span>
                  </div>
                  <pre className="whitespace-pre-wrap text-gray-300 text-xs mb-2">{copy.body}</pre>
                  <p className="text-[11px] text-gray-500 mb-2">Citações: {copy.citations}</p>
                  {copy.status === "in_review" && role === "human" && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="text-xs bg-emerald-700 px-2 py-1 rounded"
                        onClick={() => void review(copy, "approved")}
                      >
                        Aprovar
                      </button>
                      <button
                        type="button"
                        className="text-xs bg-red-800 px-2 py-1 rounded"
                        onClick={() => void review(copy, "rejected")}
                      >
                        Rejeitar
                      </button>
                    </div>
                  )}
                </li>
              ))
            ) : (
              <li className="text-gray-500">Nenhuma peça ainda. Gere a partir de um lead.</li>
            )}
          </ul>
        </div>
      </section>
    </div>
  );
}
