import { NextResponse } from "next/server";
import { api, assertSameOrigin, clientIp, enforceRateLimit, readJson, SESSION_COOKIE } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const POST = api(async (req) => {
  assertSameOrigin(req);
  const body = await readJson<{ email?: string; password?: string }>(req, 10_000);
  const email = (body.email ?? "").trim().toLowerCase();
  enforceRateLimit(`login:ip:${clientIp(req)}`, 30, 15 * 60_000);
  enforceRateLimit(`login:email:${email}`, 10, 15 * 60_000);
  if (!email || !body.password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }
  const session = getStore().login(email, body.password);
  if (!session) return NextResponse.json({ error: "E-mail ou senha inválidos" }, { status: 401 });
  const res = NextResponse.json({ user: session.user });
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.OMNI_INSECURE_COOKIES !== "1",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return res;
});
