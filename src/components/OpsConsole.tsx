"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CopyAsset, DashboardState, Lead, Task, TaskStatus } from "@/lib/types";
import type { Insights } from "@/lib/analytics";
import type { OpsAgentName, OpsAgentResult } from "@/lib/agents";
import { BarChart, Funnel, LineChart } from "@/components/charts";

const ORGS = [
  { label: "Acme Vendas", key: "omni_org_acme_demo", harnessKey: "omni_org_acme_harness_demo" },
  { label: "Beta Labs", key: "omni_org_beta_demo", harnessKey: "omni_org_beta_harness_demo" },
];

type Tab =
  | "operacao"
  | "funil"
  | "leads"
  | "quantas"
  | "memoria"
  | "agentes"
  | "integracoes";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "operacao", label: "Operação" },
  { id: "funil", label: "Funil" },
  { id: "leads", label: "Leads" },
  { id: "quantas", label: "Quantas" },
  { id: "memoria", label: "Memória" },
  { id: "agentes", label: "Agentes" },
  { id: "integracoes", label: "Integrações" },
];

const COLUMNS: Array<{ status: TaskStatus; title: string }> = [
  { status: "todo", title: "To Do" },
  { status: "in_progress", title: "In Progress" },
  { status: "in_review", title: "Human Review" },
  { status: "done", title: "Done" },
];

