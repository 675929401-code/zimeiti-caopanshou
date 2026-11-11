import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { readCoverRequestJson } from "@/lib/server/cover-request-body";
import { prepareCoverReviewOperation } from "@/lib/server/cover-review-operations";
import { coverReviewFailure, coverReviewJson } from "@/lib/server/cover-review-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ materials: z.unknown() }).strict();
export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request); if (!auth.ok) return auth.response;
  try { const body = schema.parse(await readCoverRequestJson(request, 100_000));
    return coverReviewJson(await prepareCoverReviewOperation(request, auth.user.userId, body.materials));
  } catch (error) { return coverReviewFailure(error); }
}
