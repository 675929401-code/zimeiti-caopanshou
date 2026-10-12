import { generatedImageReferenceUri, parseGeneratedImageReferenceUri, parseGeneratedVideoImageInputs } from "@/lib/generated-image-reference";
import { GeneratedImageReferenceError, resolveGeneratedImageReference, readGeneratedImageMaterial } from "@/lib/server/generated-image-reference";
import { probeAutodlH3ProviderDeliveryReadiness } from "@/lib/autodl-h3-provider-delivery-readiness";
/**
 * 视频生成 API
 * POST - 提交视频生成任务（预检现金余额 + 直接提交 + 失败即时反馈）
 *
 * 扣费策略：异步模型生成成功后扣现金（在 status/poll 路由中执行）
 *           同步模型（grok）立即返回视频URL后扣费
 * 现金与积分完全独立：积分用于智能体聊天，现金用于视频/封面生成
 *
 * 简化逻辑：用户选哪个通道就提交哪个通道，提交失败直接反馈让用户手动切换模型
 */
import { after, NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getProductionVideoModelById } from "@/lib/production-data-source";
import { buildDigitalDispatch, queuedDigitalProtocol } from '@/lib/digital-video-dispatch';
import { startDigitalVideoQueueWorker } from '@/lib/digital-video-queue-worker';
import { submitVideoTask, validateVideoParameterContract } from "@/lib/video-adapter";
import type { VideoGenerateParams, VideoModelConfig } from "@/lib/video-adapter";
import { checkCashBalance } from "@/lib/billing";
import {
  buildVideoGenerationRequestSnapshot,
  reserveVideoGenerationTask,
  type VideoRequestAssetRef,
} from "@/lib/video-budget-reservation";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { authorizeVideoAdminValidation, loadVideoAdminValidationContext, buildVideoAdminValidationContext, buildVideoAdminValidationClaimKey, VideoAdminValidationError } from "@/lib/video-admin-validation";
import { detectSuspiciousBody, trackIPSecurityEvent, logSecurityEvent, getClientIP as getSecIP, getUserAgent as getSecUA } from "@/lib/security";
import {
  coerceVideoTargetDuration,
  resolveVideoDuration,
  resolveVideoResolution,
} from "@/lib/video-model-capabilities";
import { getVideoInputContract, validateVideoInputContract } from "@/lib/video-input-contract";
import { isDigitalHumanWorkspaceModel } from "@/lib/video-model-surface";
import {
  evaluateWorkspaceModelCompatibility,
  videoWorkspaceSurfaceFromRequest,
} from "@/lib/workspace-model-policy";
import {
  WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY,
  isWorkspaceModelAssigned,
  parseWorkspaceModelAssignmentOverrides,
} from "@/lib/workspace-model-assignment-settings";
import { findModelByPublicId, publicModelDisplayName, toPublicModelId } from "@/lib/public-model-dto";
import { classifyVideoProviderError, sanitizeVideoProviderDiagnostic } from "@/lib/video-error-policy";
import { recordVideoSubmission, recordVideoTerminalOutcome } from "@/lib/video-terminal-accounting";
import {
  authorizeVideoChannelRecoveryCanary,
  evaluateVideoChannelCircuit,
} from "@/lib/video-channel-health-circuit";
import { isPublicVideoAssetUrl } from "@/lib/video-public-url";
import { safeFetch } from "@/lib/safe-fetch";
import { validateUploadBuffer } from "@/lib/file-upload-security";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { assertAutodlH3SelfhostModelBinding, isAutodlH3Selfhost } from "@/lib/autodl-h3-selfhost";
import { probeAutodlH3SelfhostGateway } from "@/lib/video-autodl-h3-selfhost";
import {
  AUTODL_COMFYUI_WORKFLOW_PROTOCOL,
  isAutodlComfyuiHostedProtocol,
  validateAutodlComfyuiWorkflowInput,
} from "@/lib/video-autodl-comfyui-workflow";
import {
  buildAutodlH3ClientRequestId,
  createAutodlH3PublicTaskId,
  enqueueAutodlH3VideoJob,
  getAutodlH3VideoJobForUser,
  isAutodlH3LifecycleEnabled,
} from "@/lib/autodl-h3-lifecycle";
import {
  AutodlH3AssetError,
  createAutodlH3AssetRef,
  parseAutodlH3AssetRef,
  stabilizeAutodlH3InputAssets,
  type AutodlH3StableInputAssets,
} from "@/lib/autodl-h3-assets";
import {
  bindVideoProviderTask,
  buildVideoRequestFingerprint,
  buildVideoTaskIdentity,
  finalizeVideoGenerationSuccess,
  markVideoSubmissionFailed,
  normalizeVideoClientRequestId,
  requireVideoPriceSnapshot,
  videoTerminalErrorResponse,
} from "@/lib/video-terminal-finalizer";
import {
  buildVideoRoutingSnapshot,
  persistVideoProviderDispatchReceipt,
  persistVideoProviderSubmissionReceipt,
} from "@/lib/video-routing-snapshot";
import { videoBillingAdapterAdmission } from "@/lib/video-model-availability";
import { resumeRequestedVideoCancellation } from "@/lib/video-cancellation-runtime";
import {
  acquireProviderAdmission,
  ProviderAdmissionBusyError,
  ProviderAdmissionUnavailableError,
  type ProviderAdmissionLease,
} from "@/lib/provider-admission-control";

function sanitizeVideoTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth-redacted]";
  if (typeof value === "string") return sanitizeVideoProviderDiagnostic(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => sanitizeVideoTraceValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 256)
      .filter(([key]) => !/(?:authorization|api.?key|access.?key|secret|token|password|cookie|signature)/iu.test(key))
      .map(([key, item]) => [key, sanitizeVideoTraceValue(item, depth + 1)]));
  }
  return sanitizeVideoProviderDiagnostic(value);
}

async function writeVideoTrace(event: Record<string, unknown>) {
  try {
    const traceDirectory = resolveAppRuntimeDir();
    await mkdir(traceDirectory, { recursive: true });
    const safeEvent = sanitizeVideoTraceValue(event) as Record<string, unknown>;
    await appendFile(path.join(traceDirectory, "canvas-video-generation.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), ...safeEvent })}\n`, "utf8");
  } catch (error) {
    console.warn("[Video/Trace] Failed to persist trace:", sanitizeVideoProviderDiagnostic(error));
  }
}

function isTencentCosAssetUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && /^[a-z0-9][a-z0-9-]{0,62}\.cos(?:-internal)?\.[a-z0-9-]+\.myqcloud\.com$/iu.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 视频供应商会在自己的网络中重新读取输入素材。私有 COS 的 GET 签名
 * 地址虽然能在浏览器里打开，但部分供应商会先发 HEAD 请求，导致签名
 * 方法不匹配并返回 403。提交前把当前账号拥有的素材转存为无查询参数的
 * 公开推理副本；归属或文件类型校验失败时 fail-closed。
 */
async function bridgeVideoProviderAsset(
  url: string,
  userId: string,
  category: "image" | "audio" | "video",
  ownedStorageKey?: string,
) {
  const { storageManager } = await import("@/storage/object");
  const maximumBytes = category === "image"
    ? 25 * 1024 * 1024
    : category === "audio"
      ? 100 * 1024 * 1024
      : 500 * 1024 * 1024;
  const isTencentCosCandidate = isTencentCosAssetUrl(url);

  let bytes: Buffer;
  let declaredContentType: string;
  try {
    // The storyboard card already carries the durable COS key for freshly
    // persisted images. Prefer that key over the browser's signed preview URL
    // so a private/expired preview URL can never break an otherwise valid H3
    // submission. Ownership is still checked by stabilizeAutodlH3InputAssets.
    const candidate = category === "image" && ownedStorageKey?.trim()
      ? createAutodlH3AssetRef("tencent_cos", ownedStorageKey.trim())
      : url;
    const stable = await stabilizeAutodlH3InputAssets({
      userId,
      candidates: category === "image"
        ? { imageUrl: candidate }
        : category === "audio"
          ? { audioUrl: url }
          : { sourceVideoUrl: url },
    });
    const owned = parseAutodlH3AssetRef(
      category === "image"
        ? stable.imageAssetRef
        : category === "audio"
          ? stable.audioAssetRef
          : stable.sourceVideoAssetRef,
    );
    if (!owned) throw new Error("视频参考素材没有稳定的 COS 归属引用");
    const db = getSupabaseAdminClient();
    const { data: file, error } = await db
      .from("user_files")
      .select("storage_key, content_type, file_size")
      .eq("user_id", userId)
      .eq("storage_provider", owned.provider)
      .eq("storage_key", owned.key)
      .eq("file_category", category)
      .maybeSingle();
    if (error || !file) throw new Error("视频参考素材归属记录不可用");
    const declaredSize = Number(file.file_size || 0);
    if (declaredSize > maximumBytes) throw new Error("视频参考素材超过大小限制");
    bytes = await storageManager.read(owned.key, owned.provider);
    declaredContentType = String(file.content_type || "application/octet-stream");
  } catch (error) {
    // 腾讯 COS URL 必须通过当前用户的对象归属校验，不能在失败后降级为
    // 普通网络下载；这既修复签名 URL 被 SSRF 门禁误拦的问题，也防止跨租户取件。
    if (ownedStorageKey || isTencentCosCandidate) throw error;
    const remote = await safeFetch(url, {
      maxBytes: maximumBytes,
      timeoutMs: 30_000,
      maxRedirects: 2,
      allowedContentTypes: category === "image"
        ? ["image/jpeg", "image/png", "image/webp"]
        : category === "audio"
          ? ["audio/mpeg", "audio/wav", "audio/mp4", "audio/flac"]
          : ["video/mp4", "video/webm", "video/quicktime"],
      trustedHostnames: [
        "source.openclaw-token.shop",
        "flow.secure-skill.com",
        "codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com",
      ],
    });
    bytes = remote.buffer;
    declaredContentType = remote.contentType;
  }

  if (bytes.byteLength > maximumBytes) throw new Error("视频参考素材超过大小限制");
  const validated = validateUploadBuffer(bytes, declaredContentType);
  if (category === "image" && !validated.contentType.startsWith("image/")) {
    throw new Error("视频参考图片文件类型无效");
  }
  if (category === "audio" && !validated.contentType.startsWith("audio/")) {
    throw new Error("视频参考音频文件类型无效");
  }
  if (category === "video" && !validated.contentType.startsWith("video/")) {
    throw new Error("视频参考源文件类型无效");
  }

  // 内容寻址让同一用户在同一天对同一素材的重放复用一个公开副本，避免在
  // 供应商提交前因页面重试反复创建对象。COS provider 会统一插入 UTC 日期目录。
  const userNamespace = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  const contentDigest = createHash("sha256").update(bytes).digest("hex");
  const bridgePrefix = `video-provider-input/${category}/${userNamespace}/`;
  const bridgeFileName = `${contentDigest}${validated.extension}`;
  const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const bridgeKey = `${bridgePrefix}${datePath}/${bridgeFileName}`;
  const inputUrl = new URL(url);
  inputUrl.hostname = inputUrl.hostname.replace(".cos-internal.", ".cos.");
  const existingPublicUrl = `${inputUrl.origin}/${bridgeKey}`;
  const db = getSupabaseAdminClient();
  const { data: existing } = await db
    .from("user_files")
    .select("storage_key,is_public")
    .eq("user_id", userId)
    .eq("storage_provider", "tencent_cos")
    .eq("storage_key", bridgeKey)
    .eq("is_public", true)
    .limit(1);
  if (existing?.[0] && await storageManager.exists(bridgeKey, "tencent_cos")) {
    if (!isPublicVideoAssetUrl(existingPublicUrl) || new URL(existingPublicUrl).search) {
      throw new Error("视频参考素材的公开推理副本地址无效");
    }
    return existingPublicUrl;
  }

  const result = await storageManager.upload(bytes, bridgeFileName, validated.contentType, {
    providerType: "tencent_cos",
    strictProvider: true,
    publicRead: true,
    category,
    userId,
    source: "video-provider-reference-bridge",
    prefix: bridgePrefix,
    fileName: bridgeFileName,
    requireOwnershipRecord: true,
  });
  if (!result.isPublic || result.provider !== "tencent_cos" || result.key !== bridgeKey || !isPublicVideoAssetUrl(result.url) || new URL(result.url).search) {
    throw new Error("视频参考素材转存后没有返回上游可访问的公开 COS 地址");
  }
  return result.url;
}

function hasAnyVideoReference(input: {
  imageUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrl?: string;
  imageUrls?: string[];
}) {
  return Boolean(input.imageUrl || input.lastFrameUrl || input.referenceImageUrl || input.imageUrls?.length);
}

function stableVideoRequestAssetRef(value: unknown, ownedStorageKey = ""): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (parseGeneratedImageReferenceUri(value)) return String(value);
  if (ownedStorageKey) return createAutodlH3AssetRef("tencent_cos", ownedStorageKey);
  if (/^(?:object|asset):\/\//u.test(raw) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!url.username && !url.password && !url.search && !url.hash) return url.toString();
    if (!url.username && !url.password && ["http:", "https:"].includes(url.protocol)) {
      const identity = `${url.protocol}//${url.host}${url.pathname}`;
      return `asset://request/${createHash("sha256").update(identity).digest("hex")}`;
    }
  } catch { /* Snapshot validation below will reject malformed references. */ }
  return raw;
}

class PageReferenceAssetRefError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code === "VIDEO_REFERENCE_ASSET_LOOKUP_FAILED"
      ? "参考素材归属校验暂时不可用，本次未提交"
      : "参考素材引用无效，请重新上传后再提交");
  }
}