function brl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export default function OpsConsole() {
  const [apiKey, setApiKey] = useState(ORGS[0].key);
  const [role, setRole] = useState<"human" | "agent">("human");
  const [health, setHealth] = useState(false);
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("operacao");
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadSource, setLeadSource] = useState("form");
  const [consent, setConsent] = useState(true);
  const [memQ, setMemQ] = useState("leads frios whatsapp copy");
  const [memHits, setMemHits] = useState<Array<{ id: string; score: number; logContent: string; agentId: string }>>(
    [],
  );
  const [agent, setAgent] = useState<OpsAgentName>("analyst");
  const [prompt, setPrompt] = useState("Onde eu dobro aquisição na próxima semana?");
  const [agentOut, setAgentOut] = useState<OpsAgentResult | null>(null);
  const [busy, setBusy] = useState(false);

  // O servidor amarra o papel à credencial (ver src/lib/auth.ts) — a agent key
  // nunca autentica como "human". Selecionar "human" aqui troca de credencial,
  // não só o header (que agora é só informativo/log).
  const bearer = useMemo(() => {
    if (role === "agent") return apiKey;
    const org = ORGS.find((o) => o.key === apiKey);
    return org?.harnessKey ?? apiKey;
  }, [apiKey, role]);

  const headers = useMemo(
    () => ({
      Authorization: `Bearer ${bearer}`,
      "X-Actor-Role": role,
      "X-Agent-Id": role === "human" ? "dashboard-human" : "dashboard-agent",
      "Content-Type": "application/json",
    }),
    [bearer, role],
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
        utm: leadSource === "ads" ? "utm_source=ads" : "utm_source=dashboard",
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
        channel: lead.source === "whatsapp" ? "whatsapp" : "email",
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

  async function searchMemory(e: FormEvent) {
    e.preventDefault();
    const res = await fetch(`/api/memory?q=${encodeURIComponent(memQ)}`, { headers });
    if (!res.ok) {
      setError((await res.json()).error ?? "Falha na busca");
      return;
    }
    const data = (await res.json()) as { hits: Array<{ id: string; score: number; logContent: string; agentId: string }> };
    setMemHits(data.hits);
  }

  async function runAgent(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/agents/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ agent, prompt }),
      });
      if (!res.ok) {
        setError((await res.json()).error ?? "Falha no agente");
        return;
      }
      setAgentOut(await res.json());
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const insights: Insights | undefined = state?.insights;
  const tasksByStatus = (status: TaskStatus): Task[] =>
    state?.tasks.filter((task) => task.status === status) ?? [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      <aside className="w-56 shrink-0 border-r border-zinc-800 p-4 flex flex-col gap-6">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Omni</p>
          <h1 className="text-lg font-semibold">Ops Console</h1>
        </div>
        <nav className="flex flex-col gap-1" aria-label="Seções">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`text-left px-3 py-2 rounded text-sm ${tab === item.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto text-xs text-zinc-500 space-y-1">
          <p>{state?.org.name ?? "—"}</p>
          <p>{state?.projects[0]?.name}</p>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex flex-wrap gap-3 items-center justify-between border-b border-zinc-800 px-6 py-3">
          <p className="text-sm text-zinc-400">Vendas · produção · gestão de agentes no mesmo estado</p>
          <div className="flex flex-wrap gap-2 items-center">
            <select
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
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
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as "human" | "agent")}
              aria-label="Papel"
            >
              <option value="human">Humano</option>
              <option value="agent">Agente</option>
            </select>
            <span className="text-sm border border-zinc-700 rounded px-3 py-1.5">
              <span className={health ? "text-emerald-400" : "text-rose-400"}>●</span> MCP{" "}
              {health ? "Online" : "Offline"}
            </span>
          </div>
        </header>

        <main className="p-6 space-y-6">
          {error && (
            <p className="text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}

          {tab === "operacao" && insights && (
            <>
              <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Kpi label="Leads" value={String(insights.kpis.leads)} />
                <Kpi label="Win rate" value={pct(insights.kpis.winRate)} hint={`${insights.kpis.won}G / ${insights.kpis.lost}P`} />
                <Kpi label="Pipeline" value={brl(insights.kpis.pipelineBrl)} />
                <Kpi label="Valor esperado" value={brl(insights.kpis.expectedBrl)} hint="Σ amount × P(estágio)" />
                <Kpi label="Score médio" value={insights.kpis.avgScore.toFixed(0)} />
                <Kpi label="Copy coverage" value={pct(insights.kpis.coverage)} />
                <Kpi label="Quantas done" value={pct(insights.kpis.doneRate)} />
                <Kpi label="Review backlog" value={String(insights.kpis.reviewBacklog)} />
                <Kpi
                  label="Slope / dia"
                  value={insights.series.slopePerDay.toFixed(2)}
                  hint={`R² linear ${insights.series.linearR2.toFixed(2)}`}
                />
                <Kpi
                  label="Curvatura"
                  value={insights.series.curvature.toFixed(3)}
                  hint={`R² parábola ${insights.series.parabolaR2.toFixed(2)}`}
                />
              </section>
              <section className="grid lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 border border-zinc-800 rounded-xl p-4 bg-zinc-900/40">
                  <h2 className="text-sm font-medium mb-2">Captação (14d) — observado, linear, parábola</h2>
                  <LineChart
                    labels={insights.series.days}
                    series={[
                      { label: "leads", values: insights.series.leads, stroke: "#38bdf8" },
                      { label: "linear", values: insights.series.linear, stroke: "#a78bfa", dashed: true },
                      { label: "parábola", values: insights.series.parabola, stroke: "#34d399", dashed: true },
                    ]}
                  />
                  <p className="text-xs text-zinc-500 mt-2">
                    Forecast 7d linear: {insights.series.forecast7Linear.map((n) => n.toFixed(1)).join(" · ")}
                  </p>
                </div>
                <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/40">
                  <h2 className="text-sm font-medium mb-3">Onde buscar</h2>
                  <p className="text-sm text-zinc-300 leading-relaxed">{insights.whereToHunt}</p>
                </div>
              </section>
              <section className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/40">
                <h2 className="text-sm font-medium mb-3">Próxima jogada por lead</h2>
                <ul className="divide-y divide-zinc-800 text-sm">
                  {insights.nextActions.map((item) => (
                    <li key={item.leadId} className="py-2 flex flex-wrap justify-between gap-2">
                      <div>
                        <span className="font-medium">{item.name}</span>
                        <span className="text-zinc-500"> · {item.stage} · {item.source}</span>
                        <p className="text-zinc-400">{item.action}</p>
                        <p className="text-xs text-zinc-600">{item.why}</p>
                      </div>
                      <span className="text-xs self-start border border-zinc-700 rounded px-2 py-1 text-zinc-400">
                        hook:{item.hook}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {tab === "funil" && insights && (
            <section className="grid md:grid-cols-2 gap-6">
              <div className="border border-zinc-800 rounded-xl p-4">
                <h2 className="text-sm font-medium mb-4">Funil comercial</h2>
                <Funnel rows={insights.funnel} />
              </div>
              <div className="border border-zinc-800 rounded-xl p-4">
                <h2 className="text-sm font-medium mb-4">Atribuição por origem (EV)</h2>
                <BarChart
                  items={insights.sources.map((s) => ({ label: s.source, value: s.expectedBrl }))}
                  value={brl}
                />
                <table className="w-full text-xs mt-4 text-zinc-400">
                  <thead>
                    <tr className="text-left border-b border-zinc-800">
                      <th className="py-1">Canal</th>
                      <th>N</th>
                      <th>Win</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.sources.map((s) => (
                      <tr key={s.source} className="border-b border-zinc-900">
                        <td className="py-1">{s.source}</td>
                        <td>{s.leads}</td>
                        <td>{pct(s.winRate)}</td>
                        <td>{s.avgScore.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === "leads" && (
            <section className="grid lg:grid-cols-3 gap-6">
              <form onSubmit={captureLead} className="border border-zinc-800 rounded-xl p-4 space-y-2 text-sm">
                <h2 className="font-medium">Captura</h2>
                <input
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
                  placeholder="Nome"
                  value={leadName}
                  onChange={(e) => setLeadName(e.target.value)}
                  required
                />
                <input
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
                  placeholder="E-mail"
                  type="email"
                  value={leadEmail}
                  onChange={(e) => setLeadEmail(e.target.value)}
                  required
                />
                <select
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
                  value={leadSource}
                  onChange={(e) => setLeadSource(e.target.value)}
                >
                  <option value="form">form</option>
                  <option value="whatsapp">whatsapp</option>
                  <option value="ads">ads</option>
                  <option value="referral">referral</option>
                </select>
                <label className="flex items-center gap-2 text-zinc-400">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  Consentimento
                </label>
                <button className="w-full bg-sky-600 hover:bg-sky-500 rounded py-2" type="submit">
                  Captar
                </button>
                <p className="text-xs text-zinc-500">
                  ICP: {state?.icp?.persona}. O que levar: {state?.icp?.offer}
                </p>
              </form>
              <div className="lg:col-span-2 border border-zinc-800 rounded-xl overflow-auto max-h-[32rem]">
                <table className="w-full text-sm">
                  <thead className="text-left text-zinc-500 text-xs sticky top-0 bg-zinc-950">
                    <tr>
                      <th className="p-3">Lead</th>
                      <th>Origem</th>
                      <th>Estágio</th>
                      <th>Score</th>
                      <th>Valor</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {state?.leads.map((lead) => (
                      <tr key={lead.id} className="border-t border-zinc-800">
                        <td className="p-3">
                          <div>{lead.name}</div>
                          <div className="text-xs text-zinc-500">{lead.email}</div>
                        </td>
                        <td className="text-xs">
                          {lead.source}
                          <div className="text-zinc-600">{lead.utm}</div>
                        </td>
                        <td>{lead.stage}</td>
                        <td>{lead.score}</td>
                        <td>{brl(lead.amount)}</td>
                        <td>
                          <button type="button" className="text-xs text-sky-400" onClick={() => void createCopy(lead)}>
                            Copy
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === "quantas" && (
            <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {COLUMNS.map((col) => (
                <div key={col.status} className="bg-zinc-900/50 rounded-xl p-3 border border-zinc-800">
                  <h2 className="text-sm text-zinc-400 mb-3 flex justify-between">
                    {col.title}
                    <span>{tasksByStatus(col.status).length}</span>
                  </h2>
                  <div className="space-y-2">
                    {tasksByStatus(col.status).map((task) => (
                      <article key={task.id} className="p-3 rounded-lg bg-zinc-900 border border-zinc-800">
                        <h3 className="text-sm">{task.title}</h3>
                        <p className="text-xs text-zinc-500 mt-1">{task.assignedAgent || "—"}</p>
                      </article>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}

          {tab === "memoria" && (
            <section className="space-y-4">
              <form onSubmit={searchMemory} className="flex gap-2">
                <input
                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
                  value={memQ}
                  onChange={(e) => setMemQ(e.target.value)}
                  aria-label="Busca vetorial"
                />
                <button className="bg-indigo-600 rounded px-4 text-sm" type="submit">
                  Buscar cosine
                </button>
              </form>
              <ul className="space-y-2">
                {(memHits.length
                  ? memHits
                  : (state?.logs ?? []).slice(0, 8).map((l) => ({
                      id: l.id,
                      score: 0,
                      logContent: l.logContent,
                      agentId: l.agentId,
                    }))
                ).map((hit) => (
                  <li key={hit.id} className="border border-zinc-800 rounded-lg p-3 text-sm">
                    <div className="text-xs text-zinc-500 mb-1">
                      {hit.agentId} · score {hit.score.toFixed(2)}
                    </div>
                    {hit.logContent}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === "agentes" && (
            <section className="grid lg:grid-cols-2 gap-6">
              <form onSubmit={runAgent} className="border border-zinc-800 rounded-xl p-4 space-y-3 text-sm">
                <h2 className="font-medium">Hook de agente</h2>
                <p className="text-zinc-500 text-xs">
                  Despacha um papel contra o banco desta org (MCP `run_ops_agent` ou POST /api/agents/run).
                </p>
                <select
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
                  value={agent}
                  onChange={(e) => setAgent(e.target.value as OpsAgentName)}
                >
                  <option value="analyst">analyst — métricas + previsão</option>
                  <option value="scout">scout — onde caçar lead</option>
                  <option value="icp">icp — o que levar ao lead</option>
                  <option value="copywriter">copywriter — peça + Human Review</option>
                </select>
                <textarea
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 min-h-24"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <button disabled={busy} className="bg-emerald-700 hover:bg-emerald-600 rounded px-4 py-2" type="submit">
                  {busy ? "Rodando…" : "Rodar"}
                </button>
              </form>
              <pre className="border border-zinc-800 rounded-xl p-4 text-xs whitespace-pre-wrap text-zinc-300 min-h-64">
                {agentOut?.report ?? "Saída do agente aparece aqui. Também grava agent_logs (RAG)."}
              </pre>
              <div className="lg:col-span-2">
                <h2 className="text-sm font-medium mb-2">Copy em review</h2>
                <ul className="grid md:grid-cols-2 gap-3">
                  {state?.copies.map((copy) => (
                    <li key={copy.id} className="border border-zinc-800 rounded-lg p-3 text-xs">
                      <div className="flex justify-between text-zinc-500 mb-1">
                        <span>{copy.channel}</span>
                        <span>{copy.status}</span>
                      </div>
                      <pre className="whitespace-pre-wrap text-zinc-300 max-h-40 overflow-auto">{copy.body}</pre>
                      {copy.status === "in_review" && role === "human" && (
                        <div className="flex gap-2 mt-2">
                          <button type="button" className="bg-emerald-800 px-2 py-1 rounded" onClick={() => void review(copy, "approved")}>
                            Aprovar
                          </button>
                          <button type="button" className="bg-rose-900 px-2 py-1 rounded" onClick={() => void review(copy, "rejected")}>
                            Rejeitar
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {tab === "integracoes" && (
            <section className="grid md:grid-cols-2 gap-4 text-sm">
              <article className="border border-zinc-800 rounded-xl p-4 space-y-2">
                <h2 className="font-medium">MCP</h2>
                <p className="text-zinc-400">POST /api/mcp-server · Bearer da org</p>
                <pre className="text-[11px] bg-zinc-900 p-3 rounded overflow-auto text-zinc-400">{`{
  "mcpServers": {
    "omni-crm": {
      "url": "http://localhost:3000/api/mcp-server",
      "headers": { "Authorization": "Bearer omni_org_acme_demo" }
    }
  }
}`}</pre>
                <p className="text-xs text-zinc-500">Tools: get_insights, run_ops_agent, upsert_lead, search_agent_memory, create_copy_job…</p>
              </article>
              <article className="border border-zinc-800 rounded-xl p-4 space-y-2">
                <h2 className="font-medium">Webhooks e HTTP</h2>
                <ul className="text-zinc-400 text-xs space-y-1 font-mono">
                  <li>POST /api/tasks — Harness / OpenClaw</li>
                  <li>POST /api/leads — form / WhatsApp / ads</li>
                  <li>POST /api/agents/run — hook LLM/agente</li>
                  <li>GET /api/memory?q= — RAG cosine</li>
                </ul>
              </article>
              <article className="border border-zinc-800 rounded-xl p-4">
                <h2 className="font-medium mb-2">Papéis</h2>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  Playbooks em /agents: auditor, repair, icp, lead-capture, copywriter. O console chama os mesmos contratos. Um plugin externo (Meta, GA, Stripe) entra como upsert_lead + lead_events — não como planilha paralela.
                </p>
              </article>
              <article className="border border-zinc-800 rounded-xl p-4">
                <h2 className="font-medium mb-2">O que estes gráficos não são</h2>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  OLS linear e parábola descrevem a série desta org. Não são cotação, Black-Scholes nem garantia de CAC. Servem para decidir canal e cadência com evidência do próprio funil.
                </p>
              </article>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-900/50">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
      {hint && <div className="text-[11px] text-zinc-600">{hint}</div>}
    </div>
  );
}
