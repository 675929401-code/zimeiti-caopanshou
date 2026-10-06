import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { getJwtSecretString } from "@/lib/auth";
import { createSignedExtractLocalVideoParams, createSignedExtractTemporaryVideoParams } from "@/lib/extract-download-signature";
import { temporaryExtractMediaNetworkOptions } from "@/lib/extract-media-network";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { safeFetch } from "@/lib/safe-fetch";

const FILE_HASH_PATTERN = /^[a-f\d]{24}$/u;
const CACHE_FILE_PATTERN = /^video_[a-f\d]{24}\.mp4$/u;
const CACHE_PART_PATTERN = /^video_[a-f\d]{24}\.mp4\.[a-f\d-]+\.part$/u;
const CACHE_RETENTION_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
let lastCleanupAt = 0;

export function resolveExtractLocalVideoCacheDir(): string {
  const configured = process.env.EXTRACT_LOCAL_VIDEO_CACHE_DIR?.trim();
  if (configured) {
    if (process.env.NODE_ENV === "production" && !path.isAbsolute(configured)) {
      throw new Error("EXTRACT_LOCAL_VIDEO_CACHE_DIR must be absolute in production");
    }
    return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  }
  return path.join(/* turbopackIgnore: true */ resolveAppRuntimeDir(), "extract-videos");
}

function videoCacheHash(videoUrl: string): string {
  return createHmac("sha256", getJwtSecretString())
    .update(videoUrl)
    .digest("hex")
    .slice(0, 24);
}

function configuredPublicOrigin(): string {
  const configured = process.env.COZE_PROJECT_DOMAIN_DEFAULT?.trim();
  if (!configured) {
    throw new Error("COZE_PROJECT_DOMAIN_DEFAULT is required for provider media pickup");
  }
  const candidate = /^https?:\/\//iu.test(configured) ? configured : `https://${configured}`;
  const parsed = new URL(candidate);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("COZE_PROJECT_DOMAIN_DEFAULT must be a public HTTP(S) origin");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname)) {
    throw new Error("COZE_PROJECT_DOMAIN_DEFAULT cannot be a loopback origin");
  }
  if ((process.env.NODE_ENV === "production" || process.env.COZE_PROJECT_ENV === "PROD") && parsed.protocol !== "https:") {
    throw new Error("COZE_PROJECT_DOMAIN_DEFAULT must use HTTPS in production");
  }
  return parsed.origin;
}

export function isExtractLocalVideoHash(value: string): boolean {
  return FILE_HASH_PATTERN.test(value);
}

export function resolveExtractLocalVideoPath(fileHash: string): string {
  if (!isExtractLocalVideoHash(fileHash)) throw new Error("Invalid extract local video hash");
  return path.join(/* turbopackIgnore: true */ resolveExtractLocalVideoCacheDir(), `video_${fileHash}.mp4`);
}

async function cleanupExpiredCache(now = Date.now()): Promise<void> {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  const cacheDirectory = resolveExtractLocalVideoCacheDir();
  let entries: string[];
  try {
    entries = await readdir(/* turbopackIgnore: true */ cacheDirectory);
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => CACHE_FILE_PATTERN.test(entry) || CACHE_PART_PATTERN.test(entry)).map(async (entry) => {
    const target = path.join(/* turbopackIgnore: true */ cacheDirectory, entry);
    try {
      const fileStat = await stat(target);
      if (now - fileStat.mtimeMs > CACHE_RETENTION_MS) await unlink(target);
    } catch {
      // A concurrent request may already have removed the expired file.
    }
  }));
}

