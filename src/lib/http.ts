import { NextResponse } from "next/server";
import { authenticate, AuthError, ForbiddenError, parseBearer } from "@/lib/auth";
import { getStore, StoreError } from "@/lib/store";
import { rateLimit } from "@/lib/security";
import type { AuthContext } from "@/lib/types";

export const SESSION_COOKIE = "omni_session";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * Bearer (agente, harness, master) ou cookie de sessão (humano no painel).
 * Escrita via cookie exige Origin do próprio host: SameSite=Lax já barra POST
 * cross-site, e esta checagem fecha o resto (subdomínios, navegadores antigos).
 */
export function requireAuth(req: Request): AuthContext {
  const store = getStore();
  if (parseBearer(req.headers.get("authorization"))) {
    return authenticate(store, {
      authorization: req.headers.get("authorization"),
      role: req.headers.get("x-actor-role"),
      agentId: req.headers.get("x-agent-id"),
      orgId: req.headers.get("x-org-id"),
    });
  }
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new AuthError("Missing credentials");
  const auth = store.sessionAuth(token);
  if (!auth) throw new AuthError("Session expired");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);
  return auth;
}

export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ForbiddenError("Cross-site request blocked");
  }
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw new ForbiddenError("Cross-origin request blocked");
  } catch (err) {
    if (err instanceof ForbiddenError) throw err;
    throw new ForbiddenError("Invalid Origin");
  }
}

/**
 * IP para rate limit. O primeiro valor do X-Forwarded-For é do cliente (forjável);
 * o último é o que o proxy de borda acrescentou. Rode atrás de um proxy (Caddy,
 * nginx, Vercel) — sem proxy, qualquer header de IP é controlado pelo cliente.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const hops = req.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean);
  return hops?.length ? hops[hops.length - 1] : "direct";
}

export function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  if (process.env.OMNI_RATE_LIMIT === "0") return;
  const { ok, retryAfterSec } = rateLimit(key, limit, windowMs);
  if (!ok) throw new HttpError(429, "Too many requests", { "Retry-After": String(retryAfterSec) });
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof StoreError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status, headers: err.headers });
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  console.error(JSON.stringify({ level: "error", msg: "unhandled", error: err instanceof Error ? err.stack : String(err) }));
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

/** Envelope de toda rota: request id, log JSON de uma linha, erros tipados → HTTP. */
export function api<C = unknown>(handler: Handler<C>): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || crypto.randomUUID();
    const started = Date.now();
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      res = errorResponse(err);
    }
    res.headers.set("x-request-id", requestId);
    if (process.env.OMNI_LOG !== "0") {
      console.log(
        JSON.stringify({
          level: res.status >= 500 ? "error" : "info",
          requestId,
          method: req.method,
          path: new URL(req.url).pathname,
          status: res.status,
          ms: Date.now() - started,
        }),
      );
    }
    return res;
  };
}

export function hasBearer(req: Request): boolean {
  return Boolean(parseBearer(req.headers.get("authorization")));
}

export async function readJson<T>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Body too large");
  return JSON.parse(text || "{}") as T;
}
