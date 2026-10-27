import { NextResponse } from "next/server";
import { errorResponse, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";
import { runOpsAgent, type OpsAgentName } from "@/lib/agents";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = requireAuth(req);
    const body = (await req.json()) as {
      agent?: OpsAgentName;
      prompt?: string;
      leadId?: string;
      channel?: string;
      projectId?: string;
    };
    if (!body.agent) {
      return NextResponse.json({ error: "agent required" }, { status: 400 });
    }
    const result = runOpsAgent(getStore(), auth, {
      agent: body.agent,
      prompt: body.prompt,
      leadId: body.leadId,
      channel: body.channel,
      projectId: body.projectId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
