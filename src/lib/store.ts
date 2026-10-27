import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embedText, encodeEmbedding, decodeEmbedding, cosine, EMBEDDING_MODEL } from "./embeddings";
import { buildInsights } from "./analytics";
import type {
  ActorRole,
  AgentLog,
  AuthContext,
  CopyAsset,
  CopyStatus,
  DashboardState,
  IcpProfile,
  IcpStatus,
  Lead,
  LeadEvent,
  LeadStage,
  Organization,
  Pipeline,
  PipelineStage,
  Project,
  Task,
  TaskStatus,
} from "./types";

const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "in_review", "done"];
const LEAD_STAGES: LeadStage[] = [
  "new",
  "qualified",
  "nurturing",
  "proposal",
  "won",
  "lost",
];

export class StoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function canMarkDone(role: ActorRole): boolean {
  return role === "human" || role === "harness";
}

function assertTransition(from: TaskStatus, to: TaskStatus, role: ActorRole) {
  if (from === to) return;
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    todo: ["in_progress"],
    in_progress: ["in_review", "todo"],
    in_review: ["in_progress", "done"],
    done: ["todo", "in_progress"],
  };
  if (!allowed[from].includes(to)) {
    throw new StoreError(`Illegal transition ${from} → ${to}`, 409);
  }
  if (to === "done" && !canMarkDone(role)) {
    throw new StoreError("Only human or harness may mark a task done", 403);
  }
  if (from === "done" && !canMarkDone(role)) {
    throw new StoreError("Only human or harness may reopen a done task", 403);
  }
}

export class OmniStore {
  private db: DatabaseSync;
  readonly path: string;

