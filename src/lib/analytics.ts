import type { CopyAsset, IcpProfile, Lead, LeadStage, Task } from "./types";
import {
  fitLinear,
  fitQuadratic,
  predictLinear,
  predictQuadratic,
  rSquared,
  type SeriesPoint,
} from "./forecast";

const STAGE_PROB: Record<LeadStage, number> = {
  new: 0.08,
  qualified: 0.18,
  nurturing: 0.28,
  proposal: 0.55,
  won: 1,
  lost: 0,
};

const STAGE_ORDER: LeadStage[] = [
  "new",
  "qualified",
  "nurturing",
  "proposal",
  "won",
  "lost",
];

export type SourceSlice = {
  source: string;
  leads: number;
  won: number;
  pipelineBrl: number;
  expectedBrl: number;
  avgScore: number;
  winRate: number;
};

export type NextAction = {
  leadId: string;
  name: string;
  stage: LeadStage;
  source: string;
  action: string;
  why: string;
  hook: "scout" | "copywriter" | "icp" | "analyst" | "human";
};

export type Insights = {
  kpis: {
    leads: number;
    won: number;
    lost: number;
    winRate: number;
    avgScore: number;
    pipelineBrl: number;
    expectedBrl: number;
    coverage: number;
    reviewBacklog: number;
    doneRate: number;
  };
  funnel: Array<{ stage: LeadStage; count: number; conversionFromPrev: number | null }>;
  sources: SourceSlice[];
  series: {
    days: string[];
    leads: number[];
    linear: number[];
    parabola: number[];
    forecast7Linear: number[];
    forecast7Parabola: number[];
    linearR2: number;
    parabolaR2: number;
    slopePerDay: number;
    curvature: number;
  };
  nextActions: NextAction[];
  whereToHunt: string;
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function brlAmount(lead: Lead): number {
  return lead.amount ?? 0;
}

export function buildInsights(input: {
  leads: Lead[];
  tasks: Task[];
  copies: CopyAsset[];
  icp: IcpProfile | null;
}): Insights {
  const { leads, tasks, copies, icp } = input;
  const won = leads.filter((l) => l.stage === "won");
  const lost = leads.filter((l) => l.stage === "lost");
  const open = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const pipelineBrl = open.reduce((s, l) => s + brlAmount(l), 0);
  const expectedBrl = leads.reduce((s, l) => s + brlAmount(l) * STAGE_PROB[l.stage], 0);
  const avgScore = leads.length ? leads.reduce((s, l) => s + l.score, 0) / leads.length : 0;
  const decided = won.length + lost.length;
  const winRate = decided ? won.length / decided : 0;
  const reviewBacklog = tasks.filter((t) => t.status === "in_review").length;
  const doneRate = tasks.length
    ? tasks.filter((t) => t.status === "done").length / tasks.length
    : 0;

  const funnel = STAGE_ORDER.map((stage, idx) => {
    const count = leads.filter((l) => l.stage === stage).length;
    if (idx === 0) return { stage, count, conversionFromPrev: null as number | null };
    const prevCount = leads.filter((l) => l.stage === STAGE_ORDER[idx - 1]).length;
    return {
      stage,
      count,
      conversionFromPrev: prevCount > 0 ? count / prevCount : null,
    };
  });

  const sourceNames = [...new Set(leads.map((l) => l.source || "unknown"))];
  const sources: SourceSlice[] = sourceNames
    .map((source) => {
      const slice = leads.filter((l) => l.source === source);
      const w = slice.filter((l) => l.stage === "won");
      const lss = slice.filter((l) => l.stage === "lost");
      const dec = w.length + lss.length;
      return {
        source,
        leads: slice.length,
        won: w.length,
        pipelineBrl: slice.filter((l) => l.stage !== "won" && l.stage !== "lost").reduce((s, l) => s + brlAmount(l), 0),
        expectedBrl: slice.reduce((s, l) => s + brlAmount(l) * STAGE_PROB[l.stage], 0),
        avgScore: slice.reduce((s, l) => s + l.score, 0) / (slice.length || 1),
        winRate: dec ? w.length / dec : 0,
      };
    })
    .sort((a, b) => b.expectedBrl - a.expectedBrl);

  const byDay = new Map<string, number>();
  for (const lead of leads) {
    const k = dayKey(lead.createdAt);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const filled: string[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    filled.push(d.toISOString().slice(0, 10));
  }
  const axis = filled;
  const ys = axis.map((d) => byDay.get(d) ?? 0);
  const pts: SeriesPoint[] = ys.map((y, x) => ({ x, y }));
  const lin = fitLinear(pts);
  const quad = fitQuadratic(pts);
  const linear = pts.map((p) => Math.max(0, predictLinear(lin, p.x)));
  const parabola = pts.map((p) => Math.max(0, predictQuadratic(quad, p.x)));
  const forecast7Linear = Array.from({ length: 7 }, (_, i) =>
    Math.max(0, predictLinear(lin, pts.length + i)),
  );
  const forecast7Parabola = Array.from({ length: 7 }, (_, i) =>
    Math.max(0, predictQuadratic(quad, pts.length + i)),
  );

  const nextActions: NextAction[] = leads
    .filter((l) => l.stage !== "won" && l.stage !== "lost")
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((lead) => recommend(lead, icp, copies));

  const bestSource = sources[0];
  const whereToHunt = bestSource
    ? `Dobrar ${bestSource.source}: EV ${fmt(bestSource.expectedBrl)} · score médio ${bestSource.avgScore.toFixed(0)} · ${bestSource.leads} leads. ${icp ? `ICP canal: ${icp.channels}.` : ""}`
    : "Ainda não há volume suficiente para apontar um canal.";

  const approvedCopy = copies.filter((c) => c.status === "approved").length;
  const coverage = leads.length ? approvedCopy / leads.length : 0;

  return {
    kpis: {
      leads: leads.length,
      won: won.length,
      lost: lost.length,
      winRate,
      avgScore,
      pipelineBrl,
      expectedBrl,
      coverage,
      reviewBacklog,
      doneRate,
    },
    funnel,
    sources,
    series: {
      days: axis,
      leads: ys,
      linear,
      parabola,
      forecast7Linear,
      forecast7Parabola,
      linearR2: rSquared(pts, (x) => predictLinear(lin, x)),
      parabolaR2: rSquared(pts, (x) => predictQuadratic(quad, x)),
      slopePerDay: lin.slope,
      curvature: quad.c,
    },
    nextActions,
    whereToHunt,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function recommend(lead: Lead, icp: IcpProfile | null, copies: CopyAsset[]): NextAction {
  const hasCopy = copies.some((c) => c.leadId === lead.id && c.status !== "rejected");
  if (lead.stage === "new" && lead.source === "whatsapp") {
    return {
      leadId: lead.id,
      name: lead.name,
      stage: lead.stage,
      source: lead.source,
      action: "Hook curto no WhatsApp com a dor do ICP",
      why: "Origem conversacional — copy de e-mail perde o timing.",
      hook: "copywriter",
    };
  }
  if (lead.stage === "new" && (lead.source === "ads" || lead.utm.includes("ads"))) {
    return {
      leadId: lead.id,
      name: lead.name,
      stage: lead.stage,
      source: lead.source,
      action: "Qualificar UTM e mandar landing alinhada ao anúncio",
      why: "Lead pago: mismatch de mensagem queima CAC.",
      hook: "scout",
    };
  }
  if (lead.stage === "new") {
    return {
      leadId: lead.id,
      name: lead.name,
      stage: lead.stage,
      source: lead.source,
      action: "Qualificar (BANT leve) e só então gerar peça",
      why: "Inbound frio. Score " + lead.score,
      hook: "analyst",
    };
  }
  if ((lead.stage === "qualified" || lead.stage === "nurturing") && !hasCopy) {
    return {
      leadId: lead.id,
      name: lead.name,
      stage: lead.stage,
      source: lead.source,
      action: `Gerar sequência ${icp?.channels.split(",")[0] ?? "e-mail"}`,
      why: "Estágio pede nutrição; ainda não há copy ligada a este lead.",
      hook: "copywriter",
    };
  }
  if (lead.stage === "proposal") {
    return {
      leadId: lead.id,
      name: lead.name,
      stage: lead.stage,
      source: lead.source,
      action: "Humano revisar proposta / copy in_review",
      why: "Fechamento é Human Review, não agente sozinho.",
      hook: "human",
    };
  }
  return {
    leadId: lead.id,
    name: lead.name,
    stage: lead.stage,
    source: lead.source,
    action: "Manter cadência e registrar memória do ciclo",
    why: icp?.pains ?? "Sem ICP extra.",
    hook: "icp",
  };
}
