"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  BillingUsage,
  CopyAsset,
  DashboardState,
  Lead,
  LeadStage,
  Permission,
  SessionUser,
  Task,
  TaskStatus,
  UserRole,
} from "@/lib/types";
import type { Insights } from "@/lib/analytics";
import type { OpsAgentName, OpsAgentResult } from "@/lib/agents";
import { BarChart, Funnel, LineChart } from "@/components/charts";

type Tab = "operacao" | "funil" | "leads" | "quantas" | "copy" | "icp" | "memoria" | "agentes" | "faturamento" | "integracoes";

const TABS: Array<{ id: Tab; label: string; perm?: Permission }> = [
  { id: "operacao", label: "Operação" },
  { id: "funil", label: "Funil" },
  { id: "leads", label: "Leads" },
  { id: "quantas", label: "Quantas" },
  { id: "copy", label: "Human Review" },
  { id: "icp", label: "ICP" },
  { id: "memoria", label: "Memória" },
  { id: "agentes", label: "Agentes" },
  { id: "faturamento", label: "Faturamento", perm: "billing.view" },
  { id: "integracoes", label: "Integrações", perm: "org.keys" },
];

// Espelho de src/lib/auth.ts só para esconder botões; quem decide é o servidor.
const PERMS: Record<UserRole, Permission[]> = {
  owner: ["task.done", "copy.review", "icp.approve", "lead.stage", "lead.erase", "lead.export", "lead.import", "org.keys", "billing.view"],
  closer: ["task.done", "lead.stage", "lead.export", "billing.view"],
  copy: ["copy.review"],
};

const ROLE_LABEL: Record<UserRole, string> = { owner: "Owner", closer: "Closer", copy: "Copy" };

const STAGES: Array<{ id: LeadStage; label: string }> = [
  { id: "new", label: "Novo" },
  { id: "qualified", label: "Qualificado" },
  { id: "nurturing", label: "Nutrição" },
  { id: "proposal", label: "Proposta" },
  { id: "won", label: "Ganho" },
  { id: "lost", label: "Perdido" },
];

const COLUMNS: Array<{ status: TaskStatus; title: string }> = [
  { status: "todo", title: "To Do" },
  { status: "in_progress", title: "In Progress" },
  { status: "in_review", title: "Human Review" },
  { status: "done", title: "Done" },
];

const UNDO_MS = 5000;

type PendingDecision = { copy: CopyAsset; decision: "approved" | "rejected"; startedAt: number; timer: number };

const BILL_LABEL: Record<string, string> = {
  lead_qualified: "Lead qualificado (com consentimento)",
  copy_approved: "Peça aprovada no Human Review",
  deal_won: "Negócio ganho",
};

