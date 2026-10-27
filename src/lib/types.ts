export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";
export type ActorRole = "agent" | "human" | "harness";
export type LeadStage =
  | "new"
  | "qualified"
  | "nurturing"
  | "proposal"
  | "won"
  | "lost";
export type CopyStatus = "draft" | "in_review" | "approved" | "rejected";
export type IcpStatus = "draft" | "approved";

export type Organization = {
  id: string;
  name: string;
  apiKey: string;
  harnessKey: string | null;
  captureKey: string | null;
  whatsappPhoneId: string | null;
  createdAt: string;
};

export type Project = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgent: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentLog = {
  id: string;
  orgId: string;
  taskId: string | null;
  projectId: string | null;
  agentId: string;
  actionType: string;
  logContent: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  createdAt: string;
};

export type Pipeline = {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
};

export type PipelineStage = {
  id: string;
  orgId: string;
  pipelineId: string;
  name: string;
  position: number;
  leadStage: LeadStage;
};

export type Company = {
  id: string;
  orgId: string;
  name: string;
};

export type IcpProfile = {
  id: string;
  orgId: string;
  projectId: string;
  persona: string;
  pains: string;
  language: string;
  channels: string;
  offer: string;
  exclusions: string;
  status: IcpStatus;
  updatedAt: string;
};

export type Lead = {
  id: string;
  orgId: string;
  projectId: string;
  companyId: string | null;
  name: string;
  email: string;
  phone: string;
  source: string;
  utm: string;
  consent: boolean;
  consentBasis: ConsentBasis | null;
  consentAt: string | null;
  score: number;
  stage: LeadStage;
  amount: number;
  externalId: string | null;
  erasedAt: string | null;
  createdAt: string;
};

export type LeadEvent = {
  id: string;
  orgId: string;
  leadId: string;
  kind: string;
  payload: string;
  createdAt: string;
};

export type CopyAsset = {
  id: string;
  orgId: string;
  projectId: string;
  leadId: string | null;
  icpId: string;
  channel: string;
  tone: string;
  title: string;
  body: string;
  citations: string;
  status: CopyStatus;
  version: number;
  embedding: number[] | null;
  createdAt: string;
};

export type UserRole = "owner" | "closer" | "copy";

export type SessionUser = {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: UserRole;
};

export type AuthVia = "apikey" | "harness" | "master" | "session" | "capture";

export type AuthContext = {
  org: Organization;
  role: ActorRole;
  agentId: string;
  isMaster: boolean;
  via?: AuthVia;
  user?: SessionUser;
};

export type Permission =
  | "task.done"
  | "copy.review"
  | "icp.approve"
  | "lead.stage"
  | "lead.erase"
  | "lead.export"
  | "lead.import"
  | "org.keys"
  | "billing.view";

export type ConsentBasis = "consent" | "inbound_contact" | "import";

export type BillableKind = "lead_qualified" | "copy_approved" | "deal_won";

export type BillableEvent = {
  id: string;
  orgId: string;
  kind: BillableKind;
  refId: string;
  actor: string;
  createdAt: string;
};

export type BillingUsage = {
  month: string;
  currency: "BRL";
  baseFeeCents: number;
  lines: Array<{ kind: BillableKind; count: number; unitCents: number; subtotalCents: number }>;
  totalCents: number;
  ledger: BillableEvent[];
};

export type DashboardState = {
  org: Organization;
  health: { ok: true; db: "sqlite"; mcp: true };
  projects: Project[];
  tasks: Task[];
  pipelines: Pipeline[];
  pipelineStages: PipelineStage[];
  icp: IcpProfile | null;
  leads: Lead[];
  copies: CopyAsset[];
  logs: AgentLog[];
  user?: SessionUser;
  insights?: import("./analytics").Insights;
};
