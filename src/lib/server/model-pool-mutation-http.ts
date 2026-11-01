import { NextResponse } from "next/server";
import { PlatformConfigurationError, resumePlatformModelMutation } from "./platform-configuration-admin";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
type HttpRequest = Pick<Request, "headers" | "method" | "url">;

export function modelPoolMutationRequest(request: HttpRequest, body: unknown, targetId?: string) {
  const requestId = String(request.headers.get("Idempotency-Key") || "").trim();
  if (!UUID.test(requestId)) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_ID_INVALID", "请刷新页面后重新提交本次模型配置");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_PAYLOAD_INVALID", "模型配置必须是对象");
  }
  const value = body as Record<string, unknown>;
  return {
    requestId,
    requestPayload: {
      method: request.method.toUpperCase(),
      modelType: String(value.model_type || new URL(request.url).pathname),
      resourcePath: new URL(request.url).pathname,
      targetId: targetId || String(value.id || ""),
      body: structuredClone(value),
    },
  };
}

export async function resumeModelPoolMutationResponse(actorId: string, mutation: ReturnType<typeof modelPoolMutationRequest>) {
  const release = await resumePlatformModelMutation(actorId, mutation.requestId, mutation.requestPayload);
  if (!release) return null;
  const published = release.status === "published" || release.status === "superseded" || release.is_current === true;
  return NextResponse.json({ success: true, staged: true, published,
    replayed: true, requestId: mutation.requestId, result: { release } },
  { status: 202, headers: { "Cache-Control": "no-store, max-age=0" } });
}

/** Database errors may contain row values. Expose only reviewed codes and opaque operation identities. */
export function modelPoolMutationFailure(error: unknown): NextResponse | null {
  if (!(error instanceof PlatformConfigurationError)) return null;
  const code = /^[A-Z][A-Z0-9_]{2,100}$/u.test(error.code) ? error.code : "PLATFORM_CONFIGURATION_OPERATION_FAILED";
  const detail = error as PlatformConfigurationError & {
    outcome?: unknown; requestId?: unknown; candidateId?: unknown; phase?: unknown;
  };
  const unknown = code === "PLATFORM_CONFIGURATION_MUTATION_OUTCOME_UNKNOWN" || detail.outcome === "outcome_unknown";
  const requestId = typeof detail.requestId === "string" && UUID.test(detail.requestId) ? detail.requestId : undefined;
  const candidateId = typeof detail.candidateId === "string" && UUID.test(detail.candidateId) ? detail.candidateId : undefined;
  let status = 503;
  let message = "模型配置服务暂不可用，请保留编辑内容并查询本次操作结果。";
  if (unknown) {
    message = "本次保存结果待确认，请查询原操作回执，避免重新创建候选。";
  } else if (code === "PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED") {
    status = 409; message = "此候选同时包含密钥变更和模型下架，请先单独发布密钥变更，再创建下架候选。";
  } else if (code === "PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED") {
    status = 409; message = "模型池基线已变化，暂存凭据尚未生效。请以当前版本重新创建候选并重新核对凭据。";
  } else if (/NOT_FOUND$/u.test(code)) {
    status = 404; message = "目标模型或候选不存在，请刷新后核对。";
  } else if (/INVALID|UNSUPPORTED|REQUIRED|CHANGE_NOTE/u.test(code) && !/RUNTIME|MIGRATION|READINESS|CURRENT_RELEASE/u.test(code)) {
    status = 400; message = "模型配置或操作编号无效，请检查输入并刷新后核对。";
  } else if (/CONFLICT|MISMATCH|STALE|ALREADY|CURRENT_CHANGED|PREVIEW|NOT_CURRENT|IDEMPOTENCY/u.test(code)) {
    status = 409; message = "配置或凭据版本已变化，请读取原候选并重新预览。";
  }
  return NextResponse.json({
    success: false, ok: false, code, error: message,
    ...(unknown ? { outcome: "unknown", retryable: false } : {}),
    ...(requestId ? { requestId, receiptPath: `/api/admin/model-pool-releases?requestId=${requestId}` } : {}),
    ...(candidateId ? { candidateId } : {}),
  }, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}
