import { NextResponse } from "next/server";
import { api, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export const GET = api(async (req) => NextResponse.json(getStore().dashboard(requireAuth(req))));
