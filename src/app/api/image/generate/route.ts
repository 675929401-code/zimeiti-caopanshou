import { ImageAdminValidationError } from "@/lib/image-admin-validation";
import { readImagePublicationStates } from "@/lib/image-model-availability";
import { prepareImageGenerationValidation, type ImageGenerationValidationInput } from "@/lib/image-generation-validation";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { verifyToken } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { checkAndCollectDebt, refundCash } from "@/lib/billing";
import { executeCashDeduction } from "@/lib/billing-executor";
import { recordRevenue } from "@/lib/revenue";
import { buildApiRootEndpoint, buildOpenAIEndpoint } from "@/lib/api-endpoints";
import { findModelByPublicId, publicModelDisplayName, toPublicModelId } from "@/lib/public-model-dto";
import {
  isRetryableImageUpstreamStatus,
} from "@/lib/image-model-fallback";
import { safeFetch } from "@/lib/safe-fetch";
import { validateUploadBuffer } from "@/lib/file-upload-security";
import {
  coerceImageResolution,
  getImageModelCapabilities,
  type ImageResolution,
} from "@/lib/image-model-capabilities";
import { buildSecureSkillImagePayload } from "@/lib/secure-skill-image-adapter";
import {
  buildSecureSkillAsyncImagePayload,
  parseSecureSkillAsyncImageTask,
} from "@/lib/secure-skill-async-image-adapter";
import {
  ImageUpstreamResponseTooLargeError,
  parseImageSseFrames,
  parseImageUpstreamResponse,
  readImageUpstreamResponseText,
} from "@/lib/image-upstream-response";
import {
  ImageGenerationInputError,
  readImageGenerationInput,
} from "@/lib/image-generation-request";
import {
  imageReferenceContractIssue,
  resolveImageProviderContract,
} from "@/lib/image-provider-contract";
import { resolveImageResolutionPrice } from "@/lib/image-resolution-pricing";
import { IMAGE_FIXED_OUTPUT_COUNT, type ImagePublishedProtocol } from "@/lib/image-parameter-contract";
import { parseImageDimensions, type ImageDimensions } from "@/lib/image-dimensions";
import { configuredImagePixelSizeFor, validateImageOutputContract } from "@/lib/image-output-contract";
import { renderCoverComposition } from "@/lib/cover-composition-server";
import {
  evaluateWorkspaceModelCompatibility,
  imageWorkspaceSurfaceFromRequest,
} from "@/lib/workspace-model-policy";
import {
  WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY,
  isWorkspaceModelAssigned,
  parseWorkspaceModelAssignmentOverrides,
} from "@/lib/workspace-model-assignment-settings";
import {
  createImageFailureRequestSnapshot,
  imageFailureBillingStateFromOperations,
  parseImageFailureRequestSnapshot,
  type ImageFailureWalletOperation,
} from "@/lib/image-failure-history";
import { resolveProviderSecret } from "@/lib/provider-secret";
import {
  createImageProviderSubmissionReceipt,
  prepareImageProviderRequest,
  type ImageProviderDispatchReceipt,
  type ImageProviderProtocol,
  type ImageProviderRequestProjection,
  type ImageProviderSubmissionReceipt,
} from "@/lib/image-provider-request-audit";
import {
  acquireProviderAdmission,
  holdProviderAdmissionUntilResponseEnds,
  ProviderAdmissionBusyError,
  ProviderAdmissionUnavailableError,
  type ProviderAdmissionLease,
} from "@/lib/provider-admission-control";
import {
  DatabaseImageExactlyOnceStore,
  ImageExactlyOnceError,
  ImageRequestRejectedError,
  getImageRequestRejection,
  type ImageRequestRejection,
  STRICT_GPT_IMAGE_DATABASE_ID,
  STRICT_GPT_IMAGE_PUBLIC_ID,
  restrictImageCandidatesForNoRetry,
  runImageExactlyOnce,
  finalizeImageExactlyOnceDelivery,
  finalizeImageProviderDelivery,
  hasImageProviderCheckpoint,
  strictImagePayloadFingerprint,
  validateStrictImageClientKeys,
} from "@/lib/image-exactly-once";
import { storageManager } from "@/storage/object";
import { providerMediaUrl } from "@/lib/generated-media-delivery";
import { imageRecoverableReferenceCapability, probeImageGenerationReadiness } from "@/lib/image-generation-readiness";
import { createImageEphemeralDelivery, decodeInlineImage, imageEphemeralStatus, isImageEphemeralReceipt } from "@/lib/image-ephemeral-delivery";
import {
  AUTODL_H3_SELFHOST_PROVIDER,
  AUTODL_H3_SELFHOST_SECRET_REF,
  assertAutodlH3SelfhostModelBinding,
  autodlH3ImagePixelSize,
  readAutodlH3SelfhostResult,
  resolveAutodlH3SelfhostResultUrl,
} from "@/lib/autodl-h3-selfhost";

// 封面图片生成 — 多模型支持
// 从 cover_models 表读取模型配置（API地址/密钥/进价/售价）
// 调用向量引擎 OpenAI 兼容格式 /v1/images/generations

// ── 尺寸映射 ──
// DALL-E 3 仅支持 1024x1024, 1024x1792, 1792x1024
const DALLE3_SIZE_MAP: Record<string, string> = {
  "3:4": "1024x1792",
  "9:16": "1024x1792",
  "4:3": "1792x1024",
  "16:9": "1792x1024",
  "1:1": "1024x1024",
};

// 火山引擎 Seedream 5.0+ 要求最小 3686400 像素
const SEEDREAM_SIZE_MAP: Record<string, string> = {
  "3:4": "1728x2304",
  "9:16": "1440x2560",
  "4:3": "2304x1728",
  "16:9": "2560x1440",
  "1:1": "2048x2048",
};

type ImageBillingReservation = {
  userId: string;
  amount: number;
  referenceId: string;
  clientIdempotencyKey: string;
  clientTraceId: string;
  requiresLedgerConfirmation?: boolean;
};

async function readImageReservationBilling(reservation: ImageBillingReservation) {
  const billing = await getSupabaseClient().from("wallet_operations")
    .select("idempotency_key,operation_kind,amount,status")
    .eq("user_id", reservation.userId)
    .in("operation_kind", ["cash_charge", "cash_refund"])
    .in("idempotency_key", [reservation.referenceId, `${reservation.referenceId}:release`]);
  return imageFailureBillingStateFromOperations({
    billingReferenceId: reservation.referenceId,
    billingExempt: false,
    operations: (billing.data || []) as ImageFailureWalletOperation[],
    queryFailed: Boolean(billing.error),
  });
}

type LocalCoverModelConfig = {
  id: string;
  name: string;
  model_name: string;
  provider: string;
  api_endpoint: string;
  api_key: string;
  cost_price: number;
  selling_price: number;
  supports_image_input?: boolean;
  api_protocol_config?: Record<string, unknown>;
};

function expectedImagePixelSize(model: LocalCoverModelConfig | null | undefined, resolution: ImageResolution, ratio: string) {
  if (model?.provider === AUTODL_H3_SELFHOST_PROVIDER) return autodlH3ImagePixelSize(ratio);
  if (model?.model_name === "dall-e-3") return DALLE3_SIZE_MAP[ratio] || DALLE3_SIZE_MAP["1:1"];
  if (model?.provider === "volcengine") return SEEDREAM_SIZE_MAP[ratio] || SEEDREAM_SIZE_MAP["1:1"];
  return configuredImagePixelSizeFor(model?.api_protocol_config, resolution, ratio);
}

function configuredImagePrice(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return Number.NaN;
  if (typeof value === "string" && !value.trim()) return Number.NaN;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : Number.NaN;
}

const AUTODL_H3_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const AUTODL_H3_IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const AUTODL_H3_IMAGE_URL_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS = 120_000;
const GENERATED_IMAGE_STORAGE_PROVIDER = "tencent_cos" as const;
const GENERATED_IMAGE_OBJECT_PREFIX = `object://${GENERATED_IMAGE_STORAGE_PROVIDER}/`;
const TRUSTED_GENERATED_IMAGE_HOSTS = [
  "source.openclaw-token.shop",
  "flow.secure-skill.com",
  "cdn.openaicn.com",
  // Volcengine Seedream returns a short-lived signed TOS object URL from this
  // exact first-party host. Some Windows proxy/DNS setups expose public hosts
  // through the reserved 198.18/15 inspection range, so safeFetch needs the
  // exact HTTPS hostname to finish delivery without weakening SSRF checks for
  // arbitrary TOS subdomains.
  "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
];
const imageExactlyOnceStore = new DatabaseImageExactlyOnceStore();

function imageParameterRejection(
  error: string,
  code: string,
  details: Record<string, unknown> = {},
  status = 422,
) {
  return NextResponse.json({
    error,
    code,
    task_submitted: false,
    taskSubmitted: false,
    price: 0,
    retryable: false,
    upstreamCalled: false,
    billed: false,
    ...details,
  }, { status });
}

function imageAdmissionRejection(error: unknown): ImageRequestRejectedError | null {
  if (error instanceof ProviderAdmissionBusyError) {
    return new ImageRequestRejectedError({
      source: "platform",
      code: "IMAGE_PROVIDER_ADMISSION_BUSY",
      retryAfterSeconds: error.retryAfterSeconds,
      admissionScope: error.scope,
    });
  }
  if (error instanceof ProviderAdmissionUnavailableError) {
    return new ImageRequestRejectedError({
      source: "platform",
      code: "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE",
    });
  }
  return null;
}

function exactTextPlan(coverText: string, aspectRatio: string) {
  const lines = coverText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return {
    title: (lines[0] || "").slice(0, 80),
    subtitle: lines.slice(1).join(" · ").slice(0, 120),
    aspectRatio: aspectRatio as "16:9" | "9:16" | "4:3" | "3:4" | "1:1",
    layoutTemplateId: "gaoding-storyboard-title",
    animationStyleId: "cinematic-real",
  } as const;
}

async function prepareGeneratedImageBytes(options: {
  buffer: Buffer;
  aspectRatio: string;
  resolution: ImageResolution;
  expectedPixelSize: string;
  coverText?: string;
}) {
  const dimensions = parseImageDimensions(options.buffer);
  if (!dimensions) throw new Error("图片生成结果尺寸无法验明，原请求与费用状态保留待核查");
  const issue = validateImageOutputContract({
    ...dimensions,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    expectedPixelSize: options.expectedPixelSize,
  });
  if (issue) {
    throw new ImageRequestRejectedError({
      source: "provider",
      code: issue.code,
      actualDimensions: issue.actualDimensions,
      expectedAspectRatio: issue.expectedAspectRatio,
      expectedResolution: issue.expectedResolution,
      expectedDimensions: issue.expectedDimensions,
    });
  }
  if (!options.coverText?.trim()) return { buffer: options.buffer, dimensions };
  const rendered = await renderCoverComposition(options.buffer, exactTextPlan(options.coverText, options.aspectRatio));
  return { buffer: rendered.bytes, dimensions: { width: rendered.width, height: rendered.height } };
}

function toGeneratedImageObjectUri(storageKey: string) {
  return `${GENERATED_IMAGE_OBJECT_PREFIX}${encodeURIComponent(storageKey)}`;
}

async function resolveGeneratedImageObjectUri(value: string) {
  if (!value.startsWith(GENERATED_IMAGE_OBJECT_PREFIX)) {
    throw new ImageExactlyOnceError(
      "IMAGE_PERSISTED_RESULT_INVALID",
      "图片生成结果未获得稳定对象存储地址，已停止发放结果",
      503,
    );
  }
  const storageKey = decodeURIComponent(value.slice(GENERATED_IMAGE_OBJECT_PREFIX.length));
  if (!storageKey) {
    throw new ImageExactlyOnceError(
      "IMAGE_PERSISTED_RESULT_INVALID",
      "图片生成结果的对象存储标识无效，已停止发放结果",
      503,
    );
  }
  return storageManager.getSignedUrl(
    storageKey,
    { expireTime: AUTODL_H3_IMAGE_URL_TTL_SECONDS },
    GENERATED_IMAGE_STORAGE_PROVIDER,
  );
}

