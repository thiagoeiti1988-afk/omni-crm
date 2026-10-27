import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embedText, encodeEmbedding, decodeEmbedding, cosine, EMBEDDING_MODEL } from "./embeddings";
import { buildInsights } from "./analytics";
import { can } from "./auth";
import { hashPassword, randomToken, sha256, verifyPassword } from "./security";
import { csvToLeadRows, isTruthy } from "./csv";
import type {
  AgentLog,
  AuthContext,
  BillableEvent,
  BillableKind,
  BillingUsage,
  ConsentBasis,
  Permission,
  SessionUser,
  UserRole,
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

function requirePerm(auth: AuthContext, permission: Permission, message: string): void {
  if (!can(auth, permission)) throw new StoreError(message, 403);
}

function assertTransition(from: TaskStatus, to: TaskStatus, auth: AuthContext, skipRbac = false) {
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
  if (skipRbac) return;
  if (to === "done") requirePerm(auth, "task.done", "Only human or harness may mark a task done");
  if (from === "done") requirePerm(auth, "task.done", "Only human or harness may reopen a done task");
}

const DUMMY_HASH = hashPassword("dummy-password-for-timing");

const STAGE_LABELS: Record<LeadStage, string> = {
  new: "Novo",
  qualified: "Qualificado",
  nurturing: "Nutrição",
  proposal: "Proposta",
  won: "Ganho",
  lost: "Perdido",
};

function normalizeStage(raw: string): LeadStage | undefined {
  const v = raw.trim().toLowerCase();
  const map: Record<string, LeadStage> = {
    new: "new", novo: "new", lead: "new",
    qualified: "qualified", qualificado: "qualified", "oportunidade": "qualified",
    nurturing: "nurturing", "nutrição": "nurturing", nutricao: "nurturing", "em contato": "nurturing",
    proposal: "proposal", proposta: "proposal", "negociação": "proposal", negociacao: "proposal",
    won: "won", ganho: "won", vendido: "won", fechado: "won",
    lost: "lost", perdido: "lost",
  };
  return map[v];
}

function normalizeSource(raw?: string): string {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.includes("whats")) return "whatsapp";
  if (v.includes("indica") || v.includes("refer")) return "referral";
  if (v.includes("ads") || v.includes("anúncio") || v.includes("anuncio") || v.includes("google") || v.includes("meta")) return "ads";
  return v ? "form" : "import";
}

const LEAD_STAGE_ORDER: Record<LeadStage, number> = {
  new: 0,
  qualified: 1,
  nurturing: 2,
  proposal: 3,
  won: 4,
  lost: 4,
};

