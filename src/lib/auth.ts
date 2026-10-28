import type { ActorRole, AuthContext, Permission, UserRole } from "./types";
import type { OmniStore } from "./store";
import { safeEqual } from "./security";

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function parseRole(header: string | null | undefined): ActorRole {
  const value = (header ?? "agent").toLowerCase();
  if (value === "human" || value === "harness" || value === "agent") return value;
  return "agent";
}

export class AuthError extends Error {
  status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

// O papel (agent/human/harness) nunca vem do header X-Actor-Role sozinho — isso
// permitiria qualquer chamador se autopromover a "harness" e fechar Quanta ou
// aprovar copy/ICP sem revisão humana de verdade (ver docs/AUDITORIA.md). O
// papel é amarrado à credencial que autenticou o request:
//   - agent key (org.apiKey)       -> sempre "agent", header é ignorado
//   - harness key (org.harnessKey) -> sempre "harness"
//   - master key (MCP_API_KEY)     -> operador de confiança; pode escolher
//                                     human/harness via header (nunca "agent")
//   - sessão de usuário (cookie)   -> "human", com RBAC por UserRole
export function authenticate(
  store: OmniStore,
  opts: {
    authorization?: string | null;
    role?: string | null;
    agentId?: string | null;
    orgId?: string | null;
  },
): AuthContext {
  const token = parseBearer(opts.authorization);
  if (!token) throw new AuthError("Missing Bearer token");

  const master = process.env.MCP_API_KEY;

  if (master && safeEqual(token, master)) {
    const orgId = opts.orgId;
    if (!orgId) throw new AuthError("Master key requires X-Org-Id");
    const org = store.getOrg(orgId);
    if (!org) throw new AuthError("Unknown organization");
    const requested = parseRole(opts.role);
    const role = requested === "agent" ? "human" : requested;
    const agentId = opts.agentId?.trim() || `master-${role}`;
    return { org, role, agentId, isMaster: true, via: "master" };
  }

  const harnessOrg = store.getOrgByHarnessKey(token);
  if (harnessOrg) {
    const agentId = opts.agentId?.trim() || "harness";
    return { org: harnessOrg, role: "harness", agentId, isMaster: false, via: "harness" };
  }

  const org = store.getOrgByApiKey(token);
  if (!org) throw new AuthError("Invalid API key");
  const agentId = opts.agentId?.trim() || "agent";
  return { org, role: "agent", agentId, isMaster: false, via: "apikey" };
}

const USER_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [
    "task.done",
    "copy.review",
    "icp.approve",
    "lead.stage",
    "lead.erase",
    "lead.export",
    "lead.import",
    "org.keys",
    "billing.view",
  ],
  closer: ["task.done", "lead.stage", "lead.export", "billing.view"],
  copy: ["copy.review"],
};

// Harness = automação confiável de pipeline (CI, OpenClaw). Fecha trabalho,
// mas não administra a org, não apaga titular e não lê faturamento.
const HARNESS_PERMISSIONS: Permission[] = ["task.done", "copy.review", "icp.approve", "lead.stage"];

/**
 * Matriz única de autorização. O agente executor (agent key / capture key) não
 * tem nenhuma destas permissões: ele propõe, humano ou harness decide. Isso
 * também protege o faturamento por resultado — o agente não fatura sozinho.
 */
export function can(auth: AuthContext, permission: Permission): boolean {
  if (auth.isMaster) return true;
  if (auth.user) return USER_PERMISSIONS[auth.user.role].includes(permission);
  if (auth.role === "harness") return HARNESS_PERMISSIONS.includes(permission);
  if (auth.role === "human") return permission !== "org.keys";
  return false;
}

export function assertCan(auth: AuthContext, permission: Permission, message?: string): void {
  if (!can(auth, permission)) {
    throw new ForbiddenError(message ?? `Missing permission ${permission}`);
  }
}