async function writeImageTrace(event: Record<string, unknown>) {
  try {
    const traceDirectory = resolveAppRuntimeDir();
    await mkdir(traceDirectory, { recursive: true });
    await appendFile(path.join(traceDirectory, "canvas-image-generation.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch (error) {
    console.warn("[Image/Trace] Failed to persist trace:", error);
  }
}

type ImageUpstreamContext = {
  modelId?: string;
  modelName?: string;
  provider?: string;
};

function safeUpstreamTarget(url: string) {
  if (!url) return "未配置上游地址";
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "上游地址格式无效";
  }
}

function summarizeFetchCause(error: unknown) {
  if (!(error instanceof Error)) return "unknown network error";
  const cause = error.cause as { code?: unknown; errno?: unknown; syscall?: unknown; hostname?: unknown; message?: unknown } | undefined;
  const parts = [
    typeof cause?.code === "string" ? cause.code : "",
    typeof cause?.syscall === "string" ? cause.syscall : "",
    typeof cause?.hostname === "string" ? cause.hostname : "",
    typeof cause?.message === "string" ? cause.message : "",
  ].filter(Boolean);
  return summarizeUpstreamImageError(parts.length > 0 ? `${error.message} (${parts.join(" / ")})` : error.message)
    || "unknown network error";
}

async function fetchImageUpstream(
  input: string | Request,
  init: RequestInit = {},
  context: ImageUpstreamContext = {},
  timeoutMs = 5 * 60 * 1000,
): Promise<Response> {
  const target = safeUpstreamTarget(typeof input === "string" ? input : input.url);
  try {
    // 断连或超时无法证明供应商未受理，所有图片模型都只能提交一次。
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.error("[Image] Upstream result unknown; automatic resubmission disabled:", {
      target,
      modelId: context.modelId,
      modelName: context.modelName,
      provider: context.provider,
      detail: summarizeFetchCause(error),
    });
    throw new Error("图片上游连接中断或超时，生成结果尚未确认。系统已停止自动重发，请保留追踪号查询状态或联系管理员核对，勿重复提交");
  }
}

type ImageProviderReceiptContext = {
  recordProviderDispatchReceipt: (receipt: ImageProviderDispatchReceipt) => Promise<ImageProviderDispatchReceipt>;
  recordProviderSubmissionReceipt: (receipt: ImageProviderSubmissionReceipt) => Promise<ImageProviderSubmissionReceipt>;
};

async function fetchAuditedImageProviderPost(input: {
  url: string;
  init: RequestInit;
  providerProtocol: ImageProviderProtocol;
  projection: ImageProviderRequestProjection;
  idempotencyKey?: string;
  receiptContext: ImageProviderReceiptContext;
  upstreamContext?: ImageUpstreamContext;
  timeoutMs?: number;
}) {
  const prepared = await prepareImageProviderRequest({
    url: input.url,
    init: input.init,
    providerProtocol: input.providerProtocol,
    projection: input.projection,
    idempotencyKey: input.idempotencyKey,
  });
  // This durable acknowledgement is the final gate before the single paid
  // POST. If it is missing or ambiguous, do not contact the provider.
  const dispatchReceipt = await input.receiptContext.recordProviderDispatchReceipt(prepared.receipt);
  try {
    const response = await fetchImageUpstream(
      prepared.request,
      {},
      input.upstreamContext,
      input.timeoutMs,
    );
    return { response, dispatchReceipt };
  } catch (error) {
    await input.receiptContext.recordProviderSubmissionReceipt(createImageProviderSubmissionReceipt({
      dispatchReceipt,
      transportState: "transport_error",
      responseBody: new Uint8Array(),
    }));
    throw error;
  }
}

async function readAuditedImageProviderResponseText(input: {
  response: Response;
  maximumBytes: number;
  dispatchReceipt: ImageProviderDispatchReceipt;
  receiptContext: ImageProviderReceiptContext;
}) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const recordBodyFailure = async () => input.receiptContext.recordProviderSubmissionReceipt(
    createImageProviderSubmissionReceipt({
      dispatchReceipt: input.dispatchReceipt,
      transportState: "response_body_error",
      responseStatus: input.response.status,
      responseContentType: input.response.headers.get("content-type"),
      responseBody: chunks.length ? Buffer.concat(chunks.map(chunk => Buffer.from(chunk))) : new Uint8Array(),
    }),
  );
  let bytes: Buffer;
  let rawText: string;
  try {
    const contentLength = Number(input.response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > input.maximumBytes) {
      throw new ImageUpstreamResponseTooLargeError(input.maximumBytes);
    }
    if (input.response.body) {
      const reader = input.response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > input.maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ImageUpstreamResponseTooLargeError(input.maximumBytes);
        }
        chunks.push(value);
      }
    }
    bytes = chunks.length ? Buffer.concat(chunks.map(chunk => Buffer.from(chunk))) : Buffer.alloc(0);
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    await recordBodyFailure();
    throw error;
  }
  await input.receiptContext.recordProviderSubmissionReceipt(createImageProviderSubmissionReceipt({
    dispatchReceipt: input.dispatchReceipt,
    transportState: "response_received",
    responseStatus: input.response.status,
    responseContentType: input.response.headers.get("content-type"),
    responseBody: bytes,
  }));
  return rawText;
}

async function loadReferenceImage(url: string) {
  const dataMatch = url.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  let buffer: Buffer;
  let declaredContentType: string;

  if (url.startsWith("data:")) {
    if (!dataMatch) throw new Error("参考图数据格式无效");
    buffer = Buffer.from(dataMatch[2].replace(/\s/g, ""), "base64");
    declaredContentType = dataMatch[1].toLowerCase();
    if (buffer.length > 20 * 1024 * 1024) throw new Error("参考图超过20MB");
  } else {
    const response = await safeFetch(url, {
      timeoutMs: 20_000,
      maxBytes: 20 * 1024 * 1024,
      maxRedirects: 3,
      allowedContentTypes: ["image/*"],
    });
    buffer = response.buffer;
    declaredContentType = response.contentType;
  }

  const validated = validateUploadBuffer(buffer, declaredContentType);
  if (!validated.contentType.startsWith("image/")) throw new Error("参考图格式无效");
  const blob = new Blob([new Uint8Array(buffer)], { type: validated.contentType });
  const extension = validated.extension.slice(1) || "png";
  return { blob, filename: `reference.${extension}`, dataUrl: `data:${validated.contentType};base64,${buffer.toString("base64")}`, byteLength: buffer.length };
}

function summarizeUpstreamImageError(raw: string) {
  const clean = (value: string) => value
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s"'<>]+/giu, "[内联数据已隐藏]")
    .replace(/https?:\/\/[^\s"'<>\\]+/giu, "[上游链接已隐藏]")
    .replace(/\bBearer\s+[^\s"',;}]+/giu, "[凭据已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/gu, "[凭据已隐藏]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|authorization|cookie|signature|secret|password)\s*["']?\s*[:=]\s*["']?)[^,\s"';&}]+/giu, "$1[凭据已隐藏]")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/gu, "[长编码已隐藏]")
    .replace(/\s+/gu, " ")
    .slice(0, 360);
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const payload = JSON.parse(trimmed) as {
      error?: string | { message?: string; code?: string };
      message?: string;
      detail?: string;
      code?: string;
    };
    const errorMessage = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const errorCode = typeof payload.error === "object" ? payload.error?.code : payload.code;
    return clean([errorCode, errorMessage || payload.message || payload.detail].filter(Boolean).join(": "));
  } catch {
    return clean(trimmed);
  }
}

function hasImageUpstreamAcceptanceSignal(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object") return false;
  if (depth > 8) return true;
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:task_?id|job_?id|id|url|image_url|b64_json|images|output)$/iu.test(key) && child != null && child !== "" && child !== false) return true;
    if (/^(?:accepted|success|ok)$/iu.test(key) && child != null && child !== false && child !== 0 && child !== "" && child !== "false") return true;
    if (/^(?:status|state)$/iu.test(key) && /^(?:accepted|queued|pending|processing|running|completed|complete|success|succeeded|finished)$/iu.test(String(child))) return true;
    return hasImageUpstreamAcceptanceSignal(child, depth + 1);
  });
}

function explicitImageProviderRejection(status: number, raw: string): ImageRequestRejection | null {
  if (status < 400 || status > 599) return null;
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch { /* A synchronous HTTP rejection is still definitive without JSON. */ }
  if (payload && hasImageUpstreamAcceptanceSignal(payload)) return null;
  const error = payload?.error;
  const structured = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : null;
  const message = typeof error === "string"
    ? error
    : typeof structured?.message === "string"
      ? structured.message
      : typeof payload?.message === "string"
        ? payload.message
        : "";
  if (status === 503 && /\bno available compatible accounts?\b/iu.test(message)) {
    return { source: "provider", code: "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE", upstreamStatus: 503 };
  }
  if (status === 400 && /failed to load image from|unable to (?:load|fetch|download) (?:the )?image|invalid image (?:url|data|format)/iu.test(message)) {
    return { source: "provider", code: "IMAGE_REFERENCE_REJECTED", upstreamStatus: status };
  }
  const code = String(structured?.code || structured?.type || payload?.code || "");
  // bad_response_status_code：New API 系中转明确报告上游渠道返回非2xx（如 lconai 403 Forbidden），
  // 是确定性拒绝而非结果未知；漏列会把验证 canary 落成 unknown 并永久锁行、无法复测。
  if (message && /^(?:model_not_found|invalid_api_key|invalid_request_error|no_available_channel|bad_response_status_code)$/u.test(code)) {
    return {
      source: "provider",
      code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
      upstreamStatus: status,
      ...(status >= 500 ? { providerConfirmedRejection: true } : {}),
    };
  }
  // Ordinary client errors are synchronous rejections: no provider task was
  // accepted, so the bound receipt may safely allow a fresh user submission.
  // Timeout/throttle/proxy-close statuses are deliberately excluded because an
  // intermediary can emit them after the provider has accepted work. Generic
  // 5xx responses have the same ambiguity. Those attempts stay fail-closed and
  // are verified in the background instead of risking a duplicate POST/charge.
  if (status >= 400 && status < 500 && ![408, 425, 429, 499].includes(status)) {
    return { source: "provider", code: "IMAGE_UPSTREAM_REQUEST_REJECTED", upstreamStatus: status };
  }
  return null;
}

class ImageCandidateFailure extends Error {
  readonly code: string;
  readonly upstreamStatus?: number;
  readonly upstreamTarget: string;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    code: string;
    upstreamTarget: string;
    upstreamStatus?: number;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "ImageCandidateFailure";
    this.code = options.code;
    this.upstreamStatus = options.upstreamStatus;
    this.upstreamTarget = options.upstreamTarget;
    this.retryable = Boolean(options.retryable);
  }
}

