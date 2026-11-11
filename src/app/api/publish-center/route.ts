import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { PublishingActionSchema, PublishingSubmissionKeySchema } from "@/lib/publishing-contract";
import { mutatePublishingCenter, publishingFailure, PublishingError, readPublishingCenter, readPublishingJson, recoverPublishingClaim, recoverPublishingPurchase } from "@/lib/server/publishing-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
function failure(error: unknown) { const result = publishingFailure(error); return NextResponse.json(result.body, { status: result.status, headers }); }
export async function GET(request: Request) {
  try { return await withAuth(request, async (user, database) => {
    const query = new URL(request.url).searchParams;
    const purchaseKey = query.get("purchaseKey");
    if (purchaseKey !== null) {
      if ([...query.keys()].length !== 1) throw new PublishingError("PUBLISH_INPUT_INVALID", "订单查询参数无效", 400);
      const key = PublishingSubmissionKeySchema.safeParse(purchaseKey);
      if (!key.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "订单标识无效", 400);
      return NextResponse.json(await recoverPublishingPurchase(user, database, key.data), { headers });
    }
    const submissionKey = query.get("submissionKey");
    if (submissionKey !== null) {
      const key = PublishingSubmissionKeySchema.safeParse(submissionKey);
      if (!key.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "请求标识无效", 400);
      return NextResponse.json(await recoverPublishingClaim(user, database, key.data), { headers });
    }
    return NextResponse.json(await readPublishingCenter(user, database), { headers });
  }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try { return await withAuth(request, async (user, database) => {
    const action = PublishingActionSchema.safeParse(await readPublishingJson(request));
    if (!action.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "请求字段不符合发布中心合同", 400);
    return NextResponse.json(await mutatePublishingCenter(user, database, action.data), { headers });
  }); } catch (error) { return failure(error); }
}