async function ensureCachedVideoFile(
  parsed: URL,
  fileHash: string,
  options: { systemDnsPinned?: boolean; renewOnReuse?: boolean } = {},
): Promise<{ fileHash: string; expiresAt: number }> {
  await mkdir(/* turbopackIgnore: true */ resolveExtractLocalVideoCacheDir(), { recursive: true });
  void cleanupExpiredCache();

  const filePath = resolveExtractLocalVideoPath(fileHash);
  const usable = async () => {
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size < 1_000 || fileStat.size > MAX_VIDEO_BYTES) return null;
      let expiresAt = Math.floor(fileStat.mtimeMs + CACHE_RETENTION_MS);
      if (options.renewOnReuse && expiresAt > Date.now() + 60_000) {
        const renewedAt = new Date();
        await utimes(filePath, renewedAt, renewedAt);
        expiresAt = renewedAt.getTime() + CACHE_RETENTION_MS;
      }
      return expiresAt > Date.now() + 60_000 ? { fileHash, expiresAt } : null;
    } catch {
      return null;
    }
  };

  let current = await usable();
  if (current) return current;
  await unlink(filePath).catch(() => undefined);

  const networkOptions = options.systemDnsPinned
    ? await temporaryExtractMediaNetworkOptions(parsed)
    : {};
  const downloaded = await safeFetch(parsed, {
    ...networkOptions,
    timeoutMs: 120_000,
    maxBytes: MAX_VIDEO_BYTES,
    maxRedirects: 4,
    allowedContentTypes: ["video/*", "application/octet-stream", "binary/octet-stream"],
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.douyin.com/",
      Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5",
      "Accept-Encoding": "identity",
    },
  });
  if (downloaded.buffer.byteLength < 1_000) throw new Error("EXTRACTION_VIDEO_CACHE_EMPTY");

  const temporaryPath = `${filePath}.${randomUUID()}.part`;
  await writeFile(temporaryPath, downloaded.buffer, { flag: "wx" });
  try {
    current = await usable();
    if (current) {
      await unlink(temporaryPath);
      return current;
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    current = await usable();
    if (current) return current;
    throw error;
  }

  current = await usable();
  if (!current) throw new Error("EXTRACTION_VIDEO_CACHE_UNUSABLE");
  return current;
}

function signedPickupUrl(fileHash: string, publicOrigin: string): string {
  const signed = createSignedExtractLocalVideoParams(fileHash);
  const query = new URLSearchParams({ file: fileHash, expires: signed.expires, sig: signed.sig });
  return `${publicOrigin}/api/extract/local-video?${query.toString()}`;
}

export async function cacheExtractVideoForProvider(videoUrl: string): Promise<string | null> {
  try {
    const parsed = new URL(videoUrl);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    const publicOrigin = configuredPublicOrigin();
    const fileHash = videoCacheHash(parsed.toString());
    await ensureCachedVideoFile(parsed, fileHash);

    return signedPickupUrl(fileHash, publicOrigin);
  } catch (error) {
    console.error("[Extract] provider video cache failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function cacheExtractVideoForTemporaryOwner(
  videoUrl: string,
  ownerId: string,
): Promise<{ fileHash: string; temporaryUrl: string; expiresAt: number }> {
  const normalizedOwner = ownerId.trim();
  if (!normalizedOwner || normalizedOwner.length > 160) throw new Error("EXTRACTION_VIDEO_OWNER_INVALID");
  const parsed = new URL(videoUrl);
  if (!/^https?:$/u.test(parsed.protocol)) throw new Error("EXTRACTION_VIDEO_SOURCE_INVALID");

  const fileHash = createHmac("sha256", getJwtSecretString())
    .update(`temporary-owner:${normalizedOwner}\u0000${parsed.toString()}`)
    .digest("hex")
    .slice(0, 24);
  const staged = await ensureCachedVideoFile(parsed, fileHash, {
    systemDnsPinned: true,
    renewOnReuse: true,
  });
  const signed = createSignedExtractTemporaryVideoParams(
    fileHash,
    normalizedOwner,
    Math.max(60_000, staged.expiresAt - Date.now()),
  );
  const query = new URLSearchParams({
    file: fileHash,
    owner: normalizedOwner,
    expires: signed.expires,
    sig: signed.sig,
  });
  return {
    fileHash,
    temporaryUrl: `/api/extract/local-video?${query.toString()}`,
    expiresAt: staged.expiresAt,
  };
}
