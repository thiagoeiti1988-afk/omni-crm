import { NextResponse } from "next/server";
import { api, assertSameOrigin, readCookie, SESSION_COOKIE } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const POST = api(async (req) => {
  assertSameOrigin(req);
  const token = readCookie(req, SESSION_COOKIE);
  if (token) getStore().logout(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
});
