import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getJwtSecretString } from "@/lib/auth";
import type { AdminAuthorizationResult } from "@/lib/admin-auth";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { getVideoInputContract } from "@/lib/video-input-contract";
import { getVideoDurationCapabilities, getVideoResolutionCapabilities } from "@/lib/video-model-capabilities";
import { publicModelDisplayName, toPublicModelId } from "@/lib/public-model-dto";
import { inspectVideoModelActivationReadiness } from "@/lib/model-activation-gate";
import { getVideoTokenPublicPricing } from "@/lib/video-token-billing";
import { evaluateVideoChannelCircuit, sanitizeVideoChannelError, VIDEO_CHANNEL_RECOVERY_CONFIRMATION, type VideoChannelHealthRecord } from "@/lib/video-channel-health-circuit";

export const VIDEO_ADMIN_VALIDATION_CONFIRMATION = VIDEO_CHANNEL_RECOVERY_CONFIRMATION;
const SCHEMA = "video_admin_validation.v1";
const NON_EXECUTION_FIELDS = new Set([
  "created_at", "updated_at", "total_requests", "success_count", "fail_count", "last_success_at",
  "name", "display_name", "public_name", "avatar_url", "icon_url", "sort_order", "admin_notes",
]);

export class VideoAdminValidationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "VideoAdminValidationError";
  }
}

export type VideoAdminValidationModel = Record<string, unknown> & { id: string };
type ReadResult = { data: unknown; error: unknown };
type ReadQuery = {
  select(columns: string): ReadQuery;
  eq(column: string, value: string): ReadQuery;
  abortSignal(signal: AbortSignal): ReadQuery;
  maybeSingle(): PromiseLike<ReadResult>;
};
export type VideoValidationDatabase = { supabaseUrl?: unknown; from(table: string): ReadQuery };

export type VideoAdminValidationContext = {
  schema: typeof SCHEMA;
  userId: string;
  /** Server-only row. Never serialize this context directly into an API response. */
  model: VideoAdminValidationModel;
  health: VideoChannelHealthRecord | null;
  configurationHash: string;
  healthEpoch: string;
  validationKey: string;
  credentialReady: boolean;
};

