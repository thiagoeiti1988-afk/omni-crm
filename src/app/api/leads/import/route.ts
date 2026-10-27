import { NextResponse } from "next/server";
import { api, HttpError, requireAuth } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

/** Corpo = CSV cru (text/csv). Cabeçalhos em PT ou EN; linhas sem consentimento são rejeitadas. */
export const POST = api(async (req) => {
  const auth = requireAuth(req);
  const csv = await req.text();
  if (csv.length > 5_000_000) throw new HttpError(413, "CSV too large (max 5 MB)");
  const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
  return NextResponse.json(getStore().importLeadsCsv(auth, csv, projectId));
});
