import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/api-middleware";
import { PublishingCashPricingActionSchema } from "@/lib/publishing-cash-contract";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { previewPublishingCashPricing, readPublishingCashPricing, readPublishingCashPricingReceipt, savePublishingCashPricing } from "@/lib/server/publishing-cash-admin-service";
import { PublishingError, publishingFailure, readPublishingJson } from "@/lib/server/publishing-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
function privateResponse<T extends Response>(response: T): T { response.headers.set("Cache-Control", headers["Cache-Control"]); return response; }
function failure(error: unknown) { const result = publishingFailure(error); return NextResponse.json(result.body, { status: result.status, headers }); }

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "integrations.manage", { requireStepUp: false, operation: "publishing_cash_pricing_read" });
    if (!authorization.ok) return privateResponse(authorization.response);
    const query = request.nextUrl.searchParams;
    if ([...query.keys()].some(key => key !== "requestKey") || query.getAll("requestKey").length > 1) throw new PublishingError("PUBLISH_INPUT_INVALID", "读取价格的参数无效。", 400);
    const database = getSupabase();
    const result = query.has("requestKey") ? await readPublishingCashPricingReceipt(database, authorization.actor.userId, query.get("requestKey")!) : await readPublishingCashPricing(database);
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const access = await authorizeAdminCapability(request, "integrations.manage", { requireStepUp: false, operation: "publishing_cash_pricing_read" });
    if (!access.ok) return privateResponse(access.response);
    const parsed = PublishingCashPricingActionSchema.safeParse(await readPublishingJson(request));
    if (!parsed.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "价格请求字段不符合要求。", 400);
    if (parsed.data.action === "preview") return NextResponse.json(await previewPublishingCashPricing(getSupabase(), access.actor.userId, parsed.data.input), { headers });
    const authorization = await authorizeAdminCapability(request, "integrations.manage", { requireStepUp: true, auditAllowed: true, operation: "publishing_cash_pricing_write" });
    if (!authorization.ok) return privateResponse(authorization.response);
    return NextResponse.json(await savePublishingCashPricing(getSupabase(), authorization.actor.userId, parsed.data), { headers });
  } catch (error) { return failure(error); }
}
