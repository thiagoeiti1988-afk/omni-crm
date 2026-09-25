import { NextResponse } from "next/server";
import { authenticate, AuthError, parseBearer } from "@/lib/auth";
import { getStore, StoreError } from "@/lib/store";
import type { AuthContext } from "@/lib/types";

export function requireAuth(req: Request): AuthContext {
  return authenticate(getStore(), {
    authorization: req.headers.get("authorization"),
    role: req.headers.get("x-actor-role"),
    agentId: req.headers.get("x-agent-id"),
    orgId: req.headers.get("x-org-id"),
  });
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof StoreError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export function hasBearer(req: Request): boolean {
  return Boolean(parseBearer(req.headers.get("authorization")));
}
