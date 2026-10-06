import { createHash } from "node:crypto";
import {
  AUTODL_H3_VIDEO_RESOLUTION_LABELS,
  AUTODL_H3_VIDEO_RESOLUTION_TIERS,
  type AutodlH3VideoResolutionTier,
} from "./autodl-h3-activation-profile";

export const AUTODL_H3_SELFHOST_PROTOCOL = "autodl_h3_selfhost";
export const AUTODL_H3_SELFHOST_PROVIDER = "autodl_h3_selfhost";
export const AUTODL_H3_SELFHOST_SECRET_REF = "secret://autodl-h3-selfhost";
export const AUTODL_H3_SELFHOST_GATEWAY_ORIGIN = "http://127.0.0.1:16011";
export const AUTODL_H3_SELFHOST_IMAGE_ENDPOINT = `${AUTODL_H3_SELFHOST_GATEWAY_ORIGIN}/v1`;
export const AUTODL_H3_SELFHOST_VIDEO_ENDPOINT = `${AUTODL_H3_SELFHOST_GATEWAY_ORIGIN}/v1/video/generations`;
export const AUTODL_H3_SELFHOST_IMAGE_MODEL = "qwen-image-2512-hq";
export const AUTODL_H3_SELFHOST_VIDEO_MODEL = "minimax-h3-turbo";
export const AUTODL_H3_SELFHOST_IMAGE_VERIFIED_RESOLUTION = "2K";
export const AUTODL_H3_SELFHOST_IMAGE_VERIFIED_ASPECT_RATIOS = ["16:9"] as const;
export const AUTODL_H3_SELFHOST_IMAGE_VERIFIED_REQUEST_PIXEL_SIZES = {
  "16:9": "1280x720",
} as const;
export const AUTODL_H3_SELFHOST_IMAGE_VERIFIED_OUTPUT_PIXEL_SIZES = {
  "16:9": "3640x2048",
} as const;

const AUTODL_H3_SELFHOST_IMAGE_STORAGE_ROOT = "image-workbench/autodl-h3-selfhost/";

const RESULT_PATH_RE = /^\/v1\/files\/([A-Za-z0-9_-]+)$/u;
const RESULT_SIGNATURE_RE = /^[a-f0-9]{64}$/u;
const RESULT_URL_MAX_TTL_SECONDS = 60 * 60;

const VIDEO_PIXEL_SIZES: Record<string, string> = {
  "16:9": "864x480",
  "9:16": "480x864",
  "1:1": "768x768",
};

const IMAGE_PIXEL_SIZES: Record<string, string> = {
  "16:9": "1280x720",
  "9:16": "720x1280",
  "1:1": "1024x1024",
};

export function isAutodlH3Selfhost(value: unknown) {
  return String(value || "").trim() === AUTODL_H3_SELFHOST_PROTOCOL;
}

function involvesAutodlH3Selfhost(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.includes("autodl_h3_selfhost") || normalized.includes("autodl-h3-selfhost");
}

export function assertAutodlH3SelfhostModelBinding(options: {
  kind: "image" | "video" | "text";
  provider: unknown;
  protocolType?: unknown;
  modelName: unknown;
  apiEndpoint: unknown;
  apiKey: unknown;
}) {
  const provider = String(options.provider || "").trim();
  const protocolType = String(options.protocolType || "").trim();
  const apiKey = String(options.apiKey || "").trim();
  const involvesH3 = involvesAutodlH3Selfhost(provider)
    || involvesAutodlH3Selfhost(protocolType)
    || involvesAutodlH3Selfhost(apiKey);
  if (!involvesH3) return false;

  if (options.kind === "text") {
    throw new Error("AutoDL H3 自租密钥只能绑定生图或视频模型");
  }
  if (provider !== AUTODL_H3_SELFHOST_PROVIDER || apiKey !== AUTODL_H3_SELFHOST_SECRET_REF) {
    throw new Error("AutoDL H3 自租供应商与密钥引用必须成对使用固定值");
  }
  if (options.kind === "video" && protocolType !== AUTODL_H3_SELFHOST_PROTOCOL) {
    throw new Error("AutoDL H3 自租视频协议必须与独立密钥引用成对使用固定值");
  }

  const expectedModel = options.kind === "image"
    ? AUTODL_H3_SELFHOST_IMAGE_MODEL
    : AUTODL_H3_SELFHOST_VIDEO_MODEL;
  if (String(options.modelName || "").trim() !== expectedModel) {
    throw new Error(`AutoDL H3 自租${options.kind === "image" ? "生图" : "视频"}模型必须为系统固定值`);
  }

  if (options.kind === "image") {
    autodlH3SelfhostImageEndpoint(String(options.apiEndpoint || ""));
  } else {
    autodlH3SelfhostVideoEndpoint(String(options.apiEndpoint || ""));
  }
  return true;
}

