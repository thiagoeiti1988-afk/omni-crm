import { NextResponse } from "next/server";
import { errorResponse, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = requireAuth(req);
    return NextResponse.json(getStore().dashboard(auth));
  } catch (err) {
    return errorResponse(err);
  }
}
