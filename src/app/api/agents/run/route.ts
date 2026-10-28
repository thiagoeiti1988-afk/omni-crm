import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";
import { runOpsAgent, type OpsAgentName } from "@/lib/agents";

export const runtime = "nodejs";

const AGENTS: OpsAgentName[] = ["analyst", "copywriter", "scout", "icp"];

export const POST = api(async (req) => {
  const auth = requireAuth(req);
  const body = await readJson<{ agent?: OpsAgentName; prompt?: string; leadId?: string; channel?: string; projectId?: string }>(req);
  if (!body.agent || !AGENTS.includes(body.agent)) {
    return NextResponse.json({ error: "agent must be analyst|copywriter|scout|icp" }, { status: 400 });
  }
  return NextResponse.json(
    runOpsAgent(getStore(), auth, {
      agent: body.agent,
      prompt: body.prompt?.slice(0, 2000),
      leadId: body.leadId,
      channel: body.channel,
      projectId: body.projectId,
    }),
  );
});