function brl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function cents(n: number): string {
  return (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    window.location.replace("/login");
    throw new Error("Sessão expirada");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export default function OpsConsole({ user, orgName }: { user: SessionUser; orgName: string }) {
  const router = useRouter();
  const perms = PERMS[user.role];
  const can = (p: Permission) => perms.includes(p);
  const [health, setHealth] = useState<{ ok: boolean; llm?: boolean } | null>(null);
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("operacao");
  const [busy, setBusy] = useState<string | null>(null);
  // Decisão de review fica UNDO_MS no cliente antes de ir ao servidor: aprovar gera cobrança e fecha a Quanta,
  // então o "desfazer" precisa acontecer antes da chamada, não depois.
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const pendingRef = useRef<PendingDecision | null>(null);

  const reload = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        fetch("/api/health").then((r) => r.json()).catch(() => ({ ok: false })),
        call<DashboardState>("/api/state"),
      ]);
      setHealth(h);
      setState(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar");
    }
  }, []);

  useEffect(() => {
    // Carga inicial do painel a partir da API (estado externo).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  async function act(label: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha");
    } finally {
      setBusy(null);
    }
  }

  async function commitReview(decision: PendingDecision) {
    if (pendingRef.current?.copy.id !== decision.copy.id) return;
    window.clearTimeout(decision.timer);
    pendingRef.current = null;
    setPending(null);
    await act(
      `review:${decision.copy.id}`,
      () => call("/api/copy", { method: "POST", body: JSON.stringify({ copyId: decision.copy.id, decision: decision.decision }) }),
      decision.decision === "approved" ? "Peça aprovada — Quanta fechada." : "Peça rejeitada — Quanta volta para In Progress.",
    );
  }

  function decide(copy: CopyAsset, decision: "approved" | "rejected") {
    // Uma decisão por vez: a anterior é confirmada antes de abrir a próxima janela de desfazer.
    if (pendingRef.current) void commitReview(pendingRef.current);
    const next: PendingDecision = { copy, decision, startedAt: Date.now(), timer: 0 };
    next.timer = window.setTimeout(() => void commitReview(next), UNDO_MS);
    pendingRef.current = next;
    setPending(next);
    setNotice(null);
  }

  function undo() {
    const current = pendingRef.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    pendingRef.current = null;
    setPending(null);
    setNotice(`Decisão desfeita: "${current.copy.title}" voltou para a fila.`);
  }

  useEffect(() => {
    // Fechar a aba não pode perder a decisão: envia o que estiver pendente.
    const flush = () => {
      const current = pendingRef.current;
      if (!current) return;
      void fetch("/api/copy", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copyId: current.copy.id, decision: current.decision }),
      });
      pendingRef.current = null;
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const insights: Insights | undefined = state?.insights;
  const visibleTabs = TABS.filter((t) => !t.perm || can(t.perm));
  const reviewQueue = state?.copies.filter((c) => c.status === "in_review" && c.id !== pending?.copy.id) ?? [];
  const leadNames = new Map(state?.leads.map((l) => [l.id, l.name]) ?? []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col md:flex-row">
      <aside className="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-zinc-800 p-4 flex md:flex-col gap-4 md:gap-6 overflow-x-auto">
        <div className="shrink-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Omni-CRM</p>
          <h1 className="text-lg font-semibold">{orgName}</h1>
        </div>
        <nav className="flex md:flex-col gap-1" aria-label="Seções">
          {visibleTabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
              className={`whitespace-nowrap text-left px-3 py-2 rounded text-sm flex justify-between gap-2 ${tab === item.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
            >
              {item.label}
              {item.id === "copy" && reviewQueue.length > 0 && (
                <span className="text-[11px] bg-amber-600/30 text-amber-300 rounded px-1.5">{reviewQueue.length}</span>
              )}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex flex-wrap gap-3 items-center justify-between border-b border-zinc-800 px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-zinc-400">Agentes propõem · pessoas aprovam · tudo auditável</p>
            {can("copy.review") && reviewQueue.length > 0 && tab !== "copy" && (
              <button
                type="button"
                onClick={() => setTab("copy")}
                className="text-xs rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-3 py-1 hover:bg-amber-500/25"
                data-testid="review-waiting"
              >
                {reviewQueue.length === 1 ? "1 peça aguardando você" : `${reviewQueue.length} peças aguardando você`}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center text-sm">
            <span className="border border-zinc-700 rounded px-3 py-1.5" title="Saúde do banco e do servidor MCP">
              <span className={health?.ok ? "text-emerald-400" : "text-rose-400"}>●</span> MCP {health?.ok ? "Online" : "Offline"}
              {health?.llm ? " · Claude" : ""}
            </span>
            <span className="border border-zinc-700 rounded px-3 py-1.5" data-testid="current-user">
              {user.name} · {ROLE_LABEL[user.role]}
            </span>
            <button type="button" onClick={() => void logout()} className="border border-zinc-700 rounded px-3 py-1.5 hover:bg-zinc-900">
              Sair
            </button>
          </div>
        </header>

        <main className="p-6 space-y-6">
          {error && (
            <p className="text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="text-sm text-emerald-400" role="status">
              {notice}
            </p>
          )}

          {tab === "operacao" && insights && <Operacao insights={insights} />}
          {tab === "funil" && insights && <Funil insights={insights} />}
          {tab === "leads" && state && (
            <Leads
              state={state}
              can={can}
              busy={busy}
              onStage={(lead, stage) => act(`stage:${lead.id}`, () => call(`/api/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify({ stage }) }))}
              onCopy={(lead) =>
                act(
                  `copy:${lead.id}`,
                  () =>
                    call("/api/copy", {
                      method: "POST",
                      body: JSON.stringify({ leadId: lead.id, channel: lead.source === "whatsapp" ? "whatsapp" : "email" }),
                    }),
                  "Peça criada e enviada para Human Review.",
                )
              }
              onErase={(lead) => {
                if (!window.confirm(`Anonimizar ${lead.name}? Isso apaga dados pessoais, eventos e peças do titular.`)) return;
                void act(`erase:${lead.id}`, () => call(`/api/leads/${lead.id}/erase`, { method: "POST" }), "Titular anonimizado (LGPD).");
              }}
              onCapture={(body) => act("capture", () => call("/api/leads", { method: "POST", body: JSON.stringify(body) }), "Lead captado.")}
              onImport={(csv) =>
                act("import", async () => {
                  const r = await call<{ imported: number; updated: number; skipped: unknown[] }>("/api/leads/import", {
                    method: "POST",
                    headers: { "Content-Type": "text/csv" },
                    body: csv,
                  });
                  setNotice(`Importados ${r.imported}, atualizados ${r.updated}, ignorados ${r.skipped.length}.`);
                })
              }
            />
          )}
          {tab === "quantas" && state && <Quantas tasks={state.tasks} />}
          {tab === "copy" && state && (
            <Review
              queue={reviewQueue}
              decided={state.copies.filter((c) => c.status !== "in_review")}
              leadNames={leadNames}
              canReview={can("copy.review")}
              busy={busy}
              onReview={decide}
              onUndo={undo}
              hasPending={pending !== null}
            />
          )}
          {tab === "icp" && state && (
            <Icp
              state={state}
              canApprove={can("icp.approve")}
              onSave={(fields, approve) =>
                act(
                  "icp",
                  () => call("/api/icp", { method: "PUT", body: JSON.stringify({ ...fields, status: approve ? "approved" : "draft" }) }),
                  approve ? "ICP aprovado." : "Rascunho salvo.",
                )
              }
            />
          )}
          {tab === "memoria" && state && <Memoria state={state} />}
          {tab === "agentes" && <Agentes onRun={reload} />}
          {tab === "faturamento" && can("billing.view") && state && <Faturamento state={state} />}
          {tab === "integracoes" && can("org.keys") && <Integracoes />}
        </main>
        {pending && <UndoToast pending={pending} onUndo={undo} onConfirm={() => void commitReview(pending)} />}
      </div>
    </div>
  );
}

