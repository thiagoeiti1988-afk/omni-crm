import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";
import { draftCopyWithClaude } from "@/lib/copywriter";

export const runtime = "nodejs";

export const POST = api(async (req) => {
  const auth = requireAuth(req);
  const body = await readJson<{
    projectId?: string;
    leadId?: string;
    channel?: string;
    copyId?: string;
    decision?: "approved" | "rejected";
    title?: string;
    body?: string;
  }>(req);
  const store = getStore();
  if (body.decision && body.copyId) {
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return NextResponse.json({ error: "decision must be approved|rejected" }, { status: 400 });
    }
    return NextResponse.json({ copy: store.reviewCopy(auth, body.copyId, body.decision) });
  }
  const projectId = body.projectId ?? store.listProjects(auth.org.id)[0]?.id;
  if (!projectId || !body.channel) {
    return NextResponse.json({ error: "projectId and channel required" }, { status: 400 });
  }
  const input = { projectId, leadId: body.leadId, channel: body.channel };
  // Rascunho explícito (do agente) > Claude (se configurado) > template. Sempre cai em Human Review.
  let draft = body.body ? { title: body.title ?? "", body: body.body, author: auth.agentId } : undefined;
  if (!draft) {
    const context = store.copyContext(auth, input);
    draft = (await draftCopyWithClaude(context)) ?? undefined;
  }
  return NextResponse.json({ copy: store.createCopyJob(auth, input, draft) }, { status: 201 });
});
