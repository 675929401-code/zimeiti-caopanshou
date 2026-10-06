import type { NextRequest } from "next/server";
// Public Film Studio compatibility path used by the reference navigation.
// The owner-scoped short-drama repository remains the single implementation
// so authorization, migration readiness and error semantics cannot drift.
// eslint-disable-next-line no-restricted-imports
import { GET as listShortDramaProjects } from "@/app/api/short-drama/projects/route";

// Route segment config must be statically declared in this file. Next.js does
// not accept these fields when they are re-exported from another route module.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return listShortDramaProjects(request);
}