/** Shared server-side reservation identity; authorization proofs remain user-bound. */
export function buildVideoAdminValidationClaimKey(context: VideoAdminValidationContext): string {
  serverOnly();
  return `vvc_${sha({ schema: "video_validation_claim.v1", modelId: context.model.id, configurationHash: context.configurationHash, healthEpoch: context.healthEpoch })}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function serverOnly() {
  if (typeof window !== "undefined") throw new VideoAdminValidationError("VIDEO_VALIDATION_SERVER_ONLY", "模型验证只允许在服务端执行", 500);
}

export function assertLocalVideoValidationDatabase(db: VideoValidationDatabase) {
  let url: URL;
  try { url = new URL(String(db.supabaseUrl || "")); } catch { throw new VideoAdminValidationError("VIDEO_VALIDATION_LOCAL_DATABASE_REQUIRED", "无法确认本地验证数据库", 503); }
  if (url.origin !== "http://127.0.0.1:54321" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new VideoAdminValidationError("VIDEO_VALIDATION_LOCAL_DATABASE_REQUIRED", "当前验证入口仅允许使用本地验证数据库", 503);
  }
}

/** The application's configured database is authoritative; never fall back to a different database. */
export function assertConfiguredVideoValidationDatabase(db: VideoValidationDatabase) {
  let url: URL;
  try { url = new URL(String(db.supabaseUrl || "")); } catch { throw new VideoAdminValidationError("VIDEO_VALIDATION_DATABASE_UNAVAILABLE", "无法确认当前应用数据库", 503); }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new VideoAdminValidationError("VIDEO_VALIDATION_DATABASE_UNAVAILABLE", "当前应用数据库地址无效", 503);
  }
}

export function assertVideoAdminValidationModelId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value) || value.startsWith("pm_")) {
    throw new VideoAdminValidationError("VIDEO_VALIDATION_MODEL_ID_REQUIRED", "请选择一个明确的后台视频模型", 400);
  }
}

/** Stable until a real terminal outcome; statistics/notes cannot mint another attempt. */
export function videoAdminValidationHealthEpoch(health: VideoChannelHealthRecord | null): string {
  const terminalTimestamp = (value: unknown) => {
    const text = typeof value === "string" ? value : "";
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  return sha({
    lastSuccessAt: terminalTimestamp(health?.last_success_at),
    lastFailAt: terminalTimestamp(health?.last_fail_at),
    consecutiveFailures: Math.max(0, Number(health?.consecutive_failures) || 0),
    healthy: health?.is_healthy === true,
  });
}

/** Deterministic identity; this does not claim/reserve or submit a provider task. */
export function buildVideoAdminValidationContext(input: {
  model: VideoAdminValidationModel;
  health: VideoChannelHealthRecord | null;
  userId: string;
  resolveCredential?: (value: unknown) => string;
  signingSecret?: string;
}): VideoAdminValidationContext {
  serverOnly();
  assertVideoAdminValidationModelId(input.model.id);
  if (!input.userId?.trim()) throw new VideoAdminValidationError("VIDEO_VALIDATION_USER_REQUIRED", "缺少已认证管理员身份", 401);
  if (input.health?.channel_id && input.health.channel_id !== input.model.id) throw new VideoAdminValidationError("VIDEO_VALIDATION_HEALTH_ID_MISMATCH", "模型与健康记录不匹配", 503);
  let resolvedCredential = "";
  try { resolvedCredential = (input.resolveCredential || resolveProviderSecret)(input.model.api_key).trim(); } catch { /* Only a readiness boolean may leave this function. */ }
  const credentialReady = resolvedCredential.length > 0;
  const executionConfig = Object.fromEntries(Object.entries(input.model).filter(([key]) => !NON_EXECUTION_FIELDS.has(key)));
  const configurationHash = sha({ schema: SCHEMA, model: executionConfig, resolvedCredentialHash: credentialReady ? sha(resolvedCredential) : "unresolved" });
  const healthEpoch = videoAdminValidationHealthEpoch(input.health);
  const secret = input.signingSecret ?? getJwtSecretString();
  if (!secret) throw new VideoAdminValidationError("VIDEO_VALIDATION_SIGNING_UNAVAILABLE", "模型验证签名配置不可用", 503);
  const validationKey = `vav_${createHmac("sha256", secret).update(JSON.stringify({ schema: SCHEMA, userId: input.userId, modelId: input.model.id, configurationHash, healthEpoch })).digest("hex")}`;
  return { schema: SCHEMA, userId: input.userId, model: input.model, health: input.health, configurationHash, healthEpoch, validationKey, credentialReady };
}

export async function loadVideoAdminValidationContext(db: VideoValidationDatabase, modelId: unknown, userId: string): Promise<VideoAdminValidationContext> {
  serverOnly();
  assertConfiguredVideoValidationDatabase(db);
  assertVideoAdminValidationModelId(modelId);
  const [modelResult, healthResult] = await Promise.all([
    db.from("video_models").select("*").eq("id", modelId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle(),
    db.from("video_channel_health").select("channel_id,is_healthy,total_requests,success_count,fail_count,timeout_count,consecutive_failures,last_success_at,last_fail_at,last_error,updated_at,health_protocol_version,verification_state,verified_at,verification_evidence").eq("channel_id", modelId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle(),
  ]);
  if (modelResult.error || healthResult.error) throw new VideoAdminValidationError("VIDEO_VALIDATION_LOOKUP_FAILED", "暂时无法读取当前模型验证配置", 503);
  if (!modelResult.data) throw new VideoAdminValidationError("VIDEO_VALIDATION_MODEL_NOT_FOUND", "没有该视频模型", 404);
  const model = modelResult.data as VideoAdminValidationModel;
  if (model.id !== modelId) throw new VideoAdminValidationError("VIDEO_VALIDATION_MODEL_ID_MISMATCH", "模型读取结果不匹配", 503);
  return buildVideoAdminValidationContext({ model, health: healthResult.data as VideoChannelHealthRecord | null, userId });
}

export type CompletedVideoValidationProof = { validationKey: string; configurationHash: string; healthEpoch: string; clientRequestId: string };

/** Completion advances health. Verify its ORIGINAL signed epoch, while requiring today's exact configuration. */
export function authorizeCompletedVideoAdminValidationProof(context: VideoAdminValidationContext, proof: CompletedVideoValidationProof, authorization: AdminAuthorizationResult, options: { acceptedConfigurationHash?: string } = {}) {
  serverOnly();
  if (!authorization.ok || authorization.user.id !== context.userId || authorization.user.role !== "admin" || authorization.user.is_active !== true || (authorization.user.status != null && authorization.user.status !== "active")) {
    throw new VideoAdminValidationError("VIDEO_VALIDATION_ADMIN_REQUIRED", "仅当前有效管理员可验证或发布", 403);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(proof.configurationHash)) || !/^[a-f0-9]{64}$/u.test(String(proof.healthEpoch)) || !/^vav_[a-f0-9]{64}$/u.test(String(proof.validationKey)) || proof.clientRequestId !== proof.validationKey) {
    throw new VideoAdminValidationError("VIDEO_VALIDATION_PROOF_INVALID", "原验证证明不完整", 400);
  }
  if (proof.configurationHash !== (options.acceptedConfigurationHash || context.configurationHash)) throw new VideoAdminValidationError("VIDEO_VALIDATION_CONFIGURATION_CHANGED", "模型配置已变化，原验证任务不能发布当前配置");
  const expected = `vav_${createHmac("sha256", getJwtSecretString()).update(JSON.stringify({ schema: SCHEMA, userId: context.userId, modelId: context.model.id, configurationHash: proof.configurationHash, healthEpoch: proof.healthEpoch })).digest("hex")}`;
  if (!timingSafeEqual(Buffer.from(proof.validationKey), Buffer.from(expected))) throw new VideoAdminValidationError("VIDEO_VALIDATION_PROOF_INVALID", "原验证签名与管理员或模型不匹配", 403);
  if (!context.credentialReady) throw new VideoAdminValidationError("VIDEO_VALIDATION_CREDENTIAL_UNAVAILABLE", "当前模型凭据尚未就绪", 503);
  return proof;
}

type ValidationAuthorization = { ok: true; validationKey: string; configurationHash: string; healthEpoch: string }
  | { ok: false; code: string; message: string; status: number };

/** Invoke after current database administrator authorization, before the existing task reservation. */
export function authorizeVideoAdminValidation(input: {
  context: VideoAdminValidationContext;
  authorization: AdminAuthorizationResult;
  requested: boolean;
  modelId: unknown;
  validationKey: unknown;
  confirmation: unknown;
  clientRequestId: unknown;
}): ValidationAuthorization {
  const fail = (code: string, message: string, status = 409): ValidationAuthorization => ({ ok: false, code, message, status });
  const auth = input.authorization;
  if (!auth.ok) return fail(auth.code, auth.error, auth.status);
  if (auth.user.role !== "admin" || auth.user.is_active !== true || (auth.user.status != null && auth.user.status !== "active") || auth.user.id !== input.context.userId) {
    return fail("VIDEO_VALIDATION_ADMIN_REQUIRED", "仅当前有效管理员可执行该验证", 403);
  }
  if (!input.requested || input.confirmation !== VIDEO_ADMIN_VALIDATION_CONFIRMATION) return fail("VIDEO_VALIDATION_CONFIRMATION_REQUIRED", "缺少单次真实视频验证的明确确认");
  if (input.modelId !== input.context.model.id) return fail("VIDEO_VALIDATION_MODEL_MISMATCH", "验证模型与选定配置不一致");
  const received = typeof input.validationKey === "string" ? Buffer.from(input.validationKey) : Buffer.alloc(0);
  const expected = Buffer.from(input.context.validationKey);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return fail("VIDEO_VALIDATION_KEY_STALE", "验证配置、健康状态或管理员身份已变化，请重新检查；未提交任务");
  if (input.clientRequestId !== input.context.validationKey) return fail("VIDEO_VALIDATION_REQUEST_KEY_MISMATCH", "本次验证必须复用原验证键，不能另建请求键");
  if (!input.context.credentialReady) return fail("VIDEO_VALIDATION_CREDENTIAL_UNAVAILABLE", "当前模型凭据尚未就绪，未提交任务", 503);
  return { ok: true, validationKey: input.context.validationKey, configurationHash: input.context.configurationHash, healthEpoch: input.context.healthEpoch };
}

/** Explicit whitelist: never spread the server context, model, config, or raw health error. */
export function toVideoAdminValidationDto(context: VideoAdminValidationContext) {
  const row = context.model;
  const config = row.api_protocol_config && typeof row.api_protocol_config === "object" && !Array.isArray(row.api_protocol_config) ? row.api_protocol_config as Record<string, unknown> : {};
  const configuredSecret = String(row.api_key || "").trim();
  let resolvedSecret = "";
  try { resolvedSecret = resolveProviderSecret(row.api_key).trim(); } catch { /* No credential diagnostics enter the DTO. */ }
  const clean = (value: unknown, limit = 500) => {
    let text = String(value || "");
    for (const secret of [configuredSecret, resolvedSecret]) if (secret) text = text.split(secret).join("[凭据已隐藏]");
    return text.replace(/https?:\/\/\S+/gu, "[链接已隐藏]").replace(/\bBearer\s+\S+/giu, "Bearer [已隐藏]").replace(/\bsk-[A-Za-z0-9_-]+/gu, "[凭据已隐藏]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[凭据已隐藏]").slice(0, limit);
  };
  let endpointHost = "";
  try { endpointHost = new URL(String(row.api_endpoint || "")).host; } catch { /* Readiness stays explicit. */ }
  const input = getVideoInputContract(row);
  const knownSourceVideoAdapter = (row.protocol_type === "gaorui_video" && /abra_edit/u.test(String(row.model_name)))
    || (row.protocol_type === "secure_skill_flow_jobs" && /omni_video_edit/u.test(String(row.model_name)));
  const requiresSourceVideo = input.requiresSourceVideo || knownSourceVideoAdapter;
  const timing = getVideoDurationCapabilities(row);
  const output = getVideoResolutionCapabilities(row);
  const tokenBilled = config.provider_billing_unit === "token";
  const tokenPricing = tokenBilled ? getVideoTokenPublicPricing({ api_protocol_config: row.api_protocol_config }) : null;
  const activation = inspectVideoModelActivationReadiness({ id: row.id, model_name: row.model_name, provider: row.provider, protocol_type: row.protocol_type, api_endpoint: row.api_endpoint, api_key: row.api_key, api_protocol_config: row.api_protocol_config });
  const circuit = evaluateVideoChannelCircuit(context.health);
  const restrictions = [];
  if (row.is_active !== true) restrictions.push("后台配置当前停用");
  if (row.is_hidden === true) restrictions.push("后台配置当前隐藏");
  if (activation.gated && !activation.ready) restrictions.push("尚未完成模型发布验收");
  if (!context.health) restrictions.push("尚无真实健康结果，验证不会预写成功");
  else if (circuit.blocksProduction) restrictions.push("最近健康状态仍阻止普通生产提交");
  const notes = String(row.admin_notes || "");
  const restrictionEvidence = [];
  if (/quota|额度不足|额度未证实恢复/iu.test(notes)) restrictionEvidence.push("管理员备注记录了上游额度限制");
  if (/已下架|被.{1,100}替代/u.test(notes)) restrictionEvidence.push("管理员备注记录了替换或下架决定");
  if (/新协议隔离记录|真实 canary 与结果持久化证据/u.test(notes)) restrictionEvidence.push("管理员备注要求独立真实任务与持久化验收");
  if (/当前硬件|实例已更换|重新.{0,8}canary/iu.test(notes)) restrictionEvidence.push("管理员备注要求对当前算力环境重新验证");
  const resolution = output.options.slice().sort((a, b) => (output.publicPrices[a] ?? Number(row.price_per_use)) - (output.publicPrices[b] ?? Number(row.price_per_use)))[0] || output.defaultResolution || null;
  const ratios = Array.isArray(config.aspect_ratios) ? config.aspect_ratios.map(String).filter(value => /^(16:9|9:16|1:1|4:3|3:4|21:9)$/u.test(value)) : [];
  const rawMinimumPrice = output.publicPrices[resolution || ""] ?? row.price_per_use;
  const parseQuotedPrice = (value: unknown) => value == null || value === "" ? NaN : Number(value);
  const minimumUnitPrice = parseQuotedPrice(rawMinimumPrice);
  return {
    schema: context.schema, validationKey: context.validationKey, configurationHash: context.configurationHash, healthEpoch: context.healthEpoch,
    confirmation: VIDEO_ADMIN_VALIDATION_CONFIRMATION, endpoint: "/api/video/generate", localDatabaseOnly: false,
    publishEndpoint: "/api/admin/video-models/validation/publish", publishConfirmation: "PUBLISH_VALIDATED_VIDEO_MODEL",
    minimumPrice: !tokenBilled && Number.isFinite(minimumUnitPrice) && minimumUnitPrice >= 0 ? Math.round(minimumUnitPrice * (config.billing_unit === "output_second" ? timing.minDuration : 1) * 10000) / 10000 : null,
    billingUnit: tokenBilled ? "token" : config.billing_unit === "output_second" ? "output_second" : "per_use",
    ...(tokenBilled ? { tokenPricing, requiresMaxChargeYuan: true } : {}),
    administratorCharge: !tokenBilled && Number.isFinite(minimumUnitPrice) && minimumUnitPrice >= 0
      ? Math.round(minimumUnitPrice * (config.billing_unit === "output_second" ? timing.minDuration : 1) * 10000) / 10000
      : null,
    model: { id: row.id, publicId: toPublicModelId("video", row.id), displayName: clean(publicModelDisplayName(row), 180), protocol: clean(row.protocol_type, 80), upstreamModel: clean(row.model_name, 180), workflowId: config.workflow_id ? clean(config.workflow_id, 180) : null, endpointHost, active: row.is_active === true, hidden: row.is_hidden === true },
    readiness: { credentialReady: context.credentialReady, endpointConfigured: !!endpointHost, activationReady: activation.ready, healthRecorded: !!context.health, ordinaryProductionBlocked: row.is_active !== true || row.is_hidden === true || !activation.ready || circuit.blocksProduction, validationDoesNotPublish: true },
    capabilities: { ...input, requiresSourceVideo, durationMode: timing.mode, minDuration: timing.minDuration, maxDuration: timing.maxDuration, defaultDuration: timing.defaultDuration, nativeDurations: timing.nativeDurations, resolutionOptions: output.options, defaultResolution: output.defaultResolution, aspectRatios: ratios.length ? ratios : ["16:9", "9:16"] },
    minimumInput: { promptRequired: input.supportsPrompt, imageCount: Math.max(input.minReferenceImages, input.requiresFirstFrame ? 1 : 0, input.requiresLastFrame ? 2 : 0), audioCount: input.minReferenceAudios, firstFrameRequired: input.requiresFirstFrame, lastFrameRequired: input.requiresLastFrame, sourceVideoRequired: requiresSourceVideo, durationSeconds: timing.minDuration, resolution, aspectRatio: ratios.includes("16:9") || !ratios.length ? "16:9" : ratios[0], requiresComputeLifecycle: row.protocol_type === "autodl_h3_selfhost" },
    restrictions, restrictionEvidence, recentError: sanitizeVideoChannelError(context.health?.last_error),
  };
}
