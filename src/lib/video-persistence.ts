import fs from "fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";
import { validateUploadBuffer } from "@/lib/file-upload-security";
import { safeFetch } from "@/lib/safe-fetch";
import { readGaoruiVideoProviderResult, readVideoProviderResult } from "@/lib/video-provider-result";
import { downloadAndTrimVideo, removeVideoTempDir } from "@/lib/video-postprocess";
import {
  AUTODL_H3_SELFHOST_PROTOCOL,
  isAutodlH3Selfhost,
  readAutodlH3SelfhostResult,
} from "@/lib/autodl-h3-selfhost";
import {
  isAutodlComfyuiHostedProtocol,
} from "@/lib/video-autodl-comfyui-workflow";
import { isSyntheticProxyAddress } from "@/lib/extract-media-network";

const VIDEO_PROVIDER: StorageProviderType = "tencent_cos";
const OBJECT_URI_PREFIX = `object://${VIDEO_PROVIDER}/`;
export type ManagedVideoStorageScope = "autodl-h3" | "short-drama" | "model-acceptance";
export const AUTODL_HOSTED_RESULT_HOST = "codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com";
// CodeWithGPU 托管工作流的产物桶已迁移到火山 TOS；结果地址是带签名的私有桶 URL，
// 下载必须保留完整签名 query，否则 TOS 返回 403。
export const AUTODL_HOSTED_TOS_RESULT_HOST = "cg-comfyui-prod.tos-cn-beijing.volces.com";
const AUTODL_HOSTED_RESULT_HOSTS = new Set<string>([
  AUTODL_HOSTED_RESULT_HOST,
  AUTODL_HOSTED_TOS_RESULT_HOST,
]);
const videoPersistenceGlobal = globalThis as typeof globalThis & {
  __autodlH3VideoFinalizationLocks?: Set<string>;
};
const autodlH3VideoFinalizationLocks = videoPersistenceGlobal.__autodlH3VideoFinalizationLocks
  ?? (videoPersistenceGlobal.__autodlH3VideoFinalizationLocks = new Set<string>());

function managedVideoPrefix(scope: ManagedVideoStorageScope) {
  return `videos/scoped/${scope}/`;
}

function toObjectUri(key: string) {
  return `${OBJECT_URI_PREFIX}${encodeURIComponent(key)}`;
}

export function persistentVideoUriForKey(key: string) {
  const normalized = String(key || "").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("://") || /[\u0000\r\n\\]/u.test(normalized)) {
    throw new Error("PERSISTENT_VIDEO_KEY_INVALID");
  }
  return toObjectUri(normalized);
}

function toPersistentVideoUri(result: { provider: StorageProviderType; key: string; url: string }) {
  if (result.provider === VIDEO_PROVIDER) return persistentVideoUriForKey(result.key);
  if (result.provider === "local" && result.url) return result.url;
  throw new Error(`Persistent video storage is unavailable: ${result.provider}`);
}

/**
 * Hosted workflow result URLs are supplied only by the authenticated AutoDL
 * result endpoint. Keep this exception narrower than the global SSRF policy:
 * pinned HTTPS bucket hosts only, no credentials/port/fragment, and an MP4
 * path. The TOS bucket requires its presigned query; the legacy COS bucket
 * must stay query-free.
 */
export function assertAutodlHostedResultUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AUTODL_HOSTED_RESULT_URL_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("AUTODL_HOSTED_RESULT_HTTPS_REQUIRED");
  const hostname = parsed.hostname.toLowerCase();
  if (!AUTODL_HOSTED_RESULT_HOSTS.has(hostname)) {
    throw new Error("AUTODL_HOSTED_RESULT_HOST_FORBIDDEN");
  }
  if (parsed.port) throw new Error("AUTODL_HOSTED_RESULT_PORT_FORBIDDEN");
  if (parsed.username || parsed.password) throw new Error("AUTODL_HOSTED_RESULT_CREDENTIALS_FORBIDDEN");
  if (hostname === AUTODL_HOSTED_RESULT_HOST && parsed.search) throw new Error("AUTODL_HOSTED_RESULT_QUERY_FORBIDDEN");
  if (parsed.hash) throw new Error("AUTODL_HOSTED_RESULT_FRAGMENT_FORBIDDEN");
  if (!/\.mp4$/iu.test(parsed.pathname)) throw new Error("AUTODL_HOSTED_RESULT_MP4_REQUIRED");
  return parsed;
}