function tencentCosPageAssetKey(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || !/^[a-z0-9][a-z0-9-]{0,62}\.cos(?:-internal)?\.[a-z0-9-]+\.myqcloud\.com$/iu.test(url.hostname)) return "";
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return "";
  }
}

async function resolveOwnedPageReferenceAssetRefs(
  db: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  value: unknown,
  candidates: Array<{ url: unknown; category: "image" | "audio" }>,
) {
  if (value !== undefined && (!Array.isArray(value) || value.length > 16)) {
    throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_REF_INVALID", 400);
  }
  const submitted = new Map(candidates
    .filter((candidate) => typeof candidate.url === "string" && Boolean(candidate.url.trim()))
    .map((candidate) => [String(candidate.url).trim(), candidate.category]));
  const hints = new Map<string, string>();
  for (const candidate of Array.isArray(value) ? value : []) {
    const item = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const assetRef = typeof item.asset_ref === "string" ? item.asset_ref.trim() : "";
    const category = item.category === "audio" ? "audio" : item.category === "image" ? "image" : "";
    const parsed = parseAutodlH3AssetRef(assetRef);
    if (!url || !category || submitted.get(url) !== category || !parsed || tencentCosPageAssetKey(url) !== parsed.key) {
      throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_REF_INVALID", 400);
    }
    const previous = hints.get(url);
    if (previous && previous !== assetRef) throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_REF_INVALID", 400);
    hints.set(url, assetRef);
  }

  const result = new Map<string, string>();
  for (const [url, category] of submitted) {
    const key = tencentCosPageAssetKey(url);
    if (!key) continue;
    const owned = await db.from("user_files")
      .select("id")
      .eq("user_id", userId)
      .eq("storage_provider", "tencent_cos")
      .eq("storage_key", key)
      .eq("file_category", category)
      .eq("source", "video-page-reference")
      .limit(2);
    if (owned.error) throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_LOOKUP_FAILED", 503);
    if ((owned.data || []).length > 1) {
      throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_REF_INVALID", 400);
    }
    if ((owned.data || []).length === 0) continue;
    const assetRef = createAutodlH3AssetRef("tencent_cos", key);
    if (hints.has(url) && hints.get(url) !== assetRef) {
      throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_REF_INVALID", 400);
    }
    result.set(url, assetRef);
  }
  if ([...hints.keys()].some((url) => !result.has(url))) {
    throw new PageReferenceAssetRefError("VIDEO_REFERENCE_ASSET_REF_INVALID", 400);
  }
  return result;
}

function buildVideoRequestAssetRefs(input: {
  imageUrl?: unknown;
  imageStorageKey?: string;
  lastFrameUrl?: unknown;
  referenceImageUrl?: unknown;
  referenceImageUrls?: unknown[];
  audioUrl?: unknown;
  referenceAudioUrls?: unknown[];
  sourceVideoUrl?: unknown;
  personAssetId?: unknown;
  audioAssetId?: unknown;
  ownedPageAssetRefs?: Map<string, string>;
}): VideoRequestAssetRef[] {
  const assets: VideoRequestAssetRef[] = [];
  const add = (role: VideoRequestAssetRef["role"], index: number, value: unknown, storageKey = "") => {
    const raw = typeof value === "string" ? value.trim() : "";
    const ref = stableVideoRequestAssetRef(input.ownedPageAssetRefs?.get(raw) || value, storageKey);
    if (ref) assets.push({ role, index, ref });
  };
  add("first_frame", 0, input.imageUrl, input.imageStorageKey);
  add("last_frame", 0, input.lastFrameUrl);
  add("reference_image", 0, input.referenceImageUrl);
  (input.referenceImageUrls || []).forEach((value, index) => add("reference_image_list", index, value));
  add("reference_audio", 0, input.audioUrl);
  (input.referenceAudioUrls || []).forEach((value, index) => add("reference_audio_list", index, value));
  add("source_video", 0, input.sourceVideoUrl);
  add("person_asset", 0, input.personAssetId);
  add("audio_asset", 0, input.audioAssetId);
  return assets;
}