export function autodlH3SelfhostImageStoragePrefix(userId: string) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) throw new Error("AutoDL H3 自租生图存储缺少用户标识");
  const userScope = createHash("sha256").update(normalizedUserId).digest("hex").slice(0, 24);
  return `${AUTODL_H3_SELFHOST_IMAGE_STORAGE_ROOT}${userScope}/`;
}

export function isOwnedAutodlH3SelfhostImageStorageKey(key: unknown, userId: string) {
  const normalizedKey = String(key || "").trim();
  const prefix = autodlH3SelfhostImageStoragePrefix(userId);
  if (!normalizedKey.startsWith(prefix)) return false;
  const relativeKey = normalizedKey.slice(prefix.length);
  return /^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]{8,128}\.(?:png|jpe?g|webp)$/u.test(relativeKey);
}

export function autodlH3SelfhostGatewayOrigin(apiEndpoint: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(String(apiEndpoint || "").trim());
  } catch {
    throw new Error("AutoDL H3 自租网关地址无效");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("AutoDL H3 自租网关地址不允许凭据、查询参数或片段");
  }
  if (endpoint.origin !== AUTODL_H3_SELFHOST_GATEWAY_ORIGIN) {
    throw new Error("AutoDL H3 自租内测网关只允许固定回环端点 127.0.0.1:16011");
  }
  return AUTODL_H3_SELFHOST_GATEWAY_ORIGIN;
}

export function autodlH3SelfhostImageEndpoint(apiEndpoint: string) {
  autodlH3SelfhostGatewayOrigin(apiEndpoint);
  const endpoint = new URL(apiEndpoint);
  if (endpoint.pathname !== "/v1") {
    throw new Error("AutoDL H3 自租生图地址必须为固定 /v1 端点");
  }
  return AUTODL_H3_SELFHOST_IMAGE_ENDPOINT;
}

