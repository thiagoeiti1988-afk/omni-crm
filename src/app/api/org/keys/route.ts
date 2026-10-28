import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const GET = api(async (req) => {
  const auth = requireAuth(req);
  const store = getStore();
  return NextResponse.json({ ...store.orgKeys(auth), users: store.listUsers(auth.org.id) });
});

export const POST = api(async (req) => {
  const auth = requireAuth(req);
  const body = await readJson<{ rotate?: "api" | "harness" | "capture"; whatsappPhoneId?: string }>(req);
  const store = getStore();
  if (body.whatsappPhoneId !== undefined) store.setWhatsAppPhoneId(auth, body.whatsappPhoneId);
  if (body.rotate) {
    if (!["api", "harness", "capture"].includes(body.rotate)) {
      return NextResponse.json({ error: "rotate must be api|harness|capture" }, { status: 400 });
    }
    store.rotateKey(auth, body.rotate);
  }
  return NextResponse.json(store.orgKeys(auth));
});
