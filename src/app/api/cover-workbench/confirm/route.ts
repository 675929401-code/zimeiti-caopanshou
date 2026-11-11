import { NextRequest } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { readCoverRequestJson } from "@/lib/server/cover-request-body";
import { confirmCoverReviewOperation } from "@/lib/server/cover-review-operations";
import { coverReviewFailure, coverReviewJson } from "@/lib/server/cover-review-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request); if (!auth.ok) return auth.response;
  try { return coverReviewJson(await confirmCoverReviewOperation(request, auth.user.userId, await readCoverRequestJson(request, 32_768))); }
  catch (error) { return coverReviewFailure(error); }
}