  private constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  static open(path: string): OmniStore {
    return new OmniStore(path);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        harness_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT 'Cursor',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','in_review','done')),
        assigned_agent TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_logs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        agent_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        log_content TEXT NOT NULL,
        embedding TEXT,
        embedding_model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pipeline_stages (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        lead_stage TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS icp_profiles (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        persona TEXT NOT NULL,
        pains TEXT NOT NULL,
        language TEXT NOT NULL,
        channels TEXT NOT NULL,
        offer TEXT NOT NULL,
        exclusions TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','approved')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        utm TEXT NOT NULL DEFAULT '',
        consent INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        stage TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        external_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (org_id, email),
        UNIQUE (org_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS lead_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS copy_assets (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
        icp_id TEXT NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        tone TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        citations TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','in_review','approved','rejected')),
        version INTEGER NOT NULL DEFAULT 1,
        embedding TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id, status);
      CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id, stage);
      CREATE INDEX IF NOT EXISTS idx_logs_org ON agent_logs(org_id);
    `);
    this.ensureColumns();
  }

  private ensureColumns(): void {
    const leadCols = this.db.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>;
    if (!leadCols.some((c) => c.name === "amount")) {
      this.db.exec("ALTER TABLE leads ADD COLUMN amount INTEGER NOT NULL DEFAULT 0");
    }
    const orgCols = this.db.prepare("PRAGMA table_info(organizations)").all() as Array<{ name: string }>;
    if (!orgCols.some((c) => c.name === "harness_key")) {
      this.db.exec("ALTER TABLE organizations ADD COLUMN harness_key TEXT");
    }
  }

  ensureSeed(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM organizations").get() as { c: number };
    if (count.c > 0) return;
    this.seedOrg({
      orgId: "org-acme",
      name: "Acme Vendas",
      apiKey: "omni_org_acme_demo",
      harnessKey: "omni_org_acme_harness_demo",
      projectId: "proj-acme-outbound",
      projectName: "Outbound B2B",
      persona: true,
      leadCount: 18,
    });
    this.seedOrg({
      orgId: "org-beta",
      name: "Beta Labs",
      apiKey: "omni_org_beta_demo",
      harnessKey: "omni_org_beta_harness_demo",
      projectId: "proj-beta-internal",
      projectName: "Labs interno",
      persona: false,
      leadCount: 2,
    });
  }

  private seedOrg(opts: {
    orgId: string;
    name: string;
    apiKey: string;
    harnessKey: string;
    projectId: string;
    projectName: string;
    persona: boolean;
    leadCount: number;
  }): void {
    const ts = nowIso();
    this.db.prepare(
      "INSERT INTO organizations (id, name, api_key, harness_key, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(opts.orgId, opts.name, opts.apiKey, opts.harnessKey, ts);
    this.db.prepare(
      `INSERT INTO projects (id, org_id, name, description, platform, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Cursor', 'active', ?, ?)`,
    ).run(
      opts.projectId,
      opts.orgId,
      opts.projectName,
      "Projeto de venda monitorado pelo Omni-CRM",
      ts,
      ts,
    );

    const taskDefs: Array<[string, string, TaskStatus, string]> = [
      [`task-${opts.orgId}-1`, "Qualificar inbound da semana", "todo", ""],
      [`task-${opts.orgId}-2`, "Atualizar ICP com wins recentes", "in_progress", "cursor-agent"],
      [`task-${opts.orgId}-3`, "Revisar sequência de e-mail", "in_review", "omni-copywriter"],
      [`task-${opts.orgId}-4`, "Schema inicial e seed", "done", "omni-repair"],
    ];
    const insTask = this.db.prepare(
      `INSERT INTO tasks (id, org_id, project_id, title, description, status, assigned_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
    );
    for (const [tid, title, status, agent] of taskDefs) {
      insTask.run(tid, opts.orgId, opts.projectId, title, status, agent, ts, ts);
    }

    const pipeId = `pipe-${opts.orgId}`;
    this.db.prepare(
      "INSERT INTO pipelines (id, org_id, project_id, name) VALUES (?, ?, ?, ?)",
    ).run(pipeId, opts.orgId, opts.projectId, "Pipeline comercial");
    const stages: Array<[LeadStage, string, number]> = [
      ["new", "Novo", 0],
      ["qualified", "Qualificado", 1],
      ["nurturing", "Nutrição", 2],
      ["proposal", "Proposta", 3],
      ["won", "Ganho", 4],
      ["lost", "Perdido", 5],
    ];
    const insStage = this.db.prepare(
      `INSERT INTO pipeline_stages (id, org_id, pipeline_id, name, position, lead_stage)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [stage, label, pos] of stages) {
      insStage.run(`st-${opts.orgId}-${stage}`, opts.orgId, pipeId, label, pos, stage);
    }

    const companyId = `co-${opts.orgId}`;
    this.db.prepare("INSERT INTO companies (id, org_id, name) VALUES (?, ?, ?)").run(
      companyId,
      opts.orgId,
      opts.persona ? "Clínicas e SaaS B2B" : "Contas internas",
    );

    const icpId = `icp-${opts.orgId}`;
    this.db.prepare(
      `INSERT INTO icp_profiles (id, org_id, project_id, persona, pains, language, channels, offer, exclusions, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      icpId,
      opts.orgId,
      opts.projectId,
      opts.persona
        ? "Diretor comercial de operação B2B com 5–50 vendedores"
        : "Time interno de produto",
      opts.persona
        ? "Leads frios, copy genérica, zero memória entre agentes"
        : "Retrabalho entre agentes de código",
      opts.persona ? "Direto, evidência, português BR" : "Técnico e curto",
      opts.persona ? "WhatsApp, e-mail, landing" : "Slack interno",
      opts.persona
        ? "CRM com agentes que entendem ICP e escrevem copy com revisão humana"
        : "Hub de Quantas",
      opts.persona ? "Consumer, infoproduto sem consentimento" : "Contas de cliente final",
      "approved",
      ts,
    );

    const names = [
      "Ana Souza",
      "Bruno Lima",
      "Carla Dias",
      "Diego Alves",
      "Elena Prado",
      "Fábio Nunes",
      "Gabi Rocha",
      "Hugo Martins",
      "Iris Pires",
      "João Klein",
      "Lia Costa",
      "Marcos Tavares",
      "Nina Bel",
      "Otto Faria",
      "Paula Reis",
      "Quintino Barros",
      "Rita Lopes",
      "Sergio Vale",
    ];
    const sourceCycle = ["form", "whatsapp", "ads", "referral"] as const;
    const stageCycle: LeadStage[] = [
      "new",
      "new",
      "qualified",
      "nurturing",
      "proposal",
      "won",
      "lost",
      "qualified",
      "nurturing",
      "proposal",
    ];
    const insLead = this.db.prepare(
      `INSERT INTO leads (id, org_id, project_id, company_id, name, email, phone, source, utm, consent, score, stage, amount, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < opts.leadCount; i++) {
      const stage = stageCycle[i % stageCycle.length];
      const source = sourceCycle[i % sourceCycle.length];
      const utm =
        source === "ads"
          ? "utm_source=ads&utm_campaign=outbound"
          : source === "referral"
            ? "utm_source=referral"
            : source === "form"
              ? "utm_source=site"
              : "";
      const created = new Date(Date.now() - (opts.leadCount - i) * 86400000).toISOString();
      const amount = stage === "won" ? 22000 + i * 1500 : stage === "lost" ? 8000 : 4500 + i * 900;
      insLead.run(
        `lead-${opts.orgId}-${i + 1}`,
        opts.orgId,
        opts.projectId,
        companyId,
        names[i % names.length],
        `${names[i % names.length].split(" ")[0].toLowerCase()}${i}@${opts.orgId}.example`,
        `1198888${String(1000 + i)}`,
        source,
        utm,
        35 + i * 3,
        stage,
        amount,
        `ext-${opts.orgId}-${i + 1}`,
        created,
      );
    }

    this.appendLogInternal({
      orgId: opts.orgId,
      taskId: taskDefs[3][0],
      projectId: opts.projectId,
      agentId: "omni-repair",
      actionType: "CODE_COMMIT",
      logContent:
        "Kernel Omni-CRM: MCP, persistência SQLite, tenancy por org e seed comercial.",
    });
    this.appendLogInternal({
      orgId: opts.orgId,
      taskId: null,
      projectId: opts.projectId,
      agentId: "omni-analyst",
      actionType: "ANALYSIS",
      logContent:
        "Canal WhatsApp converte melhor em qualificação; ads traz volume com score mais baixo. Copy deve citar dor de leads frios.",
    });
    this.appendLogInternal({
      orgId: opts.orgId,
      taskId: null,
      projectId: opts.projectId,
      agentId: "omni-scout",
      actionType: "ANALYSIS",
      logContent:
        "Referral tem menor CAC implícito. Dobrar pedido de indicação após won. Evitar infoproduto (exclusão do ICP).",
    });
  }

  getOrg(id: string): Organization | undefined {
    const row = this.db.prepare("SELECT * FROM organizations WHERE id = ?").get(id) as
      | Record<string, string>
      | undefined;
    return row ? this.mapOrg(row) : undefined;
  }

  getOrgByApiKey(apiKey: string): Organization | undefined {
    const row = this.db.prepare("SELECT * FROM organizations WHERE api_key = ?").get(apiKey) as
      | Record<string, string>
      | undefined;
    return row ? this.mapOrg(row) : undefined;
  }

  // Credencial separada da agent key: só quem detém a harness key (Harness/OpenClaw,
  // ou o operador humano até existir login de verdade) autentica como human/harness.
  getOrgByHarnessKey(harnessKey: string): Organization | undefined {
    const row = this.db.prepare(
      "SELECT * FROM organizations WHERE harness_key IS NOT NULL AND harness_key = ?",
    ).get(harnessKey) as Record<string, string> | undefined;
    return row ? this.mapOrg(row) : undefined;
  }

  private mapOrg(row: Record<string, string>): Organization {
    return {
      id: row.id,
      name: row.name,
      apiKey: row.api_key,
      harnessKey: row.harness_key ?? null,
      createdAt: row.created_at,
    };
  }

  listProjects(orgId: string): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects WHERE org_id = ? ORDER BY name").all(orgId) as Record<string, string>[];
    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      description: row.description,
      platform: row.platform,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listTasks(orgId: string, projectId?: string): Task[] {
    const rows = (
      projectId
        ? this.db.prepare(
            "SELECT * FROM tasks WHERE org_id = ? AND project_id = ? ORDER BY created_at",
          ).all(orgId, projectId)
        : this.db.prepare("SELECT * FROM tasks WHERE org_id = ? ORDER BY created_at").all(orgId)
    ) as Record<string, string>[];
    return rows.map((row) => this.mapTask(row));
  }

  getTask(orgId: string, taskId: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE org_id = ? AND id = ?").get(orgId, taskId) as
      | Record<string, string>
      | undefined;
    return row ? this.mapTask(row) : undefined;
  }

  private mapTask(row: Record<string, string>): Task {
    return {
      id: row.id,
      orgId: row.org_id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      assignedAgent: row.assigned_agent,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateTaskStatus(auth: AuthContext, taskId: string, status: string): Task {
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      throw new StoreError(`Invalid status ${status}`, 400);
    }
    const task = this.getTask(auth.org.id, taskId);
    if (!task) throw new StoreError("Task not found", 404);
    const next = status as TaskStatus;
    assertTransition(task.status, next, auth.role);
    const ts = nowIso();
    this.db.prepare(
      "UPDATE tasks SET status = ?, assigned_agent = ?, updated_at = ? WHERE id = ? AND org_id = ?",
    ).run(next, auth.agentId, ts, taskId, auth.org.id);
    this.appendLogInternal({
      orgId: auth.org.id,
      taskId,
      projectId: task.projectId,
      agentId: auth.agentId,
      actionType: "STATUS",
      logContent: `status ${task.status} → ${next} by ${auth.role}:${auth.agentId}`,
    });
    return this.getTask(auth.org.id, taskId)!;
  }

  appendAgentLog(
    auth: AuthContext,
    input: { taskId?: string; projectId?: string; actionType: string; logContent: string },
  ): AgentLog {
    return this.appendLogInternal({
      orgId: auth.org.id,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      agentId: auth.agentId,
      actionType: input.actionType,
      logContent: input.logContent,
    });
  }

  private appendLogInternal(input: {
    orgId: string;
    taskId: string | null;
    projectId: string | null;
    agentId: string;
    actionType: string;
    logContent: string;
  }): AgentLog {
    const logId = id("log");
    const ts = nowIso();
    const embedding = embedText(`${input.actionType} ${input.logContent}`);
    this.db.prepare(
      `INSERT INTO agent_logs (id, org_id, task_id, project_id, agent_id, action_type, log_content, embedding, embedding_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      logId,
      input.orgId,
      input.taskId,
      input.projectId,
      input.agentId,
      input.actionType,
      input.logContent,
      encodeEmbedding(embedding),
      EMBEDDING_MODEL,
      ts,
    );
    return {
      id: logId,
      orgId: input.orgId,
      taskId: input.taskId,
      projectId: input.projectId,
      agentId: input.agentId,
      actionType: input.actionType,
      logContent: input.logContent,
      embedding,
      embeddingModel: EMBEDDING_MODEL,
      createdAt: ts,
    };
  }

  searchMemory(orgId: string, query: string, limit = 5): Array<AgentLog & { score: number }> {
    const q = embedText(query);
    const rows = this.db.prepare(
      "SELECT * FROM agent_logs WHERE org_id = ? AND embedding IS NOT NULL",
    ).all(orgId) as Record<string, string>[];
    return rows
      .map((row) => {
        const embedding = decodeEmbedding(row.embedding);
        const score = embedding ? cosine(q, embedding) : -1;
        const log: AgentLog & { score: number } = {
          id: row.id,
          orgId: row.org_id,
          taskId: row.task_id,
          projectId: row.project_id,
          agentId: row.agent_id,
          actionType: row.action_type,
          logContent: row.log_content,
          embedding: null,
          embeddingModel: row.embedding_model,
          createdAt: row.created_at,
          score,
        };
        return log;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  listPipelines(orgId: string): Pipeline[] {
    const rows = this.db.prepare("SELECT * FROM pipelines WHERE org_id = ?").all(orgId) as Record<string, string>[];
    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      projectId: row.project_id,
      name: row.name,
    }));
  }

  listPipelineStages(orgId: string): PipelineStage[] {
    const rows = this.db.prepare(
      "SELECT * FROM pipeline_stages WHERE org_id = ? ORDER BY position",
    ).all(orgId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      orgId: String(row.org_id),
      pipelineId: String(row.pipeline_id),
      name: String(row.name),
      position: Number(row.position),
      leadStage: row.lead_stage as LeadStage,
    }));
  }

  getIcp(orgId: string, projectId?: string): IcpProfile | undefined {
    const row = (
      projectId
        ? this.db.prepare(
            "SELECT * FROM icp_profiles WHERE org_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 1",
          ).get(orgId, projectId)
        : this.db.prepare(
            "SELECT * FROM icp_profiles WHERE org_id = ? ORDER BY updated_at DESC LIMIT 1",
          ).get(orgId)
    ) as Record<string, string> | undefined;
    return row ? this.mapIcp(row) : undefined;
  }

  private mapIcp(row: Record<string, string>): IcpProfile {
    return {
      id: row.id,
      orgId: row.org_id,
      projectId: row.project_id,
      persona: row.persona,
      pains: row.pains,
      language: row.language,
      channels: row.channels,
      offer: row.offer,
      exclusions: row.exclusions,
      status: row.status as IcpStatus,
      updatedAt: row.updated_at,
    };
  }

  upsertIcp(
    auth: AuthContext,
    input: {
      projectId: string;
      persona: string;
      pains: string;
      language: string;
      channels: string;
      offer: string;
      exclusions: string;
      status?: IcpStatus;
    },
  ): IcpProfile {
    const existing = this.getIcp(auth.org.id, input.projectId);
    const ts = nowIso();
    const status: IcpStatus =
      input.status ?? (auth.role === "human" ? "approved" : existing?.status ?? "draft");
    if (status === "approved" && auth.role === "agent") {
      throw new StoreError("Agent cannot approve ICP", 403);
    }
    if (existing) {
      this.db.prepare(
        `UPDATE icp_profiles SET persona=?, pains=?, language=?, channels=?, offer=?, exclusions=?, status=?, updated_at=?
         WHERE id=? AND org_id=?`,
      ).run(
        input.persona,
        input.pains,
        input.language,
        input.channels,
        input.offer,
        input.exclusions,
        status,
        ts,
        existing.id,
        auth.org.id,
      );
      return this.getIcp(auth.org.id, input.projectId)!;
    }
    const icpId = id("icp");
    this.db.prepare(
      `INSERT INTO icp_profiles (id, org_id, project_id, persona, pains, language, channels, offer, exclusions, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      icpId,
      auth.org.id,
      input.projectId,
      input.persona,
      input.pains,
      input.language,
      input.channels,
      input.offer,
      input.exclusions,
      status,
      ts,
    );
    return this.getIcp(auth.org.id, input.projectId)!;
  }

  listLeads(orgId: string): Lead[] {
    const rows = this.db.prepare("SELECT * FROM leads WHERE org_id = ? ORDER BY created_at").all(orgId) as Record<string, unknown>[];
    return rows.map((row) => this.mapLead(row));
  }

  private mapLead(row: Record<string, unknown>): Lead {
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      projectId: String(row.project_id),
      companyId: row.company_id ? String(row.company_id) : null,
      name: String(row.name),
      email: String(row.email),
      phone: String(row.phone ?? ""),
      source: String(row.source),
      utm: String(row.utm ?? ""),
      consent: Boolean(row.consent),
      score: Number(row.score),
      stage: row.stage as LeadStage,
      amount: Number(row.amount ?? 0),
      externalId: row.external_id ? String(row.external_id) : null,
      createdAt: String(row.created_at),
    };
  }

  upsertLead(
    auth: AuthContext,
    input: {
      projectId: string;
      name: string;
      email: string;
      phone?: string;
      source: string;
      utm?: string;
      consent: boolean;
      stage?: LeadStage;
      amount?: number;
      externalId?: string;
    },
  ): Lead {
    if (!input.consent) {
      throw new StoreError("Consent is required to capture a lead", 400);
    }
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) throw new StoreError("Invalid email", 400);
    const project = this.listProjects(auth.org.id).find((p) => p.id === input.projectId);
    if (!project) throw new StoreError("Unknown project", 404);

    const existing = (
      input.externalId
        ? this.db.prepare(
            "SELECT * FROM leads WHERE org_id = ? AND (email = ? OR external_id = ?) LIMIT 1",
          ).get(auth.org.id, email, input.externalId)
        : this.db.prepare("SELECT * FROM leads WHERE org_id = ? AND email = ?").get(auth.org.id, email)
    ) as Record<string, unknown> | undefined;

    const score = this.scoreLead(input.source, input.utm ?? "");
    const amount = input.amount ?? score * 120;
    const stage: LeadStage = input.stage ?? "new";
    if (!LEAD_STAGES.includes(stage)) throw new StoreError("Invalid lead stage", 400);

    if (existing) {
      this.db.prepare(
        `UPDATE leads SET name=?, phone=?, source=?, utm=?, consent=1, score=?, stage=?, amount=?
         WHERE id=? AND org_id=?`,
      ).run(
        input.name,
        input.phone ?? "",
        input.source,
        input.utm ?? "",
        score,
        stage,
        amount,
        existing.id,
        auth.org.id,
      );
      this.addLeadEvent(auth.org.id, String(existing.id), "upsert", JSON.stringify(input));
      return this.mapLead(
        this.db.prepare("SELECT * FROM leads WHERE id = ?").get(existing.id) as Record<string, unknown>,
      );
    }

    const leadId = id("lead");
    const ts = nowIso();
    this.db.prepare(
      `INSERT INTO leads (id, org_id, project_id, company_id, name, email, phone, source, utm, consent, score, stage, amount, external_id, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      leadId,
      auth.org.id,
      input.projectId,
      input.name,
      email,
      input.phone ?? "",
      input.source,
      input.utm ?? "",
      score,
      stage,
      amount,
      input.externalId ?? null,
      ts,
    );
    this.addLeadEvent(auth.org.id, leadId, "capture", JSON.stringify({ source: input.source, utm: input.utm }));
    return this.mapLead(
      this.db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) as Record<string, unknown>,
    );
  }

  private scoreLead(source: string, utm: string): number {
    let score = 30;
    if (source === "whatsapp") score += 20;
    if (source === "form") score += 15;
    if (utm.includes("ads")) score += 10;
    if (utm.includes("referral")) score += 25;
    return Math.min(score, 100);
  }

  private addLeadEvent(orgId: string, leadId: string, kind: string, payload: string): LeadEvent {
    const event: LeadEvent = {
      id: id("evt"),
      orgId,
      leadId,
      kind,
      payload,
      createdAt: nowIso(),
    };
    this.db.prepare(
      `INSERT INTO lead_events (id, org_id, lead_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(event.id, orgId, leadId, kind, payload, event.createdAt);
    return event;
  }

  listCopies(orgId: string): CopyAsset[] {
    const rows = this.db.prepare(
      "SELECT * FROM copy_assets WHERE org_id = ? ORDER BY created_at DESC",
    ).all(orgId) as Record<string, unknown>[];
    return rows.map((row) => this.mapCopy(row));
  }

  searchCopy(orgId: string, query: string, limit = 5): Array<CopyAsset & { score: number }> {
    const q = embedText(query);
    return this.listCopies(orgId)
      .map((asset) => ({
        ...asset,
        score: asset.embedding ? cosine(q, asset.embedding) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private mapCopy(row: Record<string, unknown>): CopyAsset {
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      projectId: String(row.project_id),
      leadId: row.lead_id ? String(row.lead_id) : null,
      icpId: String(row.icp_id),
      channel: String(row.channel),
      tone: String(row.tone),
      title: String(row.title),
      body: String(row.body),
      citations: String(row.citations),
      status: row.status as CopyStatus,
      version: Number(row.version),
      embedding: decodeEmbedding(row.embedding ? String(row.embedding) : null),
      createdAt: String(row.created_at),
    };
  }

  createCopyJob(
    auth: AuthContext,
    input: { projectId: string; leadId?: string; channel: string },
  ): CopyAsset {
    const icp = this.getIcp(auth.org.id, input.projectId);
    if (!icp) throw new StoreError("ICP not found for project", 404);
    if (icp.status !== "approved") throw new StoreError("ICP must be approved before generating copy", 409);
    const lead = input.leadId
      ? this.listLeads(auth.org.id).find((item) => item.id === input.leadId)
      : undefined;
    if (input.leadId && !lead) throw new StoreError("Lead not found", 404);

    const memory = this.searchMemory(
      auth.org.id,
      `${icp.persona} ${icp.offer} ${lead?.name ?? ""}`,
      3,
    );
    const citations = [
      `icp:${icp.id}`,
      ...memory.map((item) => `log:${item.id}`),
      lead ? `lead:${lead.id}` : null,
    ].filter(Boolean);
    const channel = input.channel || icp.channels.split(",")[0].trim();
    const title = `${channel} para ${lead?.name ?? icp.persona}`;
    const body = [
      `Canal: ${channel}`,
      `Tom: ${icp.language}`,
      `Para: ${lead?.name ?? icp.persona}`,
      `Dor: ${icp.pains}`,
      `Oferta: ${icp.offer}`,
      lead ? `Contexto do lead (${lead.stage}, origem ${lead.source}): ${lead.email}` : "Peça de topo de funil.",
      memory[0] ? `Memória: ${memory[0].logContent}` : "",
      "",
      `Olá${lead ? ` ${lead.name.split(" ")[0]}` : ""},`,
      `Vi que times como o seu sofrem com ${icp.pains.toLowerCase()}.`,
      `${icp.offer}. Posso te mostrar em 15 min como o Omni-CRM liga ICP, lead e copy com revisão humana.`,
      `Não servimos: ${icp.exclusions}.`,
    ]
      .filter(Boolean)
      .join("\n");

    const embedding = embedText(`${title}\n${body}\n${icp.persona}`);
    const copyId = id("copy");
    const ts = nowIso();
    this.db.prepare(
      `INSERT INTO copy_assets (id, org_id, project_id, lead_id, icp_id, channel, tone, title, body, citations, status, version, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_review', 1, ?, ?)`,
    ).run(
      copyId,
      auth.org.id,
      input.projectId,
      lead?.id ?? null,
      icp.id,
      channel,
      icp.language,
      title,
      body,
      citations.join(","),
      encodeEmbedding(embedding),
      ts,
    );

    const taskId = id("task");
    this.db.prepare(
      `INSERT INTO tasks (id, org_id, project_id, title, description, status, assigned_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'in_review', ?, ?, ?)`,
    ).run(
      taskId,
      auth.org.id,
      input.projectId,
      `Revisar copy ${channel}`,
      copyId,
      auth.agentId,
      ts,
      ts,
    );
    this.appendLogInternal({
      orgId: auth.org.id,
      taskId,
      projectId: input.projectId,
      agentId: auth.agentId,
      actionType: "COPY",
      logContent: `copy ${copyId} created from ${citations.join(",")}`,
    });
    return this.mapCopy(
      this.db.prepare("SELECT * FROM copy_assets WHERE id = ?").get(copyId) as Record<string, unknown>,
    );
  }

  reviewCopy(auth: AuthContext, copyId: string, decision: "approved" | "rejected"): CopyAsset {
    if (!canMarkDone(auth.role)) {
      throw new StoreError("Only human or harness may review copy", 403);
    }
    const row = this.db.prepare(
      "SELECT * FROM copy_assets WHERE id = ? AND org_id = ?",
    ).get(copyId, auth.org.id) as Record<string, unknown> | undefined;
    if (!row) throw new StoreError("Copy not found", 404);
    this.db.prepare("UPDATE copy_assets SET status = ? WHERE id = ? AND org_id = ?").run(
      decision,
      copyId,
      auth.org.id,
    );
    const linked = this.db.prepare(
      "SELECT id FROM tasks WHERE org_id = ? AND description = ? AND status = 'in_review'",
    ).get(auth.org.id, copyId) as { id: string } | undefined;
    if (linked && decision === "approved") {
      this.updateTaskStatus(auth, linked.id, "done");
    }
    if (linked && decision === "rejected") {
      this.updateTaskStatus(auth, linked.id, "in_progress");
    }
    return this.mapCopy(
      this.db.prepare("SELECT * FROM copy_assets WHERE id = ?").get(copyId) as Record<string, unknown>,
    );
  }

  dashboard(auth: AuthContext): DashboardState {
    const logs = this.db.prepare(
      "SELECT * FROM agent_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(auth.org.id) as Record<string, string>[];
    const leads = this.listLeads(auth.org.id);
    const tasks = this.listTasks(auth.org.id);
    const copies = this.listCopies(auth.org.id);
    const icp = this.getIcp(auth.org.id) ?? null;
    return {
      org: {
        ...auth.org,
        apiKey: `${auth.org.apiKey.slice(0, 8)}…`,
        harnessKey: auth.org.harnessKey ? `${auth.org.harnessKey.slice(0, 8)}…` : null,
      },
      health: { ok: true, db: "sqlite", mcp: true },
      projects: this.listProjects(auth.org.id),
      tasks,
      pipelines: this.listPipelines(auth.org.id),
      pipelineStages: this.listPipelineStages(auth.org.id),
      icp,
      leads,
      copies,
      logs: logs.map((row) => ({
        id: row.id,
        orgId: row.org_id,
        taskId: row.task_id,
        projectId: row.project_id,
        agentId: row.agent_id,
        actionType: row.action_type,
        logContent: row.log_content,
        embedding: null,
        embeddingModel: row.embedding_model,
        createdAt: row.created_at,
      })),
      insights: buildInsights({ leads, tasks, copies, icp }),
    };
  }
}

let singleton: OmniStore | undefined;

export function dbPath(): string {
  return process.env.OMNI_DB_PATH ?? `${process.cwd()}/data/omni-crm.sqlite`;
}

export function getStore(): OmniStore {
  if (!singleton) {
    singleton = OmniStore.open(dbPath());
    singleton.ensureSeed();
  }
  return singleton;
}

export function replaceStore(store: OmniStore): void {
  singleton = store;
}

export function resetStore(path: string): OmniStore {
  try {
    singleton?.close();
  } catch {
    /* already closed */
  }
  singleton = OmniStore.open(path);
  singleton.ensureSeed();
  return singleton;
}