async function persistAutodlHostedResult(
  videoUrl: string,
  taskId: string,
  userId: string,
  providerProtocol: string,
  storageScope: ManagedVideoStorageScope,
) {
  const trustedUrl = assertAutodlHostedResultUrl(videoUrl);
  const downloaded = await safeFetch(trustedUrl, {
    maxBytes: 512 * 1024 * 1024,
    timeoutMs: 30_000,
    maxRedirects: 0,
    allowedContentTypes: ["video/mp4", "application/octet-stream"],
    trustedHostnames: [...AUTODL_HOSTED_RESULT_HOSTS],
  });
  const declaredContentType = downloaded.contentType === "application/octet-stream"
    ? "video/mp4"
    : downloaded.contentType;
  const validated = validateUploadBuffer(downloaded.buffer, declaredContentType);
  if (validated.contentType !== "video/mp4") {
    throw new Error(`AUTODL_HOSTED_RESULT_CONTENT_FORBIDDEN:${validated.contentType}`);
  }
  const result = await storageManager.upload(
    downloaded.buffer,
    `${taskId}.mp4`,
    "video/mp4",
    {
      providerType: VIDEO_PROVIDER,
      strictProvider: true,
      requireOwnershipRecord: true,
      category: "video",
      prefix: managedVideoPrefix(storageScope),
      fileName: `${taskId}.mp4`,
      userId,
      source: "video-generation",
      meta: { taskId, providerProtocol },
    },
  );
  return toPersistentVideoUri(result);
}

export function isPersistentVideoUri(value: string) {
  return value.startsWith(OBJECT_URI_PREFIX);
}

export function requireStableVideoStorageUrl(value: string, providerProtocol?: string) {
  const requiresStableObject = isAutodlH3Selfhost(providerProtocol)
    || isAutodlComfyuiHostedProtocol(providerProtocol);
  if (requiresStableObject && !isPersistentVideoUri(value)) {
    throw new Error("AutoDL H3 视频未获得稳定对象存储地址");
  }
  return value;
}

/**
 * Single-process guard shared by the status and SSE route modules. Database
 * state remains the durable terminal gate; this guard only prevents two local
 * recovery requests from persisting and settling the same H3 result together.
 */
export async function withAutodlH3VideoFinalizationLock<T>(
  taskId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lockKey = String(taskId || "").trim();
  if (!lockKey || autodlH3VideoFinalizationLocks.has(lockKey)) return { acquired: false };
  autodlH3VideoFinalizationLocks.add(lockKey);
  try {
    return { acquired: true, value: await operation() };
  } finally {
    autodlH3VideoFinalizationLocks.delete(lockKey);
  }
}

export async function resolvePersistentVideoUri(value: string) {
  if (!isPersistentVideoUri(value)) return value;
  const key = decodeURIComponent(value.slice(OBJECT_URI_PREFIX.length));
  return storageManager.getSignedUrl(key, { expireTime: 3600 }, VIDEO_PROVIDER);
}

export async function persistVideoFile(
  filePath: string,
  taskId: string,
  userId: string,
  storageScope: ManagedVideoStorageScope,
) {
  if (!fs.existsSync(filePath)) return "";
  const result = await storageManager.upload(
    fs.readFileSync(filePath),
    `${taskId}.mp4`,
    "video/mp4",
    {
      providerType: VIDEO_PROVIDER,
      strictProvider: true,
      requireOwnershipRecord: true,
      category: "video",
      prefix: managedVideoPrefix(storageScope),
      fileName: `${taskId}.mp4`,
      userId,
      source: "video-generation",
      meta: { taskId },
    },
  );
  return toPersistentVideoUri(result);
}