export function autodlH3SelfhostVideoEndpoint(apiEndpoint: string) {
  autodlH3SelfhostGatewayOrigin(apiEndpoint);
  const endpoint = new URL(apiEndpoint);
  if (endpoint.pathname !== "/v1/video/generations") {
    throw new Error("AutoDL H3 自租视频地址必须为固定 /v1/video/generations 端点");
  }
  return AUTODL_H3_SELFHOST_VIDEO_ENDPOINT;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeAutodlH3VideoResolutionTier(value: unknown): AutodlH3VideoResolutionTier | "" {
  const normalized = String(value || "").trim();
  for (const tier of AUTODL_H3_VIDEO_RESOLUTION_TIERS) {
    if (normalized === tier || normalized === AUTODL_H3_VIDEO_RESOLUTION_LABELS[tier]) return tier;
  }
  return "";
}

function configuredVideoResolutionTiers(config: unknown): AutodlH3VideoResolutionTier[] {
  const source = objectValue(config);
  const raw = Array.isArray(source.resolution_options) ? source.resolution_options : ["480p"];
  const tiers = raw.map(normalizeAutodlH3VideoResolutionTier).filter(Boolean) as AutodlH3VideoResolutionTier[];
  return [...new Set(tiers.length > 0 ? tiers : ["480p"] as AutodlH3VideoResolutionTier[])];
}

function configuredPixelSize(
  config: unknown,
  field: "input_pixel_size_by_resolution" | "output_pixel_size_by_resolution",
  tier: AutodlH3VideoResolutionTier,
  aspectRatio: string,
): string {
  const source = objectValue(config);
  const byResolution = objectValue(source[field]);
  const byAspect = objectValue(byResolution[tier]);
  const configured = String(byAspect[aspectRatio] || "").trim().toLowerCase();
  if (configured) {
    if (!/^\d{2,4}x\d{2,4}$/u.test(configured)) {
      throw new Error(`AutoDL H3 自租 ${field} 配置无效`);
    }
    return configured;
  }
  if (tier === "480p") {
    const legacy = String(objectValue(source.pixel_size_by_aspect_ratio)[aspectRatio] || "").trim().toLowerCase();
    if (legacy) return legacy;
    return VIDEO_PIXEL_SIZES[aspectRatio] || "";
  }
  return "";
}

export function autodlH3VideoPixelSize(
  aspectRatio: string,
  resolutionTier: unknown = "480p",
  protocolConfig?: unknown,
) {
  const normalizedAspectRatio = String(aspectRatio || "16:9");
  const tier = normalizeAutodlH3VideoResolutionTier(resolutionTier || "480p");
  if (!tier) throw new Error("AutoDL H3 自租视频分辨率档无效");
  if (!configuredVideoResolutionTiers(protocolConfig).includes(tier)) {
    throw new Error(`AutoDL H3 自租视频尚未启用 ${AUTODL_H3_VIDEO_RESOLUTION_LABELS[tier]}`);
  }
  const size = configuredPixelSize(protocolConfig, "input_pixel_size_by_resolution", tier, normalizedAspectRatio);
  if (!size) throw new Error("AutoDL H3 自租视频仅支持 16:9、9:16、1:1");
  return size;
}

export function autodlH3VideoOutputTier(resolutionTier: unknown, protocolConfig?: unknown) {
  const tier = normalizeAutodlH3VideoResolutionTier(resolutionTier || "480p");
  if (!tier) throw new Error("AutoDL H3 自租视频分辨率档无效");
  if (!configuredVideoResolutionTiers(protocolConfig).includes(tier)) {
    throw new Error(`AutoDL H3 自租视频尚未启用 ${AUTODL_H3_VIDEO_RESOLUTION_LABELS[tier]}`);
  }
  const configured = String(objectValue(objectValue(protocolConfig).gateway_output_tier_by_resolution)[tier] || "").trim();
  const expected = tier === "480p" ? "base" : tier;
  if (configured && configured !== expected) throw new Error("AutoDL H3 自租增强档网关映射无效");
  return configured || expected;
}

export function autodlH3VideoOutputPixelSize(
  aspectRatio: string,
  resolutionTier: unknown = "480p",
  protocolConfig?: unknown,
) {
  const normalizedAspectRatio = String(aspectRatio || "16:9");
  const tier = normalizeAutodlH3VideoResolutionTier(resolutionTier || "480p");
  if (!tier) throw new Error("AutoDL H3 自租视频分辨率档无效");
  if (!configuredVideoResolutionTiers(protocolConfig).includes(tier)) {
    throw new Error(`AutoDL H3 自租视频尚未启用 ${AUTODL_H3_VIDEO_RESOLUTION_LABELS[tier]}`);
  }
  const configured = configuredPixelSize(protocolConfig, "output_pixel_size_by_resolution", tier, normalizedAspectRatio);
  if (configured) return configured;
  return autodlH3VideoPixelSize(normalizedAspectRatio, tier, protocolConfig);
}

export function autodlH3ImagePixelSize(aspectRatio: string) {
  const size = IMAGE_PIXEL_SIZES[String(aspectRatio || "16:9")];
  if (!size) throw new Error("AutoDL H3 自租生图仅支持 16:9、9:16、1:1");
  return size;
}

export function resolveAutodlH3SelfhostResultUrl(rawUrl: string, apiEndpoint: string) {
  const origin = autodlH3SelfhostGatewayOrigin(apiEndpoint);
  let result: URL;
  try {
    result = new URL(String(rawUrl || "").trim(), `${origin}/`);
  } catch {
    throw new Error("AutoDL H3 自租网关返回了无效结果地址");
  }
  if (result.origin !== origin) {
    throw new Error("AutoDL H3 自租网关结果地址跨域，已拒绝取件");
  }
  if (result.username || result.password || result.hash) {
    throw new Error("AutoDL H3 自租网关结果地址含不允许的凭据或片段");
  }
  if (!RESULT_PATH_RE.test(result.pathname)) {
    throw new Error("AutoDL H3 自租网关结果路径不在允许范围");
  }
  const expiresValues = result.searchParams.getAll("expires");
  const signatureValues = result.searchParams.getAll("sig");
  if (expiresValues.length !== 1 || signatureValues.length !== 1 || [...result.searchParams].length !== 2) {
    throw new Error("AutoDL H3 自租网关结果签名不完整");
  }
  const expiresRaw = expiresValues[0];
  const signature = signatureValues[0];
  if (!/^\d+$/u.test(expiresRaw) || !RESULT_SIGNATURE_RE.test(signature)) {
    throw new Error("AutoDL H3 自租网关结果签名格式无效");
  }
  const expires = Number(expiresRaw);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + RESULT_URL_MAX_TTL_SECONDS) {
    throw new Error("AutoDL H3 自租网关结果签名已过期或有效期不合理");
  }
  return result.toString();
}

