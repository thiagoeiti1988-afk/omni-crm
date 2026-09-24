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
  const role = parseRole(opts.role);
  const agentId = opts.agentId?.trim() || `agent-${role}`;

  if (master && token === master) {
    const orgId = opts.orgId;
    if (!orgId) throw new AuthError("Master key requires X-Org-Id");
    const org = store.getOrg(orgId);
    if (!org) throw new AuthError("Unknown organization");
    return { org, role, agentId, isMaster: true };
  }

  const org = store.getOrgByApiKey(token);
  if (!org) throw new AuthError("Invalid API key");
  return { org, role, agentId, isMaster: false };
}