export async function persistVideoFromUrl(
  videoUrl: string,
  taskId: string,
  userId: string,
  options: {
    storageScope: ManagedVideoStorageScope;
    trimDurationSeconds?: number;
    sourceDurationSeconds?: number;
    providerProtocol?: string;
    providerEndpoint?: string;
    providerApiKey?: string;
    providerTaskId?: string;
    trustedProviderResultHostname?: string;
  },
) {
  const trimDuration = Number(options?.trimDurationSeconds || 0);
  const sourceDuration = Number(options?.sourceDurationSeconds || 0);
  if (trimDuration > 0 && sourceDuration > trimDuration) {
    if (isAutodlH3Selfhost(options?.providerProtocol)) {
      throw new Error("AutoDL H3 自租协议只允许原生 5/10/15 秒，本地裁切未启用");
    }
    const { outputPath, tempDir } = await downloadAndTrimVideo(videoUrl, trimDuration);
    try {
      return await persistVideoFile(outputPath, taskId, userId, options.storageScope);
    } finally {
      await removeVideoTempDir(tempDir);
    }
  }
  if (isAutodlH3Selfhost(options?.providerProtocol)) {
    const providerEndpoint = String(options?.providerEndpoint || "");
    const media = await readAutodlH3SelfhostResult(videoUrl, providerEndpoint, {
      maxBytes: 512 * 1024 * 1024,
      timeoutMs: 5 * 60_000,
      allowedContentTypes: ["video/mp4"],
    });
    const result = await storageManager.upload(
      media.buffer,
      `${taskId}.mp4`,
      media.contentType,
      {
        providerType: VIDEO_PROVIDER,
        strictProvider: true,
        requireOwnershipRecord: true,
        category: "video",
        prefix: managedVideoPrefix(options.storageScope),
        fileName: `${taskId}.mp4`,
        userId,
        source: "video-generation",
        meta: { taskId, providerProtocol: AUTODL_H3_SELFHOST_PROTOCOL },
      },
    );
    return toPersistentVideoUri(result);
  }
  if (isAutodlComfyuiHostedProtocol(options?.providerProtocol)) {
    return persistAutodlHostedResult(
      videoUrl,
      taskId,
      userId,
      String(options?.providerProtocol || ""),
      options.storageScope,
    );
  }
  if (["suanlicheng_video", "gaorui_video"].includes(String(options?.providerProtocol))) {
    const media = options?.providerProtocol === "gaorui_video"
      ? await readGaoruiVideoProviderResult({ resultUrl: videoUrl, providerEndpoint: String(options.providerEndpoint || ""), providerApiKey: String(options.providerApiKey || ""), providerTaskId: options.providerTaskId, trustedProviderResultHostname: options.trustedProviderResultHostname })
      : await readVideoProviderResult(videoUrl, String(options?.providerEndpoint || ""), String(options?.providerApiKey || ""));
    const result = await storageManager.upload(media.buffer, `${taskId}.mp4`, media.contentType, {
      providerType: VIDEO_PROVIDER,
      strictProvider: true,
      requireOwnershipRecord: true,
      category: "video",
      prefix: managedVideoPrefix(options.storageScope),
      fileName: `${taskId}.mp4`,
      userId,
      source: "video-generation",
      meta: { taskId, providerProtocol: String(options?.providerProtocol || "") },
    });
    return toPersistentVideoUri(result);
  }
  let networkOptions: { networkPolicy: "default" | "system-dns-pinned"; trustedHostnames?: string[] } = {
    networkPolicy: "system-dns-pinned",
  };
  const trustedHostname = String(options?.trustedProviderResultHostname || "").trim().toLowerCase();
  if (trustedHostname) {
    let parsed: URL | null = null;
    try { parsed = new URL(videoUrl); } catch { /* safeFetch returns the public error. */ }
    if (parsed?.protocol === "https:" && parsed.hostname.toLowerCase() === trustedHostname && !parsed.port && !parsed.username && !parsed.password) {
      try {
        const addresses = await dnsLookup(trustedHostname, { all: true, verbatim: true });
        if (addresses.length > 0 && addresses.every(({ address }) => isSyntheticProxyAddress(address))) {
          networkOptions = { networkPolicy: "default", trustedHostnames: [trustedHostname] };
        }
      } catch { /* Fall through to pinned system DNS and fail closed. */ }
    }
  }
  const downloaded = await safeFetch(videoUrl, {
    maxBytes: 512 * 1024 * 1024,
    timeoutMs: 5 * 60_000,
    maxRedirects: 3,
    allowedContentTypes: ["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"],
    ...networkOptions,
  });
  const declaredContentType = downloaded.contentType === "application/octet-stream"
    ? "video/mp4"
    : downloaded.contentType;
  const validated = validateUploadBuffer(downloaded.buffer, declaredContentType);
  if (!validated.contentType.startsWith("video/")) {
    throw new Error(`VIDEO_RESULT_CONTENT_FORBIDDEN:${validated.contentType}`);
  }
  const result = await storageManager.upload(
    downloaded.buffer,
    `${taskId}.${validated.extension}`,
    validated.contentType,
    {
      providerType: VIDEO_PROVIDER,
      strictProvider: true,
      requireOwnershipRecord: true,
      category: "video",
      prefix: managedVideoPrefix(options.storageScope),
      fileName: `${taskId}.${validated.extension}`,
      userId,
      source: "video-generation",
      meta: { taskId },
    },
  );
  return toPersistentVideoUri(result);
}

/** H3 may become terminal only after this returns a durable object URI. */
export async function persistStableVideoFromUrl(
  videoUrl: string,
  taskId: string,
  userId: string,
  options: {
    storageScope: ManagedVideoStorageScope;
    trimDurationSeconds?: number;
    sourceDurationSeconds?: number;
    providerProtocol?: string;
    providerEndpoint?: string;
    providerApiKey?: string;
    providerTaskId?: string;
    trustedProviderResultHostname?: string;
  },
) {
  const storageUrl = await persistVideoFromUrl(videoUrl, taskId, userId, options);
  return requireStableVideoStorageUrl(storageUrl, options?.providerProtocol);
}
