import type { ActorRole, AuthContext } from "./types";
import type { OmniStore } from "./store";

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

// O papel (agent/human/harness) nunca vem do header X-Actor-Role sozinho — isso
// permitiria qualquer chamador se autopromover a "harness" e fechar Quanta ou
// aprovar copy/ICP sem revisão humana de verdade (ver docs/AUDITORIA.md). O
// papel é amarrado à credencial que autenticou o request:
//   - agent key (org.apiKey)       -> sempre "agent", header é ignorado
//   - harness key (org.harnessKey) -> sempre "harness"
//   - master key (MCP_API_KEY)     -> operador de confiança; pode escolher
//                                     human/harness via header (nunca "agent")
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

  if (master && token === master) {
    const orgId = opts.orgId;
    if (!orgId) throw new AuthError("Master key requires X-Org-Id");
    const org = store.getOrg(orgId);
    if (!org) throw new AuthError("Unknown organization");
    const requested = parseRole(opts.role);
    const role = requested === "agent" ? "human" : requested;
    const agentId = opts.agentId?.trim() || `master-${role}`;
    return { org, role, agentId, isMaster: true };
  }

  const harnessOrg = store.getOrgByHarnessKey(token);
  if (harnessOrg) {
    const agentId = opts.agentId?.trim() || "harness";
    return { org: harnessOrg, role: "harness", agentId, isMaster: false };
  }

  const org = store.getOrgByApiKey(token);
  if (!org) throw new AuthError("Invalid API key");
  const agentId = opts.agentId?.trim() || "agent";
  return { org, role: "agent", agentId, isMaster: false };
}