export function autodlH3SelfhostJobStatusEndpointFromResultUrl(rawUrl: string, apiEndpoint: string) {
  const normalized = new URL(resolveAutodlH3SelfhostResultUrl(rawUrl, apiEndpoint));
  const jobId = normalized.pathname.match(RESULT_PATH_RE)?.[1] || "";
  if (!jobId) throw new Error("AutoDL H3 自租结果地址缺少任务标识");
  return `${autodlH3SelfhostGatewayOrigin(apiEndpoint)}/v1/jobs/${encodeURIComponent(jobId)}`;
}

export function isAmbiguousAutodlH3SelfhostTransportError(error: unknown) {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { name?: unknown; message?: unknown; code?: unknown };
  } | null;
  const summary = [
    candidate?.name,
    candidate?.message,
    candidate?.code,
    candidate?.cause?.name,
    candidate?.cause?.message,
    candidate?.cause?.code,
  ].map((value) => String(value || "")).join(" ");
  return /TimeoutError|AbortError|timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT/iu.test(summary);
}

export async function recoverAutodlH3SelfhostCompletedImageResultUrl(
  rawUrl: string,
  apiEndpoint: string,
  apiKey: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
) {
  const credential = String(apiKey || "").trim();
  if (!credential) throw new Error("AutoDL H3 自租结果恢复缺少网关凭据");
  const statusUrl = autodlH3SelfhostJobStatusEndpointFromResultUrl(rawUrl, apiEndpoint);
  const response = await (options.fetchImpl || fetch)(statusUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${credential}` },
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AutoDL H3 自租结果恢复禁止重定向");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`AutoDL H3 自租结果恢复查询失败 (${response.status})`);
  }
  const payload = await response.json() as {
    object?: unknown;
    model?: unknown;
    status?: unknown;
    data?: Array<{ url?: unknown }>;
  };
  if (payload.object !== "image.generation" || payload.model !== AUTODL_H3_SELFHOST_IMAGE_MODEL) {
    throw new Error("AutoDL H3 自租结果恢复返回了不匹配的任务");
  }
  if (payload.status !== "completed") {
    throw new Error(`AutoDL H3 自租结果恢复时任务尚未完成 (${String(payload.status || "unknown")})`);
  }
  const recoveredUrl = payload.data?.find((item) => typeof item?.url === "string")?.url;
  if (typeof recoveredUrl !== "string" || !recoveredUrl) {
    throw new Error("AutoDL H3 自租已完成任务未返回结果地址");
  }
  return resolveAutodlH3SelfhostResultUrl(recoveredUrl, apiEndpoint);
}

export function redactAutodlH3SelfhostResultUrl(rawUrl: string, apiEndpoint: string) {
  try {
    const normalized = new URL(resolveAutodlH3SelfhostResultUrl(rawUrl, apiEndpoint));
    return `${normalized.origin}${normalized.pathname}?signed=redacted`;
  } catch {
    return "autodl-h3-selfhost-result:invalid";
  }
}

export async function fetchAutodlH3SelfhostResult(
  rawUrl: string,
  apiEndpoint: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const normalizedUrl = resolveAutodlH3SelfhostResultUrl(rawUrl, apiEndpoint);
  const { timeoutMs = 300_000, signal } = init;
  const response = await fetch(normalizedUrl, {
    method: "GET",
    redirect: "manual",
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AutoDL H3 自租结果取件禁止重定向");
  }
  return { response, finalUrl: normalizedUrl };
}

export async function readAutodlH3SelfhostResult(
  rawUrl: string,
  apiEndpoint: string,
  options: { maxBytes: number; allowedContentTypes: string[]; timeoutMs?: number },
) {
  const { response, finalUrl } = await fetchAutodlH3SelfhostResult(rawUrl, apiEndpoint, {
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`AutoDL H3 自租结果取件失败 (${response.status})`);
  }
  const contentType = (response.headers.get("content-type") || "application/octet-stream")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!options.allowedContentTypes.some((allowed) => contentType === allowed || (allowed.endsWith("/*") && contentType.startsWith(allowed.slice(0, -1))))) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`AutoDL H3 自租结果类型不受支持: ${contentType}`);
  }
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AutoDL H3 自租结果超过大小限制");
  }
  if (!response.body) throw new Error("AutoDL H3 自租结果为空");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > options.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("AutoDL H3 自租结果超过大小限制");
    }
    chunks.push(value);
  }
  return { buffer: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), contentType, finalUrl };
}
