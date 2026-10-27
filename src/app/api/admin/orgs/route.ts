import { NextResponse } from "next/server";
import { AuthError, parseBearer } from "@/lib/auth";
import { api, clientIp, enforceRateLimit, readJson } from "@/lib/http";
import { getStore } from "@/lib/store";
import { safeEqual } from "@/lib/security";

export const runtime = "nodejs";

/** Provisionamento de org pelo operador da plataforma (MCP_API_KEY). Chaves voltam uma única vez. */
export const POST = api(async (req) => {
  enforceRateLimit(`admin:${clientIp(req)}`, 20, 60_000);
  const master = process.env.MCP_API_KEY;
  const token = parseBearer(req.headers.get("authorization"));
  if (!master || !token || !safeEqual(token, master)) throw new AuthError("Operator key required");
  const body = await readJson<{ name?: string; ownerEmail?: string; ownerName?: string; ownerPassword?: string; projectName?: string }>(req);
  if (!body.name?.trim() || !body.ownerEmail || !body.ownerPassword) {
    return NextResponse.json({ error: "name, ownerEmail, ownerPassword required" }, { status: 400 });
  }
  const { org, owner } = getStore().createOrg({
    name: body.name,
    ownerEmail: body.ownerEmail,
    ownerName: body.ownerName,
    ownerPassword: body.ownerPassword,
    projectName: body.projectName,
  });
  return NextResponse.json(
    {
      org: { id: org.id, name: org.name },
      owner,
      keys: { apiKey: org.apiKey, harnessKey: org.harnessKey, captureKey: org.captureKey },
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
});
