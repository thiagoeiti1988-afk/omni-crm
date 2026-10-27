import { NextResponse } from "next/server";
import { api, HttpError } from "@/lib/http";
import { getStore } from "@/lib/store";
import { safeEqual, verifyHubSignature } from "@/lib/security";

export const runtime = "nodejs";

/** Handshake da Meta: devolve hub.challenge se o verify token bater. */
export const GET = api(async (req) => {
  const params = new URL(req.url).searchParams;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const token = params.get("hub.verify_token") ?? "";
  if (params.get("hub.mode") === "subscribe" && expected && safeEqual(token, expected)) {
    return new NextResponse(params.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
});

/** Entrega de mensagens. Assinatura HMAC obrigatória (fail-closed sem WHATSAPP_APP_SECRET). */
export const POST = api(async (req) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) throw new HttpError(503, "WhatsApp webhook not configured");
  const raw = await req.text();
  if (raw.length > 1_000_000) throw new HttpError(413, "Body too large");
  if (!verifyHubSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  const result = getStore().ingestWhatsApp(JSON.parse(raw));
  return NextResponse.json({ ok: true, ...result });
});