async function generateLocalImageCandidate(options: {
  model: LocalCoverModelConfig;
  ratio: string;
  effectiveResolution: ImageResolution;
  references: string[];
  identityReferenceOnly: boolean;
  userPrompt: string;
  fullPrompt: string;
  idempotencyKey: string;
  receiptContext: ImageProviderReceiptContext;
  strictSingleSubmit?: boolean;
}): Promise<string> {
  const {
    model,
    ratio,
    effectiveResolution,
    references,
    identityReferenceOnly,
    userPrompt,
    fullPrompt,
    idempotencyKey,
    receiptContext,
    strictSingleSubmit = false,
  } = options;
  const provider = model.provider || "vectorengine";
  const providerContract = resolveImageProviderContract(model);
  if (providerContract.requestProtocol === "images_edits" && references.length === 0) {
    throw new ImageGenerationInputError(
      "IMAGE_REFERENCE_REQUIRED",
      "当前模型使用图片编辑协议，至少需要一张参考图",
      422,
    );
  }
  // H3 的 provider/secret/model/endpoint 是一个不可拆分的安全边界。
  // 必须在 secret 解析和任何上游 fetch 之前完成校验。
  const isAutodlH3Selfhost = assertAutodlH3SelfhostModelBinding({
    kind: "image",
    provider,
    modelName: model.model_name,
    apiEndpoint: model.api_endpoint,
    apiKey: model.api_key,
  });
  const providerApiKey = resolveProviderSecret(model.api_key);
  const isDalle3 = model.model_name === "dall-e-3";
  const isVolcengine = provider === "volcengine";
  const referenceContractIssue = imageReferenceContractIssue(providerContract, references.length);
  if (referenceContractIssue) {
    throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
  }

  const sizeStr = isAutodlH3Selfhost
    ? autodlH3ImagePixelSize(ratio)
    : isDalle3
      ? DALLE3_SIZE_MAP[ratio] || DALLE3_SIZE_MAP["1:1"]
      : isVolcengine
        ? SEEDREAM_SIZE_MAP[ratio] || SEEDREAM_SIZE_MAP["1:1"]
        : configuredImagePixelSizeFor(model.api_protocol_config, effectiveResolution, ratio);

  let apiUrl: string;
  let requestBody: BodyInit;
  let requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${providerApiKey}`,
  };
  if (providerContract.requestProtocol === "google_generate_content") {
    apiUrl = buildApiRootEndpoint(
      model.api_endpoint,
      `/v1beta/models/${encodeURIComponent(model.model_name)}:generateContent`,
    );
    const inlineReferences: Array<Record<string, unknown>> = [];
    let referenceBytes = 0;
    for (const url of references) {
      try {
        const reference = await loadReferenceImage(url);
        referenceBytes += reference.byteLength;
        if (referenceBytes > 20 * 1024 * 1024) throw new Error("REFERENCE_TOTAL_TOO_LARGE");
        const match = reference.dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu);
        if (!match) throw new Error("REFERENCE_DATA_INVALID");
        inlineReferences.push({
          inlineData: {
            mimeType: match[1].toLowerCase(),
            data: match[2].replace(/\s/gu, ""),
          },
        });
      } catch {
        throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
      }
    }
    const textPart = { text: fullPrompt };
    requestBody = JSON.stringify({
      contents: [{
        role: "user",
        parts: identityReferenceOnly
          ? [...inlineReferences, textPart]
          : [textPart, ...inlineReferences],
      }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: ratio, imageSize: effectiveResolution },
      },
    });
    requestHeaders = {
      "Content-Type": "application/json",
      "x-goog-api-key": providerApiKey,
    };
  } else if (providerContract.requestProtocol === "chat_completions") {
    apiUrl = buildOpenAIEndpoint(model.api_endpoint, "chat/completions");
    // The application reads the original signed URL; the provider receives image bytes,
    // so it does not need access to our private COS link or its signature.
    const inlineReferences: string[] = [];
    let referenceBytes = 0;
    for (const url of references) {
      try {
        const reference = await loadReferenceImage(url);
        referenceBytes += reference.byteLength;
        if (referenceBytes > 20 * 1024 * 1024) throw new Error("REFERENCE_TOTAL_TOO_LARGE");
        inlineReferences.push(reference.dataUrl);
      } catch {
        throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
      }
    }
    const content: string | Array<Record<string, unknown>> = references.length === 0
      ? fullPrompt
      : identityReferenceOnly
        ? [
            ...inlineReferences.map((url) => ({ type: "image_url", image_url: { url } })),
            { type: "text", text: fullPrompt },
          ]
        : [
            { type: "text", text: fullPrompt },
            ...inlineReferences.map((url) => ({ type: "image_url", image_url: { url } })),
          ];
    requestBody = JSON.stringify({
      model: model.model_name,
      messages: [{ role: "user", content }],
      stream: false,
      image_size: effectiveResolution,
      aspect_ratio: ratio,
      size: sizeStr,
      image_config: { aspect_ratio: ratio, image_size: effectiveResolution },
      generation_config: { image_config: { aspect_ratio: ratio, image_size: effectiveResolution } },
    });
  } else if (providerContract.requestProtocol === "images_generations_async") {
    if (references.some(url => !/^https?:\/\//iu.test(url))) {
      throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
    }
    const submitPath = typeof model.api_protocol_config?.submit_path === "string"
      ? model.api_protocol_config.submit_path
      : "/v1/images/generations";
    apiUrl = buildApiRootEndpoint(model.api_endpoint, submitPath);
    requestBody = JSON.stringify(buildSecureSkillAsyncImagePayload({
      modelName: model.model_name,
      prompt: fullPrompt,
      resolution: effectiveResolution,
      aspectRatio: ratio,
      pixelSize: sizeStr,
      referenceImageUrls: references,
    }));
  } else if (references.length > 0 && providerContract.referenceTransport === "generations_url_array") {
    apiUrl = buildOpenAIEndpoint(model.api_endpoint, "images/generations");
    requestBody = JSON.stringify(buildSecureSkillImagePayload({
      modelName: model.model_name,
      prompt: fullPrompt,
      resolution: effectiveResolution,
      aspectRatio: ratio,
      referenceImageUrls: references,
    }));
  } else if (references.length > 0 && (providerContract.referenceTransport === "edits_multipart_single"
    || providerContract.referenceTransport === "edits_multipart_array")) {
    const formData = new FormData();
    formData.append("model", model.model_name);
    formData.append("prompt", fullPrompt);
    let referenceBytes = 0;
    for (const [index, url] of references.entries()) {
      let reference;
      try {
        reference = await loadReferenceImage(url);
      } catch {
        throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
      }
      referenceBytes += reference.byteLength;
      if (referenceBytes > 20 * 1024 * 1024) {
        throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
      }
      const fieldName = providerContract.referenceTransport === "edits_multipart_array" ? "image[]" : "image";
      formData.append(fieldName, reference.blob, `reference-${index + 1}-${reference.filename}`);
    }
    formData.append("n", "1");
    formData.append("size", sizeStr);
    formData.append("response_format", "url");
    apiUrl = buildOpenAIEndpoint(model.api_endpoint, "images/edits");
    requestHeaders = { "Authorization": `Bearer ${providerApiKey}` };
    requestBody = formData;
  } else if (references.length > 0) {
    // A model can advertise reference capability while its channel has no
    // matching transport contract. Never silently drop those references.
    throw new ImageRequestRejectedError({ source: "input", code: "IMAGE_REFERENCE_READ_FAILED" });
  } else if (providerContract.requestProtocol === "images_generations"
    && providerContract.source === "configured") {
    apiUrl = buildOpenAIEndpoint(model.api_endpoint, "images/generations");
    requestBody = JSON.stringify(buildSecureSkillImagePayload({
      modelName: model.model_name,
      prompt: fullPrompt,
      resolution: effectiveResolution,
      aspectRatio: ratio,
    }));
  } else if (isVolcengine) {
    apiUrl = buildOpenAIEndpoint(model.api_endpoint, "images/generations");
    requestBody = JSON.stringify({
      model: model.model_name,
      prompt: fullPrompt,
      n: 1,
      size: sizeStr,
      response_format: "url",
    });
  } else {
    apiUrl = buildOpenAIEndpoint(model.api_endpoint, "images/generations");
    requestBody = JSON.stringify({
      model: model.model_name,
      prompt: fullPrompt,
      n: 1,
      size: sizeStr,
      ...(isAutodlH3Selfhost ? { response_format: "url" } : {}),
    });
  }

  if (isAutodlH3Selfhost || strictSingleSubmit || providerContract.requestProtocol === "images_generations_async") {
    requestHeaders["Idempotency-Key"] = idempotencyKey;
  }

  const receiptProtocol: ImageProviderProtocol = references.length > 0
    && (providerContract.referenceTransport === "edits_multipart_single"
      || providerContract.referenceTransport === "edits_multipart_array")
    ? "images_edits"
    : providerContract.requestProtocol;
  const requestProjection: ImageProviderRequestProjection = {
    userPromptSha256: createHash("sha256").update(userPrompt).digest("hex"),
    effectivePromptSha256: createHash("sha256").update(fullPrompt).digest("hex"),
    modelIdSha256: createHash("sha256").update(model.id).digest("hex"),
    aspectRatio: ratio,
    resolution: effectiveResolution,
    imageCount: 1,
    referenceCount: references.length,
  };

  const upstreamContext = {
    modelId: model.id,
    modelName: model.name,
    provider: model.provider,
  };
  const upstreamTarget = safeUpstreamTarget(apiUrl);
  let apiResp: Response;
  let dispatchReceipt: ImageProviderDispatchReceipt;
  try {
    const submitted = await fetchAuditedImageProviderPost({
      url: apiUrl,
      init: { method: "POST", headers: requestHeaders, body: requestBody },
      providerProtocol: receiptProtocol,
      projection: requestProjection,
      idempotencyKey: requestHeaders["Idempotency-Key"],
      receiptContext,
      upstreamContext,
      timeoutMs: providerContract.requestProtocol === "google_generate_content" ? 12 * 60 * 1000 : undefined,
    });
    apiResp = submitted.response;
    dispatchReceipt = submitted.dispatchReceipt;
  } catch (error) {
    throw new ImageCandidateFailure({
      message: summarizeUpstreamImageError(error instanceof Error ? error.message : "")
        || "图片上游连接失败或派发回执未确认",
      code: "IMAGE_UPSTREAM_RESULT_UNKNOWN",
      upstreamTarget,
      retryable: false,
    });
  }

  if (!apiResp.ok) {
    const errText = await readAuditedImageProviderResponseText({
      response: apiResp,
      maximumBytes: 512 * 1024,
      dispatchReceipt,
      receiptContext,
    }).catch((error) => {
      if (error instanceof ImageUpstreamResponseTooLargeError) return "";
      throw error;
    });
    const detail = summarizeUpstreamImageError(errText);
    console.error("[Image] API error:", {
      status: apiResp.status,
      target: upstreamTarget,
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      detail,
    });
    const rejection = explicitImageProviderRejection(apiResp.status, errText);
    if (rejection) throw new ImageRequestRejectedError(rejection);
    throw new ImageCandidateFailure({
      message: `${model.name} 图片生成失败 (${apiResp.status})${detail ? `：${detail}` : ""}`,
      code: "IMAGE_UPSTREAM_ERROR",
      upstreamStatus: apiResp.status,
      upstreamTarget,
      retryable: isRetryableImageUpstreamStatus(apiResp.status),
    });
  }

  let rawResponse: string;
  try {
    rawResponse = await readAuditedImageProviderResponseText({
      response: apiResp,
      maximumBytes: 40 * 1024 * 1024,
      dispatchReceipt,
      receiptContext,
    });
  } catch (error) {
    throw new ImageCandidateFailure({
      message: error instanceof ImageUpstreamResponseTooLargeError
        ? `${model.name} 返回的数据超过平台安全上限，结果无法确认`
        : `${model.name} 响应读取中断，结果无法确认`,
      code: error instanceof ImageUpstreamResponseTooLargeError
        ? "IMAGE_UPSTREAM_RESPONSE_TOO_LARGE"
        : "IMAGE_UPSTREAM_RESULT_UNKNOWN",
      upstreamStatus: apiResp.status,
      upstreamTarget,
      retryable: false,
    });
  }
  const parsedResponse = parseImageUpstreamResponse(rawResponse, apiResp.headers.get("content-type") || "");
  if (parsedResponse.error) {
    const detail = summarizeUpstreamImageError(JSON.stringify(parsedResponse.error));
    console.error("[Image] API payload error:", {
      target: upstreamTarget,
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      code: parsedResponse.error.code,
      detail,
    });
    if (parsedResponse.payload && !hasImageUpstreamAcceptanceSignal(parsedResponse.payload)) {
      throw new ImageRequestRejectedError({ source: "provider", code: "IMAGE_UPSTREAM_TERMINAL_EVENT" });
    }
    throw new ImageCandidateFailure({
      message: `${model.name} 图片生成失败${detail ? `：${detail}` : ""}`,
      code: "IMAGE_UPSTREAM_EVENT_ERROR",
      upstreamStatus: apiResp.status,
      upstreamTarget,
      retryable: false,
    });
  }
  if (!parsedResponse.payload) {
    throw new ImageCandidateFailure({
      message: `${model.name} 返回了无法识别的图片响应格式`,
      code: "IMAGE_UPSTREAM_RESPONSE_INVALID",
      upstreamStatus: apiResp.status,
      upstreamTarget,
      retryable: false,
    });
  }
  const apiData = parsedResponse.payload as Record<string, unknown> & {
    error?: { message?: string };
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  if (apiData.error) {
    const detail = summarizeUpstreamImageError(JSON.stringify(apiData.error));
    console.error("[Image] API payload error:", {
      target: upstreamTarget,
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      detail,
    });
    throw new ImageCandidateFailure({
      message: `${model.name} 图片生成失败${detail ? `：${detail}` : ""}`,
      code: "IMAGE_UPSTREAM_PAYLOAD_ERROR",
      upstreamTarget,
    });
  }

  if (providerContract.requestProtocol === "images_generations_async") {
    let task = parseSecureSkillAsyncImageTask(apiData);
    if (task.status === "succeeded" && task.imageUrl) return task.imageUrl;
    if (task.status === "failed") {
      throw new ImageRequestRejectedError({ source: "provider", code: "IMAGE_UPSTREAM_TERMINAL_EVENT" });
    }
    if (!task.id) {
      throw new ImageCandidateFailure({
        message: `${model.name} 异步图片接口未返回任务 ID`,
        code: "IMAGE_UPSTREAM_RESPONSE_INVALID",
        upstreamStatus: apiResp.status,
        upstreamTarget,
      });
    }

    const taskId = task.id;
    const configuredPollPath = typeof model.api_protocol_config?.poll_path === "string"
      ? model.api_protocol_config.poll_path
      : "/v1/images/generations/{id}";
    const pollPath = configuredPollPath.replace("{id}", encodeURIComponent(taskId));
    const pollUrl = buildApiRootEndpoint(model.api_endpoint, pollPath);
    const pollTarget = safeUpstreamTarget(pollUrl);
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3_000));
      let pollResponse: Response;
      try {
        pollResponse = await fetchImageUpstream(pollUrl, {
          method: "GET",
          headers: { "Authorization": `Bearer ${providerApiKey}` },
        }, upstreamContext, 60_000);
      } catch {
        continue;
      }
      if (!pollResponse.ok) {
        const pollError = await readImageUpstreamResponseText(pollResponse, 512 * 1024).catch(() => "");
        const rejection = explicitImageProviderRejection(pollResponse.status, pollError);
        if (rejection) throw new ImageRequestRejectedError(rejection);
        if (isRetryableImageUpstreamStatus(pollResponse.status)) continue;
        throw new ImageCandidateFailure({
          message: `${model.name} 图片任务查询失败 (${pollResponse.status})`,
          code: "IMAGE_UPSTREAM_ERROR",
          upstreamStatus: pollResponse.status,
          upstreamTarget: pollTarget,
        });
      }
      const pollRaw = await readImageUpstreamResponseText(pollResponse, 40 * 1024 * 1024);
      const pollParsed = parseImageUpstreamResponse(pollRaw, pollResponse.headers.get("content-type") || "");
      if (!pollParsed.payload || pollParsed.error) {
        throw new ImageCandidateFailure({
          message: `${model.name} 图片任务返回了无法识别的状态`,
          code: "IMAGE_UPSTREAM_RESPONSE_INVALID",
          upstreamStatus: pollResponse.status,
          upstreamTarget: pollTarget,
        });
      }
      task = parseSecureSkillAsyncImageTask(pollParsed.payload);
      if (task.id && task.id !== taskId) {
        throw new ImageCandidateFailure({
          message: `${model.name} 图片任务 ID 不一致`,
          code: "IMAGE_UPSTREAM_RESPONSE_INVALID",
          upstreamStatus: pollResponse.status,
          upstreamTarget: pollTarget,
        });
      }
      if (task.status === "succeeded" && task.imageUrl) return task.imageUrl;
      if (task.status === "failed") {
        throw new ImageRequestRejectedError({ source: "provider", code: "IMAGE_UPSTREAM_TERMINAL_EVENT" });
      }
    }
    throw new ImageCandidateFailure({
      message: `${model.name} 图片任务仍在处理中，请保留原请求号查询，勿重复提交`,
      code: "IMAGE_UPSTREAM_RESULT_UNKNOWN",
      upstreamTarget: pollTarget,
    });
  }

  if (providerContract.requestProtocol === "google_generate_content") {
    const candidates = Array.isArray(apiData.candidates) ? apiData.candidates as Array<Record<string, unknown>> : [];
    for (const candidate of candidates) {
      const content = candidate.content && typeof candidate.content === "object"
        ? candidate.content as Record<string, unknown>
        : {};
      const parts = Array.isArray(content.parts) ? content.parts as Array<Record<string, unknown>> : [];
      for (const part of parts) {
        const inline = part.inlineData && typeof part.inlineData === "object"
          ? part.inlineData as Record<string, unknown>
          : part.inline_data && typeof part.inline_data === "object"
            ? part.inline_data as Record<string, unknown>
            : null;
        const data = typeof inline?.data === "string" ? inline.data.replace(/\s/gu, "") : "";
        if (!data) continue;
        const mimeType = typeof inline?.mimeType === "string"
          ? inline.mimeType
          : typeof inline?.mime_type === "string"
            ? inline.mime_type
            : "image/png";
        if (/^image\/[a-z0-9.+-]+$/iu.test(mimeType)) return `data:${mimeType};base64,${data}`;
      }
    }
    throw new ImageCandidateFailure({
      message: "Google 原生图片接口未返回 inlineData",
      code: "IMAGE_EMPTY_RESPONSE",
      upstreamTarget,
    });
  }

  if (providerContract.requestProtocol === "chat_completions") {
    const imageUrl = extractImageUrlFromChatResponse(apiData);
    if (imageUrl) return imageUrl;
    throw new ImageCandidateFailure({
      message: "多模态模型未返回图片",
      code: "IMAGE_EMPTY_RESPONSE",
      upstreamTarget,
    });
  }

  const generatedImages = apiData.data || [];
  const image = generatedImages[0];
  if (image?.url) {
    return isAutodlH3Selfhost
      ? resolveAutodlH3SelfhostResultUrl(image.url, model.api_endpoint)
      : image.url;
  }
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  throw new ImageCandidateFailure({
    message: "模型未返回图片URL或数据",
    code: "IMAGE_EMPTY_RESPONSE",
    upstreamTarget,
  });
}

function extractImageUrlFromChatResponse(data: Record<string, unknown>): string {
  const choices = data.choices as Array<{
    message?: {
      content?: string | Array<Record<string, unknown>>;
      images?: Array<{ image_url?: { url?: string } | string; url?: string }>;
    };
  }> | undefined;
  const message = choices?.[0]?.message;
  const directImage = message?.images?.map((item) =>
    typeof item.image_url === "string" ? item.image_url : item.image_url?.url || item.url,
  ).find(Boolean);
  if (directImage) return directImage;

  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      const url = typeof part.url === "string"
        ? part.url
        : typeof part.image_url === "string"
          ? part.image_url
          : (part.image_url as { url?: string } | undefined)?.url;
      if (url) return url;
      const dataValue = typeof part.data === "string" ? part.data : undefined;
      if (dataValue) return dataValue.startsWith("data:image/") ? dataValue : `data:image/png;base64,${dataValue}`;
    }
  }

  const content = typeof message?.content === "string" ? message.content : "";
  const markdownUrl = content.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  if (markdownUrl) return markdownUrl;
  return content.match(/https?:\/\/[^\s"'<>]+/i)?.[0] || "";
}

// ── 从 SSE 流中解析图片 URL（工作流模式用） ──
function extractImageUrlsFromSSE(rawText: string): string[] {
  const urls: string[] = [];
  for (const { payload: d } of parseImageSseFrames(rawText)) {
    try {
      if (d.type === "answer" && d.content) {
        const content = d.content as Record<string, unknown> | string;
        const answerText = typeof content === "string" ? content : String(content.answer || "");
        const mdImgRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
        let match;
        while ((match = mdImgRegex.exec(answerText)) !== null) urls.push(match[1]);
        const urlRegex = /(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)[^\s"'<>]*)/gi;
        while ((match = urlRegex.exec(answerText)) !== null) urls.push(match[1]);
        const signedUrlRegex = /(https?:\/\/[^\s"'<>]*(?:tos|oss|cos|s3)[^\s"'<>]*)/gi;
        while ((match = signedUrlRegex.exec(answerText)) !== null) {
          if (!urls.includes(match[1])) urls.push(match[1]);
        }
      }
      if (d.type === "tool_response" || d.type === "function_output") {
        const contentStr = typeof d.content === "string" ? d.content : JSON.stringify(d.content);
        const urlRegex2 = /(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)[^\s"'<>]*)/gi;
        let match;
        while ((match = urlRegex2.exec(contentStr)) !== null) {
          if (!urls.includes(match[1])) urls.push(match[1]);
        }
      }
    } catch {}
  }
  return urls;
}

// The provider creates artwork only. Exact glyphs are rendered after the
// returned pixels pass the aspect-ratio and resolution contract.
function buildCoverTextPrompt(_coverText: string, style: string, aspectRatio: string, prompt: string): string {
  return [
    "Professional cover background artwork without any visible text",
    prompt.trim() ? `Main visual: ${prompt.trim()}` : "",
    style ? `Art style: ${style}` : "",
    aspectRatio === "9:16" || aspectRatio === "3:4"
      ? "Vertical portrait composition with a clean upper title-safe area"
      : "Horizontal composition with a clean upper title-safe area",
    "Do not draw Chinese characters, English letters, numbers, captions, labels, logos, signs, watermarks, or simulated text",
    "The application will render every requested glyph after generation",
    "High quality, clean composition, sharp details",
  ].filter(Boolean).join(". ") + ".";
}

export async function POST(request: NextRequest) {
  let traceId = "";
  let traceStartedAt = Date.now();
  let traceNodeId = "";
  let traceNodeTitle = "";
  let tracePromptHash = "";
  let validationControl: Awaited<ReturnType<typeof prepareImageGenerationValidation>> | null = null;
  let deductResult: Awaited<ReturnType<typeof executeCashDeduction>> | null = null;
  let billingReservation: ImageBillingReservation | null = null;
  // TypeScript cannot safely narrow assignments made inside the exactly-once
  // callback. Keep the callback result in a stable holder and copy it at the
  // single success/catch join points below.
  const imageBudgetState: {
    deduction: Awaited<ReturnType<typeof executeCashDeduction>> | null;
    reservation: ImageBillingReservation | null;
  } = { deduction: null, reservation: null };
  try {
    // ── 用户认证：必须早于 trace、参数校验和任何上游/账单链路 ──
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const payload = token ? await verifyToken(token) : null;
    if (!payload) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    const currentAuthorization = await authorizeAdminToken(token);
    if (!currentAuthorization.ok && currentAuthorization.code !== "ADMIN_REQUIRED") {
      return NextResponse.json({
        error: currentAuthorization.error, code: currentAuthorization.code,
        upstreamCalled: false, billed: false,
      }, { status: currentAuthorization.status });
    }
    const userId = payload.userId;
    const userRole = currentAuthorization.ok ? "admin" : "student";

    const body = await readImageGenerationInput(request);
    const {
      prompt, modelId, style, mode, aspectRatio, resolution, coverText,
      referenceImageUrls, referenceUsage, clientTraceId, clientIdempotencyKey,
      clientNodeId, clientNodeTitle, historySurface, noRetry,
      strictSingleSubmit, resumeDeliveryOnly = false, adminValidation: rawAdminValidation,
    } = body;
    const deliveryRequirement = historySurface === "short-drama-film-studio" ? "recoverable_reference" : body.deliveryRequirement;
    const adminValidation = rawAdminValidation as ImageGenerationValidationInput | undefined;
    const internalModelIdRequested = typeof modelId === "string"
      && modelId.trim().length > 0
      && !modelId.startsWith("pm_");
    let privilegedModelOperationAuthorized = false;
    if (adminValidation || internalModelIdRequested) {
      const modelAccess = await authorizeAdminCapability(request, "models.manage", {
        requireStepUp: true,
        operation: adminValidation ? "image_model_validation_generate" : "image_internal_model_generate",
      });
      if (!modelAccess.ok) return modelAccess.response;
      privilegedModelOperationAuthorized = true;
    }

    const requestedTraceId = clientTraceId || "";
    if (requestedTraceId && !/^[a-zA-Z0-9_-]{8,128}$/u.test(requestedTraceId)) {
      return imageParameterRejection("图片生成追踪键格式无效", "IMAGE_TRACE_ID_INVALID");
    }
    traceId = /^[a-zA-Z0-9_-]{8,128}$/u.test(requestedTraceId) ? requestedTraceId : crypto.randomUUID();
    const requestedIdempotencyKey = clientIdempotencyKey || "";
    if (requestedIdempotencyKey && !/^[a-zA-Z0-9_-]{8,128}$/u.test(requestedIdempotencyKey)) {
      return imageParameterRejection("图片生成幂等键格式无效", "IMAGE_IDEMPOTENCY_KEY_INVALID");
    }
    if (!privilegedModelOperationAuthorized && !requestedIdempotencyKey) {
      return imageParameterRejection(
        "图片生成请求缺少幂等键，请刷新工作台后重新提交",
        "IMAGE_IDEMPOTENCY_KEY_REQUIRED",
      );
    }
    if (!privilegedModelOperationAuthorized && !requestedTraceId) {
      return imageParameterRejection(
        "图片生成请求缺少稳定追踪键，请刷新工作台后重新提交",
        "IMAGE_TRACE_ID_REQUIRED",
      );
    }
    const generationIdempotencyKey = requestedIdempotencyKey
      || `admin_${createHash("sha256").update(traceId).digest("hex").slice(0, 48)}`;
    traceNodeId = clientNodeId || "";
    traceNodeTitle = clientNodeTitle || "";
    tracePromptHash = createHash("sha256").update(prompt || "").digest("hex").slice(0, 16);
    traceStartedAt = Date.now();
    await writeImageTrace({
      phase: "requested",
      traceId,
      nodeId: traceNodeId,
      nodeTitle: traceNodeTitle,
      modelId: modelId || "",
      aspectRatio: aspectRatio || "",
      resolution: resolution || "",
      promptHash: tracePromptHash,
      promptPreview: String(prompt || "").replace(/\s+/g, " ").slice(0, 240),
      referenceCount: referenceImageUrls.length,
    });

    if (!prompt?.trim()) return imageParameterRejection("提示词不能为空", "IMAGE_PROMPT_REQUIRED");

    const h3OperationId = requestedIdempotencyKey
      ? `h3_${createHash("sha256").update(`${userId}:${requestedIdempotencyKey}`).digest("hex").slice(0, 48)}`
      : traceId;

    const dbClient = getSupabaseClient();
    const effectiveMode = mode || "local";
    const ratio = aspectRatio || "3:4";
    if (!["3:4", "9:16", "4:3", "16:9", "1:1"].includes(ratio)) {
      return imageParameterRejection("图片画幅不受支持", "IMAGE_ASPECT_RATIO_UNSUPPORTED");
    }
    const exactCoverText = coverText || "";
    if (exactCoverText.length > 200 || /[\x00-\x08\x0b-\x1f]/u.test(exactCoverText)) {
      return imageParameterRejection("精确画面文字不能超过 200 个字符且不能包含控制字符", "IMAGE_EXACT_TEXT_INVALID");
    }
    // Input validation has already rejected malformed/empty/non-string values
    // and enforced the platform-wide count before de-duplication. Never slice
    // here: the model-specific contract below must see the complete request.
    const references = referenceImageUrls;

    // Delivery-only continuation belongs to the immutable accepted request, not
    // to today's catalog. Resolve it before publication/assignment/capability
    // gates so a model being hidden, reassigned or repriced cannot strand an
    // already-created image.
    try {
      validateStrictImageClientKeys(generationIdempotencyKey, traceId);
    } catch (error) {
      if (error instanceof ImageExactlyOnceError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      throw error;
    }
    const previousImageRequest = await imageExactlyOnceStore.get({
      userId, clientIdempotencyKey: generationIdempotencyKey, clientTraceId: traceId,
    });
    const resumeSnapshot = resumeDeliveryOnly
      ? parseImageFailureRequestSnapshot(previousImageRequest?.requestSnapshot)
      : null;
    if (resumeDeliveryOnly) {
      const deliveryCanResume = Boolean(previousImageRequest && (
        (previousImageRequest.state === "completed" && previousImageRequest.response)
        || hasImageProviderCheckpoint(previousImageRequest)
      ));
      if (!deliveryCanResume || !resumeSnapshot) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_FAIL_CLOSED", "原图片结果尚未确认，系统会继续后台核验", 409);
      }
      if (prompt.trim() !== resumeSnapshot.prompt
        || modelId !== resumeSnapshot.publicModelId
        || ratio !== resumeSnapshot.aspectRatio
        || String(resolution || "").toUpperCase() !== resumeSnapshot.resolution
        || (historySurface || "other") !== resumeSnapshot.surface
        || deliveryRequirement !== resumeSnapshot.deliveryRequirement
        || exactCoverText.trim() !== (resumeSnapshot.exactCoverText || "")
        || (resumeSnapshot.schema === "image_generation_request_snapshot.v2"
          && ((style || "").trim() !== (resumeSnapshot.style || "")
            || (referenceUsage || "general") !== resumeSnapshot.referenceUsage))) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_CONFLICT", "自动交付参数与原请求不一致，已停止处理", 409);
      }
    }

    // ── 工作流价格（由插件配置决定） ──
    let workflowCostPriceGlobal = Number.NaN;
    let workflowSellingPriceGlobal = Number.NaN;

    // ── 获取模型配置 + 价格 ──
    let modelConfig: LocalCoverModelConfig | null = null;
    let localModelCandidates: LocalCoverModelConfig[] = [];
    let publicModelLabel = "";
    const workflowConfig = { apiUrl: "", appId: "", apiToken: "" };

    if (resumeSnapshot) {
      // The exact-once row already contains the accepted provider result and
      // immutable commercial snapshot. No current model credential is needed
      // unless a private provider object itself must still be fetched; that
      // delivery attempt remains fail-closed and never submits upstream again.
      publicModelLabel = resumeSnapshot.modelName;
    } else if (adminValidation) {
      validationControl = await prepareImageGenerationValidation({ db: dbClient, authorization: currentAuthorization,
        modelId, mode: effectiveMode, proof: adminValidation, clientKey: generationIdempotencyKey, clientTraceId: traceId });
    }

    if (effectiveMode === "workflow") {
      // ★ 优先从 plugins 表读取封面工作流配置（支持多备选切换）
      let workflowCostPrice = Number.NaN;
      let workflowSellingPrice = Number.NaN;
      try {
        const { data: pluginData } = await dbClient
          .from("plugins")
          .select("config, price_per_use, cost_price")
          .eq("role", "cover_workflow")
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        if (pluginData) {
          const config = pluginData.config as Record<string, string>;
          workflowConfig.apiUrl = config.api_base_url || "";
          workflowConfig.appId = config.app_id || "";
          workflowConfig.apiToken = config.api_token || "";
          // 从插件读取价格配置
          workflowSellingPrice = configuredImagePrice(pluginData.price_per_use);
          workflowCostPrice = configuredImagePrice(pluginData.cost_price);
        } else {
          // ★ 兼容回退：plugins 表无数据时从 platform_settings 读取
          const { data: settings } = await dbClient
            .from("platform_settings")
            .select("setting_key, setting_value")
            .in("setting_key", ["cover_workflow_api_url", "cover_workflow_app_id", "cover_workflow_token"]);
          if (settings && settings.length > 0) {
            const getSetting = (key: string) => settings.find((s: { setting_key: string; setting_value: string }) => s.setting_key === key)?.setting_value;
            if (getSetting("cover_workflow_api_url")) workflowConfig.apiUrl = getSetting("cover_workflow_api_url")!;
            if (getSetting("cover_workflow_app_id")) workflowConfig.appId = getSetting("cover_workflow_app_id")!;
            if (getSetting("cover_workflow_token")) workflowConfig.apiToken = getSetting("cover_workflow_token")!;
          }
        }
      } catch (e) {
        console.warn("[Image] Failed to load workflow config:", e);
      }
      // 保存价格供后续使用
      workflowCostPriceGlobal = workflowCostPrice;
      workflowSellingPriceGlobal = workflowSellingPrice;
      if (!Number.isFinite(workflowCostPriceGlobal)
        || workflowCostPriceGlobal < 0
        || !Number.isFinite(workflowSellingPriceGlobal)
        || workflowSellingPriceGlobal < 0) {
        return NextResponse.json({
          error: "封面工作流尚未配置有效成本价和销售价，已停止生成以避免错误扣费",
          code: "IMAGE_PRICE_NOT_CONFIGURED",
        }, { status: 503 });
      }
    } else if (validationControl) {
      modelConfig = validationControl.model as unknown as LocalCoverModelConfig;
      localModelCandidates = [modelConfig];
    } else {
      const availableModels = (await readImagePublicationStates(dbClient)).filter(entry => entry.available)
        .map(entry => entry.model as unknown as LocalCoverModelConfig);
      modelConfig = modelId
        ? modelId.startsWith("pm_") ? findModelByPublicId("cover", availableModels, modelId) as LocalCoverModelConfig | null
          : privilegedModelOperationAuthorized ? availableModels.find(model => model.id === modelId) || null : null
        : availableModels[0] || null;
      if (!modelConfig) return NextResponse.json({ error: "模型配置失效或密钥缺失，不能提交生成", code: "IMAGE_MODEL_CONFIGURATION_REQUIRED" }, { status: 409 });
      publicModelLabel = publicModelDisplayName(modelConfig as unknown as Record<string, unknown>);
      localModelCandidates = [modelConfig];
    }

    const workspaceSurface = imageWorkspaceSurfaceFromRequest(historySurface);
    if (!resumeSnapshot && !validationControl && effectiveMode !== "workflow" && modelConfig && workspaceSurface) {
      const workspaceModel = modelConfig as unknown as Record<string, unknown>;
      const workspaceCompatibility = evaluateWorkspaceModelCompatibility("image", workspaceModel, workspaceSurface);
      if (!workspaceCompatibility.compatible) {
        return NextResponse.json({
          error: workspaceCompatibility.issues[0]?.message || "当前工作台不支持该图片模型的输入能力",
          code: "IMAGE_MODEL_SURFACE_UNAVAILABLE",
          upstreamCalled: false,
          billed: false,
        }, { status: 409 });
      }
      const assignmentResult = await dbClient.from("platform_settings")
        .select("setting_value")
        .eq("setting_key", WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY)
        .maybeSingle();
      if (assignmentResult.error) {
        return NextResponse.json({
          error: "当前工作台模型清单暂不可读取，请稍后重试",
          code: "IMAGE_WORKSPACE_ASSIGNMENT_UNAVAILABLE",
          upstreamCalled: false,
          billed: false,
        }, { status: 503 });
      }
      if (!isWorkspaceModelAssigned(
        parseWorkspaceModelAssignmentOverrides(assignmentResult.data?.setting_value),
        "image",
        workspaceModel,
        workspaceSurface,
      )) {
        return NextResponse.json({
          error: "该模型尚未添加到当前工作台",
          code: "IMAGE_MODEL_NOT_ASSIGNED_TO_WORKSPACE",
          upstreamCalled: false,
          billed: false,
        }, { status: 409 });
      }
    }

    const imageCapabilities = getImageModelCapabilities(modelConfig);
    const userVisibleImageModelLabel = publicModelLabel
      || publicModelDisplayName(modelConfig as unknown as Record<string, unknown>);
    if (!resumeSnapshot && references.length > 0 && !imageCapabilities.supportsReferenceInput) {
      return imageParameterRejection(
        `${userVisibleImageModelLabel} 不支持参考图输入，请选择带“角色参考”能力的图片模型`,
        "IMAGE_REFERENCE_UNSUPPORTED", {
        referenceCapability: imageCapabilities.referenceCapabilityLabel,
      });
    }
    if (!resumeSnapshot && references.length > imageCapabilities.maxReferenceImages) {
      return imageParameterRejection(
        `${userVisibleImageModelLabel} 最多支持 ${imageCapabilities.maxReferenceImages} 张参考图，当前提交了 ${references.length} 张`,
        "IMAGE_REFERENCE_LIMIT_EXCEEDED", {
        maxReferenceImages: imageCapabilities.maxReferenceImages,
        submittedReferenceImages: references.length,
        referenceCapability: imageCapabilities.referenceCapabilityLabel,
      });
    }
    if (!resumeSnapshot && modelConfig && references.length > 0) {
      const providerContract = resolveImageProviderContract(modelConfig);
      const contractIssue = imageReferenceContractIssue(providerContract, references.length);
      if (contractIssue) {
        return imageParameterRejection(
          `${userVisibleImageModelLabel}：${contractIssue.message}`,
          contractIssue.code, {
          referenceTransport: providerContract.referenceTransport,
        });
      }
    }
    if (!resumeSnapshot && modelConfig?.provider === AUTODL_H3_SELFHOST_PROVIDER && ratio !== "16:9") {
      return imageParameterRejection(
        `${userVisibleImageModelLabel} 当前支持 16:9 画幅，请重新选择`,
        "AUTODL_H3_IMAGE_ASPECT_UNVERIFIED", {
        supportedAspectRatios: ["16:9"],
      });
    }
    const normalizedRequestedResolution = resolution?.toUpperCase();
    if (!resumeSnapshot && modelConfig?.provider === AUTODL_H3_SELFHOST_PROVIDER
      && normalizedRequestedResolution
      && normalizedRequestedResolution !== "2K") {
      return imageParameterRejection(
        `${userVisibleImageModelLabel} 当前支持 2K 输出，请重新选择`,
        "AUTODL_H3_IMAGE_RESOLUTION_UNVERIFIED", {
        supportedResolutions: ["2K"],
      });
    }
    if (!resumeSnapshot && normalizedRequestedResolution && !imageCapabilities.resolutionOptions.includes(normalizedRequestedResolution as ImageResolution)) {
      return imageParameterRejection(
        `${userVisibleImageModelLabel} 不支持 ${resolution}，可选：${imageCapabilities.resolutionOptions.join("、")}`,
        "IMAGE_RESOLUTION_UNSUPPORTED", {
        supportedResolutions: imageCapabilities.resolutionOptions,
      });
    }
    const effectiveResolution: ImageResolution = resumeSnapshot?.resolution
      || (modelConfig?.provider === AUTODL_H3_SELFHOST_PROVIDER
        ? "2K"
        : coerceImageResolution(modelConfig, normalizedRequestedResolution));
    const strictImageRequest = effectiveMode === "local" && Boolean(
      validationControl
      || modelId
      || noRetry
      || strictSingleSubmit
      || modelId === STRICT_GPT_IMAGE_PUBLIC_ID
      || modelConfig?.id === STRICT_GPT_IMAGE_DATABASE_ID,
    );
    if ((noRetry || strictSingleSubmit) && effectiveMode !== "local") {
      return imageParameterRejection("严格单次提交模式只支持本地图片模型", "IMAGE_STRICT_MODE_UNSUPPORTED");
    }
    let costPrice = resumeSnapshot ? 0 : effectiveMode === "workflow"
      ? workflowCostPriceGlobal
      : resolveImageResolutionPrice(modelConfig!, effectiveResolution, "cost");
    const sellingPrice = resumeSnapshot ? resumeSnapshot.quotedPriceYuan : effectiveMode === "workflow"
      ? workflowSellingPriceGlobal
      : resolveImageResolutionPrice(modelConfig!, effectiveResolution, "selling");
    if (!Number.isFinite(costPrice) || costPrice < 0 || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
      return NextResponse.json({
        error: "当前图片模型尚未配置有效成本价和销售价，已停止生成以避免错误扣费",
        code: "IMAGE_PRICE_NOT_CONFIGURED",
      }, { status: 503 });
    }
    // Freeze the user-selected public model identity before an equivalent
    // provider fallback can replace modelConfig. Pricing always remains the
    // selected model's published selling price; the terminal ledger records
    // the actual provider cost separately.
    const selectedBillingPublicModelId = resumeSnapshot?.publicModelId || (effectiveMode === "workflow"
      ? `workflow:${workflowConfig.appId}`
      : modelId?.startsWith("pm_")
        ? modelId
        : toPublicModelId("cover", modelConfig!.id));

    // ── 会员状态拦截（inactive/expired 用户禁止使用） ──
    if (!privilegedModelOperationAuthorized && !resumeDeliveryOnly) {
      const { data: membershipData } = await dbClient.from("users").select("member_status, member_expires_at").eq("id", userId).single();
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

    // 在欠费补扣、写入生图意图和调用上游前确认完整交付依赖，
    // 防止只部署 claim 后，生成成功才发现 save / finalize / 钱包迁移缺失。
    const prerequisites = await probeImageGenerationReadiness(sellingPrice > 0);
    if (!prerequisites.ready) {
      return NextResponse.json({
        error: prerequisites.error,
        code: prerequisites.code,
        upstreamCalled: false,
        billed: false,
      }, { status: 503 });
    }

    // ── 图片生成 ──
    let imageUrl = "";
    let autodlH3StoredObjectKey = "";
    let autodlH3StoredDimensions: ImageDimensions | null = null;
    let idempotencyReplayed = false;
    const ratioConstraint = ratio === "16:9"
      ? "画幅硬约束：最终图像必须是16:9横屏，宽度约为高度的1.78倍；禁止竖屏、方图、旋转画布或在竖版画布中留白。全身角色必须重新安排在横向构图内。"
      : ratio === "9:16"
        ? "画幅硬约束：最终图像必须是9:16竖屏；禁止横屏、方图或旋转画布。"
        : `画幅硬约束：最终图像必须严格使用${ratio}画幅。`;
    const basePrompt = exactCoverText
      ? buildCoverTextPrompt(exactCoverText, style || "", ratio, prompt)
      : (style ? `${prompt.trim()}，风格：${style}` : prompt.trim());
    const identityReferenceOnly = referenceUsage === "character-identity" && references.length > 0;
    const scenePrompt = identityReferenceOnly
      ? [
          "生成任务：参考图只用于锁定角色身份与固定造型，请从空白画布重新生成完整分镜关键帧，不要编辑或复刻角色定妆图。",
          basePrompt,
          "最终优先执行分镜中的剧情表演、叙事道具、环境反馈和明确指定的语义装饰；参考图不得带入原背景、站姿、机位或设定板排版，也不得覆盖这些画面内容。",
        ].join("\n")
      : basePrompt;
    const fullPrompt = `${ratioConstraint}\n${scenePrompt}`;
    const workflowPromptBase = exactCoverText
      ? buildCoverTextPrompt(exactCoverText, style || "", ratio, prompt)
      : (style
        ? `请生成一张抖音封面图，主题是：${prompt.trim()}，风格：${style}，尺寸比例：${ratio}`
        : `请生成一张抖音封面图，主题是：${prompt.trim()}，尺寸比例：${ratio}`);
    const outputPixelSize = resumeSnapshot?.outputPixelSize
      || expectedImagePixelSize(modelConfig, effectiveResolution, ratio);
    const providerProtocol: ImagePublishedProtocol = resumeSnapshot
      ? resumeSnapshot.providerProtocol || (effectiveMode === "workflow" ? "cover_workflow" : "images_generations")
      : (effectiveMode === "workflow" ? "cover_workflow" : resolveImageProviderContract(modelConfig!).requestProtocol);
    const workflowPrompt = `${workflowPromptBase}。输出画幅：${ratio}；清晰度档位：${effectiveResolution}；目标像素尺寸：${outputPixelSize}。`;
    const candidates = effectiveMode === "local" && modelConfig
      ? restrictImageCandidatesForNoRetry(
          localModelCandidates.length > 0 ? localModelCandidates : [modelConfig],
          strictImageRequest,
        )
      : [];
    if (!resumeDeliveryOnly && deliveryRequirement === "recoverable_reference") {
      const capable = effectiveMode === "local" && candidates.length > 0 && candidates.every((candidate) => {
        const boundH3 = assertAutodlH3SelfhostModelBinding({ kind: "image", provider: candidate.provider || "vectorengine",
          modelName: candidate.model_name, apiEndpoint: candidate.api_endpoint, apiKey: candidate.api_key });
        return imageRecoverableReferenceCapability({ contract: resolveImageProviderContract(candidate), referenceCount: references.length,
          boundH3, volcengine: candidate.provider === "volcengine" }) === "url_requested";
      });
      if (!capable) return imageParameterRejection("当前生图通道没有可恢复链接输出合同，无法用于后台编排；本次未调用模型或扣费", "IMAGE_RECOVERABLE_REFERENCE_UNSUPPORTED");
    }
    if (!resumeDeliveryOnly && effectiveMode === "local" && references.length === 0
      && candidates.some(candidate => resolveImageProviderContract(candidate).requestProtocol === "images_edits")) {
      return imageParameterRejection(
        "当前模型使用图片编辑协议，至少需要一张参考图",
        "IMAGE_REFERENCE_REQUIRED",
      );
    }
    const generationFingerprint = resumeDeliveryOnly && previousImageRequest
      ? previousImageRequest.payloadFingerprint
      : strictImagePayloadFingerprint({
      schema: "image_generation_request.v2",
      ...(deliveryRequirement ? { deliveryRequirement } : {}),
      ...(validationControl ? { validationConfigurationHash: validationControl.configurationHash } : {}),
      userId,
      mode: effectiveMode,
      requestedModelId: modelId || modelConfig?.id || `workflow:${workflowConfig.appId}`,
      candidateBindings: candidates.map((candidate) => ({
        id: candidate.id,
        provider: candidate.provider,
        modelName: candidate.model_name,
        apiEndpoint: candidate.api_endpoint,
        protocolConfig: candidate.api_protocol_config || {},
      })),
      workflowBinding: effectiveMode === "workflow"
        ? { appId: workflowConfig.appId, apiUrl: workflowConfig.apiUrl }
        : null,
      prompt: effectiveMode === "workflow" ? workflowPrompt : fullPrompt,
      userPrompt: prompt.trim(),
      style: style || "",
      exactCoverText,
      ratio,
      resolution: effectiveResolution,
      outputPixelSize,
      providerProtocol,
      imageCount: IMAGE_FIXED_OUTPUT_COUNT,
      references,
      referenceUsage: referenceUsage || "general",
      costPrice,
      sellingPrice,
    });
    const failureRequestSnapshot = resumeDeliveryOnly && previousImageRequest?.requestSnapshot
      ? previousImageRequest.requestSnapshot
      : createImageFailureRequestSnapshot({
      surface: historySurface,
      ...(deliveryRequirement ? { deliveryRequirement } : {}),
      prompt,
      publicModelId: selectedBillingPublicModelId,
      modelName: userVisibleImageModelLabel,
      aspectRatio: ratio,
      resolution: effectiveResolution,
      referenceImageUrls: references,
      quotedPriceYuan: sellingPrice,
      billingExempt: sellingPrice === 0,
      exactCoverText,
      style: style || "",
      effectivePrompt: effectiveMode === "workflow" ? workflowPrompt : fullPrompt,
      providerProtocol,
      outputPixelSize,
      imageCount: IMAGE_FIXED_OUTPUT_COUNT,
      referenceUsage: referenceUsage || "general",
      payloadFingerprint: generationFingerprint,
    });
    if (!failureRequestSnapshot) {
      return imageParameterRejection("生图请求快照无效，本次不会调用图片模型", "IMAGE_REQUEST_SNAPSHOT_INVALID");
    }

    // A confirmed result resumes this request's settlement/delivery, not a new
    // generation. Bind all original keys and payload before skipping new-request
    // balance/debt prechecks; the atomic terminal wallet call remains mandatory.
    if (previousImageRequest && previousImageRequest.payloadFingerprint !== generationFingerprint) {
      throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_CONFLICT", "同一图片请求号已绑定不同参数，请保留原请求核查", 409);
    }
    const billingReferenceId = `image:${h3OperationId}`;
    const previousRejection = previousImageRequest && getImageRequestRejection(previousImageRequest);
    if (previousRejection) {
      const rejectedSnapshot = parseImageFailureRequestSnapshot(previousImageRequest?.requestSnapshot);
      if (previousRejection.code !== "IMAGE_BILLING_RESERVATION_REJECTED"
        && (!rejectedSnapshot || (!rejectedSnapshot.billingExempt && rejectedSnapshot.quotedPriceYuan <= 0))) {
        throw new ImageExactlyOnceError(
          "IMAGE_BILLING_RELEASE_PENDING",
          "图片请求已拒绝，但原费用快照不完整；确认账务释放前不可重新提交。",
          503,
          { canRecover: false },
        );
      }
      if (rejectedSnapshot && !rejectedSnapshot.billingExempt && rejectedSnapshot.quotedPriceYuan > 0
        && previousRejection.code !== "IMAGE_BILLING_RESERVATION_REJECTED") {
        imageBudgetState.reservation = {
          userId,
          amount: rejectedSnapshot.quotedPriceYuan,
          referenceId: billingReferenceId,
          clientIdempotencyKey: generationIdempotencyKey,
          clientTraceId: traceId,
          requiresLedgerConfirmation: true,
        };
      }
      throw new ImageRequestRejectedError(previousRejection);
    }
    const resumingImageDelivery = Boolean(previousImageRequest && (
      (previousImageRequest.state === "completed" && previousImageRequest.response)
      || hasImageProviderCheckpoint(previousImageRequest)
    ));
    if (previousImageRequest && !resumingImageDelivery) {
      throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_FAIL_CLOSED", "图片结果待确认，原请求已保留。请稍后刷新状态。", 409);
    }
    if (!resumingImageDelivery) {
      if (sellingPrice > 0) {
        const { data: user } = await dbClient.from("users").select("cash_balance").eq("id", userId).single();
        if (!user || Number(user.cash_balance) < sellingPrice) {
          return NextResponse.json(
            { error: `现金余额不足，本次生成图片需要 ¥${sellingPrice.toFixed(2)}`, code: "INSUFFICIENT_BALANCE" },
            { status: 402 },
          );
        }
        const debtResult = await checkAndCollectDebt(userId);
        if (!debtResult.canProceed && debtResult.failureCode === "DEBT_LEDGER_UNAVAILABLE") {
          return NextResponse.json({
            error: "计费账本暂不可用，本次不会调用图片模型，也不会扣费，请稍后重试",
            code: "BILLING_LEDGER_UNAVAILABLE", retryable: true,
          }, { status: 503 });
        }
        if (!debtResult.canProceed) {
          return NextResponse.json({
            error: `您有未缴欠费 ¥${debtResult.remainingDebt.toFixed(2)}，请先充值`, code: "OUTSTANDING_CASH_DEBT",
          }, { status: 402 });
        }
        if (!Number.isFinite(debtResult.availableBalance) || debtResult.availableBalance < sellingPrice) {
          return NextResponse.json({
            error: `处理历史欠费后的余额不足，生成图片需要 ¥${sellingPrice.toFixed(2)}`,
            code: "INSUFFICIENT_BALANCE", upstreamCalled: false,
          }, { status: 402 });
        }
      }
    }

    if (validationControl) await validationControl.claim(generationFingerprint);

    // Atomically reserve the user's budget before any paid provider call.
    // This uses the wallet's idempotent charge as the reservation: a definite
    // provider rejection is released below, while an unknown/provider-complete
    // outcome keeps the same operation bound to the original request.
    const userVisibleModelLabel = effectiveMode === "workflow"
      ? "工作流"
      : publicModelLabel || publicModelDisplayName(modelConfig! as unknown as Record<string, unknown>);
    const reserveImageBudgetOnce = sellingPrice > 0 ? async () => {
      const quotedProfitRmb = Math.max(0, Math.round((sellingPrice - costPrice) * 10_000) / 10_000);
      const quotedProfitMargin = costPrice > 0
        ? Math.round((quotedProfitRmb / costPrice) * 10_000) / 100
        : null;
      imageBudgetState.deduction = await executeCashDeduction({
        userId,
        amount: sellingPrice,
        idempotencyKey: billingReferenceId,
        modelName: userVisibleModelLabel,
        description: `图片生成预算预留 ${userVisibleModelLabel}`,
        phase: "image_provider_reservation",
        publicModelId: selectedBillingPublicModelId,
        priceSnapshot: {
          price_yuan: sellingPrice,
          quoted_cost_price_yuan: costPrice,
          quoted_profit_yuan: quotedProfitRmb,
          quoted_profit_margin: quotedProfitMargin,
          aspect_ratio: ratio,
          resolution: effectiveResolution,
          requested_public_model_id: selectedBillingPublicModelId,
          requested_model_id: modelConfig?.id || `workflow:${workflowConfig.appId}`,
        },
        metadata: {
          route: "/api/image/generate",
          trace_id: traceId,
          image_operation_id: h3OperationId,
          reservation: true,
        },
      });
      if (!imageBudgetState.deduction.success) {
        throw new ImageRequestRejectedError({
          source: "input",
          code: "IMAGE_BILLING_RESERVATION_REJECTED",
        });
      }
      imageBudgetState.reservation = {
        userId,
        amount: sellingPrice,
        referenceId: billingReferenceId,
        clientIdempotencyKey: generationIdempotencyKey,
        clientTraceId: traceId,
      };
    } : undefined;

    const exactResult = await runImageExactlyOnce({
      store: imageExactlyOnceStore,
      userId,
      clientIdempotencyKey: generationIdempotencyKey,
      clientTraceId: traceId,
      payloadFingerprint: generationFingerprint,
      requestSnapshot: failureRequestSnapshot,
      billingReferenceId,
      ...(sellingPrice > 0 ? { rejectionBilling: { referenceId: billingReferenceId, amount: sellingPrice } } : {}),
      // runImageExactlyOnce first stores the durable intent and invokes this
      // hook only for its unique creator. Concurrent/replayed requests cannot
      // reserve the wallet or reach the provider callback.
      beforeSubmitOnce: reserveImageBudgetOnce,
      submitOnce: async (receiptContext) => {
        if (effectiveMode === "workflow") {
          if (!workflowConfig.apiToken || !workflowConfig.apiUrl || !workflowConfig.appId) {
            throw new ImageCandidateFailure({
              message: "封面工作流配置不完整",
              code: "IMAGE_WORKFLOW_NOT_CONFIGURED",
              upstreamTarget: "",
            });
          }
          let workflowResp: Response;
          let workflowDispatchReceipt: ImageProviderDispatchReceipt;
          let workflowAdmissionLease: ProviderAdmissionLease | null = null;
          try {
            workflowAdmissionLease = await acquireProviderAdmission({
              provider: "cover_workflow",
              channel: workflowConfig.apiUrl,
              model: workflowConfig.appId,
            });
            const workflowBody = JSON.stringify({
                app_id: workflowConfig.appId,
                user_id: userId,
                stream: true,
                content: { query: { prompt: [{ type: "text", content: { text: workflowPrompt } }] } },
                type: "query",
              });
            const submitted = await fetchAuditedImageProviderPost({
              url: workflowConfig.apiUrl,
              init: {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${workflowConfig.apiToken}` },
                body: workflowBody,
              },
              providerProtocol: "cover_workflow",
              projection: {
                userPromptSha256: createHash("sha256").update(prompt).digest("hex"),
                effectivePromptSha256: createHash("sha256").update(workflowPrompt).digest("hex"),
                modelIdSha256: createHash("sha256").update(`workflow:${workflowConfig.appId}`).digest("hex"),
                aspectRatio: ratio,
                resolution: effectiveResolution,
                imageCount: 1,
                referenceCount: references.length,
              },
              receiptContext,
              upstreamContext: { modelId: `workflow:${workflowConfig.appId}`, modelName: "cover-workflow", provider: "workflow" },
            });
            workflowResp = submitted.response;
            workflowDispatchReceipt = submitted.dispatchReceipt;
            workflowResp = await holdProviderAdmissionUntilResponseEnds(workflowResp, workflowAdmissionLease);
            workflowAdmissionLease = null;
          } catch (error) {
            if (workflowAdmissionLease) {
              await workflowAdmissionLease.release().catch((releaseError) => {
                console.error("[Image] workflow admission release failed", summarizeUpstreamImageError(
                  releaseError instanceof Error ? releaseError.message : "unknown",
                ));
              });
            }
            const admissionRejection = imageAdmissionRejection(error);
            if (admissionRejection) throw admissionRejection;
            throw new ImageCandidateFailure({
              message: summarizeUpstreamImageError(error instanceof Error ? error.message : "")
                || "图片工作流连接中断或派发回执未确认，结果无法确认",
              code: "IMAGE_WORKFLOW_RESULT_UNKNOWN",
              upstreamTarget: workflowConfig.apiUrl,
              retryable: false,
            });
          }
          if (!workflowResp.ok) {
            const errText = await readAuditedImageProviderResponseText({
              response: workflowResp,
              maximumBytes: 512 * 1024,
              dispatchReceipt: workflowDispatchReceipt,
              receiptContext,
            }).catch((error) => {
              if (error instanceof ImageUpstreamResponseTooLargeError) return "";
              throw error;
            });
            console.error("[Image/Workflow] API error:", {
              status: workflowResp.status,
              target: safeUpstreamTarget(workflowConfig.apiUrl),
              detail: summarizeUpstreamImageError(errText),
            });
            const rejection = explicitImageProviderRejection(workflowResp.status, errText);
            if (rejection) throw new ImageRequestRejectedError(rejection);
            throw new ImageCandidateFailure({
              message: `图片工作流返回 HTTP ${workflowResp.status}，结果无法确认`,
              code: "IMAGE_WORKFLOW_RESULT_UNKNOWN",
              upstreamStatus: workflowResp.status,
              upstreamTarget: workflowConfig.apiUrl,
              retryable: false,
            });
          }
          let rawText: string;
          try {
            rawText = await readAuditedImageProviderResponseText({
              response: workflowResp,
              maximumBytes: 8 * 1024 * 1024,
              dispatchReceipt: workflowDispatchReceipt,
              receiptContext,
            });
          } catch (error) {
            throw new ImageCandidateFailure({
              message: error instanceof ImageUpstreamResponseTooLargeError
                ? "图片工作流响应超过平台安全上限，结果无法确认"
                : "图片工作流响应读取中断，结果无法确认",
              code: error instanceof ImageUpstreamResponseTooLargeError
                ? "IMAGE_WORKFLOW_RESPONSE_TOO_LARGE"
                : "IMAGE_WORKFLOW_RESULT_UNKNOWN",
              upstreamStatus: workflowResp.status,
              upstreamTarget: workflowConfig.apiUrl,
              retryable: false,
            });
          }
          const parsedWorkflow = parseImageUpstreamResponse(rawText, workflowResp.headers.get("content-type") || "text/event-stream");
          if (parsedWorkflow.error) {
            if (parsedWorkflow.payload && !hasImageUpstreamAcceptanceSignal(parsedWorkflow.payload)) {
              throw new ImageRequestRejectedError({ source: "provider", code: "IMAGE_UPSTREAM_TERMINAL_EVENT" });
            }
            throw new ImageCandidateFailure({
              message: "图片工作流返回错误事件，但任务受理状态无法确认",
              code: "IMAGE_WORKFLOW_RESULT_UNKNOWN",
              upstreamStatus: workflowResp.status,
              upstreamTarget: workflowConfig.apiUrl,
              retryable: false,
            });
          }
          for (const { payload: data } of parseImageSseFrames(rawText)) {
            const content = data.content && typeof data.content === "object" && !Array.isArray(data.content)
              ? data.content as Record<string, unknown>
              : null;
            const messageEnd = content?.message_end && typeof content.message_end === "object" && !Array.isArray(content.message_end)
              ? content.message_end as Record<string, unknown>
              : null;
            if (data.type === "message_end" && messageEnd?.code && String(messageEnd.code) !== "0") {
              throw new ImageRequestRejectedError({ source: "provider", code: "IMAGE_UPSTREAM_TERMINAL_EVENT" });
            }
          }
          const extractedUrls = extractImageUrlsFromSSE(rawText);
          if (extractedUrls.length === 0) {
            throw new ImageCandidateFailure({
              message: "图片工作流未返回可确认的图片结果",
              code: "IMAGE_WORKFLOW_RESULT_UNKNOWN",
              upstreamStatus: workflowResp.status,
              upstreamTarget: workflowConfig.apiUrl,
              retryable: false,
            });
          }
          return {
            schema: "image_provider_result.v1",
            ...(extractedUrls[0].startsWith("data:") ? { kind: "inline", inlineDataUrl: extractedUrls[0] } : { kind: "url", rawUrl: extractedUrls[0] }),
            mode: "workflow",
            selectedModelId: `workflow:${workflowConfig.appId}`,
            selectedCostPrice: costPrice,
            provider: "workflow",
            apiEndpoint: workflowConfig.apiUrl,
            source: "image-workflow-generation",
          };
        }

        let finalFailure: ImageCandidateFailure | null = null;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          let candidateAdmissionLease: ProviderAdmissionLease | null = null;
          try {
            candidateAdmissionLease = await acquireProviderAdmission({
              provider: candidate.provider || "unknown",
              channel: candidate.api_endpoint || candidate.id,
              model: candidate.model_name || candidate.name || candidate.id,
            });
            const candidateImageUrl = await generateLocalImageCandidate({
              model: candidate,
              ratio,
              effectiveResolution,
              references,
              identityReferenceOnly,
              userPrompt: prompt,
              fullPrompt,
              idempotencyKey: `image-${h3OperationId}`,
              receiptContext,
              strictSingleSubmit: strictImageRequest,
            });
            if (index > 0) {
              await writeImageTrace({
                phase: "channel_fallback_succeeded",
                traceId,
                nodeId: traceNodeId,
                nodeTitle: traceNodeTitle,
                candidateIndex: index,
                candidateCount: candidates.length,
                modelId: candidate.id,
              });
            }
            return {
              schema: "image_provider_result.v1",
              ...(candidateImageUrl.startsWith("data:") ? { kind: "inline", inlineDataUrl: candidateImageUrl } : { kind: "url", rawUrl: candidateImageUrl }),
              mode: "local",
              selectedModelId: candidate.id,
              selectedCostPrice: resolveImageResolutionPrice(candidate, effectiveResolution, "cost"),
              provider: candidate.provider,
              apiEndpoint: candidate.api_endpoint,
              source: candidate.provider === AUTODL_H3_SELFHOST_PROVIDER ? "autodl-h3-selfhost" : "image-generation",
            };
          } catch (error) {
            const admissionRejection = imageAdmissionRejection(error);
            if (admissionRejection) throw admissionRejection;
            if (error instanceof ImageRequestRejectedError) throw error;
            const failure = error instanceof ImageCandidateFailure
              ? error
              : new ImageCandidateFailure({
                  message: summarizeUpstreamImageError(error instanceof Error ? error.message : "") || "图片生成失败",
                  code: "IMAGE_GENERATION_ERROR",
                  upstreamTarget: "",
                });
            finalFailure = failure;
            const hasNextCandidate = index + 1 < candidates.length;
            await writeImageTrace({
              phase: hasNextCandidate && failure.retryable ? "channel_fallback_started" : "channel_failed",
              traceId,
              nodeId: traceNodeId,
              nodeTitle: traceNodeTitle,
              candidateIndex: index,
              candidateCount: candidates.length,
              modelId: candidate.id,
              upstreamStatus: failure.upstreamStatus,
              code: failure.code,
              retryable: failure.retryable,
            });
            if (failure.retryable && hasNextCandidate) continue;
            break;
          } finally {
            if (candidateAdmissionLease) {
              await candidateAdmissionLease.release().catch((releaseError) => {
                console.error("[Image] candidate admission release failed", summarizeUpstreamImageError(
                  releaseError instanceof Error ? releaseError.message : "unknown",
                ));
              });
            }
          }
        }
        throw finalFailure || new ImageCandidateFailure({
          message: "图片生成服务未返回结果",
          code: "IMAGE_GENERATION_ERROR",
          upstreamTarget: "",
        });
      },
      prepareEphemeralResult: async (result, recordId) => {
        const candidate = candidates.find((entry) => entry.id === result.selectedModelId);
        const boundCost = result.mode === "local" && candidate
          ? resolveImageResolutionPrice(candidate, effectiveResolution, "cost") : costPrice;
        if (result.mode !== effectiveMode || result.selectedCostPrice !== boundCost || (result.mode === "local"
          ? !candidate || candidate.provider !== result.provider || candidate.api_endpoint !== result.apiEndpoint
          : result.selectedModelId !== `workflow:${workflowConfig.appId}` || result.apiEndpoint !== workflowConfig.apiUrl)) {
          throw new ImageExactlyOnceError("IMAGE_MODEL_BINDING_CHANGED", "原图片结果的模型配置已变化，请保留请求号核查", 409);
        }
        const decoded = decodeInlineImage(result.inlineDataUrl);
        const validated = validateUploadBuffer(decoded.buffer, decoded.contentType);
        if (validated.contentType !== decoded.contentType || !AUTODL_H3_IMAGE_CONTENT_TYPES.includes(validated.contentType)) {
          throw new ImageExactlyOnceError("IMAGE_INLINE_RESULT_INVALID", "上游图片格式无法确认，原请求保持锁定", 503);
        }
        const prepared = await prepareGeneratedImageBytes({
          buffer: decoded.buffer, aspectRatio: ratio, resolution: effectiveResolution,
          expectedPixelSize: expectedImagePixelSize(candidate, effectiveResolution, ratio),
        });
        return createImageEphemeralDelivery({
          recordId, buffer: prepared.buffer, contentType: decoded.contentType,
          width: prepared.dimensions.width, height: prepared.dimensions.height,
          selectedModelId: result.selectedModelId, selectedCostPrice: result.selectedCostPrice,
        });
      },
      // This callback is invoked only after the private provider result and a
      // persistence lease are durably confirmed. Replays never enter submitOnce.
      persistProviderResult: async (result, persistence) => {
        const candidate = candidates.find((entry) => entry.id === result.selectedModelId);
        if (result.mode !== effectiveMode || (!resumeSnapshot && (result.mode === "local"
          ? !candidate || candidate.provider !== result.provider || candidate.api_endpoint !== result.apiEndpoint
          : result.selectedModelId !== `workflow:${workflowConfig.appId}` || result.apiEndpoint !== workflowConfig.apiUrl))) {
          throw new ImageExactlyOnceError("IMAGE_MODEL_BINDING_CHANGED", "原图片结果的模型配置已变化，请保留请求号核查", 409);
        }
        const providerUrl = providerMediaUrl(result.rawUrl);
        if (!providerUrl) throw new ImageRequestRejectedError({ source: "provider", code: "IMAGE_PROVIDER_LINK_REQUIRED" });
        // Inspect bytes in memory; deliver the original link without copying.
        let ownedResultRecovery: { kind: "image"; expectedJobId: string; apiKey: string } | undefined;
        if (result.provider === AUTODL_H3_SELFHOST_PROVIDER) {
          const bound = await imageExactlyOnceStore.readProviderPersistenceBinding({
            recordId: persistence.recordId, userId, payloadFingerprint: persistence.payloadFingerprint,
            persistenceAttemptId: persistence.persistenceAttemptId, result,
          });
          const boundUrl = new URL(resolveAutodlH3SelfhostResultUrl(bound.rawUrl, bound.apiEndpoint, { allowExpired: true }));
          ownedResultRecovery = { kind: "image", expectedJobId: boundUrl.pathname.slice("/v1/files/".length), apiKey: resolveProviderSecret(AUTODL_H3_SELFHOST_SECRET_REF) };
        }
        const imported = result.provider === AUTODL_H3_SELFHOST_PROVIDER
          ? await readAutodlH3SelfhostResult(providerUrl, result.apiEndpoint, {
              maxBytes: AUTODL_H3_IMAGE_MAX_BYTES, timeoutMs: AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS,
              allowedContentTypes: AUTODL_H3_IMAGE_CONTENT_TYPES,
              ownedResultRecovery,
            })
          : await safeFetch(providerUrl, {
              maxBytes: AUTODL_H3_IMAGE_MAX_BYTES, timeoutMs: AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS,
              maxRedirects: 3, allowedContentTypes: ["image/*"], trustedHostnames: TRUSTED_GENERATED_IMAGE_HOSTS,
            });
        const validated = validateUploadBuffer(imported.buffer, imported.contentType);
        if (!AUTODL_H3_IMAGE_CONTENT_TYPES.includes(validated.contentType)) throw new Error("上游图片格式不受支持");
        const prepared = await prepareGeneratedImageBytes({
          buffer: imported.buffer, aspectRatio: ratio, resolution: effectiveResolution,
          expectedPixelSize: expectedImagePixelSize(candidate, effectiveResolution, ratio),
        });
        return {
          deliveryMode: "provider_url", providerUrl: "finalUrl" in imported ? imported.finalUrl : providerUrl, provider: result.provider, apiEndpoint: result.apiEndpoint,
          contentType: validated.contentType, source: result.source,
          width: prepared.dimensions.width, height: prepared.dimensions.height,
          selectedModelId: result.selectedModelId, selectedCostPrice: result.selectedCostPrice,
        };
      },
    });
    deductResult = imageBudgetState.deduction;
    billingReservation = imageBudgetState.reservation;
    idempotencyReplayed = exactResult.replayed;
    if (isImageEphemeralReceipt(exactResult.response)) {
      const receipt = exactResult.response;
      const transient = "transientDelivery" in exactResult ? exactResult.transientDelivery : undefined;
      // The durable task/financial receipt does not claim browser receipt or future media availability.
      // Existing revenue task identity is unique: receipt-only replays repair a
      // lost projection without touching the wallet, provider or image bytes.
      await recordRevenue({ userId, modelId: effectiveMode === "workflow" ? selectedBillingPublicModelId : receipt.selectedModelId,
        taskId: receipt.billingReferenceId || billingReferenceId, costPrice: receipt.selectedCostPrice,
        sellingPrice: receipt.cashCharged ?? sellingPrice,
        userRole: (userRole as "admin" | "student") || "student", recordType: "image", cashCharged: receipt.cashCharged ?? sellingPrice,
      }).catch(() => console.error("[Image] ephemeral revenue receipt projection unavailable"));
      return NextResponse.json({
        success: true, status: "completed", taskId: traceId, traceId, operationId: h3OperationId,
        ...imageEphemeralStatus(receipt),
        mediaAvailable: Boolean(transient), transientAvailable: Boolean(transient),
        images: transient ? [{ url: transient.dataUrl, recordId: receipt.recordId, deliveryMode: "inline_ephemeral",
          ephemeral: true, retention: "current_page_only", mediaAvailable: true, canRecover: false,
          width: receipt.width, height: receipt.height, dimensionsVerified: true }] : [],
        modelUsed: userVisibleModelLabel, modelIdUsed: modelId?.startsWith("pm_") ? modelId : null,
        resolution: effectiveResolution, outputPixelSize, imageCount: IMAGE_FIXED_OUTPUT_COUNT, providerProtocol,
        payloadFingerprint: generationFingerprint, idempotencyReplayed,
        message: transient ? "图片仅在当前页面可预览和下载，请及时下载保存。" : "本次任务已完成；图片仅在原页面临时交付，刷新后无法恢复。",
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const directProviderUrl = exactResult.response.deliveryMode === "provider_url" ? providerMediaUrl(exactResult.response.providerUrl) : null;
    if (exactResult.response.sourceExpiredAt) throw new ImageExactlyOnceError("IMAGE_SOURCE_EXPIRED", "上游图片已确认失效，原任务与账务凭据仍保留", 410);
    const imageStorageUri = String(exactResult.response.imageStorageUri || "");
    autodlH3StoredObjectKey = String(exactResult.response.storageKey || "");
    const storedProvider = String(exactResult.response.storageProvider || "");
    const storedFileName = String(exactResult.response.fileName || "");
    const storedFileSize = Number(exactResult.response.fileSize);
    const storedContentType = String(exactResult.response.contentType || "");
    const storedSource = String(exactResult.response.source || "image-generation");
    const storedWidth = Number(exactResult.response.width);
    const storedHeight = Number(exactResult.response.height);
    if (Number.isInteger(storedWidth) && storedWidth > 0 && Number.isInteger(storedHeight) && storedHeight > 0) {
      autodlH3StoredDimensions = { width: storedWidth, height: storedHeight };
    }
    const selectedModelId = String(exactResult.response.selectedModelId || "");
    const selectedCostPrice = configuredImagePrice(exactResult.response.selectedCostPrice);
    if (
      (!directProviderUrl && (!imageStorageUri
      || !autodlH3StoredObjectKey
      || storedProvider !== GENERATED_IMAGE_STORAGE_PROVIDER
      || !storedFileName
      || !Number.isInteger(storedFileSize)
      || storedFileSize <= 0))
      || !AUTODL_H3_IMAGE_CONTENT_TYPES.includes(storedContentType)
      || !autodlH3StoredDimensions
      || !selectedModelId
      || !Number.isFinite(selectedCostPrice)
      || selectedCostPrice < 0
    ) {
      throw new ImageExactlyOnceError(
        "IMAGE_IDEMPOTENCY_RESULT_INVALID",
        "图片生成幂等结果不完整，已停止发放结果",
        503,
      );
    }
    costPrice = selectedCostPrice;
    if (effectiveMode === "local") {
      const selectedCandidate = candidates.find((candidate) => candidate.id === selectedModelId);
      if (!selectedCandidate && !resumeSnapshot) {
        throw new ImageExactlyOnceError(
          "IMAGE_MODEL_BINDING_CHANGED",
          "原图片的模型配置已变更，暂时无法完成保存。请联系管理员检查对应配置。",
          409,
        );
      }
      if (selectedCandidate) modelConfig = selectedCandidate;
    }
    imageUrl = directProviderUrl
      ? (exactResult.response.provider === AUTODL_H3_SELFHOST_PROVIDER
        ? `/api/media-history/content?recordId=${encodeURIComponent(exactResult.record.recordId)}` : directProviderUrl)
      : await resolveGeneratedImageObjectUri(imageStorageUri);

    await recordRevenue({
      userId,
      modelId: effectiveMode === "workflow" ? selectedBillingPublicModelId : modelConfig?.id || selectedModelId,
      taskId: billingReferenceId,
      costPrice,
      sellingPrice,
      userRole: (userRole as "admin" | "student") || "student",
      recordType: "image",
      cashCharged: sellingPrice,
    });

    // 图片对象先以“held”状态保存，不写 user_files，也不向用户暴露。
    // 只有扣费成功或配置明确为零价后，原子 RPC 才建立账号资产归属；
    // 重放同一请求会复用同一账单 reference 与同一 assetId。
    const delivery = directProviderUrl
      ? await finalizeImageProviderDelivery({ recordId: exactResult.record.recordId, userId, providerUrl: directProviderUrl })
      : await finalizeImageExactlyOnceDelivery({
      recordId: exactResult.record.recordId,
      userId,
      storageKey: autodlH3StoredObjectKey,
      storageProvider: storedProvider,
      fileName: storedFileName,
      fileSize: storedFileSize,
      contentType: storedContentType,
      source: storedSource,
      meta: {
        traceId,
        modelId: selectedModelId,
        billingReferenceId: `image:${h3OperationId}`,
        quotedPriceYuan: String(sellingPrice),
        actualCostPriceYuan: String(costPrice),
        billingExempt: String(sellingPrice === 0),
        billingExemptionReason: sellingPrice === 0 ? "zero_price" : "none",
        billingOperationId: deductResult?.operationId || "",
      },
    });

    if (validationControl) await validationControl.recordOutcome();

    // ── 计算宽高 ──
    const [estimatedWidth, estimatedHeight] = outputPixelSize
      .split("x").map(Number);
    const verifiedDimensions = autodlH3StoredDimensions;
    const width = verifiedDimensions?.width || estimatedWidth;
    const height = verifiedDimensions?.height || estimatedHeight;

    await writeImageTrace({
      phase: "succeeded",
      traceId,
      nodeId: traceNodeId,
      nodeTitle: traceNodeTitle,
      modelId: modelConfig?.id || modelId || "",
      modelName: modelConfig?.name || "工作流",
      promptHash: tracePromptHash,
      outputUrl: directProviderUrl ? "provider_url" : `object://${GENERATED_IMAGE_STORAGE_PROVIDER}/${encodeURIComponent(autodlH3StoredObjectKey)}`,
      durationMs: Date.now() - traceStartedAt,
    });
    let currentCashRemaining: number | null = null;
    if (sellingPrice > 0) {
      try {
        const currentBalance = await dbClient.from("users").select("cash_balance").eq("id", userId).single();
        const value = Number(currentBalance.data?.cash_balance);
        if (Number.isFinite(value) && value >= 0) currentCashRemaining = value;
      } catch { /* A stale balance must never hide an already-delivered image. */ }
    }
    return NextResponse.json({
      success: true,
      status: "completed",
      taskId: traceId,
      traceId,
      operationId: h3OperationId,
      billingReferenceId,
      images: [{
        url: imageUrl,
        ...(delivery.assetId ? { assetId: delivery.assetId } : {}),
        ...(directProviderUrl ? { deliveryMode: "provider_url", recordId: exactResult.record.recordId } : {}),
        aspectRatio: ratio,
        width,
        height,
        dimensionsVerified: Boolean(verifiedDimensions),
        ...(autodlH3StoredObjectKey ? { storageKey: autodlH3StoredObjectKey } : {}),
      }],
      modelUsed: userVisibleModelLabel,
      modelIdUsed: modelId?.startsWith("pm_") ? modelId : null,
      resolution: effectiveResolution,
      outputPixelSize,
      imageCount: IMAGE_FIXED_OUTPUT_COUNT,
      providerProtocol,
      payloadFingerprint: generationFingerprint,
      idempotencyReplayed,
      recordId: exactResult.record.recordId,
      ...(directProviderUrl ? { deliveryMode: "provider_url" } : {}),
      // This is the total charge bound to the business request, not the delta
      // of an idempotent wallet replay (which is correctly zero internally).
      cashCharged: sellingPrice,
      cashRemaining: currentCashRemaining,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    deductResult = imageBudgetState.deduction;
    billingReservation = imageBudgetState.reservation;
    if (error instanceof ImageGenerationInputError) {
      return imageParameterRejection(error.message, error.code, {}, error.status);
    }
    if (billingReservation) {
      const definiteNoResult = error instanceof ImageRequestRejectedError
        || (error instanceof ImageCandidateFailure
          && ["IMAGE_WORKFLOW_NOT_CONFIGURED", "IMAGE_GENERATION_ERROR"].includes(error.code));
      if (definiteNoResult) {
        let providerResultDurable = false;
        let rejectionRecord: Awaited<ReturnType<DatabaseImageExactlyOnceStore["get"]>> = null;
        try {
          const current = await imageExactlyOnceStore.get({
            userId: billingReservation.userId,
            clientIdempotencyKey: billingReservation.clientIdempotencyKey,
            clientTraceId: billingReservation.clientTraceId,
          });
          providerResultDurable = Boolean(current && (
            current.state === "completed" || hasImageProviderCheckpoint(current)
          ));
          rejectionRecord = current;
        } catch {
          return NextResponse.json({
            error: "图片生成失败，费用状态正在自动核对",
            code: "IMAGE_BILLING_RELEASE_PENDING",
            traceId,
            canResubmit: false,
            billingHeld: true,
          }, { status: 503 });
        }
        if (!providerResultDurable) {
          let releaseConfirmed = false;
          if (billingReservation.requiresLedgerConfirmation) {
            const ledger = await readImageReservationBilling(billingReservation).catch(() => ({ state: "unknown" as const }));
            if (ledger.state === "not_charged" || ledger.state === "exempt") {
              releaseConfirmed = true;
            } else if (ledger.state === "charged" && ledger.chargedAmount !== undefined) {
              billingReservation.amount = ledger.chargedAmount;
            } else {
              return NextResponse.json({
                error: "图片请求已拒绝，费用状态正在自动对账",
                code: "IMAGE_BILLING_RELEASE_PENDING",
                traceId,
                state: "billing_release_pending",
                canResubmit: false,
                billingHeld: true,
                billingReleaseState: "pending",
              }, { status: 503 });
            }
          }
          const released = releaseConfirmed ? { success: true } : await refundCash(
              billingReservation.userId,
              billingReservation.amount,
              "图片上游明确失败，释放原请求预算",
              `${billingReservation.referenceId}:release`,
            ).catch(() => ({ success: false }));
          if (!released.success) {
            return NextResponse.json({
              error: "图片生成失败，费用释放正在自动核对",
              code: "IMAGE_BILLING_RELEASE_PENDING",
              traceId,
              state: "billing_release_pending",
              canResubmit: false,
              billingHeld: true,
              billingReleaseState: "pending",
            }, { status: 503 });
          }
          if (rejectionRecord) {
            await imageExactlyOnceStore.markRejectionBillingRelease?.(rejectionRecord, {
              schema: "image_billing_release.v1",
              state: "confirmed",
              referenceId: billingReservation.referenceId,
              amount: billingReservation.amount,
              updatedAt: new Date().toISOString(),
            }).catch((releaseError) => {
              console.error("[Image] billing release receipt confirmation failed", summarizeUpstreamImageError(
                releaseError instanceof Error ? releaseError.message : "unknown",
              ));
            });
          }
          billingReservation = null;
          deductResult = null;
        }
      }
    }
    if (validationControl) await validationControl.recordOutcome(error);
    const traceErrorCode = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "").trim()
      : "";
    await writeImageTrace({
      phase: "failed",
      traceId,
      nodeId: traceNodeId,
      nodeTitle: traceNodeTitle,
      promptHash: tracePromptHash,
      durationMs: Date.now() - traceStartedAt,
      detail: summarizeUpstreamImageError(error instanceof Error ? error.message : "") || "图片生成失败",
      ...(traceErrorCode ? { code: traceErrorCode } : {}),
    });
    console.error("[Image] Generate error:", {
      code: traceErrorCode || "IMAGE_GENERATION_ERROR",
      detail: summarizeUpstreamImageError(error instanceof Error ? error.message : "") || "图片生成失败",
    });
    if (error instanceof ImageAdminValidationError) {
      return NextResponse.json({ error: error.message, code: error.code, traceId, canResubmit: false, taskSubmitted: false }, { status: error.status });
    }
    if (error instanceof ImageRequestRejectedError) {
      const admissionRejected = error.rejection.code === "IMAGE_PROVIDER_ADMISSION_BUSY"
        || error.rejection.code === "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE";
      const billingReleaseConfirmed = !billingReservation;
      return NextResponse.json({ error: billingReleaseConfirmed
          ? error.message
          : "图片请求已明确拒绝，费用仍在自动对账或释放；确认完成前不可使用新键重提。",
         code: error.code, traceId, state: billingReleaseConfirmed ? "rejected" : "billing_release_pending",
         rejectionState: "rejected",
         canRecover: false, canResubmit: billingReleaseConfirmed, sameKeyCanResubmit: false,
         upstreamCalled: error.rejection.source === "provider",
         billed: Boolean(billingReservation),
         billingHeld: Boolean(billingReservation),
         billingReleaseState: billingReleaseConfirmed ? "confirmed" : "pending",
         ...(admissionRejected ? {
           task_submitted: false,
           taskSubmitted: false,
           price: 0,
           retryable: true,
           admissionScope: error.rejection.admissionScope,
         } : {}),
        ...(error.rejection.upstreamStatus ? { upstreamStatus: error.rejection.upstreamStatus } : {}),
      }, {
        status: error.status,
        headers: error.rejection.code === "IMAGE_PROVIDER_ADMISSION_BUSY" && error.rejection.retryAfterSeconds
          ? { "Retry-After": String(error.rejection.retryAfterSeconds) }
          : undefined,
      });
    }
    if (error instanceof ImageExactlyOnceError) {
      const requestSnapshotRejected = error.code === "IMAGE_REQUEST_SNAPSHOT_INVALID";
      const retryAfterMs = Number(error.recovery?.retryAfterMs) || 0;
      return NextResponse.json({
        error: error.message, code: error.code,
        ...(requestSnapshotRejected ? {
          traceId,
          state: "rejected",
          canRecover: false,
          canResubmit: false,
          sameKeyCanResubmit: false,
          requestAccepted: false,
          upstreamCalled: false,
           billed: false,
          taskSubmitted: false,
        } : error.code === "IMAGE_RESULT_PERSISTENCE_PENDING" ? {
           traceId,
           state: "provider_completed_pending_delivery",
           canRecover: error.recovery?.canRecover === true,
           canResubmit: false,
           billingHeld: Boolean(billingReservation),
          ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
         } : error.code === "IMAGE_PROVIDER_CHECKPOINT_NOT_CONFIRMED" || error.code === "IMAGE_REJECTION_RECEIPT_UNCONFIRMED"
           || error.code === "IMAGE_BILLING_RELEASE_PENDING" ? {
            traceId,
            state: error.code === "IMAGE_BILLING_RELEASE_PENDING" ? "billing_release_pending" : "unknown",
            canRecover: false, canResubmit: false,
            billingHeld: error.code === "IMAGE_BILLING_RELEASE_PENDING" || Boolean(billingReservation),
            ...(error.code === "IMAGE_BILLING_RELEASE_PENDING" ? { billingReleaseState: "pending" } : {}),
         } : {}),
      }, {
        status: error.status,
        headers: retryAfterMs > 0
          ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
          : undefined,
      });
    }
    if (error instanceof ImageCandidateFailure) {
      return NextResponse.json({
        error: summarizeUpstreamImageError(error.message) || "图片生成失败，结果无法确认",
        code: error.code,
        traceId,
         state: "failed_unknown",
         canResubmit: false,
         billingHeld: Boolean(billingReservation),
        ...(typeof error.upstreamStatus === "number" ? { upstreamStatus: error.upstreamStatus } : {}),
      }, { status: 502 });
    }
    return NextResponse.json(
      { error: "图片生成失败，请保留追踪号并联系管理员核对" },
      { status: 500 }
    );
  }
}
