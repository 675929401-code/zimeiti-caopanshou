import { NextRequest, NextResponse } from "next/server";
import { requireCommerceAdmin } from "@/lib/commerce-admin-auth";
import {
  createPlatformConfigurationCandidate,
  createPlatformConfigurationRollbackCandidate,
  platformConfigurationOverview,
  PlatformConfigurationError,
  PlatformConfigurationImageAdditionError,
  previewPlatformConfigurationRelease,
  previewImageModelAdditionTransaction,
  publishPlatformConfigurationRelease,
  publishLlmVisionCapabilityOnlyRelease,
  validatePlatformConfigurationCandidate,
  readPlatformModelMutationReceipt,
  readPlatformConfigurationRelease,
} from "@/lib/server/platform-configuration-admin";
import { modelPoolMutationFailure } from "@/lib/server/model-pool-mutation-http";
import { modelPoolCredentialStatus } from "@/lib/server/model-pool-credential-status";
import { stageInitialModelPoolCandidate } from "@/lib/server/platform-configuration-compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kind = "model-pool" as const;
const noStore = { "Cache-Control": "no-store, max-age=0" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function failure(error: unknown, fallback: string, status = 409) {
  if (error instanceof PlatformConfigurationImageAdditionError) {
    return NextResponse.json({ ok: false, code: error.code,
      error: error.code === "IMAGE_ADDITION_ALREADY_PUBLISHED" ? "原图片模型候选已发布，请读取原候选和当前版本，不要重复提交"
        : error.outcome ? "原图片模型发布结果未知，请查询原候选及当前版本，不要重复提交" : "单图片模型新增事务未通过校验，本次未发布",
      retryable: false, ...(error.outcome ? { outcome: error.outcome } : {}),
      candidateId: error.candidateId, receiptPath: error.receiptPath }, { status: error.status, headers: noStore });
  }
  const classified = modelPoolMutationFailure(error);
  if (classified) return classified;
  const code = error instanceof PlatformConfigurationError ? error.code : "PLATFORM_CONFIGURATION_OPERATION_FAILED";
  return NextResponse.json({ ok: false, code, error: fallback }, { status, headers: noStore });
}

export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request);
  if ("response" in auth) return auth.response;
  try {
    const originalReleaseId = request.nextUrl.searchParams.get("releaseId");
    if (originalReleaseId) {
      const readAuth = await requireCommerceAdmin(request, { requiredPermissions: ["models.manage"], operation: "image_model_addition_readback" });
      if ("response" in readAuth) return readAuth.response;
      return NextResponse.json({ ok: true, release: await readPlatformConfigurationRelease(kind, originalReleaseId) }, { headers: noStore });
    }
    const requestId = request.nextUrl.searchParams.get("requestId");
    if (requestId) return NextResponse.json({ ok: true, requestId, receipt: await readPlatformModelMutationReceipt(auth.actor.userId, requestId) }, { headers: noStore });
    const credentialReleaseId = request.nextUrl.searchParams.get("credentialReleaseId");
    if (credentialReleaseId) return NextResponse.json({ ok: true, releaseId: credentialReleaseId,
      credentialChanges: await modelPoolCredentialStatus(credentialReleaseId) }, { headers: noStore });
    const releaseId = request.nextUrl.searchParams.get("previewReleaseId");
    if (releaseId) return NextResponse.json({ ok: true, preview: await previewPlatformConfigurationRelease(kind, releaseId) }, { headers: noStore });
    return NextResponse.json({ ok: true, ...(await platformConfigurationOverview(kind)) }, { headers: noStore });
  } catch (error) {
    return failure(error, "读取模型池版本失败", 503);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, true);
  if ("response" in auth) return auth.response;
  try {
    const body = record(await request.json());
    const action = String(body.action || "draft");
    if (action === "publish" || action === "preview-image-addition-transaction") {
      const publishAuth = await requireCommerceAdmin(request, { mutation: true,
        requiredPermissions: ["models.manage"], stepUpPermissions: ["models.manage"],
        operation: action === "publish" ? "model_pool_publish" : "image_model_addition_rehearsal" });
      if ("response" in publishAuth) return publishAuth.response;
      const allowed = new Set(["action", "releaseId", "previewSha256"]);
      if (Object.keys(body).some(key => !allowed.has(key))) {
        return failure(new PlatformConfigurationError("PLATFORM_CONFIGURATION_PUBLISH_INPUT_INVALID", "发布不接受客户端范围、凭据或配置覆盖"), "发布参数无效", 400);
      }
      const result = action === "publish"
        ? await publishPlatformConfigurationRelease(publishAuth.actor.userId, kind, String(body.releaseId || ""), String(body.previewSha256 || ""))
        : await previewImageModelAdditionTransaction(publishAuth.actor.userId, String(body.releaseId || ""), String(body.previewSha256 || ""));
      return NextResponse.json(action === "publish" ? { ok: true, release: result } : { ok: true, ...result }, { headers: noStore });
    }
    if (action === "publish-vision-capability-only") {
      const visionAuth = await requireCommerceAdmin(request, { mutation: true,
        requiredPermissions: ["models.manage"], stepUpPermissions: ["models.manage"], operation: "llm_vision_capability_only_publish" });
      if ("response" in visionAuth) return visionAuth.response;
      const allowed = new Set(["action", "releaseId", "previewSha256", "targetModelId"]);
      if (Object.keys(body).some(key => !allowed.has(key))) {
        return failure(new PlatformConfigurationError("VISION_PUBLICATION_INPUT_INVALID", "仅能力发布不接受客户端证据、凭据或配置覆盖"), "图片能力发布参数无效", 400);
      }
      try {
        const release = await publishLlmVisionCapabilityOnlyRelease(visionAuth.actor.userId, String(body.releaseId || ""),
          String(body.previewSha256 || ""), String(body.targetModelId || ""));
        return NextResponse.json({ ok: true, release }, { headers: noStore });
      } catch (error) {
        if (error instanceof PlatformConfigurationError && error.code === "VISION_PUBLICATION_OUTCOME_UNKNOWN") {
          return NextResponse.json({ ok: false, code: error.code, error: "原发布结果待核对，请读取当前版本及原候选，不要重复提交或转入普通发布",
            outcome: "outcome_unknown", retryable: false, releaseId: String(body.releaseId || ""),
            receiptPath: "/api/admin/model-pool-releases" }, { status: 503, headers: noStore });
        }
        throw error;
      }
    }

    const release = action === "bootstrap"
      ? await stageInitialModelPoolCandidate({ actorId: auth.actor.userId, changeNote: String(body.changeNote || "") || undefined })
      : action === "draft"
      ? await createPlatformConfigurationCandidate(auth.actor.userId, kind, body.snapshot, body.changeNote)
      : action === "validate"
        ? await validatePlatformConfigurationCandidate(auth.actor.userId, kind, String(body.releaseId || ""))
        : action === "rollback"
            ? await createPlatformConfigurationRollbackCandidate(auth.actor.userId, kind, String(body.targetId || ""), body.changeNote)
            : null;
    if (!release) return failure(new PlatformConfigurationError("PLATFORM_CONFIGURATION_ACTION_INVALID", "未知模型池版本操作"), "操作无效", 400);
    return NextResponse.json({ ok: true, release }, { status: action === "bootstrap" || action === "draft" || action === "rollback" ? 201 : 200, headers: noStore });
  } catch (error) {
    return failure(error, "模型池版本操作失败");
  }
}
