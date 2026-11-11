import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { readCoverRequestJson } from "@/lib/server/cover-request-body";
import { executeCoverReviewOperation } from "@/lib/server/cover-review-execution";
import { coverReviewFailure, coverReviewJson } from "@/lib/server/cover-review-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const schema = z.object({ confirmationId: z.string().uuid() }).strict();
export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request); if (!auth.ok) return auth.response;
  try { const query = schema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return coverReviewJson(await executeCoverReviewOperation(request, auth.user.userId, query.confirmationId, false));
  } catch (error) { return coverReviewFailure(error); }
}
export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request); if (!auth.ok) return auth.response;
  try { const body = schema.parse(await readCoverRequestJson(request, 4096));
    return coverReviewJson(await executeCoverReviewOperation(request, auth.user.userId, body.confirmationId, true));
  } catch (error) { return coverReviewFailure(error); }
}
