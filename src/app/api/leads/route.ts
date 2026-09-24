import { NextResponse } from "next/server";
import { errorResponse, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = requireAuth(req);
    const body = (await req.json()) as {
      projectId?: string;
      name?: string;
      email?: string;
      phone?: string;
      source?: string;
      utm?: string;
      consent?: boolean;
      externalId?: string;
    };
    if (!body.projectId || !body.name || !body.email || !body.source) {
      return NextResponse.json({ error: "projectId, name, email, source required" }, { status: 400 });
    }
    const lead = getStore().upsertLead(auth, {
      projectId: body.projectId,
      name: body.name,
      email: body.email,
      phone: body.phone,
      source: body.source,
      utm: body.utm,
      consent: Boolean(body.consent),
      externalId: body.externalId,
    });
    return NextResponse.json({ lead }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
