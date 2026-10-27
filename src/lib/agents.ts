import { buildInsights, type Insights } from "./analytics";
import { StoreError, type OmniStore } from "./store";
import type { AuthContext } from "./types";

export type OpsAgentName = "analyst" | "copywriter" | "scout" | "icp";

export type OpsAgentResult = {
  agent: OpsAgentName;
  report: string;
  citations: string[];
  insights?: Insights;
  copyId?: string;
  memory?: Array<{ id: string; score: number; logContent: string }>;
};

export function runOpsAgent(
  store: OmniStore,
  auth: AuthContext,
  input: {
    agent: OpsAgentName;
    prompt?: string;
    leadId?: string;
    channel?: string;
    projectId?: string;
  },
): OpsAgentResult {
  const projectId = input.projectId ?? store.listProjects(auth.org.id)[0]?.id;
  const icp = store.getIcp(auth.org.id, projectId) ?? null;
  const insights = buildInsights({
    leads: store.listLeads(auth.org.id),
    tasks: store.listTasks(auth.org.id),
    copies: store.listCopies(auth.org.id),
    icp,
  });

  if (input.agent === "copywriter") {
    if (!projectId) throw new StoreError("projectId required", 404);
    const copy = store.createCopyJob(auth, {
      projectId,
      leadId: input.leadId,
      channel: input.channel ?? "email",
    });
    store.appendAgentLog(auth, {
      actionType: "COPY",
      projectId,
      logContent: `copywriter hook: ${copy.id} ${input.prompt ?? ""}`.trim(),
    });
    return {
      agent: "copywriter",
      report: copy.body,
      citations: copy.citations.split(","),
      copyId: copy.id,
      insights,
    };
  }

  const query =
    input.prompt ||
    [icp?.persona, icp?.pains, insights.whereToHunt, input.leadId].filter(Boolean).join(" ");
  const memory = store.searchMemory(auth.org.id, query, 5).map((m) => ({
    id: m.id,
    score: m.score,
    logContent: m.logContent,
  }));

  if (input.agent === "scout") {
    const top = insights.sources[0];
    const report = [
      "Scout — onde buscar o próximo lead",
      insights.whereToHunt,
      top
        ? `Canal #1 ${top.source}: ${top.leads} leads, win rate ${(top.winRate * 100).toFixed(0)}%, EV R$ ${Math.round(top.expectedBrl)}.`
        : "",
      `Tendência linear: ${insights.series.slopePerDay >= 0 ? "alta" : "queda"} de ${insights.series.slopePerDay.toFixed(2)} leads/dia (R² ${insights.series.linearR2.toFixed(2)}).`,
      `Curvatura parabólica c=${insights.series.curvature.toFixed(3)} — ${insights.series.curvature > 0 ? "aceleração" : insights.series.curvature < 0 ? "desaceleração" : "sem curvatura"}.`,
      input.prompt ? `Pedido: ${input.prompt}` : "",
      "Memória:",
      ...memory.map((m) => `· (${m.score.toFixed(2)}) ${m.logContent}`),
    ]
      .filter(Boolean)
      .join("\n");
    store.appendAgentLog(auth, {
      actionType: "ANALYSIS",
      projectId,
      logContent: report.slice(0, 2000),
    });
    return { agent: "scout", report, citations: memory.map((m) => `log:${m.id}`), insights, memory };
  }

  if (input.agent === "icp") {
    const report = icp
      ? [
          "ICP vigente",
          `Persona: ${icp.persona}`,
          `Dores: ${icp.pains}`,
          `Canais: ${icp.channels}`,
          `Oferta: ${icp.offer}`,
          `Exclusões: ${icp.exclusions}`,
          `Status: ${icp.status}`,
          "O que levar ao lead: a oferta acima na linguagem do perfil, nunca o contrário do canal de origem.",
        ].join("\n")
      : "Sem ICP. Humano precisa aprovar um perfil antes de copy em massa.";
    store.appendAgentLog(auth, {
      actionType: "ANALYSIS",
      projectId,
      logContent: report,
    });
    return { agent: "icp", report, citations: icp ? [`icp:${icp.id}`] : [], insights };
  }

  const report = [
    "Analyst — operação (vendas + quantas + memória)",
    `Leads ${insights.kpis.leads} · ganho ${insights.kpis.won} · perdido ${insights.kpis.lost} · win rate ${(insights.kpis.winRate * 100).toFixed(0)}%`,
    `Pipeline aberto R$ ${Math.round(insights.kpis.pipelineBrl)} · valor esperado R$ ${Math.round(insights.kpis.expectedBrl)}`,
    `Score médio ${insights.kpis.avgScore.toFixed(0)} · cobertura de copy ${(insights.kpis.coverage * 100).toFixed(0)}%`,
    `Quantas done ${(insights.kpis.doneRate * 100).toFixed(0)}% · backlog review ${insights.kpis.reviewBacklog}`,
    insights.whereToHunt,
    "Próximas jogadas:",
    ...insights.nextActions.slice(0, 5).map((a) => `· ${a.name} [${a.stage}/${a.source}] → ${a.action} (${a.hook})`),
    input.prompt ? `Contexto do operador: ${input.prompt}` : "",
    "Memória vetorial:",
    ...memory.map((m) => `· (${m.score.toFixed(2)}) ${m.logContent}`),
  ]
    .filter(Boolean)
    .join("\n");
  store.appendAgentLog(auth, {
    actionType: "ANALYSIS",
    projectId,
    logContent: report.slice(0, 2000),
  });
  return { agent: "analyst", report, citations: memory.map((m) => `log:${m.id}`), insights, memory };
}