function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`border border-zinc-800 rounded-xl p-4 bg-zinc-900/40 ${className}`}>
      {title && <h2 className="text-sm font-medium mb-3">{title}</h2>}
      {children}
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

function Operacao({ insights }: { insights: Insights }) {
  return (
    <>
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Leads" value={String(insights.kpis.leads)} />
        <Kpi label="Win rate" value={pct(insights.kpis.winRate)} hint={`${insights.kpis.won}G / ${insights.kpis.lost}P`} />
        <Kpi label="Pipeline" value={brl(insights.kpis.pipelineBrl)} />
        <Kpi label="Valor esperado" value={brl(insights.kpis.expectedBrl)} hint="Σ valor × P(estágio)" />
        <Kpi label="Score médio" value={insights.kpis.avgScore.toFixed(0)} />
        <Kpi label="Copy coverage" value={pct(insights.kpis.coverage)} />
        <Kpi label="Quantas done" value={pct(insights.kpis.doneRate)} />
        <Kpi label="Review backlog" value={String(insights.kpis.reviewBacklog)} />
        <Kpi label="Tendência / dia" value={insights.series.slopePerDay.toFixed(2)} hint={`R² linear ${insights.series.linearR2.toFixed(2)}`} />
        <Kpi label="Curvatura" value={insights.series.curvature.toFixed(3)} hint={`R² parábola ${insights.series.parabolaR2.toFixed(2)}`} />
      </section>
      <section className="grid lg:grid-cols-3 gap-4">
        <Card title="Captação (14d) — observado, linear, parábola" className="lg:col-span-2">
          <LineChart
            labels={insights.series.days}
            series={[
              { label: "leads", values: insights.series.leads, stroke: "#38bdf8" },
              { label: "linear", values: insights.series.linear, stroke: "#a78bfa", dashed: true },
              { label: "parábola", values: insights.series.parabola, stroke: "#34d399", dashed: true },
            ]}
          />
          <p className="text-xs text-zinc-500 mt-2">
            Projeção 7d (linear): {insights.series.forecast7Linear.map((n) => n.toFixed(1)).join(" · ")}
          </p>
        </Card>
        <Card title="Onde buscar">
          <p className="text-sm text-zinc-300 leading-relaxed">{insights.whereToHunt}</p>
        </Card>
      </section>
      <Card title="Próxima jogada por lead">
        <ul className="divide-y divide-zinc-800 text-sm">
          {insights.nextActions.map((item) => (
            <li key={item.leadId} className="py-2 flex flex-wrap justify-between gap-2">
              <div>
                <span className="font-medium">{item.name}</span>
                <span className="text-zinc-500"> · {item.stage} · {item.source}</span>
                <p className="text-zinc-400">{item.action}</p>
                <p className="text-xs text-zinc-600">{item.why}</p>
              </div>
              <span className="text-xs self-start border border-zinc-700 rounded px-2 py-1 text-zinc-400">hook:{item.hook}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Funil({ insights }: { insights: Insights }) {
  return (
    <section className="grid md:grid-cols-2 gap-6">
      <Card title="Funil comercial">
        <Funnel rows={insights.funnel} />
      </Card>
      <Card title="Atribuição por origem (valor esperado)">
        <BarChart items={insights.sources.map((s) => ({ label: s.source, value: s.expectedBrl }))} value={brl} />
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
      </Card>
    </section>
  );
}

function Leads(props: {
  state: DashboardState;
  can: (p: Permission) => boolean;
  busy: string | null;
  onStage: (lead: Lead, stage: LeadStage) => void;
  onCopy: (lead: Lead) => void;
  onErase: (lead: Lead) => void;
  onCapture: (body: Record<string, unknown>) => void;
  onImport: (csv: string) => void;
}) {
  const { state, can, busy } = props;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState("form");
  const [consent, setConsent] = useState(false);
  const [filter, setFilter] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    props.onCapture({ name, email: email || undefined, phone: phone || undefined, source, consent, utm: "utm_source=console" });
    setName("");
    setEmail("");
    setPhone("");
    setConsent(false);
  }

  const leads = state.leads.filter((l) =>
    `${l.name} ${l.email} ${l.phone} ${l.source}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <section className="grid lg:grid-cols-3 gap-6">
      <div className="space-y-4">
        <form onSubmit={submit} className="border border-zinc-800 rounded-xl p-4 space-y-2 text-sm" aria-label="Captar lead">
          <h2 className="font-medium">Captar lead</h2>
          <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2" placeholder="Nome" aria-label="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2" placeholder="E-mail" aria-label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2" placeholder="WhatsApp / telefone" aria-label="Telefone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <select className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2" aria-label="Origem" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="form">form</option>
            <option value="whatsapp">whatsapp</option>
            <option value="ads">ads</option>
            <option value="referral">referral</option>
          </select>
          <label className="flex items-start gap-2 text-zinc-400 text-xs">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            Titular consentiu com o uso dos dados para contato comercial (LGPD art. 7º, I)
          </label>
          <button disabled={busy === "capture"} className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-60 rounded py-2" type="submit">
            Captar
          </button>
        </form>
        {can("lead.import") && <ImportCsv onImport={props.onImport} busy={busy === "import"} />}
      </div>
      <div className="lg:col-span-2 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="p-3 border-b border-zinc-800">
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm"
            placeholder={`Filtrar ${state.leads.length} leads…`}
            aria-label="Filtrar leads"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="overflow-auto max-h-[36rem]">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500 text-xs sticky top-0 bg-zinc-950">
              <tr>
                <th className="p-3">Lead</th>
                <th>Origem</th>
                <th>Estágio</th>
                <th>Score</th>
                <th>Valor</th>
                <th className="pr-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-zinc-800" data-testid={`lead-row-${lead.id}`}>
                  <td className="p-3">
                    <div>{lead.name}</div>
                    <div className="text-xs text-zinc-500">{lead.email || lead.phone}</div>
                  </td>
                  <td className="text-xs">
                    {lead.source}
                    <div className="text-zinc-600">{lead.consentBasis === "inbound_contact" ? "contato do titular" : lead.consentBasis ?? ""}</div>
                  </td>
                  <td>
                    {can("lead.stage") ? (
                      <select
                        aria-label={`Estágio de ${lead.name}`}
                        value={lead.stage}
                        disabled={busy === `stage:${lead.id}`}
                        onChange={(e) => props.onStage(lead, e.target.value as LeadStage)}
                        className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-xs"
                      >
                        {STAGES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs">{STAGES.find((s) => s.id === lead.stage)?.label}</span>
                    )}
                  </td>
                  <td>{lead.score}</td>
                  <td>{brl(lead.amount)}</td>
                  <td className="pr-3">
                    <div className="flex gap-2 justify-end text-xs">
                      <button type="button" className="text-sky-400 disabled:opacity-50" disabled={busy === `copy:${lead.id}`} onClick={() => props.onCopy(lead)}>
                        {busy === `copy:${lead.id}` ? "Gerando…" : "Gerar copy"}
                      </button>
                      {can("lead.export") && (
                        <a className="text-zinc-400" href={`/api/leads/${lead.id}/export`}>
                          Exportar
                        </a>
                      )}
                      {can("lead.erase") && (
                        <button type="button" className="text-rose-400" onClick={() => props.onErase(lead)}>
                          Apagar
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function ImportCsv({ onImport, busy }: { onImport: (csv: string) => void; busy: boolean }) {
  return (
    <div className="border border-zinc-800 rounded-xl p-4 space-y-2 text-sm">
      <h2 className="font-medium">Importar CSV</h2>
      <p className="text-xs text-zinc-500">
        Exportações de RD Station, Ploomes, Kommo ou planilha. Colunas: nome, e-mail, telefone, origem, etapa, valor, consentimento. Linhas sem
        consentimento são ignoradas.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="Arquivo CSV"
        disabled={busy}
        className="text-xs"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) onImport(await file.text());
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Quantas({ tasks }: { tasks: Task[] }) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.status === col.status);
        return (
          <div key={col.status} className="bg-zinc-900/50 rounded-xl p-3 border border-zinc-800" data-testid={`column-${col.status}`}>
            <h2 className="text-sm text-zinc-400 mb-3 flex justify-between">
              {col.title}
              <span>{items.length}</span>
            </h2>
            <div className="space-y-2">
              {items.map((task) => (
                <article key={task.id} className="p-3 rounded-lg bg-zinc-900 border border-zinc-800">
                  <h3 className="text-sm">{task.title}</h3>
                  <p className="text-xs text-zinc-500 mt-1">{task.assignedAgent || "—"}</p>
                </article>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function citationLabels(citations: string): Array<{ label: string; ref: string }> {
  const refs = citations.split(",").filter(Boolean);
  const memory = refs.filter((r) => r.startsWith("log:"));
  const out: Array<{ label: string; ref: string }> = [];
  for (const ref of refs) {
    if (ref.startsWith("icp:")) out.push({ label: "ICP aprovado", ref });
    if (ref.startsWith("lead:")) out.push({ label: "Dados do lead", ref });
  }
  if (memory.length) out.push({ label: memory.length === 1 ? "1 memória do time" : `${memory.length} memórias do time`, ref: memory.join(",") });
  return out;
}

function Review(props: {
  queue: CopyAsset[];
  decided: CopyAsset[];
  leadNames: Map<string, string>;
  canReview: boolean;
  busy: string | null;
  hasPending: boolean;
  onReview: (copy: CopyAsset, d: "approved" | "rejected") => void;
  onUndo: () => void;
}) {
  const { queue, canReview, onReview, onUndo } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const index = Math.max(0, queue.findIndex((c) => c.id === selectedId));
  const current = queue[index];

  useEffect(() => {
    if (!canReview) return;
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable]")) return;
      const key = e.key.toLowerCase();
      if (key === "u") {
        e.preventDefault();
        onUndo();
        return;
      }
      if (!current) return;
      if (key === "a") onReview(current, "approved");
      else if (key === "r") onReview(current, "rejected");
      else if (key === "j") setSelectedId(queue[Math.min(queue.length - 1, index + 1)].id);
      else if (key === "k") setSelectedId(queue[Math.max(0, index - 1)].id);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canReview, current, index, queue, onReview, onUndo]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium mb-1">Fila de revisão ({queue.length})</h2>
          <p className="text-xs text-zinc-500 max-w-2xl">
            Nenhuma peça sai sem aprovação humana. Cada uma mostra as fontes que a geraram.
            {!canReview && " Seu papel pode ler, mas não aprovar."}
          </p>
        </div>
        {canReview && queue.length > 0 && (
          <p className="text-[11px] text-zinc-500" aria-label="Atalhos de teclado">
            <Kbd>A</Kbd> aprovar · <Kbd>R</Kbd> rejeitar · <Kbd>J</Kbd>/<Kbd>K</Kbd> próxima/anterior · <Kbd>U</Kbd> desfazer
          </p>
        )}
      </div>

      {queue.length === 0 && <p className="text-sm text-zinc-500">Fila vazia. Nada aguardando você.</p>}

      {current && (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_16rem] gap-4">
          <article
            className="border border-amber-500/40 rounded-xl p-4 bg-zinc-900/40 space-y-4"
            data-testid={`copy-${current.id}`}
            aria-label={`Peça em revisão: ${current.title}`}
          >
            <header className="flex flex-wrap justify-between gap-2 items-center">
              <div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-amber-300">Aguardando sua aprovação</p>
                <h3 className="text-base font-medium mt-1">{current.title}</h3>
              </div>
              <span className="text-xs text-zinc-400">
                {current.channel}
                {current.leadId && props.leadNames.get(current.leadId) ? ` · ${props.leadNames.get(current.leadId)}` : ""}
              </span>
            </header>
            <ChannelPreview copy={current} />
            <div className="flex flex-wrap gap-2 text-[11px]" aria-label="Fontes">
              {citationLabels(current.citations).map((c) => (
                <span key={c.ref} title={c.ref} className="rounded-full bg-sky-500/10 text-sky-300 border border-sky-500/20 px-2 py-0.5">
                  Fonte: {c.label}
                </span>
              ))}
            </div>
            {canReview && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={props.busy === `review:${current.id}`}
                  className="bg-emerald-700 hover:bg-emerald-600 px-4 py-2 rounded-lg text-sm font-medium"
                  onClick={() => onReview(current, "approved")}
                >
                  Aprovar <Kbd>A</Kbd>
                </button>
                <button
                  type="button"
                  disabled={props.busy === `review:${current.id}`}
                  className="border border-rose-800 text-rose-300 hover:bg-rose-950 px-4 py-2 rounded-lg text-sm"
                  onClick={() => onReview(current, "rejected")}
                >
                  Rejeitar <Kbd>R</Kbd>
                </button>
              </div>
            )}
          </article>
          {queue.length > 1 && (
            <ol className="space-y-1 text-xs" aria-label="Próximas na fila">
              {queue.map((copy, i) => (
                <li key={copy.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(copy.id)}
                    aria-current={i === index ? "true" : undefined}
                    className={`w-full text-left rounded-lg px-3 py-2 border ${i === index ? "border-amber-500/40 bg-zinc-900" : "border-zinc-800 hover:bg-zinc-900"}`}
                  >
                    <span className="block truncate text-zinc-200">{copy.title}</span>
                    <span className="text-zinc-500">{copy.channel}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {props.decided.length > 0 && (
        <div>
          <h2 className="text-sm font-medium mb-3">Decididas recentemente</h2>
          <ul className="grid md:grid-cols-3 gap-3">
            {props.decided.slice(0, 12).map((copy) => (
              <CopyCard key={copy.id} copy={copy} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[10px] border border-current/40 rounded px-1 opacity-80">{children}</kbd>;
}

/** Mostra a peça como o cliente final vai ver: balão de WhatsApp ou e-mail com assunto. */
function ChannelPreview({ copy }: { copy: CopyAsset }) {
  if (copy.channel === "whatsapp") {
    return (
      <div className="rounded-lg bg-[#0b141a] p-3">
        <p className="ml-auto max-w-md rounded-lg rounded-tr-sm bg-[#005c4b] text-[#e9edef] px-3 py-2 text-sm whitespace-pre-wrap">{copy.body}</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 text-sm">
      <p className="border-b border-zinc-800 px-3 py-2 text-zinc-400">
        Assunto: <span className="text-zinc-200">{copy.title}</span>
      </p>
      <pre className="whitespace-pre-wrap font-sans text-zinc-200 px-3 py-3 max-h-72 overflow-auto">{copy.body}</pre>
    </div>
  );
}

function UndoToast({ pending, onUndo, onConfirm }: { pending: PendingDecision; onUndo: () => void; onConfirm: () => void }) {
  const approved = pending.decision === "approved";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="undo-toast"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(28rem,calc(100%-2rem))] rounded-xl bg-zinc-100 text-zinc-900 shadow-2xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="flex-1 min-w-0 truncate">
          {approved ? "Aprovando" : "Rejeitando"} “{pending.copy.title}”
        </span>
        <button type="button" onClick={onUndo} className="font-semibold underline underline-offset-2">
          Desfazer
        </button>
        <button type="button" onClick={onConfirm} className="text-zinc-600 hover:text-zinc-900">
          Confirmar agora
        </button>
      </div>
      <div
        key={pending.copy.id + pending.startedAt}
        className={`h-1 origin-left ${approved ? "bg-emerald-600" : "bg-rose-600"}`}
        style={{ animation: `omni-shrink ${UNDO_MS}ms linear forwards` }}
      />
      <style>{"@keyframes omni-shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}"}</style>
    </div>
  );
}

function CopyCard({ copy, children }: { copy: CopyAsset; children?: ReactNode }) {
  const color = copy.status === "approved" ? "text-emerald-400" : copy.status === "rejected" ? "text-rose-400" : "text-amber-300";
  return (
    <li className="border border-zinc-800 rounded-lg p-3 text-xs" data-testid={`copy-${copy.id}`}>
      <div className="flex justify-between text-zinc-500 mb-1">
        <span>{copy.channel}</span>
        <span className={color}>{copy.status}</span>
      </div>
      <p className="text-sm text-zinc-200 mb-1">{copy.title}</p>
      <pre className="whitespace-pre-wrap text-zinc-300 max-h-48 overflow-auto font-sans">{copy.body}</pre>
      <p className="text-[11px] text-zinc-600 mt-2 break-all">fontes: {copy.citations}</p>
      {children}
    </li>
  );
}

function Icp({ state, canApprove, onSave }: { state: DashboardState; canApprove: boolean; onSave: (f: Record<string, string>, approve: boolean) => void }) {
  const icp = state.icp;
  const [fields, setFields] = useState<Record<string, string>>({
    persona: icp?.persona ?? "",
    pains: icp?.pains ?? "",
    language: icp?.language ?? "",
    channels: icp?.channels ?? "",
    offer: icp?.offer ?? "",
    exclusions: icp?.exclusions ?? "",
  });
  const labels: Record<string, string> = {
    persona: "Persona (quem compra)",
    pains: "Dores",
    language: "Tom de voz",
    channels: "Canais (separados por vírgula)",
    offer: "Oferta (o que levar)",
    exclusions: "Exclusões (quem não atender)",
  };
  return (
    <section className="max-w-2xl space-y-3 text-sm">
      <p className="text-zinc-400">
        Status: <span className={icp?.status === "approved" ? "text-emerald-400" : "text-amber-300"}>{icp?.status ?? "—"}</span>. Copy só é gerada a partir de ICP aprovado.
      </p>
      {Object.keys(labels).map((key) => (
        <label key={key} className="block space-y-1">
          <span className="text-zinc-400">{labels[key]}</span>
          <textarea
            value={fields[key]}
            onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            rows={key === "persona" || key === "offer" ? 2 : 1}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
          />
        </label>
      ))}
      <div className="flex gap-2">
        {canApprove && (
          <button type="button" className="bg-emerald-700 hover:bg-emerald-600 rounded px-4 py-2" onClick={() => onSave(fields, true)}>
            Salvar e aprovar
          </button>
        )}
        <button type="button" className="border border-zinc-700 rounded px-4 py-2" onClick={() => onSave(fields, false)} disabled={!canApprove}>
          Salvar rascunho
        </button>
      </div>
    </section>
  );
}

function Memoria({ state }: { state: DashboardState }) {
  const [q, setQ] = useState("leads frios whatsapp copy");
  const [hits, setHits] = useState<Array<{ id: string; score: number; logContent: string; agentId: string }>>([]);
  async function search(e: FormEvent) {
    e.preventDefault();
    const data = await call<{ hits: typeof hits }>(`/api/memory?q=${encodeURIComponent(q)}`);
    setHits(data.hits);
  }
  const rows = hits.length ? hits : state.logs.slice(0, 10).map((l) => ({ id: l.id, score: 0, logContent: l.logContent, agentId: l.agentId }));
  return (
    <section className="space-y-4">
      <form onSubmit={search} className="flex gap-2">
        <input className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Busca na memória" />
        <button className="bg-indigo-600 rounded px-4 text-sm" type="submit">
          Buscar
        </button>
      </form>
      <ul className="space-y-2">
        {rows.map((hit) => (
          <li key={hit.id} className="border border-zinc-800 rounded-lg p-3 text-sm">
            <div className="text-xs text-zinc-500 mb-1">
              {hit.agentId}
              {hit.score ? ` · similaridade ${hit.score.toFixed(2)}` : ""}
            </div>
            {hit.logContent}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Agentes({ onRun }: { onRun: () => Promise<void> }) {
  const [agent, setAgent] = useState<OpsAgentName>("analyst");
  const [prompt, setPrompt] = useState("Onde eu dobro aquisição na próxima semana?");
  const [out, setOut] = useState<OpsAgentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setOut(await call<OpsAgentResult>("/api/agents/run", { method: "POST", body: JSON.stringify({ agent, prompt }) }));
      await onRun();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Falha");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid lg:grid-cols-2 gap-6">
      <form onSubmit={run} className="border border-zinc-800 rounded-xl p-4 space-y-3 text-sm">
        <h2 className="font-medium">Despachar agente</h2>
        <p className="text-zinc-500 text-xs">Mesmo contrato do MCP (`run_ops_agent`). Toda execução vira memória pesquisável.</p>
        <select className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2" value={agent} onChange={(e) => setAgent(e.target.value as OpsAgentName)} aria-label="Agente">
          <option value="analyst">analyst — métricas e projeção</option>
          <option value="scout">scout — onde caçar lead</option>
          <option value="icp">icp — o que levar ao lead</option>
          <option value="copywriter">copywriter — peça para Human Review</option>
        </select>
        <textarea className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 min-h-24" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Pedido" />
        <button disabled={busy} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 rounded px-4 py-2" type="submit">
          {busy ? "Rodando…" : "Rodar"}
        </button>
        {err && <p className="text-rose-400 text-xs">{err}</p>}
      </form>
      <pre className="border border-zinc-800 rounded-xl p-4 text-xs whitespace-pre-wrap text-zinc-300 min-h-64">{out?.report ?? "A saída do agente aparece aqui."}</pre>
    </section>
  );
}

/** Barras diárias do mês: mostra quando os resultados aconteceram, não só quantos. */
function DailyBars({ month, dates }: { month: string; dates: string[] }) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const counts = Array.from({ length: days }, () => 0);
  for (const d of dates) if (d.startsWith(month)) counts[Number(d.slice(8, 10)) - 1]++;
  const max = Math.max(1, ...counts);
  return (
    <svg viewBox={`0 0 ${days * 4} 16`} className="w-28 h-4 mt-1" role="img" aria-label={`Por dia: ${counts.join(", ")}`}>
      {counts.map((c, i) => (
        <rect key={i} x={i * 4} y={16 - (c / max) * 16} width={3} height={Math.max(c ? 2 : 0.5, (c / max) * 16)} fill={c ? "#38bdf8" : "#3f3f46"} />
      ))}
    </svg>
  );
}

function Faturamento({ state }: { state: DashboardState }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    call<BillingUsage>(`/api/billing/usage?month=${month}`)
      .then(setUsage)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Falha"));
  }, [month]);
  return (
    <section className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium">Resultados faturáveis</h2>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mês" className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm" />
      </div>
      <p className="text-xs text-zinc-500">
        Cobrança por resultado auditável: cada linha nasce de uma ação humana ou harness registrada (agente sozinho não gera cobrança) e é idempotente
        por lead/peça.
      </p>
      {err && <p className="text-rose-400 text-sm">{err}</p>}
      {usage && (
        <>
          <table className="w-full text-sm border border-zinc-800 rounded-xl overflow-hidden" data-testid="billing-table">
            <thead className="bg-zinc-900 text-xs text-zinc-500 text-left">
              <tr>
                <th className="p-2">Resultado</th>
                <th>Qtd.</th>
                <th>Unitário</th>
                <th className="pr-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-800">
                <td className="p-2">Plataforma (mensal)</td>
                <td>1</td>
                <td>{cents(usage.baseFeeCents)}</td>
                <td className="pr-2 text-right">{cents(usage.baseFeeCents)}</td>
              </tr>
              {usage.lines.map((line) => (
                <tr key={line.kind} className="border-t border-zinc-800" data-testid={`billing-${line.kind}`}>
                  <td className="p-2">
                    {BILL_LABEL[line.kind]}
                    <DailyBars month={usage.month} dates={usage.ledger.filter((e) => e.kind === line.kind).map((e) => e.createdAt)} />
                  </td>
                  <td>{line.count}</td>
                  <td>{cents(line.unitCents)}</td>
                  <td className="pr-2 text-right">{cents(line.subtotalCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-zinc-700 font-semibold">
                <td className="p-2" colSpan={3}>
                  Total
                </td>
                <td className="pr-2 text-right" data-testid="billing-total">
                  {cents(usage.totalCents)}
                </td>
              </tr>
            </tbody>
          </table>
          <div>
            <h3 className="text-sm font-medium mb-2">Extrato ({usage.ledger.length} eventos)</h3>
            {usage.ledger.length === 0 && <p className="text-xs text-zinc-500">Nenhum resultado faturável neste mês.</p>}
            {usage.ledger.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-zinc-300" data-testid="billing-ledger">
                  <thead className="text-left text-zinc-500 border-b border-zinc-800">
                    <tr>
                      <th className="py-1 pr-2">Quando</th>
                      <th className="pr-2">Resultado</th>
                      <th className="pr-2">Referente a</th>
                      <th className="pr-2">Quem decidiu</th>
                      <th className="text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...usage.ledger]
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                      .slice(0, 100)
                      .map((e) => (
                        <tr key={e.id} className="border-b border-zinc-900">
                          <td className="py-1 pr-2 font-mono whitespace-nowrap">{e.createdAt.slice(5, 16).replace("T", " ")}</td>
                          <td className="pr-2">{BILL_LABEL[e.kind]?.split(" (")[0] ?? e.kind}</td>
                          <td className="pr-2">{ledgerRef(state, e.kind, e.refId)}</td>
                          <td className="pr-2 font-mono">{e.actor}</td>
                          <td className="text-right font-mono">{cents(usage.lines.find((l) => l.kind === e.kind)?.unitCents ?? 0)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ledgerRef(state: DashboardState, kind: string, refId: string): string {
  if (kind === "copy_approved") return state.copies.find((c) => c.id === refId)?.title ?? "peça removida";
  return state.leads.find((l) => l.id === refId)?.name ?? "titular anonimizado (LGPD)";
}

type Keys = { apiKey: string; harnessKey: string | null; captureKey: string | null; whatsappPhoneId: string | null; users: SessionUser[] };

function Integracoes() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [phoneId, setPhoneId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  useEffect(() => {
    call<Keys>("/api/org/keys")
      .then((k) => {
        setKeys(k);
        setPhoneId(k.whatsappPhoneId ?? "");
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Falha"));
  }, []);

  async function post(body: Record<string, unknown>) {
    try {
      const k = await call<Keys>("/api/org/keys", { method: "POST", body: JSON.stringify(body) });
      setKeys((prev) => (prev ? { ...prev, ...k } : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Falha");
    }
  }

  if (!keys) return <p className="text-sm text-zinc-500">{err ?? "Carregando…"}</p>;

  const snippet = `<form action="${origin}/api/capture" method="post">
  <input type="hidden" name="key" value="${keys.captureKey}">
  <input name="name" placeholder="Nome" required>
  <input name="email" type="email" placeholder="E-mail">
  <input name="phone" placeholder="WhatsApp">
  <input name="website" style="display:none" tabindex="-1" autocomplete="off">
  <label><input type="checkbox" name="consent" required>
    Aceito ser contatado e o uso dos meus dados (LGPD)</label>
  <button>Quero falar com vocês</button>
</form>`;
  const mcp = JSON.stringify(
    { mcpServers: { "omni-crm": { url: `${origin}/api/mcp-server`, headers: { Authorization: `Bearer ${keys.apiKey}` } } } },
    null,
    2,
  );

  return (
    <section className="grid md:grid-cols-2 gap-4 text-sm">
      {err && <p className="text-rose-400 md:col-span-2">{err}</p>}
      <Card title="MCP para agentes (Claude Code, Cursor)">
        <p className="text-xs text-zinc-500 mb-2">Chave de agente: move Quantas até in_review, propõe ICP, cria peças. Não aprova nem fatura.</p>
        <pre className="text-[11px] bg-zinc-950 p-3 rounded overflow-auto text-zinc-300">{mcp}</pre>
        <p className="text-xs text-zinc-500 mt-2">
          Claude Code: <code className="text-zinc-300">claude mcp add --transport http omni-crm {origin}/api/mcp-server --header &quot;Authorization: Bearer …&quot;</code>
        </p>
      </Card>
      <Card title="Chaves">
        <dl className="space-y-3 text-xs">
          {[
            { label: "Agente (MCP)", value: keys.apiKey, kind: "api" },
            { label: "Harness (CI / automação que fecha trabalho)", value: keys.harnessKey, kind: "harness" },
            { label: "Captura pública (vai no site)", value: keys.captureKey, kind: "capture" },
          ].map((k) => (
            <div key={k.kind}>
              <dt className="text-zinc-500">{k.label}</dt>
              <dd className="flex gap-2 items-center">
                <code className="bg-zinc-950 px-2 py-1 rounded break-all flex-1">{k.value ?? "—"}</code>
                <button
                  type="button"
                  className="border border-zinc-700 rounded px-2 py-1 shrink-0"
                  onClick={() => window.confirm("Rotacionar invalida a chave atual imediatamente. Continuar?") && void post({ rotate: k.kind })}
                >
                  Rotacionar
                </button>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Formulário de captura (cole no site)">
        <p className="text-xs text-zinc-500 mb-2">Funciona sem JavaScript. Honeypot anti-bot, consentimento obrigatório, limite por IP.</p>
        <pre className="text-[11px] bg-zinc-950 p-3 rounded overflow-auto text-zinc-300">{snippet}</pre>
      </Card>
      <Card title="WhatsApp Cloud API">
        <p className="text-xs text-zinc-500">
          Webhook (Meta → Configuração): <code className="text-zinc-300">{origin}/api/webhooks/whatsapp</code>. Mensagens recebidas viram lead com base legal
          &quot;contato do titular&quot;. Assinatura <code>X-Hub-Signature-256</code> validada.
        </p>
        <form
          className="flex gap-2 mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void post({ whatsappPhoneId: phoneId });
          }}
        >
          <input
            value={phoneId}
            onChange={(e) => setPhoneId(e.target.value)}
            placeholder="phone_number_id"
            aria-label="phone_number_id do WhatsApp"
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs"
          />
          <button className="border border-zinc-700 rounded px-3 py-1 text-xs" type="submit">
            Salvar
          </button>
        </form>
      </Card>
      <Card title="Equipe" className="md:col-span-2">
        <ul className="text-xs text-zinc-400 grid md:grid-cols-3 gap-2">
          {keys.users.map((u) => (
            <li key={u.id} className="border border-zinc-800 rounded px-2 py-1">
              {u.name} · {u.email} · {ROLE_LABEL[u.role]}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
