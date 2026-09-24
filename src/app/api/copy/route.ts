import { NextResponse } from "next/server";
import { errorResponse, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = requireAuth(req);
    const body = (await req.json()) as {
      projectId?: string;
      leadId?: string;
      channel?: string;
      copyId?: string;
      decision?: "approved" | "rejected";
    };
    const store = getStore();
    if (body.decision && body.copyId) {
      const copy = store.reviewCopy(auth, body.copyId, body.decision);
      return NextResponse.json({ copy });
    }
    if (!body.projectId || !body.channel) {
      return NextResponse.json({ error: "projectId and channel required" }, { status: 400 });
    }
    const copy = store.createCopyJob(auth, {
      projectId: body.projectId,
      leadId: body.leadId,
      channel: body.channel,
    });
    return NextResponse.json({ copy }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
