import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
// Reuse the original authenticated/billed handler in process, with its ledger.
// eslint-disable-next-line no-restricted-imports
import { POST as analyzeOriginal } from "@/app/api/cover/prepare/route";
import { readCoverRequestJson } from "@/lib/server/cover-request-body";
import { getCoverReviewOperation, reviewInternalRequest } from "@/lib/server/cover-review-operations";
import { coverReviewFailure, coverReviewJson } from "@/lib/server/cover-review-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const schema = z.object({ operationId: z.string().uuid(), consent: z.object({ analysis: z.literal(true) }).strict() }).strict();
export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request); if (!auth.ok) return auth.response;
  try { const body = schema.parse(await readCoverRequestJson(request, 4096));
    const response = await analyzeOriginal(reviewInternalRequest(request, "/api/cover/prepare", "POST", { action: "analyze", ...body }));
    if (!response.ok) return response;
    return coverReviewJson(await getCoverReviewOperation(request, auth.user.userId, body.operationId), response.status);
  } catch (error) { return coverReviewFailure(error); }
}
