import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/api-middleware";
import { PublishingAdminActionSchema } from "@/lib/publishing-contract";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { mutatePublishingAdmin, publishingFailure, PublishingError, readPublishingAdmin, readPublishingJson } from "@/lib/server/publishing-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
function privateResponse<T extends Response>(response: T): T { response.headers.set("Cache-Control", headers["Cache-Control"]); return response; }
function failure(error: unknown) { const result = publishingFailure(error); return NextResponse.json(result.body, { status: result.status, headers }); }
async function readAccess(request: NextRequest) {
  for (const capability of ["integrations.manage", "packages.manage"] as const) {
    const access = await authorizeAdminCapability(request, capability, { requireStepUp: false, operation: "publishing_admin_read" });
    if (!access.ok) return access;
  }
  return { ok: true as const };
}
async function billingAccess(request: NextRequest): Promise<boolean> {
  const access = await authorizeAdminCapability(request, "billing.view", { requireStepUp: false, operation: "publishing_admin_metadata_read" });
  return access.ok;
}
export async function GET(request: NextRequest) {
  try {
    const access = await readAccess(request);
    if (!access.ok) return privateResponse(access.response);
    return NextResponse.json(await readPublishingAdmin(getSupabase(), await billingAccess(request)), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const access = await readAccess(request);
    if (!access.ok) return privateResponse(access.response);
    const parsed = PublishingAdminActionSchema.safeParse(await readPublishingJson(request));
    if (!parsed.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "请求字段不符合发布管理合同", 400);
    const action = parsed.data;
    const capability = action.action === "save-config" ? "integrations.manage" : "packages.manage";
    const authorization = await authorizeAdminCapability(request, capability, { requireStepUp: true, operation: action.action === "save-config" ? "publishing_config_write" : "publishing_plan_write", auditAllowed: true });
    if (!authorization.ok) return privateResponse(authorization.response);
    const database = getSupabase();
    await mutatePublishingAdmin(database, authorization.actor.userId, action);
    return NextResponse.json(await readPublishingAdmin(database, await billingAccess(request)), { headers });
  } catch (error) { return failure(error); }
}
