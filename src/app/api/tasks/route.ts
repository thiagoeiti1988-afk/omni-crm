import { NextResponse } from "next/server";
import { api, readJson, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const POST = api(async (req) => {
  const auth = requireAuth(req);
  const body = await readJson<{ taskId?: string; status?: string }>(req);
  if (!body.taskId || !body.status) {
    return NextResponse.json({ error: "taskId and status required" }, { status: 400 });
  }
  return NextResponse.json({ task: getStore().updateTaskStatus(auth, body.taskId, body.status) });
});
