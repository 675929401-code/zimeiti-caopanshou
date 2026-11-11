import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getCoverReviewOperation } from "@/lib/server/cover-review-operations";
import { coverReviewFailure, coverReviewJson } from "@/lib/server/cover-review-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ operationId: z.string().uuid().optional(), clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u).optional() }).strict();
export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request); if (!auth.ok) return auth.response;
  try { const query = schema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return coverReviewJson(await getCoverReviewOperation(request, auth.user.userId, query.operationId, query.clientRequestId));
  } catch (error) { return coverReviewFailure(error); }
}
