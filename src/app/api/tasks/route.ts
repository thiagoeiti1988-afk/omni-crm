import { NextResponse } from "next/server";
import { errorResponse, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = requireAuth(req);
    const body = (await req.json()) as {
      taskId?: string;
      status?: string;
      title?: string;
      projectId?: string;
    };
    if (!body.taskId || !body.status) {
      return NextResponse.json({ error: "taskId and status required" }, { status: 400 });
    }
    const task = getStore().updateTaskStatus(auth, body.taskId, body.status);
    return NextResponse.json({ task });
  } catch (err) {
    return errorResponse(err);
  }
}