export async function POST(req: NextRequest) {
  const submitStart = Date.now();
  const traceId = crypto.randomUUID();
  let traceModelId = "";
  let traceTaskLabel = "";
  let tracePromptHash = "";
  let acceptedReceipt: { taskId: string; businessTaskId: string; modelId: unknown } | null = null;
  try {
    // 验证用户身份
    const token = getTokenFromHeaders(req.headers);
    if (!token) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "登录已过期，请重新登录" }, { status: 401 });
    }
    const userId = payload.userId;
    const currentAuthorization = await authorizeAdminToken(token);
    if (!currentAuthorization.ok && currentAuthorization.code !== "ADMIN_REQUIRED") {
      return NextResponse.json({ error: currentAuthorization.error, error_code: currentAuthorization.code, task_submitted: false }, { status: currentAuthorization.status });
    }
    let userRole: "admin" | "student" = currentAuthorization.ok ? "admin" : "student";

    const body = await req.json();
    let generatedInputs: ReturnType<typeof parseGeneratedVideoImageInputs>;
    try { generatedInputs = parseGeneratedVideoImageInputs(body); } catch {
      return NextResponse.json({ error: "生成图片引用格式无效或与原始地址冲突", error_code: "GENERATED_IMAGE_REFERENCE_INVALID", task_submitted: false }, { status: 422 });
    }
    const generatedImageRef = generatedInputs.typed.get("image_url") || null;
    const generatedImageUri = generatedImageRef ? generatedImageReferenceUri(generatedImageRef) : null;
    const image_url = generatedInputs.imageUrl;
    const last_frame_url = generatedInputs.lastFrameUrl;
    const reference_image_url = generatedInputs.referenceImageUrl;
    const { model_id, prompt, audio_url, negative_prompt, duration, aspect_ratio, resolution, resolution_tier, source_video_url, task_label, batch_id, batch_topic, card_index, surface, client_request_id } = body;
    const generateAudio = Object.prototype.hasOwnProperty.call(body, "generate_audio")
      ? body.generate_audio
      : body.generateAudio;
    if (body.generate_audio !== undefined && body.generateAudio !== undefined && body.generate_audio !== body.generateAudio) {
      return NextResponse.json({
        error: "音轨开关参数冲突，本次未提交上游",
        error_code: "VIDEO_PARAMETER_CONFLICT",
        parameter: "generateAudio",
        retryable: false,
        task_submitted: false,
      }, { status: 422 });
    }
    const adminValidationRequested = body.admin_validation === true;
    const adminAuthorization = adminValidationRequested ? currentAuthorization : null;
    if (adminAuthorization && !adminAuthorization.ok) return NextResponse.json({ error: adminAuthorization.error, error_code: adminAuthorization.code, task_submitted: false }, { status: adminAuthorization.status });
    if (adminAuthorization?.ok) userRole = "admin";
    const healthRecoveryCanaryRequested = body.health_recovery_canary === true;
    const healthRecoveryKey = body.health_recovery_key;
    const healthRecoveryConfirmation = body.health_recovery_confirmation;
    const healthOperatorRetest = body.health_operator_retest === true;
    const healthOperatorRetestReason = typeof body.health_operator_retest_reason === "string" ? body.health_operator_retest_reason.trim() : "";
    const internalModelIdRequested = typeof model_id === "string"
      && model_id.trim().length > 0
      && !model_id.startsWith("pm_");
    let privilegedModelOperationAuthorized = false;
    if (adminValidationRequested || healthRecoveryCanaryRequested || healthOperatorRetest || internalModelIdRequested) {
      const modelAccess = await authorizeAdminCapability(req, "models.manage", {
        requireStepUp: true,
        operation: adminValidationRequested
          ? "video_model_validation_generate"
          : healthRecoveryCanaryRequested || healthOperatorRetest
            ? "video_channel_recovery_generate"
            : "video_internal_model_generate",
      });
      if (!modelAccess.ok) return modelAccess.response;
      privilegedModelOperationAuthorized = true;
    }
    if (healthRecoveryCanaryRequested || healthOperatorRetest) {
      const admin = currentAuthorization;
      if (!admin.ok) return NextResponse.json({ error: admin.error, error_code: admin.code, task_submitted: false }, { status: admin.status });
      userRole = "admin";
      if (healthOperatorRetest && !healthRecoveryCanaryRequested) {
        return NextResponse.json({ error: "修复后复测需要显式授权单次生成", error_code: "CHANNEL_RETEST_CONFIRMATION_REQUIRED", task_submitted: false }, { status: 409 });
      }
    }
    const image_storage_key = typeof body.image_storage_key === "string" ? body.image_storage_key.trim() : "";
    const rawReferenceImageUrls = generatedInputs.referenceImageUrls;
    const rawReferenceAudioUrls = body.reference_audio_urls;
    if (rawReferenceImageUrls !== undefined && !Array.isArray(rawReferenceImageUrls)
      || rawReferenceAudioUrls !== undefined && !Array.isArray(rawReferenceAudioUrls)) {
      return NextResponse.json({ error: "参考素材列表格式无效", error_code: "VIDEO_REFERENCE_LIST_INVALID", task_submitted: false }, { status: 400 });
    }
    if ((rawReferenceImageUrls?.length || 0) > 32 || (rawReferenceAudioUrls?.length || 0) > 16) {
      return NextResponse.json({ error: "参考素材数量超过请求安全上限", error_code: "VIDEO_REFERENCE_LIST_TOO_LARGE", task_submitted: false }, { status: 400 });
    }
    if ([...(rawReferenceImageUrls || []), ...(rawReferenceAudioUrls || [])]
      .some((value: unknown) => typeof value !== "string" || !value.trim())) {
      return NextResponse.json({ error: "参考素材列表包含空值或无效地址", error_code: "VIDEO_REFERENCE_URL_INVALID", task_submitted: false }, { status: 400 });
    }
    const referenceImageUrls: string[] = (rawReferenceImageUrls || []).map((value: string) => value.trim());
    const referenceAudioUrls: string[] = (rawReferenceAudioUrls || []).map((value: string) => value.trim());
    traceModelId = typeof model_id === "string" ? model_id : "";
    traceTaskLabel = typeof task_label === "string" ? task_label : "";
    tracePromptHash = createHash("sha256").update(typeof prompt === "string" ? prompt : "").digest("hex").slice(0, 16);
    await writeVideoTrace({
      phase: "requested",
      traceId,
      modelId: traceModelId,
      taskLabel: traceTaskLabel,
      duration,
      aspectRatio: aspect_ratio || "",
      resolution: resolution_tier || resolution || "",
      promptHash: tracePromptHash,
      promptPreview: String(prompt || "").replace(/\s+/g, " ").slice(0, 240),
      hasImageUrl: Boolean(image_url),
      hasLastFrameUrl: Boolean(last_frame_url),
      hasReferenceImageUrl: Boolean(reference_image_url),
      hasAudioUrl: Boolean(audio_url),
      referenceImageCount: referenceImageUrls.length,
      referenceAudioCount: referenceAudioUrls.length,
    });

    // Prompt requirements depend on the selected model; image/audio-driven
    // workflows can deliberately omit it. The model input contract checks it below.
    if (!model_id || !userId) {
      return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
    }

    // 防御性校验：上游只能读取真实公网 URL。localhost、局域网、blob:/data:
    // 即使形式上是 http/https，也不能作为图生视频输入。
    const urlFields = {
      image_url,
      last_frame_url,
      reference_image_url,
      audio_url,
      source_video_url,
      ...Object.fromEntries(referenceImageUrls.map((url, index) => [`reference_image_urls[${index}]`, url])),
      ...Object.fromEntries(referenceAudioUrls.map((url, index) => [`reference_audio_urls[${index}]`, url])),
    };
    for (const [fieldName, val] of Object.entries(urlFields)) {
      if (typeof val === "string" && val && !(generatedInputs.typed.has(fieldName) && generatedImageReferenceUri(generatedInputs.typed.get(fieldName)!) === val) && !isPublicVideoAssetUrl(val)) {
        return NextResponse.json(
          { error: `${fieldName} 必须是上游可访问的公网URL，请通过视频制作页上传按钮重新上传（不支持本地或局域网地址）`, error_code: "VIDEO_ASSET_URL_NOT_PUBLIC" },
          { status: 400 }
        );
      }
    }

    // 校验 prompt 长度
    const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (trimmedPrompt.length > 4000) {
      return NextResponse.json({ error: `提示词过长（${trimmedPrompt.length}字），请控制在4000字以内` }, { status: 400 });
    }

    // 校验 aspect_ratio 格式
    const validRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"];
    if (aspect_ratio && !validRatios.includes(aspect_ratio)) {
      return NextResponse.json({ error: `不支持的画面比例: ${aspect_ratio}，当前仅支持: ${validRatios.join("/")}` }, { status: 400 });
    }

    // ── 安全防护1：POST请求体注入检测（SQL注入/XSS/路径遍历） ──
    const requestBody = { model_id, prompt, image_url, last_frame_url, reference_image_url, reference_image_urls: referenceImageUrls, audio_url, reference_audio_urls: referenceAudioUrls, negative_prompt, generate_audio: generateAudio, duration, aspect_ratio, resolution, resolution_tier, source_video_url, task_label, batch_id, batch_topic, card_index, client_request_id };
    const bodySuspicious = detectSuspiciousBody(requestBody, ["task_label", "batch_topic"]);
    if (bodySuspicious.suspicious) {
      const secIP = getSecIP(req as unknown as Request);
      const secUA = getSecUA(req as unknown as Request);
      const riskLevel = bodySuspicious.threatType === "sql_injection" ? "critical" as const : "high" as const;
      trackIPSecurityEvent(secIP, riskLevel);

      const eventType = bodySuspicious.threatType === "sql_injection" ? "sql_injection"
        : bodySuspicious.threatType === "xss" ? "xss_attempt"
        : "path_traversal";
      await logSecurityEvent({
        event_type: eventType,
        risk_level: riskLevel,
        ip: secIP,
        user_agent: secUA,
        path: "/api/video/generate",
        method: "POST",
        details: bodySuspicious.details,
        blocked: true,
        user_id: userId,
        username: payload.username,
        display_name: payload.displayName,
      });

      return NextResponse.json({ error: "请求包含非法内容", code: "SUSPICIOUS_BODY" }, { status: 400 });
    }

    const db = getSupabaseAdminClient();
    let ownedPageAssetRefs: Map<string, string>;
    try {
      ownedPageAssetRefs = await resolveOwnedPageReferenceAssetRefs(db, userId, body.reference_asset_refs, [
        { url: image_url, category: "image" },
        { url: last_frame_url, category: "image" },
        { url: reference_image_url, category: "image" },
        ...referenceImageUrls.map((url) => ({ url, category: "image" as const })),
        { url: audio_url, category: "audio" },
        ...referenceAudioUrls.map((url) => ({ url, category: "audio" as const })),
      ]);
    } catch (error) {
      const referenceError = error instanceof PageReferenceAssetRefError ? error : null;
      return NextResponse.json({
        error: referenceError?.message || "参考素材归属校验暂时不可用，本次未提交",
        error_code: referenceError?.code || "VIDEO_REFERENCE_ASSET_LOOKUP_FAILED",
        task_submitted: false,
        retryable: referenceError?.status === 503,
      }, { status: referenceError?.status || 503 });
    }

    // 1. 查询用户选择的模型配置。普通用户只提交公开 opaque ID；管理员兼容内部 ID。
    let dbSelectedModel = null;
    let adminValidation = null;
    let validationClaimKey = "";
    if (adminValidationRequested && adminAuthorization) {
      try {
        const context = await loadVideoAdminValidationContext(db, model_id, userId);
        const authorization = authorizeVideoAdminValidation({ context, authorization: adminAuthorization, requested: true, modelId: model_id, validationKey: body.admin_validation_key, confirmation: body.admin_validation_confirmation, clientRequestId: client_request_id });
        if (!authorization.ok) return NextResponse.json({ error: authorization.message, error_code: authorization.code, task_submitted: false }, { status: authorization.status });
        adminValidation = authorization;
        validationClaimKey = buildVideoAdminValidationClaimKey(context);
        dbSelectedModel = context.model;
        await writeVideoTrace({ phase: "admin_validation_authorized", traceId, modelId: context.model.id, userId, clientRequestId: client_request_id, configurationHash: authorization.configurationHash, healthEpoch: authorization.healthEpoch });
      } catch (error) {
        return NextResponse.json({ error: error instanceof VideoAdminValidationError ? error.message : "暂时无法读取本地验证配置", error_code: error instanceof VideoAdminValidationError ? error.code : "VIDEO_VALIDATION_UNAVAILABLE", task_submitted: false }, { status: error instanceof VideoAdminValidationError ? error.status : 503 });
      }
    }
    try {
      if (adminValidation) {
        // The authenticated local validation context already resolved the exact row.
      } else if (String(model_id).startsWith("pm_")) {
        const { data: modelRows } = await db
          .from("video_models")
          .select("*")
          .eq("is_active", true)
          .eq("is_hidden", false);
        dbSelectedModel = findModelByPublicId(
          "video",
          (modelRows || []) as Array<Record<string, unknown> & { id?: unknown }>,
          String(model_id),
        );
      } else if (privilegedModelOperationAuthorized) {
        const result = await db
          .from("video_models")
          .select("*")
          .eq("id", model_id)
          .eq("is_active", true)
          .single();
        dbSelectedModel = result.data;
      }
    } catch (modelLookupError) {
      console.warn("[video-gen] Supabase model lookup failed, trying production proxy:", sanitizeVideoProviderDiagnostic(modelLookupError));
    }

    const selectedModel = dbSelectedModel || (!adminValidationRequested && privilegedModelOperationAuthorized && !String(model_id).startsWith("pm_")
      ? await getProductionVideoModelById(model_id)
      : null);

    if (!selectedModel) {
      return NextResponse.json({ error: "模型不存在或已停用" }, { status: 404 });
    }

    const selectedProtocolConfig = selectedModel.api_protocol_config && typeof selectedModel.api_protocol_config === "object"
      ? selectedModel.api_protocol_config as Record<string, unknown>
      : {};
    const protocolParameterIssue = validateVideoParameterContract(selectedModel as VideoModelConfig, {
      prompt: trimmedPrompt,
      negativePrompt: negative_prompt,
      generateAudio,
      duration,
      fps: body.fps,
      seed: body.seed,
      resolution,
      resolutionTier: resolution_tier,
      userProvidedOptions: {
        resolution: Boolean(String(resolution ?? "").trim() || String(resolution_tier ?? "").trim()),
      },
    });
    if (protocolParameterIssue) {
      return NextResponse.json({
        error: protocolParameterIssue.message,
        error_code: protocolParameterIssue.code,
        parameter: protocolParameterIssue.parameter,
        accepted_values: protocolParameterIssue.acceptedValues,
        retryable: false,
        task_submitted: false,
        price: 0,
      }, { status: protocolParameterIssue.status });
    }
    const parameterGuardedProtocol = [
      "siliconflow_kling",
      "kling_official",
      "replicate",
      "autodl_comfyui_workflow",
      "autodl_comfyui_h3",
      "autodl_h3_selfhost",
    ]
      .includes(String(selectedModel.protocol_type || ""));
    const billingAdmission = videoBillingAdapterAdmission(selectedProtocolConfig);
    if (!billingAdmission.ready) {
      return NextResponse.json({
        error: billingAdmission.message,
        error_code: billingAdmission.code,
        retryable: false,
        task_submitted: false,
        price: 0,
      }, { status: 409 });
    }
    // A customer submission is governed by the current enabled model row and
    // the concrete checks below (surface, input, protocol, price and balance).
    // Historical acceptance evidence is an administrator diagnostic and must
    // not veto an otherwise valid live configuration.
    // Digital-person pricing is derived from owned media, never a client supplied cheap duration.
    const digitalHumanModel = isDigitalHumanWorkspaceModel(selectedModel);
    if (!adminValidation && (surface === 'digital-human' || digitalHumanModel)) {
      try {
        const { ownedDigitalHumanAsset } = await import('@/lib/digital-human-assets');
        const { humanDurationCapabilities, planHumanDuration } = await import('@/features/digital-human/duration-policy');
        const { humanBillingSeconds } = await import('@/features/digital-human/client-state');
        const [person, audio] = await Promise.all([ownedDigitalHumanAsset(userId, String(body.person_asset_id || '')), ownedDigitalHumanAsset(userId, String(body.audio_asset_id || ''))]);
        const videoMode = getVideoInputContract(selectedModel).requiresSourceVideo;
        const plan = planHumanDuration(humanDurationCapabilities(selectedModel), videoMode ? 'video' : 'photo', person.duration, audio.duration, body.duration_choice, audio.size);
        const sameObject = (left: string, right: string) => { const a = new URL(left), b = new URL(right); return a.origin === b.origin && a.pathname === b.pathname; };
        const correctAssets = audio.category === 'audio' && person.category === (videoMode ? 'video' : 'image') && sameObject(audio.url, audio_url) && sameObject(person.url, videoMode ? source_video_url : image_url);
        const expectedDuration = humanBillingSeconds({ publicPrice:Number(selectedModel.price_per_use),capabilities:{},...selectedModel }, plan.seconds);
        if (plan.error || !correctAssets || expectedDuration <= 0 || Number(duration) !== expectedDuration || (body.video_extension === true) !== plan.videoExtension) return NextResponse.json({error:plan.error || '素材或报价已变化，请回到数字人工作台重新确认',error_code:plan.code || 'DIGITAL_HUMAN_QUOTE_MISMATCH',task_submitted:false,price:0},{status:422});
      } catch { return NextResponse.json({error:'请从数字人工作台选择当前账号的素材并确认费用',error_code:'DIGITAL_HUMAN_OWNED_INPUT_REQUIRED',task_submitted:false,price:0},{status:422}); }
    }
    const inputContract = getVideoInputContract(selectedModel);
    const inputViolation = validateVideoInputContract(inputContract, {
      prompt: trimmedPrompt, imageUrl: image_url, lastFrameUrl: last_frame_url,
      referenceImageUrl: reference_image_url, referenceImageUrls,
      audioUrl: audio_url, referenceAudioUrls, sourceVideoUrl: source_video_url,
    });
    if (inputViolation) {
      return NextResponse.json({
        error: inputViolation.message, error_code: inputViolation.code,
        retryable: false, task_submitted: false,
      }, { status: 422 });
    }
    const normalizedSurface = typeof surface === "string" ? surface.trim() : "";
    const workspaceSurface = videoWorkspaceSurfaceFromRequest(normalizedSurface);
    if (!adminValidation && workspaceSurface) {
      const workspaceCompatibility = evaluateWorkspaceModelCompatibility("video", selectedModel, workspaceSurface);
      if (!workspaceCompatibility.compatible) {
        return NextResponse.json({
          error: workspaceCompatibility.issues[0]?.message || "当前工作台不支持该模型所需的输入能力",
          error_code: "MODEL_SURFACE_UNAVAILABLE",
          retryable: false,
          task_submitted: false,
        }, { status: 409 });
      }
      const assignmentResult = await db.from("platform_settings")
        .select("setting_value")
        .eq("setting_key", WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY)
        .maybeSingle();
      if (assignmentResult.error) {
        return NextResponse.json({
          error: "当前工作台模型清单暂不可读取，请稍后重试",
          error_code: "WORKSPACE_MODEL_ASSIGNMENT_UNAVAILABLE",
          retryable: true,
          task_submitted: false,
        }, { status: 503 });
      }
      if (!isWorkspaceModelAssigned(
        parseWorkspaceModelAssignmentOverrides(assignmentResult.data?.setting_value),
        "video",
        selectedModel,
        workspaceSurface,
      )) {
        return NextResponse.json({
          error: "该模型尚未添加到当前工作台",
          error_code: "MODEL_NOT_ASSIGNED_TO_WORKSPACE",
          retryable: false,
          task_submitted: false,
        }, { status: 409 });
      }
    }
    const configuredWorkspaceSurfaces = Array.isArray(selectedProtocolConfig.workspace_surfaces)
      ? selectedProtocolConfig.workspace_surfaces.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    if (
      normalizedSurface === "short-drama-film-studio"
      && configuredWorkspaceSurfaces.length > 0
      && !configuredWorkspaceSurfaces.includes("short-drama-film-studio")
      && !configuredWorkspaceSurfaces.includes("storyboard-workbench")
    ) {
      return NextResponse.json({
        error: "当前模型尚未开放给影视工坊，请切换已验证的分镜视频模型",
        error_code: "MODEL_SURFACE_UNAVAILABLE",
        retryable: false,
        task_submitted: false,
      }, { status: 409 });
    }
    const configuredAspectRatios = Array.isArray(selectedProtocolConfig.aspect_ratios)
      ? selectedProtocolConfig.aspect_ratios.map(String)
      : [];
    if (aspect_ratio && configuredAspectRatios.length > 0 && !configuredAspectRatios.includes(aspect_ratio)) {
      return NextResponse.json({
        error: `当前模型不支持 ${aspect_ratio}，可选比例：${configuredAspectRatios.join("/")}`,
      }, { status: 400 });
    }

    // 该路由的任意成功分支都可能直接创建供应商任务，因此不能由缺失或
    // 伪造 surface 绕过渠道健康门禁。健康查询错误、无记录和熔断均
    // fail-closed；影视工坊已有的本地 job 仍保留，但绝不会继续提交上游。
    if (!adminValidation) {
      const { data: channelHealth, error: healthError } = await db
        .from("video_channel_health")
        .select("channel_id, is_healthy, consecutive_failures, last_success_at, last_fail_at, updated_at, total_requests, success_count, fail_count, timeout_count, last_error")
        .eq("channel_id", selectedModel.id)
        .maybeSingle();
      if (healthError) {
        console.warn("[Video/HealthGate] Health lookup unavailable; blocking paid submission:", healthError.code);
        return NextResponse.json({
          error: "渠道健康状态暂时无法读取，本次不会提交视频任务",
          error_code: "CHANNEL_HEALTH_UNAVAILABLE",
          retryable: true,
          task_submitted: false,
        }, { status: 503 });
      }

      const circuit = evaluateVideoChannelCircuit(channelHealth);
      if (healthRecoveryCanaryRequested && normalizedSurface !== "video-page") {
        return NextResponse.json({
          error: "通道 canary 只允许从视频制作页的管理员受控入口提交",
          error_code: "CHANNEL_RECOVERY_SURFACE_INVALID",
          retryable: false,
          task_submitted: false,
        }, { status: 409 });
      }
      if (!circuit.blocksProduction && healthRecoveryCanaryRequested) {
        return NextResponse.json({
          error: "该渠道当前健康，无需执行通道 canary",
          error_code: "CHANNEL_RECOVERY_NOT_REQUIRED",
          retryable: false,
          task_submitted: false,
        }, { status: 409 });
      }
      if (circuit.blocksProduction) {
        const authorization = authorizeVideoChannelRecoveryCanary({
          decision: circuit,
          userRole,
          requested: healthRecoveryCanaryRequested,
          recoveryKey: healthRecoveryKey,
          confirmation: healthRecoveryConfirmation,
          clientRequestId: client_request_id,
          operatorRetest: healthOperatorRetest,
          operatorRetestReason: healthOperatorRetestReason,
        });
        if (!authorization.ok) {
          const ordinaryBlock = !healthRecoveryCanaryRequested;
          const recoveryReady = circuit.state === "canary_ready";
          const error = ordinaryBlock
            ? recoveryReady
              ? `该模型渠道连续失败 ${circuit.consecutiveFailures} 次，已过冷却期；普通生产仍暂停，仅管理员可执行受控 canary 验证`
              : `该模型渠道连续失败 ${circuit.consecutiveFailures} 次，当前生产入口已暂停提交`
            : authorization.message;
          return NextResponse.json({
            error,
            error_code: ordinaryBlock ? "CHANNEL_HEALTH_BLOCKED" : authorization.code,
            circuit_state: circuit.state,
            recovery_eligible_at: circuit.recoveryEligibleAt,
            retryable: false,
            task_submitted: false,
          }, { status: ordinaryBlock ? 503 : authorization.status });
        }

        validationClaimKey = buildVideoAdminValidationClaimKey(buildVideoAdminValidationContext({ model: selectedModel, health: channelHealth, userId }));

        // A stale health row remains blocked for all ordinary traffic. Only
        // this admin-only, epoch-bound key may pass into the existing durable
        // task reservation. Replays reuse the same business task; terminal
        // success resets health and terminal failure advances the health epoch.
        console.warn("[Video/HealthGate] Explicit recovery canary authorized", {
          modelId: selectedModel.id,
          circuitState: circuit.state,
          recoveryKeyPrefix: String(circuit.recoveryKey || "").slice(0, 8),
        });
        await writeVideoTrace({
          phase: "channel_validation_authorized", traceId, modelId: selectedModel.id,
          userId, clientRequestId: client_request_id,
          operatorRetest: healthOperatorRetest,
          reason: healthOperatorRetest ? healthOperatorRetestReason : "管理员单次渠道验证",
        });
      }
    }

    const exactAutodlH3Selfhost = isAutodlH3Selfhost(selectedModel.protocol_type);
    const useAutodlH3Lifecycle = exactAutodlH3Selfhost
      && isAutodlH3LifecycleEnabled();
    let stableH3ClientRequestId = "";
    if (exactAutodlH3Selfhost) {
      const rawClientRequestId = String(client_request_id || "").trim();
      if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(rawClientRequestId)) {
        return NextResponse.json({
          error: "AutoDL H3 任务缺少稳定的客户端请求编号，请刷新页面后重试",
          error_code: "H3_CLIENT_REQUEST_ID_REQUIRED",
          retryable: false,
        }, { status: 400 });
      }
      stableH3ClientRequestId = buildAutodlH3ClientRequestId({
        userId,
        idempotencyKey: rawClientRequestId,
      });
    }
    let providerApiKey = "";
    let providerBindingValid = false;
    try {
      assertAutodlH3SelfhostModelBinding({
        kind: "video",
        provider: selectedModel.provider,
        protocolType: selectedModel.protocol_type,
        modelName: selectedModel.model_name,
        apiEndpoint: selectedModel.api_endpoint,
        apiKey: selectedModel.api_key,
      });
      providerBindingValid = true;
      // 生命周期队列请求只持久化业务参数，不在 Web 请求里读取或携带网关密钥。
      // 独立 worker 只有在实例就绪并派发时才会重新加载并校验精确 H3 模型配置。
      if (!useAutodlH3Lifecycle) providerApiKey = resolveProviderSecret(selectedModel.api_key);
    } catch (secretError) {
      console.error("[Video/ProviderDiagnostic] provider credential unavailable", {
        modelId: selectedModel.id,
        error: sanitizeVideoProviderDiagnostic(secretError),
      });
    }

    if (!providerBindingValid || (!providerApiKey && !useAutodlH3Lifecycle) || !selectedModel.api_endpoint) {
      const missingFields = [
        !providerBindingValid ? "binding" : "",
        !providerApiKey && !useAutodlH3Lifecycle ? "api_key" : "",
        !selectedModel.api_endpoint ? "api_endpoint" : "",
      ].filter(Boolean);
      console.error("[Video/ProviderDiagnostic] model channel configuration incomplete", {
        modelId: selectedModel.id,
        missingFields,
      });
      return NextResponse.json({
        error: "该模型的渠道配置不完整，请联系管理员处理",
        error_code: "CHANNEL_CONFIGURATION_INCOMPLETE",
        retryable: false,
      }, { status: 400 });
    }

    const requestedDuration = Number(duration) || Number(selectedModel.duration_seconds) || 5;
    const requestedTiming = resolveVideoDuration(selectedModel, requestedDuration);
    if (!requestedTiming.supported) {
      return NextResponse.json({
        error: requestedDuration < requestedTiming.minDuration
          ? `当前模型最短支持 ${requestedTiming.minDuration} 秒，请调整时长或切换模型`
          : `当前模型最长支持 ${requestedTiming.maxDuration} 秒，请缩短镜头或切换模型`,
        duration_capabilities: requestedTiming,
        ...(parameterGuardedProtocol ? {
          error_code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
          parameter: "duration",
          retryable: false,
        } : {}),
        task_submitted: false,
      }, { status: parameterGuardedProtocol ? 422 : 400 });
    }
    const targetDuration = parameterGuardedProtocol
      ? requestedDuration
      : coerceVideoTargetDuration(selectedModel, requestedDuration);
    const videoTiming = resolveVideoDuration(selectedModel, targetDuration);
    if (!videoTiming.supported) {
      return NextResponse.json({
        error: videoTiming.target < videoTiming.minDuration
          ? `当前模型最短支持 ${videoTiming.minDuration} 秒，请调整时长或切换模型`
          : `当前模型最长支持 ${videoTiming.maxDuration} 秒，请缩短镜头或切换模型`,
        duration_capabilities: videoTiming,
      }, { status: parameterGuardedProtocol ? 422 : 400 });
    }
    if (parameterGuardedProtocol
      && (videoTiming.target !== requestedDuration || videoTiming.submit !== requestedDuration)) {
      return NextResponse.json({
        error: `当前协议无法原样提交 ${requestedDuration} 秒，本次未提交上游`,
        error_code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
        parameter: "duration",
        retryable: false,
        task_submitted: false,
        price: 0,
      }, { status: 422 });
    }
    const configuredDurations = Array.isArray(selectedProtocolConfig.duration_options)
      ? selectedProtocolConfig.duration_options.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : [];
    if (selectedProtocolConfig.exact_duration_only === true && !configuredDurations.includes(videoTiming.target)) {
      return NextResponse.json({
        error: `当前模型只支持原生时长：${configuredDurations.join("/")} 秒`,
        duration_options: configuredDurations,
      }, { status: 400 });
    }
    // Creative prompt integrity is independent from technical model settings.
    // Duration, ratio and resolution are forwarded in structured fields below.
    const normalizedTiming = { prompt: trimmedPrompt, timelineNormalized: false };
    const executionPrompt = inputContract.supportsPrompt ? trimmedPrompt : "";
    const requestedResolution = resolution_tier || resolution || "";
    const videoResolution = resolveVideoResolution(selectedModel, requestedResolution);
    if (requestedResolution && !videoResolution.supported) {
      return NextResponse.json({
        error: `当前模型不支持 ${requestedResolution}，可选分辨率：${videoResolution.options.join("/")}`,
        resolution_options: videoResolution.options,
        default_resolution: videoResolution.defaultResolution,
        ...(parameterGuardedProtocol ? {
          error_code: "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL",
          parameter: "resolution",
          retryable: false,
          task_submitted: false,
        } : {}),
      }, { status: parameterGuardedProtocol ? 422 : 400 });
    }
    const selectedResolution = videoResolution.resolution;

    // The lifecycle controller is the only component allowed to wake a stopped
    // AutoDL instance. When it is disabled, require the exact loopback gateway
    // to be ready before any direct submission. This turns a generic `fetch
    // failed` into an actionable, zero-GPU failure and prevents blind retries.
    if (exactAutodlH3Selfhost && !useAutodlH3Lifecycle) {
      const gateway = await probeAutodlH3SelfhostGateway(String(selectedModel.api_endpoint || ""));
      if (!gateway.ready) {
        const publicMessage = "自租 H3 实例未开机或网关未就绪，且自动唤醒尚未启用；本次任务未提交。请先启动 AutoDL 实例，或由管理员配置 Developer Token 后启用自动唤醒";
        await writeVideoTrace({
          phase: "blocked",
          traceId,
          modelId: traceModelId,
          taskLabel: traceTaskLabel,
          promptHash: tracePromptHash,
          errorCode: "H3_SELFHOST_NOT_READY",
          errorCategory: "configuration",
          gatewayReason: gateway.reason,
          durationMs: Date.now() - submitStart,
        });
        return NextResponse.json({
          error: publicMessage,
          error_code: "H3_SELFHOST_NOT_READY",
          retryable: false,
          task_submitted: false,
        }, { status: 503 });
      }
    }

    // Reference inputs were checked before dispatch. Image creation has its own
    // priced, durable workflow; a video request never creates an implicit image.
    // hosted H3 的 ref_image/ref_audio 参数必须使用无查询参数的公开 COS 地址。
    // 其他渠道继续使用各自的输入协议，避免改变既有兼容性。
    let effectiveImageUrl = image_url;
    let effectiveLastFrameUrl = last_frame_url;
    let effectiveReferenceImageUrl = reference_image_url;
    let effectiveReferenceImageUrls = [...referenceImageUrls];
    if (generatedInputs.typed.size > 0) {
      try {
        if (isAutodlComfyuiHostedProtocol(selectedModel.protocol_type)) throw new GeneratedImageReferenceError("GENERATED_IMAGE_HOSTED_INPUT_UNSUPPORTED", "当前托管视频通道要求已上传素材，暂不支持直接复用生成结果；本次未提交或扣费");
        const bytesCapable = selectedModel.protocol_type === "newapi_video" && selectedProtocolConfig.request_format === "multipart" && selectedModel.supports_image_input === true;
        if (bytesCapable && [image_url, last_frame_url, reference_image_url, ...referenceImageUrls].filter(Boolean).length !== 1) throw new GeneratedImageReferenceError("GENERATED_IMAGE_SLOT_UNSUPPORTED", "当前图片字节通道仅支持一张主参考图，不能同时发送其他首尾帧或附参考；本次未提交或扣费");
        for (const [field, reference] of generatedInputs.typed) {
          const canonical = generatedImageReferenceUri(reference);
          let resolved: string;
          if (bytesCapable) {
            if (field === "last_frame_url" || field.startsWith("reference_image_urls[")) throw new GeneratedImageReferenceError("GENERATED_IMAGE_SLOT_UNSUPPORTED", "当前图片字节通道仅支持单张主参考图，尚不支持此尾帧或附参考槽位；本次未提交或扣费");
            await readGeneratedImageMaterial({ userId, reference });
            resolved = canonical;
          } else {
            const freshUrl = await resolveGeneratedImageReference({ userId, reference });
            resolved = useAutodlH3Lifecycle ? canonical : freshUrl;
          }
          if (field === "image_url") effectiveImageUrl = resolved;
          else if (field === "last_frame_url") effectiveLastFrameUrl = resolved;
          else if (field === "reference_image_url") effectiveReferenceImageUrl = resolved;
          else effectiveReferenceImageUrls[Number(field.match(/\[(\d+)\]/u)![1])] = resolved;
        }
      } catch (error) {
        const refError = error instanceof GeneratedImageReferenceError ? error : null;
        return NextResponse.json({ error: refError?.message || "生成图片暂时无法安全读取，本次未提交", error_code: refError?.code || "GENERATED_IMAGE_REFERENCE_UNAVAILABLE", task_submitted: false, retryable: refError?.status === 503 }, { status: refError?.status || 503 });
      }
    }
    let effectiveAudioUrl = audio_url;
    let effectiveSourceVideoUrl = source_video_url;
    let effectiveReferenceAudioUrls = [...referenceAudioUrls];
    const hasHostedReferenceInput = hasAnyVideoReference({
      imageUrl: effectiveImageUrl,
      lastFrameUrl: effectiveLastFrameUrl,
      referenceImageUrl: effectiveReferenceImageUrl,
      imageUrls: effectiveReferenceImageUrls,
    }) || Boolean(effectiveAudioUrl || effectiveReferenceAudioUrls.length > 0);
    if (isAutodlComfyuiHostedProtocol(selectedModel.protocol_type) && hasHostedReferenceInput) {
      try {
        if (effectiveImageUrl) effectiveImageUrl = await bridgeVideoProviderAsset(effectiveImageUrl, userId, "image", image_storage_key);
        if (effectiveLastFrameUrl) effectiveLastFrameUrl = await bridgeVideoProviderAsset(effectiveLastFrameUrl, userId, "image");
        if (effectiveReferenceImageUrl) effectiveReferenceImageUrl = await bridgeVideoProviderAsset(effectiveReferenceImageUrl, userId, "image");
        effectiveReferenceImageUrls = await Promise.all(effectiveReferenceImageUrls.map((url) => bridgeVideoProviderAsset(url, userId, "image")));
        if (effectiveAudioUrl) effectiveAudioUrl = await bridgeVideoProviderAsset(effectiveAudioUrl, userId, "audio");
        effectiveReferenceAudioUrls = await Promise.all(effectiveReferenceAudioUrls.map((url) => bridgeVideoProviderAsset(url, userId, "audio")));
      } catch (bridgeError) {
        await writeVideoTrace({ phase: "blocked", traceId, modelId: traceModelId, taskLabel: traceTaskLabel, promptHash: tracePromptHash, errorCode: "VIDEO_H3_REFERENCE_BRIDGE_FAILED", errorCategory: "configuration", detail: bridgeError instanceof Error ? bridgeError.message : String(bridgeError), durationMs: Date.now() - submitStart });
        return NextResponse.json({
          error: "AutoDL H3 无法读取参考素材，平台未提交任务；请重新上传故事板图片后重试",
          error_code: "VIDEO_H3_REFERENCE_BRIDGE_FAILED",
          retryable: true,
          task_submitted: false,
        }, { status: 502 });
      }
    }

    // Secure Skill 的 Grok/Flow 服务会从上游网络取回素材。只对当前账号
    // 的 COS 输入执行公开桥接；公开第三方 URL 仍按原协议透传。
    if (["secure_skill_grok_video", "secure_skill_flow_jobs", "secure_skill_video", "secure_skill_wan3_video"].includes(selectedModel.protocol_type)) {
      try {
        if (!generatedInputs.typed.has("image_url") && effectiveImageUrl && isTencentCosAssetUrl(effectiveImageUrl)) {
          effectiveImageUrl = await bridgeVideoProviderAsset(effectiveImageUrl, userId, "image", image_storage_key);
        }
        if (!generatedInputs.typed.has("last_frame_url") && effectiveLastFrameUrl && isTencentCosAssetUrl(effectiveLastFrameUrl)) {
          effectiveLastFrameUrl = await bridgeVideoProviderAsset(effectiveLastFrameUrl, userId, "image");
        }
        if (!generatedInputs.typed.has("reference_image_url") && effectiveReferenceImageUrl && isTencentCosAssetUrl(effectiveReferenceImageUrl)) {
          effectiveReferenceImageUrl = await bridgeVideoProviderAsset(effectiveReferenceImageUrl, userId, "image");
        }
        effectiveReferenceImageUrls = await Promise.all(effectiveReferenceImageUrls.map((url, index) => (
          !generatedInputs.typed.has(`reference_image_urls[${index}]`) && isTencentCosAssetUrl(url) ? bridgeVideoProviderAsset(url, userId, "image") : url
        )));
        if (effectiveAudioUrl && isTencentCosAssetUrl(effectiveAudioUrl)) {
          effectiveAudioUrl = await bridgeVideoProviderAsset(effectiveAudioUrl, userId, "audio");
        }
        effectiveReferenceAudioUrls = await Promise.all(effectiveReferenceAudioUrls.map((url) => (
          isTencentCosAssetUrl(url) ? bridgeVideoProviderAsset(url, userId, "audio") : url
        )));
        if (effectiveSourceVideoUrl && isTencentCosAssetUrl(effectiveSourceVideoUrl)) {
          effectiveSourceVideoUrl = await bridgeVideoProviderAsset(effectiveSourceVideoUrl, userId, "video");
        }
      } catch (bridgeError) {
        await writeVideoTrace({ phase: "blocked", traceId, modelId: traceModelId, taskLabel: traceTaskLabel, promptHash: tracePromptHash, errorCode: "VIDEO_PROVIDER_REFERENCE_BRIDGE_FAILED", errorCategory: "asset_input", detail: bridgeError instanceof Error ? bridgeError.message : String(bridgeError), durationMs: Date.now() - submitStart });
        return NextResponse.json({
          error: "当前模型无法读取所选素材，请通过上传按钮重新添加后重试；本次未提交上游",
          error_code: "VIDEO_PROVIDER_REFERENCE_BRIDGE_FAILED",
          retryable: true,
          task_submitted: false,
        }, { status: 422 });
      }
    }

    // 新版 AutoDL ComfyUI workflow 使用服务端精确输入契约。必填首图、尾帧或
    // 音频缺失时必须在任何上游 POST 之前拒绝，不能把无效任务送给供应商。
    if (selectedModel.protocol_type === AUTODL_COMFYUI_WORKFLOW_PROTOCOL) {
      const inputValidation = validateAutodlComfyuiWorkflowInput({
        id: selectedModel.id,
        name: selectedModel.name,
        provider: selectedModel.provider,
        api_endpoint: selectedModel.api_endpoint,
        api_key: "",
        protocol_type: selectedModel.protocol_type,
        price_per_use: Number(selectedModel.price_per_use) || 0,
        duration_seconds: Number(selectedModel.duration_seconds) || 5,
        supports_image_input: selectedModel.supports_image_input === true,
        model_name: selectedModel.model_name || selectedModel.id,
        api_protocol_config: selectedProtocolConfig,
      }, {
        prompt: executionPrompt,
        imageUrl: effectiveImageUrl,
        lastFrameUrl: effectiveLastFrameUrl,
        referenceImageUrl: effectiveReferenceImageUrl,
        imageUrls: effectiveReferenceImageUrls,
        audioUrl: effectiveAudioUrl,
        audioUrls: effectiveReferenceAudioUrls,
        sourceVideoUrl: effectiveSourceVideoUrl,
        duration: videoTiming.submit,
        aspectRatio: aspect_ratio || "16:9",
        resolutionTier: selectedResolution,
      });
      if (!inputValidation.ok) {
        return NextResponse.json({
          error: inputValidation.error,
          error_code: inputValidation.code,
          retryable: false,
          task_submitted: false,
        }, { status: 400 });
      }
    }

    const billing = requireVideoPriceSnapshot(selectedModel, selectedResolution, videoTiming.target);
    const price = billing.priceYuan;
    const selectedCostPrice = billing.costPriceYuan;
    const billingExempt = false;
    const rawClientRequestId = String(client_request_id || "").trim();
    const normalizedClientRequestId = price > 0
      ? normalizeVideoClientRequestId(rawClientRequestId)
      : rawClientRequestId
        ? normalizeVideoClientRequestId(rawClientRequestId)
        : `trace:${traceId}`;
    // Recovery canaries are globally unique per health epoch, not merely per
    // administrator account. This keeps two admins from creating two paid
    // supplier tasks with the same recovery key.
    const taskIdentity = buildVideoTaskIdentity(
      validationClaimKey ? "video-channel-validation" : userId,
      validationClaimKey || normalizedClientRequestId,
    );

    // 1.5 会员状态拦截（inactive/expired 用户禁止使用）
    if (!privilegedModelOperationAuthorized) {
      const client = getSupabaseAdminClient();
      const { data: membershipData } = await client.from("users").select("member_status, member_expires_at").eq("id", userId).single();
      const md = membershipData as { member_status?: string; member_expires_at?: string } | null;
      let ms = md?.member_status;
      // 会员过期自动检测：active + 过期时间已过 → expired
      if (ms === "active" && md?.member_expires_at && new Date(md.member_expires_at) < new Date()) {
        ms = "expired";
      }
      if (ms === "inactive" || ms === "expired") {
        return NextResponse.json(
          { error: ms === "inactive" ? "您的会员尚未激活，请联系管理员或使用卡密兑换激活" : "您的会员已过期，请联系管理员续费或使用卡密兑换", code: "MEMBERSHIP_REQUIRED" },
          { status: 403 }
        );
      }
    }

    // 2. 快速余额提示。它不是并发放行依据；真正的可用额度会在
    // reserveVideoGenerationTask 中按账户锁定，并与任务行原子预留。
    // 真实扣费仍只允许终态 finalizer 通过原子钱包操作完成。
    if (price > 0) {
      // 🔒 20260914 审计#P1加固：计入未结算任务的总价，防止并发提交透支余额
      const { data: unsettled, error: unsettledError } = await getSupabaseAdminClient()
        .from("video_tasks")
        .select("billing_price_yuan")
        .eq("user_id", userId)
        .in("status", ["pending", "queued", "processing", "generating", "finalizing", "billing_pending"]);
      if (unsettledError) {
        return NextResponse.json({ error: "在途任务费用暂时无法核对，本次不会提交视频任务", error_code: "PENDING_BALANCE_UNAVAILABLE", task_submitted: false }, { status: 503 });
      }
      const pendingSum = (unsettled || []).reduce(
        (sum: number, row: { billing_price_yuan?: unknown }) => sum + Number(row.billing_price_yuan || 0),
        0,
      );
      const { data: walletRow, error: walletError } = await getSupabaseAdminClient()
        .from("users")
        .select("cash_balance")
        .eq("id", userId)
        .maybeSingle();
      if (walletError || !walletRow) {
        return NextResponse.json({ error: "现金余额暂时无法核对，本次不会提交视频任务", error_code: "CASH_BALANCE_UNAVAILABLE", task_submitted: false }, { status: 503 });
      }
      const cashAvailable = Number(walletRow?.cash_balance || 0);
      if (pendingSum + price > cashAvailable) {
        return NextResponse.json(
          {
            error: `有 ${pendingSum.toFixed(2)} 元未结算任务在途，加上本单将超过现金余额 ${cashAvailable.toFixed(2)} 元。请等待任务完成或先充值`,
            error_code: "PENDING_EXCEEDS_BALANCE",
            pending_sum: pendingSum,
          },
          { status: 402 }
        );
      }
      const { sufficient, currentBalance, required } = await checkCashBalance(userId, price);

      if (!sufficient) {
        return NextResponse.json(
          {
            error: `现金余额不足，需要 ¥${price.toFixed(2)}，当前余额 ¥${currentBalance.toFixed(2)}`,
            error_code: "INSUFFICIENT_CASH_BALANCE",
            required_cash: required,
            current_balance: currentBalance,
          },
          { status: 402 }
        );
      }
    }

    // 3. 直接用选中的通道提交任务（不做竞速，不做故障转移）
    const channelConfig: VideoModelConfig = {
      id: selectedModel.id,
      name: selectedModel.name,
      provider: selectedModel.provider,
      api_endpoint: selectedModel.api_endpoint,
      api_key: providerApiKey,
      protocol_type: selectedModel.protocol_type,
      price_per_use: price,
      duration_seconds: selectedModel.duration_seconds || 5,
      supports_image_input: selectedModel.supports_image_input || false,
      model_name: selectedModel.model_name || selectedModel.id,
      api_protocol_config: selectedModel.api_protocol_config || undefined,
    };
    // Freeze all non-secret routing data before reservation. The original
    // credential reference is captured, never the resolved provider secret.
    const routingSnapshot = buildVideoRoutingSnapshot(selectedModel as Record<string, unknown>);
    const publicRequestedModelId = String(model_id).startsWith("pm_")
      ? String(model_id)
      : toPublicModelId("video", String(selectedModel.id));
    const promptNormalizations = [
      { name: "trim_prompt", applied: typeof prompt === "string" && prompt !== trimmedPrompt },
      { name: "omit_unsupported_prompt", applied: !inputContract.supportsPrompt && Boolean(trimmedPrompt) },
      { name: "timeline_normalization", applied: normalizedTiming.timelineNormalized },
    ];
    const snapshotFps = Number.isFinite(Number(body.fps)) && Number(body.fps) > 0 ? Number(body.fps) : null;
    const snapshotSeed = body.seed === undefined || body.seed === null || String(body.seed).trim() === ""
      ? null
      : String(body.seed);
    const snapshotGenerateAudio = typeof generateAudio === "boolean" ? generateAudio : null;

    if (useAutodlH3Lifecycle) {
      const deliveryReadiness = await probeAutodlH3ProviderDeliveryReadiness();
      if (!deliveryReadiness.ready) return NextResponse.json({
        error: "H3 结果交付依赖尚未就绪，任务未提交",
        error_code: deliveryReadiness.code, task_submitted: false, retryable: true,
      }, { status: 503 });
      let stableInputAssets: AutodlH3StableInputAssets;
      try {
        stableInputAssets = await stabilizeAutodlH3InputAssets({
          userId,
          candidates: {
            imageUrl: effectiveImageUrl,
            lastFrameUrl: effectiveLastFrameUrl,
            referenceImageUrl: effectiveReferenceImageUrl,
            audioUrl: effectiveAudioUrl,
            imageUrls: effectiveReferenceImageUrls,
            audioUrls: effectiveReferenceAudioUrls,
            sourceVideoUrl: effectiveSourceVideoUrl,
          },
        });
      } catch (error) {
        const assetError = error instanceof AutodlH3AssetError ? error : null;
        return NextResponse.json({
          error: assetError?.message || "H3 输入资产校验暂时不可用，任务未入队",
          error_code: assetError?.code || "H3_ASSET_STABILIZATION_FAILED",
          retryable: assetError?.code === "H3_ASSET_OWNERSHIP_LOOKUP_FAILED",
        }, { status: assetError?.code === "H3_ASSET_NOT_OWNED" || assetError?.code === "H3_ASSET_REF_INVALID" ? 400 : 503 });
      }

      const publicTaskId = createAutodlH3PublicTaskId({ userId, clientRequestId: stableH3ClientRequestId });
      const videoTaskInternalId = taskIdentity.taskIdInternal;
      const h3RequestPayload = {
        prompt: executionPrompt,
        ...stableInputAssets,
        negativePrompt: negative_prompt || undefined,
        generateAudio: typeof generateAudio === "boolean" ? generateAudio : undefined,
        duration: videoTiming.submit,
        aspectRatio: aspect_ratio || "16:9",
        resolution: selectedResolution,
        resolutionTier: selectedResolution,
        billingPriceYuan: price,
        billingCostPrice: selectedCostPrice,
        idempotencyKey: stableH3ClientRequestId,
      };
      const requestSnapshot = buildVideoGenerationRequestSnapshot({
        userPrompt: typeof prompt === "string" ? prompt : "",
        effectivePrompt: executionPrompt,
        promptNormalizations,
        negativePrompt: typeof negative_prompt === "string" ? negative_prompt : "",
        referenceAssets: buildVideoRequestAssetRefs({
          imageUrl: stableInputAssets.imageAssetRef,
          lastFrameUrl: stableInputAssets.lastFrameAssetRef,
          referenceImageUrl: stableInputAssets.referenceImageAssetRef,
          referenceImageUrls: stableInputAssets.imageAssetRefs,
          audioUrl: stableInputAssets.audioAssetRef,
          referenceAudioUrls: stableInputAssets.audioAssetRefs,
          sourceVideoUrl: stableInputAssets.sourceVideoAssetRef,
          personAssetId: body.person_asset_id,
          audioAssetId: body.audio_asset_id,
        }),
        targetDurationSeconds: videoTiming.target,
        effectiveDurationSeconds: videoTiming.submit,
        aspectRatio: aspect_ratio || "16:9",
        resolution: selectedResolution,
        fps: snapshotFps,
        seed: snapshotSeed,
        generateAudio: snapshotGenerateAudio,
        publicModelId: publicRequestedModelId,
        routingConfigHash: routingSnapshot.configVersion,
        adapterVersion: `video-adapter:${channelConfig.protocol_type}:v1`,
        providerPayload: h3RequestPayload,
      });
      const requestFingerprint = buildVideoRequestFingerprint({
        modelId: channelConfig.id,
        prompt: executionPrompt,
        negativePrompt: negative_prompt || null,
        generateAudio: generateAudio ?? null,
        duration: videoTiming.submit,
        targetDuration: videoTiming.target,
        aspectRatio: aspect_ratio || "16:9",
        resolution: selectedResolution,
        stableInputAssets,
      });
      const reservation = await reserveVideoGenerationTask({
        taskIdInternal: videoTaskInternalId,
        userId,
        modelId: channelConfig.id,
        clientRequestId: normalizedClientRequestId,
        requestFingerprint,
        routingSnapshot,
        requestSnapshot,
        price: billing,
        billingExempt,
        providerTaskId: publicTaskId,
        task: {
          taskLabel: task_label,
          batchId: batch_id,
          batchTopic: batch_topic,
          cardIndex: card_index,
          prompt: typeof prompt === "string" ? prompt : "",
          firstFrameUrl: stableInputAssets.imageAssetRef,
          lastFrameUrl: stableInputAssets.lastFrameAssetRef,
          referenceImageUrl: stableInputAssets.referenceImageAssetRef,
          aspectRatio: aspect_ratio || "16:9",
          resolution: selectedResolution,
          durationSeconds: videoTiming.target,
        },
      });

      // Same key + same immutable payload is a read-only replay. Never enqueue
      // a second provider job, including when the original task is failed or
      // its terminal result is still being reconciled.
      if (!reservation.created) {
        return NextResponse.json({
          task_id: reservation.providerTaskId || publicTaskId,
          business_task_id: reservation.taskIdInternal,
          model_id,
          model_name: channelConfig.name || selectedModel.name,
          status: reservation.status,
          billing_state: reservation.billingState,
          replayed: true,
          price,
          target_duration: videoTiming.target,
          resolution: selectedResolution,
          message: "已找到同一视频任务，本次没有重复提交供应商",
        });
      }

      try {
        const queued = await enqueueAutodlH3VideoJob({
          userId,
          modelId: channelConfig.id,
          idempotencyKey: stableH3ClientRequestId,
          publicTaskId,
          videoTaskInternalId,
          // Immutable billing fields are consumed only by the fenced atomic
          // finalizer. The exact same payload is hashed into the reservation.
          requestPayload: h3RequestPayload,
        });

        if (queued.created) {
          await recordVideoSubmission(channelConfig.id)
            .catch((error) => console.warn("[Video/Accounting] Failed to record H3 lifecycle submission", sanitizeVideoProviderDiagnostic(error)));
        }
        const totalMs = Date.now() - submitStart;
        await writeVideoTrace({
          phase: "submitted",
          traceId,
          modelId: channelConfig.id,
          taskLabel: traceTaskLabel,
          promptHash: tracePromptHash,
          taskId: publicTaskId,
          status: "pending",
          lifecycleState: queued.state,
          durationMs: totalMs,
        });
        return NextResponse.json({
          task_id: publicTaskId,
          content_url: null,
          model_id,
          model_name: channelConfig.name || selectedModel.name,
          status: "queued",
          lifecycle_state: queued.state,
          processing_stage: String(queued.state || "ACCEPTED").toLowerCase(),
          price,
          submit_ms: totalMs,
          target_duration: videoTiming.target,
          submit_duration: videoTiming.submit,
          auto_trim_required: videoTiming.needsTrim,
          prompt_timeline_normalized: normalizedTiming.timelineNormalized,
          resolution: selectedResolution,
          message: "任务已安全登记，系统将自动启动 GPU 并在 H3 就绪后派发",
        });
      } catch {
        // RPC 可能已提交但回应丢失。先按确定性 publicTaskId 回查，绝不盲目把已派发的任务改成失败。
        let recoveredJob: Awaited<ReturnType<typeof getAutodlH3VideoJobForUser>> = null;
        let recoveryLookupFailed = false;
        try {
          recoveredJob = await getAutodlH3VideoJobForUser({ publicTaskId, userId });
        } catch {
          recoveryLookupFailed = true;
        }

        if (recoveredJob) {
          await db.from("video_tasks").update({
            status: "pending",
            error_message: "任务已登记，等待 GPU 实例调度",
            completed_at: null,
          }).eq("id", videoTaskInternalId).eq("user_id", userId).in("status", ["pending", "failed"]);
          const totalMs = Date.now() - submitStart;
          await writeVideoTrace({
            phase: "submitted",
            traceId,
            modelId: channelConfig.id,
            taskLabel: traceTaskLabel,
            promptHash: tracePromptHash,
            taskId: publicTaskId,
            status: "pending",
            lifecycleState: recoveredJob.state,
            recoveredAfterAmbiguousEnqueue: true,
            durationMs: totalMs,
          });
          return NextResponse.json({
            task_id: publicTaskId,
            content_url: recoveredJob.contentUrl || null,
            model_id,
            model_name: channelConfig.name || selectedModel.name,
            status: "queued",
            lifecycle_state: recoveredJob.state,
            processing_stage: String(recoveredJob.state || "ACCEPTED").toLowerCase(),
            price,
            submit_ms: totalMs,
            target_duration: videoTiming.target,
            submit_duration: videoTiming.submit,
            auto_trim_required: videoTiming.needsTrim,
            prompt_timeline_normalized: normalizedTiming.timelineNormalized,
            resolution: selectedResolution,
            message: "任务已在调度队列中，继续使用同一业务任务",
          });
        }

        if (recoveryLookupFailed) {
          await db.from("video_tasks").update({
            status: "pending",
            error_message: "H3 调度结果待确认；请勿重复提交，可稍后查看任务状态",
            price_charged: 0,
            completed_at: null,
          }).eq("id", videoTaskInternalId).eq("user_id", userId);
          return NextResponse.json({
            error: "H3 任务已登记，正在确认调度结果；请勿重复提交，可稍后查看任务状态",
            error_code: "H3_LIFECYCLE_ENQUEUE_OUTCOME_UNKNOWN",
            retryable: false,
          }, { status: 503 });
        }

        // 回查明确不存在 job：收敛本地行为可重试失败，不留下永久 pending 孤儿。
        await db.from("video_tasks").update({
          status: "failed",
          error_message: "H3 生命周期调度暂时不可用；请使用同一请求重试，系统不会重复创建任务",
          price_charged: 0,
          completed_at: new Date().toISOString(),
        }).eq("id", videoTaskInternalId).eq("user_id", userId);
        return NextResponse.json({
          error: "H3 任务已登记，但调度队列暂时不可用；请稍后使用原请求重试",
          error_code: "H3_LIFECYCLE_ENQUEUE_FAILED",
          retryable: true,
        }, { status: 503 });
      }
    }

    const taskIdInternal = taskIdentity.taskIdInternal;
    const adapterParams: VideoGenerateParams = {
      prompt: executionPrompt,
      imageUrl: effectiveImageUrl,
      lastFrameUrl: effectiveLastFrameUrl,
      referenceImageUrl: effectiveReferenceImageUrl,
      audioUrl: effectiveAudioUrl,
      imageUrls: effectiveReferenceImageUrls,
      audioUrls: effectiveReferenceAudioUrls,
      sourceVideoUrl: effectiveSourceVideoUrl,
      videoExtension: ["dashscope_video_retalk", "volcengine_digital_human"].includes(selectedModel.protocol_type)
        && body.video_extension === true,
      negativePrompt: negative_prompt,
      generateAudio,
      duration: videoTiming.submit,
      aspectRatio: aspect_ratio || "16:9",
      resolution: selectedResolution,
      resolutionTier: selectedResolution,
      userProvidedOptions: { resolution: Boolean(requestedResolution) },
      idempotencyKey: taskIdentity.providerIdempotencyKey,
    };
    const requestFingerprint = buildVideoRequestFingerprint({
      modelId: channelConfig.id,
      prompt: executionPrompt,
      imageUrl: generatedImageUri || effectiveImageUrl || null,
      lastFrameUrl: generatedInputs.typed.has("last_frame_url") ? last_frame_url : effectiveLastFrameUrl || null,
      referenceImageUrl: generatedInputs.typed.has("reference_image_url") ? reference_image_url : effectiveReferenceImageUrl || null,
      referenceImageUrls: effectiveReferenceImageUrls.map((url, index) => generatedInputs.typed.has(`reference_image_urls[${index}]`) ? referenceImageUrls[index] : url),
      audioUrl: effectiveAudioUrl || null,
      referenceAudioUrls: effectiveReferenceAudioUrls,
      sourceVideoUrl: effectiveSourceVideoUrl || null,
      videoExtension: body.video_extension === true,
      negativePrompt: negative_prompt || null,
      generateAudio: generateAudio ?? null,
      duration: videoTiming.submit,
      targetDuration: videoTiming.target,
      aspectRatio: aspect_ratio || "16:9",
      resolution: selectedResolution,
    });
    const dispatch = !adminValidation && String(task_label || '').startsWith('digital-human:') && queuedDigitalProtocol(channelConfig.protocol_type)
      ? buildDigitalDispatch(channelConfig, {
          personAssetId: String(body.person_asset_id || ''), audioAssetId: String(body.audio_asset_id || ''),
          mode: task_label === 'digital-human:video' ? 'video' : 'photo', durationChoice: body.duration_choice,
          params: {prompt:executionPrompt,negativePrompt:negative_prompt,duration:videoTiming.submit,
            aspectRatio:aspect_ratio || '16:9',resolution:selectedResolution,resolutionTier:selectedResolution,
            generateAudio,
            videoExtension: ['dashscope_video_retalk','volcengine_digital_human'].includes(selectedModel.protocol_type) && body.video_extension === true,
            idempotencyKey:taskIdentity.providerIdempotencyKey},
        }) : undefined;
    const requestSnapshot = buildVideoGenerationRequestSnapshot({
      userPrompt: typeof prompt === "string" ? prompt : "",
      effectivePrompt: executionPrompt,
      promptNormalizations,
      negativePrompt: typeof negative_prompt === "string" ? negative_prompt : "",
      referenceAssets: buildVideoRequestAssetRefs({
        imageUrl: image_url,
        imageStorageKey: image_storage_key,
        lastFrameUrl: last_frame_url,
        referenceImageUrl: reference_image_url,
        referenceImageUrls,
        audioUrl: audio_url,
        referenceAudioUrls,
        sourceVideoUrl: source_video_url,
        personAssetId: body.person_asset_id,
        audioAssetId: body.audio_asset_id,
        ownedPageAssetRefs,
      }),
      targetDurationSeconds: videoTiming.target,
      effectiveDurationSeconds: videoTiming.submit,
      aspectRatio: aspect_ratio || "16:9",
      resolution: selectedResolution,
      fps: snapshotFps,
      seed: snapshotSeed,
      generateAudio: snapshotGenerateAudio,
      publicModelId: publicRequestedModelId,
      routingConfigHash: routingSnapshot.configVersion,
      adapterVersion: `video-adapter:${channelConfig.protocol_type}:v1`,
      providerPayload: dispatch || (generatedInputs.typed.size ? { ...adapterParams, imageUrl: generatedImageUri || adapterParams.imageUrl, lastFrameUrl: generatedInputs.typed.has("last_frame_url") ? last_frame_url : adapterParams.lastFrameUrl, referenceImageUrl: generatedInputs.typed.has("reference_image_url") ? reference_image_url : adapterParams.referenceImageUrl, imageUrls: effectiveReferenceImageUrls.map((url, index) => generatedInputs.typed.has(`reference_image_urls[${index}]`) ? referenceImageUrls[index] : url) } : adapterParams),
    });
    const reservation = await reserveVideoGenerationTask({
      dispatch,
      taskIdInternal,
      userId,
      modelId: channelConfig.id,
      clientRequestId: normalizedClientRequestId,
      requestFingerprint,
      routingSnapshot,
      requestSnapshot,
      price: billing,
      billingExempt,
      task: {
        taskLabel: task_label,
        batchId: batch_id,
        batchTopic: batch_topic,
        cardIndex: card_index,
        prompt: typeof prompt === "string" ? prompt : "",
        firstFrameUrl: image_url,
        lastFrameUrl: last_frame_url,
        referenceImageUrl: reference_image_url,
        aspectRatio: aspect_ratio || "16:9",
        resolution: selectedResolution,
        durationSeconds: videoTiming.target,
      },
    });
    if (!reservation.created) {
      if (reservation.status === "completed") {
        const completed = await finalizeVideoGenerationSuccess({
          taskIdInternal: reservation.taskIdInternal,
          userId,
          userRole,
          providerTaskId: reservation.providerTaskId,
        });
        if (completed.state === "completed") {
          return NextResponse.json({
            task_id: reservation.providerTaskId || reservation.taskIdInternal,
            business_task_id: reservation.taskIdInternal,
            status: "completed",
            billing_state: completed.billingState,
            video_url: completed.playbackUrl,
            price: completed.priceCharged,
            replayed: true,
          });
        }
      }
      return NextResponse.json({
        task_id: reservation.providerTaskId || reservation.taskIdInternal,
        business_task_id: reservation.taskIdInternal,
        model_id,
        model_name: channelConfig.name || selectedModel.name,
        status: reservation.status,
        billing_state: reservation.billingState,
        replayed: true,
        price,
        target_duration: videoTiming.target,
        resolution: selectedResolution,
        message: "已找到同一视频任务，本次没有重复提交供应商",
      });
    }

    if (dispatch) {
      startDigitalVideoQueueWorker();
      return NextResponse.json({task_id:taskIdInternal,business_task_id:taskIdInternal,model_id,
        model_name:channelConfig.name,status:'queued',price,target_duration:videoTiming.target,
        resolution:selectedResolution,message:'任务已加入队列，轮到后自动开始。可在作品与任务中查看。'}, {status:202});
    }
    const submitMs = Date.now() - submitStart;
    console.log(`[视频生成] 预检完成 ${submitMs}ms，通道=${selectedModel.id}(${selectedModel.protocol_type})，开始提交`);

    let result;
    let providerRequestDispatched = false;
    let submitFailedBeforeProviderDispatch = false;
    let providerAdmissionLease: ProviderAdmissionLease | null = null;
    let providerAdmissionError: ProviderAdmissionBusyError | ProviderAdmissionUnavailableError | null = null;
    try {
      providerAdmissionLease = await acquireProviderAdmission({
        provider: String(selectedModel.provider || "unknown"),
        channel: String(selectedModel.id || selectedModel.api_endpoint || "unknown"),
        model: String(selectedModel.model_name || selectedModel.name || selectedModel.id || "unknown"),
      });
      result = await submitVideoTask(channelConfig, {
        ...adapterParams,
        inputOwnerId: userId,
        onProviderRequest: async (receipt) => {
          // The audited provider fetch is fail-closed: this durable receipt
          // must commit before a single request byte may leave our process.
          await persistVideoProviderDispatchReceipt({
            db,
            taskIdInternal,
            userId,
            requestFingerprint,
            snapshot: routingSnapshot,
            receipt,
          });
          providerRequestDispatched = true;
          await writeVideoTrace({ phase: "provider_dispatch", traceId, clientRequestId: normalizedClientRequestId, modelId: selectedModel.id, protocol: selectedModel.protocol_type, ...receipt });
        },
      });
    } catch (submitError) {
      if (submitError instanceof ProviderAdmissionBusyError || submitError instanceof ProviderAdmissionUnavailableError) {
        providerAdmissionError = submitError;
      }
      const errorMessage = submitError instanceof Error ? submitError.message : String(submitError);
      submitFailedBeforeProviderDispatch = !providerRequestDispatched;
      const upstreamStatus = Number(errorMessage.match(/(?:API|HTTP|status|返回)\D{0,8}(4\d\d)/iu)?.[1] || 0);
      const definitelyRejected = upstreamStatus >= 400 && upstreamStatus < 500 && ![408, 425].includes(upstreamStatus);
      result = definitelyRejected || !providerRequestDispatched
        ? { taskId: "", status: "failed" as const, error: errorMessage }
        : {
            taskId: "",
            status: "processing" as const,
            submissionOutcome: "unknown" as const,
            error: errorMessage,
          };
    } finally {
      await providerAdmissionLease?.release().catch(() => undefined);
    }

    if (!result.taskId && !result.videoUrl && result.status !== "failed"
      && result.submissionOutcome !== "unknown") {
      result = {
        ...result,
        submissionOutcome: "unknown" as const,
        error: result.error || "上游响应未包含可追踪的任务号",
      };
    }

    if (result.taskId) acceptedReceipt = { taskId: result.taskId, businessTaskId: taskIdInternal, modelId: model_id };
    const totalMs = Date.now() - submitStart;
    console.log(`[视频生成] 提交完成 ${totalMs}ms（提交耗时${totalMs - submitMs}ms），状态=${result.status}`);

    // 4. Preserve the selected model and classify its submission error.
    if (result.submissionOutcome === "unknown") {
      const message = "上游提交结果尚未确认，已保留原任务，请暂不要重复生成";
      let preservationConfirmed = false;
      try {
        await persistVideoProviderSubmissionReceipt({
          db,
          taskIdInternal,
          userId,
          requestFingerprint,
          outcome: "unknown",
          receipt: result.submissionReceipt || {
            schemaVersion: 1,
            receiptState: "adapter_exception",
          },
        });
        preservationConfirmed = true;
      } catch { /* The durable reservation still owns this unknown submission. */ }
      if (!preservationConfirmed) {
        return NextResponse.json({ task_id: taskIdInternal, business_task_id: taskIdInternal, model_id, status: "pending", submission_outcome: "unknown", error_code: "VIDEO_SUBMISSION_RECONCILIATION_STATE_UNAVAILABLE", message, task_submitted: null, retryable: false }, { status: 503 });
      }
      await writeVideoTrace({
        phase: "submission_unknown",
        traceId,
        modelId: selectedModel.id,
        clientRequestId: normalizedClientRequestId,
        businessTaskId: taskIdInternal,
        submissionReceipt: result.submissionReceipt || {
          schemaVersion: 1,
          receiptState: "adapter_exception",
        },
      });
      return NextResponse.json({ task_id: taskIdInternal, business_task_id: taskIdInternal, model_id,
        status: "pending", submission_outcome: "unknown", error_code: "VIDEO_SUBMIT_OUTCOME_UNKNOWN",
        message, task_submitted: null, retryable: false,
      }, { status: 202 });
    }
    if (result.status === "failed") {
      if (providerAdmissionError) {
        const failurePersisted = await markVideoSubmissionFailed({
          taskIdInternal,
          userId,
          requestFingerprint,
          errorCode: providerAdmissionError.code,
          errorMessage: providerAdmissionError.message,
        });
        await writeVideoTrace({
          phase: "blocked",
          traceId,
          modelId: traceModelId,
          taskLabel: traceTaskLabel,
          promptHash: tracePromptHash,
          durationMs: Date.now() - submitStart,
          errorCode: failurePersisted ? providerAdmissionError.code : "VIDEO_ADMISSION_RELEASE_UNCONFIRMED",
        });
        if (!failurePersisted) {
          return NextResponse.json({
            error: "视频任务未调用供应商，但预算释放状态正在核对；请保留原请求号，暂勿重复提交",
            error_code: "VIDEO_ADMISSION_RELEASE_UNCONFIRMED",
            task_id: taskIdInternal,
            business_task_id: taskIdInternal,
            status: "billing_pending",
            submission_outcome: "not_submitted",
            task_submitted: false,
            retryable: false,
          }, { status: 503 });
        }
        return NextResponse.json({
          error: providerAdmissionError.message,
          error_code: providerAdmissionError.code,
          task_id: taskIdInternal,
          business_task_id: taskIdInternal,
          status: "failed",
          submission_outcome: "not_submitted",
          task_submitted: false,
          retryable: true,
        }, {
          status: providerAdmissionError.status,
          headers: providerAdmissionError instanceof ProviderAdmissionBusyError
            ? { "Retry-After": String(providerAdmissionError.retryAfterSeconds) }
            : undefined,
        });
      }
      const modelDisplayName = publicModelDisplayName(selectedModel as Record<string, unknown>);
      const classifiedError = classifyVideoProviderError(result.error, modelDisplayName);
      await writeVideoTrace({
        phase: "failed",
        traceId,
        modelId: traceModelId,
        taskLabel: traceTaskLabel,
        promptHash: tracePromptHash,
        durationMs: Date.now() - submitStart,
        errorCode: classifiedError.code,
        errorCategory: classifiedError.category,
        detail: classifiedError.operatorMessage,
      });
      console.error("[Video/ProviderDiagnostic] submit failed", {
        traceId,
        modelId: selectedModel.id,
        modelName: selectedModel.model_name,
        protocolType: selectedModel.protocol_type,
        endpointHost: (() => {
          try { return new URL(String(selectedModel.api_endpoint)).host; } catch { return "invalid"; }
        })(),
        category: classifiedError.category,
        code: classifiedError.code,
        rawError: classifiedError.operatorMessage,
      });
      if (result.taskId) {
        await bindVideoProviderTask({ taskIdInternal, userId, requestFingerprint, providerTaskId: result.taskId, contentUrl: result.contentUrl || undefined });
        await persistVideoProviderSubmissionReceipt({
          db,
          taskIdInternal,
          userId,
          requestFingerprint,
          outcome: "acknowledged",
          providerTaskId: result.taskId,
          receipt: result.submissionReceipt || { schemaVersion: 1, receiptState: "provider_task_id_received" },
        });
        const { data: failedTask, error: failureSaveError } = await db.from("video_tasks").update({ status: "failed", error_message: classifiedError.publicMessage, submission_error_code: classifiedError.code, billing_state: "submission_failed", price_charged: 0, completed_at: new Date().toISOString() }).eq("id", taskIdInternal).eq("user_id", userId).in("status", ["pending", "queued", "processing"]).select("id").maybeSingle();
        if (failureSaveError || !failedTask) return NextResponse.json({ task_id: result.taskId, business_task_id: taskIdInternal, status: "processing", message: "任务结果正在保存，请继续追踪原任务", retryable: false }, { status: 503 });
      } else await markVideoSubmissionFailed({
        taskIdInternal,
        userId,
        requestFingerprint,
        errorCode: classifiedError.code,
        errorMessage: classifiedError.publicMessage,
      });
      if (!submitFailedBeforeProviderDispatch) {
        await recordVideoTerminalOutcome({ modelId: selectedModel.id, outcome: "fail", responseMs: totalMs, errorMessage: result.error, countSubmission: true }).catch((error) => console.warn("[Video/Accounting] Failed to record submit failure", sanitizeVideoProviderDiagnostic(error)));
      }

      return NextResponse.json(
        {
          error: classifiedError.publicMessage,
          error_code: classifiedError.code,
          retryable: classifiedError.retryable,
          submit_ms: totalMs,
          task_id: result.taskId || undefined,
          status: "failed",
          business_task_id: taskIdInternal,
        },
        { status: classifiedError.category === "asset_input" ? 400 : 502 }
      );
    }

    // 5. Bind the provider id before any terminal processing. Synchronous
    // providers still receive a deterministic local provider id when they do
    // not expose one, so retries cannot create a second business task.
    const isSyncCompleted = result.status === "success" && result.videoUrl;
    const providerTaskId = String(
      result.taskId || (isSyncCompleted ? `sync_${taskIdentity.taskIdInternal.slice(3)}` : ""),
    );
    acceptedReceipt = { taskId: providerTaskId, businessTaskId: taskIdInternal, modelId: model_id };
    await bindVideoProviderTask({
      taskIdInternal,
      userId,
      requestFingerprint,
      providerTaskId,
      contentUrl: result.contentUrl || undefined,
    });
    await persistVideoProviderSubmissionReceipt({
      db,
      taskIdInternal,
      userId,
      requestFingerprint,
      outcome: "acknowledged",
      providerTaskId,
      receipt: result.submissionReceipt || { schemaVersion: 1, receiptState: "provider_task_id_received" },
    });

    // A user may terminate while the provider POST is still waiting for its
    // task id. Once that id is durably bound, continue the already-recorded
    // intent against the same immutable route instead of asking for a second
    // click or leaving a hidden upstream job running.
    if (!isSyncCompleted) {
      const pendingCancellation = await resumeRequestedVideoCancellation({
        userId,
        clientRequestId: normalizedClientRequestId,
        taskId: taskIdInternal,
      }).catch(() => null);
      if (pendingCancellation?.body.success === true
        && pendingCancellation.body.status === "cancelled") {
        return NextResponse.json({
          task_id: providerTaskId,
          business_task_id: taskIdInternal,
          model_id,
          status: "cancelled",
          billing_state: "failed",
          price: 0,
          retryable: true,
          task_submitted: true,
          message: pendingCancellation.body.message || "上游已确认终止，本次未扣费",
        });
      }
    }

    if (isSyncCompleted) {
      // A synchronous provider response is still one accepted provider
      // submission. The async branch records this below, while submission
      // failures use countSubmission in their terminal accounting call.
      // Keep the sync path explicit so total_requests is neither skipped nor
      // coupled to whether terminal persistence/billing finishes immediately.
      await recordVideoSubmission(channelConfig.id)
        .catch((error) => console.warn("[Video/Accounting] Failed to record sync submission", sanitizeVideoProviderDiagnostic(error)));
      const finalized = await finalizeVideoGenerationSuccess({
        taskIdInternal,
        userId,
        userRole,
        providerTaskId,
        providerVideoUrl: result.videoUrl,
        responseMs: totalMs,
      });
      if (finalized.state !== "completed") {
        return NextResponse.json({
          error: finalized.message || "视频终态结算尚未完成，结果暂不交付",
          error_code: finalized.code || "VIDEO_FINALIZATION_PENDING",
          retryable: true,
          task_id: providerTaskId,
          business_task_id: taskIdInternal,
          status: finalized.state,
          billing_state: finalized.billingState,
          price: 0,
          video_url: "",
        }, { status: 503 });
      }

      await writeVideoTrace({
        phase: "submitted",
        traceId,
        modelId: channelConfig.id,
        taskLabel: traceTaskLabel,
        promptHash: tracePromptHash,
        taskId: taskIdInternal,
        status: "completed",
        durationMs: totalMs,
      });
      return NextResponse.json({
        task_id: taskIdInternal,
        provider_task_id: providerTaskId,
        status: "completed",
        video_url: finalized.playbackUrl,
        model_id,
        model_name: channelConfig.name || selectedModel.name,
        price: finalized.priceCharged,
        billing_state: finalized.billingState,
        submit_ms: totalMs,
        needsProxy: result.needsProxy || false,
        target_duration: videoTiming.target,
        submit_duration: videoTiming.submit,
        auto_trim_required: videoTiming.needsTrim,
        auto_trimmed: videoTiming.needsTrim,
        processing_stage: "ready",
        prompt_timeline_normalized: normalizedTiming.timelineNormalized,
        resolution: selectedResolution,
      });
    }

    // 6. The reservation is already the durable pending task. Bind has stored
    // the provider id, so the API must not issue a second insert after submit.
    after(async () => {
      const [accountingResult, traceResult] = await Promise.allSettled([
        recordVideoSubmission(channelConfig.id),
        writeVideoTrace({
          phase: "submitted",
          traceId,
          modelId: channelConfig.id,
          taskLabel: traceTaskLabel,
          promptHash: tracePromptHash,
          taskId: providerTaskId,
          status: "pending",
          durationMs: totalMs,
        }),
      ]);
      if (accountingResult.status === "rejected") {
        console.warn("[Video/Accounting] Failed to record async submission", sanitizeVideoProviderDiagnostic(accountingResult.reason));
      }
      if (traceResult.status === "rejected") {
        console.warn("[Video/Trace] Failed to persist accepted submission trace", sanitizeVideoProviderDiagnostic(traceResult.reason));
      }
    });
    return NextResponse.json({
      task_id: providerTaskId,
      business_task_id: taskIdInternal,
      content_url: result.contentUrl || null,
      model_id,
      model_name: channelConfig.name || selectedModel.name,
      status: "pending",
      price: price,
      submit_ms: totalMs,
      target_duration: videoTiming.target,
      submit_duration: videoTiming.submit,
      auto_trim_required: videoTiming.needsTrim,
      prompt_timeline_normalized: normalizedTiming.timelineNormalized,
      resolution: selectedResolution,
      message: price > 0
        ? `任务已提交，预估费用 ¥${price.toFixed(2)}，生成成功后扣费`
        : "任务已提交（明确免费模型）",
    });
  } catch (error: unknown) {
    if (acceptedReceipt) {
      return NextResponse.json({ task_id: acceptedReceipt.taskId, business_task_id: acceptedReceipt.businessTaskId, model_id: acceptedReceipt.modelId, status: "processing", error_code: "VIDEO_ACCEPTED_RESULT_PENDING", message: "上游已受理，任务结果正在保存，请继续追踪原任务", task_submitted: true, retryable: false }, { status: 503 });
    }
    const terminalError = videoTerminalErrorResponse(error);
    if (terminalError) {
      await writeVideoTrace({
        phase: "blocked",
        traceId,
        modelId: traceModelId,
        taskLabel: traceTaskLabel,
        promptHash: tracePromptHash,
        durationMs: Date.now() - submitStart,
        errorCode: terminalError.body.error_code,
      });
      return NextResponse.json(terminalError.body, { status: terminalError.status });
    }
    const message = error instanceof Error ? error.message : "视频生成失败";
    const classifiedError = classifyVideoProviderError(message);
    await writeVideoTrace({
      phase: "failed",
      traceId,
      modelId: traceModelId,
      taskLabel: traceTaskLabel,
      promptHash: tracePromptHash,
      durationMs: Date.now() - submitStart,
      errorCode: classifiedError.code,
      errorCategory: classifiedError.category,
      detail: classifiedError.operatorMessage,
    });
    console.error("视频生成错误:", classifiedError.operatorMessage);
    return NextResponse.json({
      error: classifiedError.publicMessage,
      error_code: classifiedError.code,
      retryable: classifiedError.retryable,
    }, { status: 500 });
  }
}