function priceCents(kind: BillableKind): number {
  const env: Record<BillableKind, string | undefined> = {
    lead_qualified: process.env.OMNI_PRICE_LEAD_QUALIFIED_CENTS,
    copy_approved: process.env.OMNI_PRICE_COPY_APPROVED_CENTS,
    deal_won: process.env.OMNI_PRICE_DEAL_WON_CENTS,
  };
  const defaults: Record<BillableKind, number> = { lead_qualified: 1500, copy_approved: 900, deal_won: 9900 };
  const parsed = Number(env[kind]);
  return Number.isFinite(parsed) && parsed >= 0 && env[kind] !== undefined ? parsed : defaults[kind];
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
    this.migrateV2();
  }

  /**
   * v2: usuários/sessões, faturamento por resultado, chaves de captura e
   * WhatsApp, trilha LGPD (base legal + apagamento) e lead sem e-mail
   * (WhatsApp só traz telefone). Rebuild de `leads` segue o procedimento
   * oficial do SQLite para mudar constraint (FK off + cópia + rename).
   */
  private migrateV2(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= 2) return;

    this.db.exec("PRAGMA foreign_keys = OFF;");
    this.db.exec("BEGIN");
    try {
      const orgCols = (this.db.prepare("PRAGMA table_info(organizations)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (!orgCols.includes("capture_key")) this.db.exec("ALTER TABLE organizations ADD COLUMN capture_key TEXT");
      if (!orgCols.includes("whatsapp_phone_id")) {
        this.db.exec("ALTER TABLE organizations ADD COLUMN whatsapp_phone_id TEXT");
      }

      this.db.exec(`
        CREATE TABLE leads_v2 (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          email TEXT,
          phone TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL,
          utm TEXT NOT NULL DEFAULT '',
          consent INTEGER NOT NULL DEFAULT 0,
          consent_basis TEXT CHECK (consent_basis IN ('consent','inbound_contact','import')),
          consent_at TEXT,
          score INTEGER NOT NULL DEFAULT 0,
          stage TEXT NOT NULL,
          amount INTEGER NOT NULL DEFAULT 0,
          external_id TEXT,
          erased_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (org_id, email),
          UNIQUE (org_id, external_id)
        );
        INSERT INTO leads_v2 (id, org_id, project_id, company_id, name, email, phone, source, utm, consent,
                              consent_basis, consent_at, score, stage, amount, external_id, erased_at, created_at)
          SELECT id, org_id, project_id, company_id, name, NULLIF(email, ''), phone, source, utm, consent,
                 CASE WHEN consent = 1 THEN 'consent' END, CASE WHEN consent = 1 THEN created_at END,
                 score, stage, amount, external_id, NULL, created_at
          FROM leads;
        DROP TABLE leads;
        ALTER TABLE leads_v2 RENAME TO leads;
        CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id, stage);

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner','closer','copy')),
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS billable_events (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('lead_qualified','copy_approved','deal_won')),
          ref_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (org_id, kind, ref_id)
        );
        CREATE INDEX IF NOT EXISTS idx_billable_org ON billable_events(org_id, created_at);
      `);

      const eventCols = (this.db.prepare("PRAGMA table_info(lead_events)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (!eventCols.includes("dedupe_key")) {
        this.db.exec("ALTER TABLE lead_events ADD COLUMN dedupe_key TEXT");
        this.db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_events_dedupe ON lead_events(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL",
        );
      }

      this.db.exec("PRAGMA user_version = 2");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  ensureSeed(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM organizations").get() as { c: number };
    if (count.c > 0) return;
    if (process.env.OMNI_SEED_DEMO === "0") {
      this.bootstrapFromEnv();
      return;
    }
    if (process.env.NODE_ENV === "production") {
      console.warn(
        JSON.stringify({ level: "warn", msg: "demo seed active in production; set OMNI_SEED_DEMO=0 and bootstrap a real org" }),
      );
    }
    this.seedOrg({
      orgId: "org-acme",
      name: "Acme Vendas",
      apiKey: "omni_org_acme_demo",
      harnessKey: "omni_org_acme_harness_demo",
      captureKey: "omni_pub_acme_demo",
      whatsappPhoneId: "100000000000001",
      users: [
        { email: "owner@acme.demo", name: "Olívia Owner", role: "owner" },
        { email: "closer@acme.demo", name: "Caio Closer", role: "closer" },
        { email: "copy@acme.demo", name: "Cora Copy", role: "copy" },
      ],
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
      captureKey: "omni_pub_beta_demo",
      whatsappPhoneId: "100000000000002",
      users: [{ email: "owner@beta.demo", name: "Bia Owner", role: "owner" }],
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
    captureKey: string;
    whatsappPhoneId: string;
    users: Array<{ email: string; name: string; role: UserRole }>;
    projectId: string;
    projectName: string;
    persona: boolean;
    leadCount: number;
  }): void {
    const ts = nowIso();
    this.db.prepare(
      `INSERT INTO organizations (id, name, api_key, harness_key, capture_key, whatsapp_phone_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.orgId, opts.name, opts.apiKey, opts.harnessKey, opts.captureKey, opts.whatsappPhoneId, ts);
    const demoPassword = process.env.OMNI_DEMO_PASSWORD ?? "omni-demo-2026";
    for (const user of opts.users) {
      this.createUser(opts.orgId, { ...user, password: demoPassword });
    }
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
      `INSERT INTO leads (id, org_id, project_id, company_id, name, email, phone, source, utm, consent,
                          consent_basis, consent_at, score, stage, amount, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'consent', ?, ?, ?, ?, ?, ?)`,
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
      // Último lead do seed é de hoje: a série de 14 dias não termina num zero artificial.
      const created = new Date(Date.now() - (opts.leadCount - 1 - i) * 86400000).toISOString();
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
        created,
        35 + i * 3,
        stage,
        amount,
        `ext-${opts.orgId}-${i + 1}`,
        created,
      );
      const leadId = `lead-${opts.orgId}-${i + 1}`;
      if (stage !== "new" && stage !== "lost") {
        this.recordBillable(opts.orgId, "lead_qualified", leadId, "seed", created);
      }
      if (stage === "won") this.recordBillable(opts.orgId, "deal_won", leadId, "seed", created);
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

  getOrgByCaptureKey(captureKey: string): Organization | undefined {
    const row = this.db.prepare(
      "SELECT * FROM organizations WHERE capture_key IS NOT NULL AND capture_key = ?",
    ).get(captureKey) as Record<string, string> | undefined;
    return row ? this.mapOrg(row) : undefined;
  }

  getOrgByWhatsAppPhoneId(phoneId: string): Organization | undefined {
    const row = this.db.prepare(
      "SELECT * FROM organizations WHERE whatsapp_phone_id IS NOT NULL AND whatsapp_phone_id = ?",
    ).get(phoneId) as Record<string, string> | undefined;
    return row ? this.mapOrg(row) : undefined;
  }

  private mapOrg(row: Record<string, string>): Organization {
    return {
      id: row.id,
      name: row.name,
      apiKey: row.api_key,
      harnessKey: row.harness_key ?? null,
      captureKey: row.capture_key ?? null,
      whatsappPhoneId: row.whatsapp_phone_id ?? null,
      createdAt: row.created_at,
    };
  }

  ping(): boolean {
    return (this.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
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

  updateTaskStatus(auth: AuthContext, taskId: string, status: string, opts: { skipRbac?: boolean } = {}): Task {
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      throw new StoreError(`Invalid status ${status}`, 400);
    }
    const task = this.getTask(auth.org.id, taskId);
    if (!task) throw new StoreError("Task not found", 404);
    const next = status as TaskStatus;
    assertTransition(task.status, next, auth, opts.skipRbac);
    if (task.status === next) return task;
    const ts = nowIso();
    // Compare-and-swap no status lido: dois atores na mesma Quanta não se sobrescrevem em silêncio.
    const result = this.db.prepare(
      "UPDATE tasks SET status = ?, assigned_agent = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = ?",
    ).run(next, auth.agentId, ts, taskId, auth.org.id, task.status);
    if (Number(result.changes) !== 1) {
      throw new StoreError("Task changed concurrently; reload and retry", 409);
    }
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
    // Agente pode propor ICP, nunca aprovar; edição de agente devolve o ICP para draft.
    const canApprove = can(auth, "icp.approve");
    if (input.status === "approved" && !canApprove) throw new StoreError("Agent cannot approve ICP", 403);
    const status: IcpStatus = canApprove ? (input.status ?? "approved") : "draft";
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
      email: row.email ? String(row.email) : "",
      phone: String(row.phone ?? ""),
      source: String(row.source),
      utm: String(row.utm ?? ""),
      consent: Boolean(row.consent),
      consentBasis: (row.consent_basis as ConsentBasis | null) ?? null,
      consentAt: row.consent_at ? String(row.consent_at) : null,
      score: Number(row.score),
      stage: row.stage as LeadStage,
      amount: Number(row.amount ?? 0),
      externalId: row.external_id ? String(row.external_id) : null,
      erasedAt: row.erased_at ? String(row.erased_at) : null,
      createdAt: String(row.created_at),
    };
  }

  getLead(orgId: string, leadId: string): Lead | undefined {
    const row = this.db.prepare("SELECT * FROM leads WHERE org_id = ? AND id = ?").get(orgId, leadId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapLead(row) : undefined;
  }

  /**
   * Captura idempotente (dedupe por e-mail ou external_id dentro da org).
   * Estágio NÃO muda aqui em lead existente: mover funil gera evento faturável
   * e passa por updateLeadStage (RBAC). Um lead novo só nasce fora de "new" se
   * o ator tiver permissão lead.stage (importação do dono, harness).
   */
  upsertLead(
    auth: AuthContext,
    input: {
      projectId: string;
      name: string;
      email?: string;
      phone?: string;
      source: string;
      utm?: string;
      consent: boolean;
      consentBasis?: ConsentBasis;
      stage?: LeadStage;
      amount?: number;
      externalId?: string;
    },
  ): Lead {
    const basis: ConsentBasis = input.consentBasis ?? "consent";
    if (!input.consent && basis === "consent") {
      throw new StoreError("Consent is required to capture a lead", 400);
    }
    const name = input.name.trim().slice(0, 200);
    if (!name) throw new StoreError("Name required", 400);
    const email = input.email?.trim().toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new StoreError("Invalid email", 400);
    const phone = (input.phone ?? "").replace(/[^\d+]/g, "").slice(0, 20);
    if (!email && !phone && !input.externalId) throw new StoreError("email or phone required", 400);
    const project = this.listProjects(auth.org.id).find((p) => p.id === input.projectId);
    if (!project) throw new StoreError("Unknown project", 404);
    if (input.stage !== undefined && !LEAD_STAGES.includes(input.stage)) {
      throw new StoreError("Invalid lead stage", 400);
    }

    const existing = this.db.prepare(
      `SELECT * FROM leads WHERE org_id = ? AND erased_at IS NULL AND (
         (? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND external_id = ?)
       ) LIMIT 1`,
    ).get(auth.org.id, email, email, input.externalId ?? null, input.externalId ?? null) as
      | Record<string, unknown>
      | undefined;

    const score = this.scoreLead(input.source, input.utm ?? "");
    const ts = nowIso();

    if (existing) {
      this.db.prepare(
        `UPDATE leads SET name=?, email=COALESCE(?, email), phone=CASE WHEN ? = '' THEN phone ELSE ? END,
                source=?, utm=?, consent=1, consent_basis=COALESCE(consent_basis, ?), consent_at=COALESCE(consent_at, ?),
                score=MAX(score, ?), external_id=COALESCE(external_id, ?)
         WHERE id=? AND org_id=?`,
      ).run(
        name,
        email,
        phone,
        phone,
        input.source,
        input.utm ?? "",
        basis,
        ts,
        score,
        input.externalId ?? null,
        String(existing.id),
        auth.org.id,
      );
      this.addLeadEvent(auth.org.id, String(existing.id), "upsert", JSON.stringify({ source: input.source, utm: input.utm, actor: auth.agentId }));
      return this.getLead(auth.org.id, String(existing.id))!;
    }

    const stage: LeadStage = input.stage && can(auth, "lead.stage") ? input.stage : "new";
    const amount = Math.max(0, Math.round(input.amount ?? score * 120));
    const leadId = id("lead");
    this.db.prepare(
      `INSERT INTO leads (id, org_id, project_id, company_id, name, email, phone, source, utm, consent,
                          consent_basis, consent_at, score, stage, amount, external_id, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      leadId,
      auth.org.id,
      input.projectId,
      name,
      email,
      phone,
      input.source,
      input.utm ?? "",
      basis,
      ts,
      score,
      stage,
      amount,
      input.externalId ?? null,
      ts,
    );
    this.addLeadEvent(auth.org.id, leadId, "capture", JSON.stringify({ source: input.source, utm: input.utm, basis, actor: auth.agentId }));
    if (stage !== "new" && stage !== "lost") this.recordBillable(auth.org.id, "lead_qualified", leadId, auth.agentId);
    if (stage === "won") this.recordBillable(auth.org.id, "deal_won", leadId, auth.agentId);
    return this.getLead(auth.org.id, leadId)!;
  }

  /** Move o lead no funil. Humano/harness apenas; gera eventos faturáveis idempotentes. */
  updateLeadStage(auth: AuthContext, leadId: string, stage: string, amount?: number): Lead {
    requirePerm(auth, "lead.stage", "Only a closer, owner or harness may move a lead in the funnel");
    if (!LEAD_STAGES.includes(stage as LeadStage)) throw new StoreError("Invalid lead stage", 400);
    const lead = this.getLead(auth.org.id, leadId);
    if (!lead || lead.erasedAt) throw new StoreError("Lead not found", 404);
    const next = stage as LeadStage;
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) throw new StoreError("Invalid amount", 400);
    this.db.prepare("UPDATE leads SET stage = ?, amount = COALESCE(?, amount) WHERE id = ? AND org_id = ?").run(
      next,
      amount === undefined ? null : Math.round(amount),
      leadId,
      auth.org.id,
    );
    this.addLeadEvent(auth.org.id, leadId, "stage", JSON.stringify({ from: lead.stage, to: next, actor: auth.agentId }));
    if (LEAD_STAGE_ORDER[next] >= LEAD_STAGE_ORDER.qualified && next !== "lost" && lead.consent) {
      this.recordBillable(auth.org.id, "lead_qualified", leadId, auth.agentId);
    }
    if (next === "won") this.recordBillable(auth.org.id, "deal_won", leadId, auth.agentId);
    return this.getLead(auth.org.id, leadId)!;
  }

  private scoreLead(source: string, utm: string): number {
    let score = 30;
    if (source === "whatsapp") score += 20;
    if (source === "form") score += 15;
    if (utm.includes("ads")) score += 10;
    if (utm.includes("referral")) score += 25;
    return Math.min(score, 100);
  }

  /** Retorna null quando `dedupeKey` já foi visto (entrega duplicada de webhook). */
  private addLeadEvent(
    orgId: string,
    leadId: string,
    kind: string,
    payload: string,
    dedupeKey?: string,
  ): LeadEvent | null {
    const event: LeadEvent = {
      id: id("evt"),
      orgId,
      leadId,
      kind,
      payload,
      createdAt: nowIso(),
    };
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO lead_events (id, org_id, lead_id, kind, payload, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.id, orgId, leadId, kind, payload, event.createdAt, dedupeKey ?? null);
    return Number(result.changes) === 1 ? event : null;
  }

  listLeadEvents(orgId: string, leadId: string): LeadEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM lead_events WHERE org_id = ? AND lead_id = ? ORDER BY created_at",
    ).all(orgId, leadId) as Record<string, string>[];
    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      leadId: row.lead_id,
      kind: row.kind,
      payload: row.payload,
      createdAt: row.created_at,
    }));
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

  /** Contexto que alimenta a peça: ICP aprovado, lead e memória do org. Reusado pelo copywriter LLM. */
  copyContext(
    auth: AuthContext,
    input: { projectId: string; leadId?: string; channel?: string },
  ): { icp: IcpProfile; lead: Lead | undefined; memory: Array<AgentLog & { score: number }>; channel: string } {
    const icp = this.getIcp(auth.org.id, input.projectId);
    if (!icp) throw new StoreError("ICP not found for project", 404);
    if (icp.status !== "approved") throw new StoreError("ICP must be approved before generating copy", 409);
    const lead = input.leadId ? this.getLead(auth.org.id, input.leadId) : undefined;
    if (input.leadId && (!lead || lead.erasedAt)) throw new StoreError("Lead not found", 404);
    const memory = this.searchMemory(auth.org.id, `${icp.persona} ${icp.offer} ${icp.pains}`, 3);
    const channel = input.channel?.trim() || icp.channels.split(",")[0].trim();
    return { icp, lead, memory, channel };
  }

  createCopyJob(
    auth: AuthContext,
    input: { projectId: string; leadId?: string; channel: string },
    draft?: { title: string; body: string; author?: string },
  ): CopyAsset {
    const { icp, lead, memory, channel } = this.copyContext(auth, input);
    const citations = [
      `icp:${icp.id}`,
      ...memory.map((item) => `log:${item.id}`),
      lead ? `lead:${lead.id}` : null,
    ].filter(Boolean);
    const firstName = lead?.name.split(" ")[0];
    const title = (draft?.title?.trim() || `${channel} para ${lead?.name ?? icp.persona}`).slice(0, 200);
    // Só o que vai para o cliente final. Briefing (ICP, memória) fica nas citações, não no corpo.
    const body = (
      draft?.body?.trim() ||
      [
        `Olá${firstName ? ` ${firstName}` : ""}, tudo bem?`,
        "",
        `Times como o seu costumam esbarrar em ${icp.pains.toLowerCase().replace(/\.$/, "")}.`,
        `${icp.offer.replace(/\.$/, "")}.`,
        "",
        channel.toLowerCase().includes("whatsapp")
          ? "Faz sentido eu te mandar um exemplo aplicado ao seu caso por aqui?"
          : "Topa 15 minutos esta semana para eu te mostrar isso aplicado ao seu caso?",
      ].join("\n")
    ).slice(0, 5000);

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
      logContent: `copy ${copyId} (${draft?.author ?? "template"}) created from ${citations.join(",")}`,
    });
    return this.mapCopy(
      this.db.prepare("SELECT * FROM copy_assets WHERE id = ?").get(copyId) as Record<string, unknown>,
    );
  }

  reviewCopy(auth: AuthContext, copyId: string, decision: "approved" | "rejected"): CopyAsset {
    requirePerm(auth, "copy.review", "Only human or harness may review copy");
    const row = this.db.prepare(
      "SELECT * FROM copy_assets WHERE id = ? AND org_id = ?",
    ).get(copyId, auth.org.id) as Record<string, unknown> | undefined;
    if (!row) throw new StoreError("Copy not found", 404);
    if (row.status !== "in_review" && row.status !== "draft") {
      if (row.status === decision) return this.mapCopy(row);
      throw new StoreError(`Copy already ${String(row.status)}`, 409);
    }
    this.db.prepare("UPDATE copy_assets SET status = ? WHERE id = ? AND org_id = ?").run(
      decision,
      copyId,
      auth.org.id,
    );
    const linked = this.db.prepare(
      "SELECT id FROM tasks WHERE org_id = ? AND description = ? AND status = 'in_review'",
    ).get(auth.org.id, copyId) as { id: string } | undefined;
    // A revisão humana É o gate do Quanta: fecha a tarefa mesmo para o papel "copy",
    // que não tem task.done genérico.
    if (linked) this.updateTaskStatus(auth, linked.id, decision === "approved" ? "done" : "in_progress", { skipRbac: true });
    if (decision === "approved") this.recordBillable(auth.org.id, "copy_approved", copyId, auth.agentId);
    this.appendLogInternal({
      orgId: auth.org.id,
      taskId: linked?.id ?? null,
      projectId: String(row.project_id),
      agentId: auth.agentId,
      actionType: "REVIEW",
      logContent: `copy ${copyId} ${decision} by ${auth.user?.email ?? auth.agentId}`,
    });
    return this.mapCopy(
      this.db.prepare("SELECT * FROM copy_assets WHERE id = ?").get(copyId) as Record<string, unknown>,
    );
  }

  dashboard(auth: AuthContext): DashboardState {
    const logs = this.db.prepare(
      "SELECT * FROM agent_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(auth.org.id) as Record<string, string>[];
    const leads = this.listLeads(auth.org.id).filter((lead) => !lead.erasedAt);
    const tasks = this.listTasks(auth.org.id);
    const copies = this.listCopies(auth.org.id);
    const icp = this.getIcp(auth.org.id) ?? null;
    return {
      org: {
        ...auth.org,
        apiKey: `${auth.org.apiKey.slice(0, 8)}…`,
        harnessKey: auth.org.harnessKey ? `${auth.org.harnessKey.slice(0, 8)}…` : null,
      },
      user: auth.user,
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

  // ─── Usuários e sessões (painel humano) ───────────────────────────────────

  createUser(
    orgId: string,
    input: { email: string; name: string; role: UserRole; password: string },
  ): SessionUser {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new StoreError("Invalid email", 400);
    if (input.password.length < 10) throw new StoreError("Password must have at least 10 characters", 400);
    if (!["owner", "closer", "copy"].includes(input.role)) throw new StoreError("Invalid role", 400);
    const userId = id("usr");
    try {
      this.db.prepare(
        "INSERT INTO users (id, org_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(userId, orgId, email, input.name.trim() || email, input.role, hashPassword(input.password), nowIso());
    } catch {
      throw new StoreError("Email already registered", 409);
    }
    return { id: userId, orgId, email, name: input.name.trim() || email, role: input.role };
  }

  /** Sempre roda o scrypt (mesmo sem usuário) para não vazar quais e-mails existem por tempo de resposta. */
  login(email: string, password: string): { token: string; user: SessionUser; expiresAt: string } | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
      | Record<string, string>
      | undefined;
    const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) return null;
    const token = randomToken();
    const ttlHours = Number(process.env.OMNI_SESSION_TTL_HOURS ?? 24 * 7);
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
      sha256(token),
      row.id,
      expiresAt,
      nowIso(),
    );
    return { token, user: this.mapUser(row), expiresAt };
  }

  sessionAuth(token: string): AuthContext | null {
    const row = this.db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
    ).get(sha256(token), nowIso()) as Record<string, string> | undefined;
    if (!row) return null;
    const org = this.getOrg(row.org_id);
    if (!org) return null;
    const user = this.mapUser(row);
    return { org, role: "human", agentId: `user:${user.email}`, isMaster: false, via: "session", user };
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  listUsers(orgId: string): SessionUser[] {
    const rows = this.db.prepare("SELECT * FROM users WHERE org_id = ? ORDER BY created_at").all(orgId) as Record<
      string,
      string
    >[];
    return rows.map((row) => this.mapUser(row));
  }

  private mapUser(row: Record<string, string>): SessionUser {
    return { id: row.id, orgId: row.org_id, email: row.email, name: row.name, role: row.role as UserRole };
  }

  // ─── Faturamento por resultado (RESaaS) ───────────────────────────────────

  /** Idempotente por (org, kind, ref): o mesmo lead/peça nunca é cobrado duas vezes. */
  recordBillable(orgId: string, kind: BillableKind, refId: string, actor: string, at?: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO billable_events (id, org_id, kind, ref_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id("bill"), orgId, kind, refId, actor, at ?? nowIso());
  }

  billingUsage(auth: AuthContext, month?: string): BillingUsage {
    requirePerm(auth, "billing.view", "Billing is visible to owner and closer only");
    const target = month && /^\d{4}-\d{2}$/.test(month) ? month : nowIso().slice(0, 7);
    const rows = this.db.prepare(
      "SELECT * FROM billable_events WHERE org_id = ? AND substr(created_at, 1, 7) = ? ORDER BY created_at DESC",
    ).all(auth.org.id, target) as Record<string, string>[];
    const ledger: BillableEvent[] = rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      kind: row.kind as BillableKind,
      refId: row.ref_id,
      actor: row.actor,
      createdAt: row.created_at,
    }));
    const kinds: BillableKind[] = ["lead_qualified", "copy_approved", "deal_won"];
    const lines = kinds.map((kind) => {
      const count = ledger.filter((e) => e.kind === kind).length;
      const unitCents = priceCents(kind);
      return { kind, count, unitCents, subtotalCents: count * unitCents };
    });
    const baseFeeCents = Number(process.env.OMNI_BASE_FEE_CENTS ?? 19900);
    return {
      month: target,
      currency: "BRL",
      baseFeeCents,
      lines,
      totalCents: baseFeeCents + lines.reduce((sum, l) => sum + l.subtotalCents, 0),
      ledger: ledger.slice(0, 100),
    };
  }

  // ─── LGPD: acesso e eliminação do titular (art. 18) ───────────────────────

  exportLead(auth: AuthContext, leadId: string): { lead: Lead; events: LeadEvent[]; copies: CopyAsset[]; exportedAt: string } {
    requirePerm(auth, "lead.export", "Only owner or closer may export personal data");
    const lead = this.getLead(auth.org.id, leadId);
    if (!lead) throw new StoreError("Lead not found", 404);
    const copies = this.listCopies(auth.org.id)
      .filter((c) => c.leadId === leadId)
      .map((c) => ({ ...c, embedding: null }));
    return { lead, events: this.listLeadEvents(auth.org.id, leadId), copies, exportedAt: nowIso() };
  }

  /**
   * Anonimiza o titular: remove PII do lead, apaga eventos e peças que citam
   * a pessoa. Mantém o id (e o evento faturável, que não tem PII) para a
   * contabilidade continuar fechando.
   */
  eraseLead(auth: AuthContext, leadId: string): Lead {
    requirePerm(auth, "lead.erase", "Only the owner may erase personal data");
    const lead = this.getLead(auth.org.id, leadId);
    if (!lead) throw new StoreError("Lead not found", 404);
    if (lead.erasedAt) return lead;
    const ts = nowIso();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `UPDATE leads SET name = 'Titular removido', email = NULL, phone = '', utm = '', external_id = NULL,
                          company_id = NULL, erased_at = ? WHERE id = ? AND org_id = ?`,
      ).run(ts, leadId, auth.org.id);
      this.db.prepare("DELETE FROM lead_events WHERE lead_id = ? AND org_id = ?").run(leadId, auth.org.id);
      const copyIds = (this.db.prepare("SELECT id FROM copy_assets WHERE lead_id = ? AND org_id = ?").all(
        leadId,
        auth.org.id,
      ) as Array<{ id: string }>).map((r) => r.id);
      for (const copyId of copyIds) {
        this.db.prepare("DELETE FROM copy_assets WHERE id = ? AND org_id = ?").run(copyId, auth.org.id);
        this.db.prepare("UPDATE tasks SET description = '' WHERE org_id = ? AND description = ?").run(auth.org.id, copyId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.appendLogInternal({
      orgId: auth.org.id,
      taskId: null,
      projectId: lead.projectId,
      agentId: auth.agentId,
      actionType: "LGPD_ERASE",
      logContent: `lead ${leadId} anonimizado a pedido do titular`,
    });
    return this.getLead(auth.org.id, leadId)!;
  }

  // ─── Importação (migração de RD Station / Ploomes / Kommo) ────────────────

  importLeadsCsv(
    auth: AuthContext,
    csv: string,
    projectId?: string,
  ): { imported: number; updated: number; skipped: Array<{ line: number; reason: string }> } {
    requirePerm(auth, "lead.import", "Only the owner may import leads");
    if (csv.length > 5_000_000) throw new StoreError("CSV too large (max 5 MB)", 413);
    const project = projectId
      ? this.listProjects(auth.org.id).find((p) => p.id === projectId)
      : this.listProjects(auth.org.id)[0];
    if (!project) throw new StoreError("Unknown project", 404);
    const rows = csvToLeadRows(csv);
    if (rows.length > 10_000) throw new StoreError("Max 10.000 rows per import", 413);
    const before = new Set(this.listLeads(auth.org.id).map((l) => l.id));
    let imported = 0;
    let updated = 0;
    const skipped: Array<{ line: number; reason: string }> = [];
    for (const row of rows) {
      if (!isTruthy(row.consent)) {
        skipped.push({ line: row.line, reason: "sem consentimento registrado" });
        continue;
      }
      try {
        const stage = row.stage ? normalizeStage(row.stage) : undefined;
        const lead = this.upsertLead(auth, {
          projectId: project.id,
          name: row.name ?? "",
          email: row.email,
          phone: row.phone,
          source: normalizeSource(row.source),
          utm: row.utm,
          consent: true,
          consentBasis: "import",
          stage,
          amount: row.amount ? Number(row.amount.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".")) : undefined,
          externalId: row.externalId || undefined,
        });
        if (before.has(lead.id)) updated++;
        else {
          imported++;
          before.add(lead.id);
        }
      } catch (err) {
        skipped.push({ line: row.line, reason: err instanceof Error ? err.message : "erro" });
      }
    }
    return { imported, updated, skipped };
  }

  // ─── WhatsApp Cloud API (inbound) ─────────────────────────────────────────

  /**
   * Ingestão do webhook oficial (entry[].changes[].value). Roteia pela
   * phone_number_id da org, cria/atualiza lead (base legal: contato iniciado
   * pelo titular) e registra a mensagem com dedupe pelo id da Meta — reentrega
   * do webhook não duplica nada.
   */
  ingestWhatsApp(payload: unknown): { processed: number; duplicates: number; ignored: number } {
    const result = { processed: 0, duplicates: 0, ignored: 0 };
    const entries = (payload as { entry?: unknown[] })?.entry;
    if (!Array.isArray(entries)) return result;
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] })?.changes ?? [];
      for (const change of changes as Array<{ field?: string; value?: Record<string, unknown> }>) {
        const value = change?.value;
        const phoneId = String((value?.metadata as { phone_number_id?: string } | undefined)?.phone_number_id ?? "");
        const messages = (value?.messages as Array<Record<string, unknown>> | undefined) ?? [];
        if (!messages.length) continue;
        const org = phoneId ? this.getOrgByWhatsAppPhoneId(phoneId) : undefined;
        if (!org) {
          result.ignored += messages.length;
          continue;
        }
        const project = this.listProjects(org.id)[0];
        if (!project) {
          result.ignored += messages.length;
          continue;
        }
        const contacts = (value?.contacts as Array<{ wa_id?: string; profile?: { name?: string } }> | undefined) ?? [];
        const auth: AuthContext = { org, role: "agent", agentId: "whatsapp-webhook", isMaster: false, via: "capture" };
        for (const msg of messages) {
          const from = String(msg.from ?? "").replace(/\D/g, "");
          const msgId = String(msg.id ?? "");
          if (!from || !msgId) {
            result.ignored++;
            continue;
          }
          const contactName = contacts.find((c) => c.wa_id === from)?.profile?.name;
          const lead = this.upsertLead(auth, {
            projectId: project.id,
            name: contactName || `WhatsApp +${from}`,
            phone: `+${from}`,
            source: "whatsapp",
            consent: true,
            consentBasis: "inbound_contact",
            externalId: `wa:${from}`,
          });
          const text = (msg.text as { body?: string } | undefined)?.body ?? `[${String(msg.type ?? "message")}]`;
          const event = this.addLeadEvent(
            org.id,
            lead.id,
            "whatsapp_inbound",
            JSON.stringify({ id: msgId, type: msg.type, text: text.slice(0, 4000), timestamp: msg.timestamp }),
            `wa:${msgId}`,
          );
          if (event) result.processed++;
          else result.duplicates++;
        }
      }
    }
    return result;
  }

  // ─── Chaves da organização ────────────────────────────────────────────────

  orgKeys(auth: AuthContext): { apiKey: string; harnessKey: string | null; captureKey: string | null; whatsappPhoneId: string | null } {
    requirePerm(auth, "org.keys", "Only the owner may read organization keys");
    const org = this.getOrg(auth.org.id)!;
    return { apiKey: org.apiKey, harnessKey: org.harnessKey, captureKey: org.captureKey, whatsappPhoneId: org.whatsappPhoneId };
  }

  rotateKey(auth: AuthContext, kind: "api" | "harness" | "capture"): string {
    requirePerm(auth, "org.keys", "Only the owner may rotate organization keys");
    const prefix = { api: "omni_org_", harness: "omni_hns_", capture: "omni_pub_" }[kind];
    const column = { api: "api_key", harness: "harness_key", capture: "capture_key" }[kind];
    const key = `${prefix}${randomToken(24)}`;
    this.db.prepare(`UPDATE organizations SET ${column} = ? WHERE id = ?`).run(key, auth.org.id);
    this.appendLogInternal({
      orgId: auth.org.id,
      taskId: null,
      projectId: null,
      agentId: auth.agentId,
      actionType: "SECURITY",
      logContent: `${kind} key rotated`,
    });
    return key;
  }

  setWhatsAppPhoneId(auth: AuthContext, phoneId: string): void {
    requirePerm(auth, "org.keys", "Only the owner may configure WhatsApp");
    const clean = phoneId.replace(/\D/g, "");
    if (!clean) throw new StoreError("phone_number_id must be numeric", 400);
    this.db.prepare("UPDATE organizations SET whatsapp_phone_id = ? WHERE id = ?").run(clean, auth.org.id);
  }

  // ─── Provisionamento ──────────────────────────────────────────────────────

  /** Cria uma org real: chaves aleatórias, projeto, pipeline, ICP em draft e o owner. */
  createOrg(input: { name: string; ownerEmail: string; ownerName?: string; ownerPassword: string; projectName?: string }): {
    org: Organization;
    owner: SessionUser;
  } {
    const orgId = id("org");
    const projectId = id("proj");
    const ts = nowIso();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO organizations (id, name, api_key, harness_key, capture_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        orgId,
        input.name.trim(),
        `omni_org_${randomToken(24)}`,
        `omni_hns_${randomToken(24)}`,
        `omni_pub_${randomToken(18)}`,
        ts,
      );
      this.db.prepare(
        `INSERT INTO projects (id, org_id, name, description, platform, status, created_at, updated_at)
         VALUES (?, ?, ?, '', 'Omni', 'active', ?, ?)`,
      ).run(projectId, orgId, input.projectName?.trim() || "Projeto principal", ts, ts);
      const pipeId = id("pipe");
      this.db.prepare("INSERT INTO pipelines (id, org_id, project_id, name) VALUES (?, ?, ?, ?)").run(
        pipeId,
        orgId,
        projectId,
        "Pipeline comercial",
      );
      (["new", "qualified", "nurturing", "proposal", "won", "lost"] as LeadStage[]).forEach((stage, pos) => {
        this.db.prepare(
          "INSERT INTO pipeline_stages (id, org_id, pipeline_id, name, position, lead_stage) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id("st"), orgId, pipeId, STAGE_LABELS[stage], pos, stage);
      });
      this.db.prepare(
        `INSERT INTO icp_profiles (id, org_id, project_id, persona, pains, language, channels, offer, exclusions, status, updated_at)
         VALUES (?, ?, ?, '', '', 'Direto, português BR', 'WhatsApp, e-mail', '', '', 'draft', ?)`,
      ).run(id("icp"), orgId, projectId, ts);
      const owner = this.createUser(orgId, {
        email: input.ownerEmail,
        name: input.ownerName ?? input.ownerEmail,
        role: "owner",
        password: input.ownerPassword,
      });
      this.db.exec("COMMIT");
      return { org: this.getOrg(orgId)!, owner };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private bootstrapFromEnv(): void {
    const name = process.env.OMNI_BOOTSTRAP_ORG_NAME;
    const email = process.env.OMNI_BOOTSTRAP_OWNER_EMAIL;
    const password = process.env.OMNI_BOOTSTRAP_OWNER_PASSWORD;
    if (!name || !email || !password) return;
    this.createOrg({ name, ownerEmail: email, ownerPassword: password });
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
