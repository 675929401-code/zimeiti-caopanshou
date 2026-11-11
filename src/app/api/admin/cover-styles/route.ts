import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { readCoverRequestJson, CoverRequestBodyError } from "@/lib/server/cover-request-body";
import { coverStyleAdminDto, CoverStyleMutationSchema, loadCoverStyleCatalog, mutateCoverStyleCatalog } from "@/lib/server/cover-style-store";
import { CoverStyleStoreError } from "@/lib/server/cover-style-config";
import { previewCoverAnalysisRuntime, readCoverAnalysisModelOptions } from "@/lib/server/cover-admin-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
function privateResponse<T extends Response>(response: T): T { response.headers.set("Cache-Control", headers["Cache-Control"]); return response; }
async function modelOptions() {
  try { return { modelOptions: await readCoverAnalysisModelOptions() }; }
  catch { return { modelOptions: [], modelOptionsUnavailable: true }; }
}
function failure(error: unknown) {
  if (error instanceof CoverStyleStoreError) return NextResponse.json({ error: error.message, code: error.code,
    ...(error.outcome ? { outcome: error.outcome, retryable: false } : {}) }, { status: error.status, headers });
  if (error instanceof CoverRequestBodyError) return NextResponse.json({ error: error.message, code: "COVER_STYLE_INPUT_INVALID" }, { status: error.status, headers });
  return NextResponse.json({ error: "风格配置操作暂不可确认，请读取当前状态", code: "COVER_STYLE_SERVICE_UNAVAILABLE" }, { status: 503, headers });
}
export async function GET(request: NextRequest) {
  try {
    const auth = await authorizeAdminCapability(request, "prompts.view", { requireStepUp: true, operation: "cover_style_admin_read", auditAllowed: true });
    if (!auth.ok) return privateResponse(auth.response);
    const [loaded, options] = await Promise.all([loadCoverStyleCatalog(), modelOptions()]);
    return NextResponse.json({ ...coverStyleAdminDto(loaded, request.nextUrl.searchParams.get("styleKey") ?? undefined,
      request.nextUrl.searchParams.get("releaseId") ?? undefined, request.nextUrl.searchParams.get("workflowReleaseId") ?? undefined), ...options }, { headers });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const body = await readCoverRequestJson(request, 512 * 1024);
    const preview = body && typeof body === "object" && "action" in body && body.action === "preview";
    const auth = await authorizeAdminCapability(request, preview ? "prompts.view" : "prompts.edit", {
      requireStepUp: true, operation: preview ? "cover_style_admin_preview" : "cover_style_admin_write", auditAllowed: true,
    });
    if (!auth.ok) return privateResponse(auth.response);
    if (preview) {
      const { action: _action, ...input } = body as Record<string, unknown>;
      void _action;
      return NextResponse.json({ ok: true, preview: await previewCoverAnalysisRuntime(input) }, { headers });
    }
    const parsed = CoverStyleMutationSchema.safeParse(body);
    if (!parsed.success) throw new CoverStyleStoreError("COVER_STYLE_INPUT_INVALID", "制作配置操作参数或提示词无效", 400);
    const result = await mutateCoverStyleCatalog(auth.actor.userId, parsed.data);
    const key = body && typeof body === "object" && "styleKey" in body && typeof body.styleKey === "string" ? body.styleKey : undefined;
    return NextResponse.json({ ok: true, ...coverStyleAdminDto(result, key), ...await modelOptions() }, { headers });
  } catch (error) { return failure(error); }
}
