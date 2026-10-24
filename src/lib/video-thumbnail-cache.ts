import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const CACHE_FILE_PATTERN = /^[a-zA-Z0-9_-]+\.jpg$/u;
const DEFAULT_TTL_MS = 5 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export type VideoThumbnailCachePolicy = {
  ttlMs: number;
  maxFiles: number;
  maxBytes: number;
  pruneIntervalMs: number;
};

export type VideoThumbnailCachePruneReport = {
  scannedFiles: number;
  removedFiles: number;
  removedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
  skippedEntries: number;
  failedEntries: number;
  rootStatus: "ready" | "missing" | "not-directory" | "symbolic-link" | "unavailable";
};

type CacheCandidate = {
  filePath: string;
  name: string;
  size: number;
  mtimeMs: number;
  protected: boolean;
};

type MaintenanceState = {
  nextPruneAt: number;
  job?: Promise<void>;
};

const maintenanceGlobal = globalThis as typeof globalThis & {
  __videoThumbnailCacheMaintenance?: MaintenanceState;
};
const maintenanceState = maintenanceGlobal.__videoThumbnailCacheMaintenance
  ?? (maintenanceGlobal.__videoThumbnailCacheMaintenance = { nextPruneAt: 0 });

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (!value || !/^\d+$/u.test(value.trim())) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function readVideoThumbnailCachePolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VideoThumbnailCachePolicy {
  return {
    ttlMs: positiveInteger(env.VIDEO_THUMBNAIL_CACHE_TTL_MS, DEFAULT_TTL_MS, 365 * 24 * 60 * 60 * 1000),
    maxFiles: positiveInteger(env.VIDEO_THUMBNAIL_CACHE_MAX_FILES, DEFAULT_MAX_FILES, 100_000),
    maxBytes: positiveInteger(env.VIDEO_THUMBNAIL_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES, 100 * 1024 * 1024 * 1024),
    pruneIntervalMs: positiveInteger(
      env.VIDEO_THUMBNAIL_CACHE_PRUNE_INTERVAL_MS,
      DEFAULT_PRUNE_INTERVAL_MS,
      24 * 60 * 60 * 1000,
    ),
  };
}

function normalizedCacheRoot(cacheRoot: string): string {
  const resolved = path.resolve(cacheRoot);
  if (resolved === path.parse(resolved).root) {
    throw new Error("VIDEO_THUMBNAIL_CACHE_ROOT_TOO_BROAD");
  }
  return resolved;
}

export function resolveVideoThumbnailCacheFile(cacheRoot: string, taskId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(taskId)) {
    throw new Error("VIDEO_THUMBNAIL_CACHE_TASK_ID_INVALID");
  }
  const root = normalizedCacheRoot(cacheRoot);
  const candidate = path.resolve(root, `${taskId}.jpg`);
  if (path.dirname(candidate) !== root) {
    throw new Error("VIDEO_THUMBNAIL_CACHE_PATH_OUTSIDE_ROOT");
  }
  return candidate;
}

async function ensureCacheRoot(cacheRoot: string): Promise<string> {
  const root = normalizedCacheRoot(cacheRoot);
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("VIDEO_THUMBNAIL_CACHE_ROOT_UNSAFE");
  }
  return root;
}

export async function readVideoThumbnailCacheFile(
  cacheRoot: string,
  taskId: string,
  ttlMs: number,
  now = Date.now(),
): Promise<Buffer | null> {
  const root = normalizedCacheRoot(cacheRoot);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
    const filePath = resolveVideoThumbnailCacheFile(root, taskId);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || now - info.mtimeMs > ttlMs) return null;
    const handle = await open(filePath, "r");
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile()) return null;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function writeVideoThumbnailCacheFile(
  cacheRoot: string,
  taskId: string,
  thumbnail: Buffer,
): Promise<string> {
  const root = await ensureCacheRoot(cacheRoot);
  const filePath = resolveVideoThumbnailCacheFile(root, taskId);
  const temporaryPath = path.join(root, `.${taskId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, thumbnail, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
    return filePath;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function emptyReport(
  rootStatus: VideoThumbnailCachePruneReport["rootStatus"],
): VideoThumbnailCachePruneReport {
  return {
    scannedFiles: 0,
    removedFiles: 0,
    removedBytes: 0,
    remainingFiles: 0,
    remainingBytes: 0,
    skippedEntries: 0,
    failedEntries: 0,
    rootStatus,
  };
}

function protectedCachePaths(cacheRoot: string, paths: Iterable<string>): Set<string> {
  const root = normalizedCacheRoot(cacheRoot);
  const protectedPaths = new Set<string>();
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) === root) protectedPaths.add(resolved);
  }
  return protectedPaths;
}

async function removeCandidate(candidate: CacheCandidate): Promise<boolean> {
  try {
    const current = await lstat(candidate.filePath);
    if (current.isSymbolicLink() || !current.isFile()) return false;
    await unlink(candidate.filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the rendered cover files of tasks whose history was cleared. Clearing
 * history must not leave orphan covers behind on the runtime disk.
 */
export async function removeVideoThumbnailCacheFiles(
  cacheRoot: string,
  taskIds: readonly string[],
): Promise<number> {
  const root = normalizedCacheRoot(cacheRoot);
  let removed = 0;
  for (const taskId of taskIds) {
    let filePath: string;
    try {
      filePath = resolveVideoThumbnailCacheFile(root, taskId);
    } catch {
      continue;
    }
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await unlink(filePath);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[VideoThumbnail] cache removal failed", {
          reason: error instanceof Error ? error.message.split(":", 1)[0] : "UNKNOWN",
        });
      }
    }
  }
  return removed;
}

export async function pruneVideoThumbnailCache(options: {
  cacheRoot: string;
  policy: Pick<VideoThumbnailCachePolicy, "ttlMs" | "maxFiles" | "maxBytes">;
  protectedPaths?: Iterable<string>;
  now?: number;
}): Promise<VideoThumbnailCachePruneReport> {
  const root = normalizedCacheRoot(options.cacheRoot);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
    return emptyReport(status);
  }
  if (rootInfo.isSymbolicLink()) return emptyReport("symbolic-link");
  if (!rootInfo.isDirectory()) return emptyReport("not-directory");

  const report = emptyReport("ready");
  const protectedPaths = protectedCachePaths(root, options.protectedPaths ?? []);
  const candidates: CacheCandidate[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { ...report, rootStatus: "unavailable" };
  }

  for (const entry of entries) {
    // Temporary writes, directories, and links are never cleanup targets. The
    // writer removes its own temporary file after rename or failure.
    if (!entry.isFile() || !CACHE_FILE_PATTERN.test(entry.name)) {
      report.skippedEntries += 1;
      continue;
    }
    const filePath = path.resolve(root, entry.name);
    if (path.dirname(filePath) !== root) {
      report.skippedEntries += 1;
      continue;
    }
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        report.skippedEntries += 1;
        continue;
      }
      candidates.push({
        filePath,
        name: entry.name,
        size: info.size,
        mtimeMs: info.mtimeMs,
        protected: protectedPaths.has(filePath),
      });
    } catch {
      report.failedEntries += 1;
    }
  }

  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  report.scannedFiles = candidates.length;
  let remainingFiles = candidates.length;
  let remainingBytes = candidates.reduce((total, candidate) => total + candidate.size, 0);
  const removed = new Set<string>();

  const evict = async (candidate: CacheCandidate) => {
    if (candidate.protected || removed.has(candidate.filePath)) return;
    if (await removeCandidate(candidate)) {
      removed.add(candidate.filePath);
      remainingFiles -= 1;
      remainingBytes -= candidate.size;
      report.removedFiles += 1;
      report.removedBytes += candidate.size;
    } else {
      report.failedEntries += 1;
    }
  };

  const now = options.now ?? Date.now();
  for (const candidate of candidates) {
    if (now - candidate.mtimeMs > options.policy.ttlMs) await evict(candidate);
  }
  for (const candidate of candidates) {
    if (remainingFiles <= options.policy.maxFiles && remainingBytes <= options.policy.maxBytes) break;
    await evict(candidate);
  }

  report.remainingFiles = remainingFiles;
  report.remainingBytes = remainingBytes;
  return report;
}

export function scheduleVideoThumbnailCachePrune(options: {
  cacheRoot: string;
  policy?: VideoThumbnailCachePolicy;
  protectedPaths?: Iterable<string>;
  force?: boolean;
}): void {
  const policy = options.policy ?? readVideoThumbnailCachePolicy();
  const now = Date.now();
  if (maintenanceState.job || (!options.force && now < maintenanceState.nextPruneAt)) return;
  maintenanceState.nextPruneAt = now + policy.pruneIntervalMs;
  const job = pruneVideoThumbnailCache({
    cacheRoot: options.cacheRoot,
    policy,
    protectedPaths: options.protectedPaths,
    now,
  })
    .then(() => undefined)
    .catch((error) => {
      console.warn("[VideoThumbnail] cache cleanup failed", {
        reason: error instanceof Error ? error.message.split(":", 1)[0] : "UNKNOWN",
      });
    })
    .finally(() => {
      if (maintenanceState.job === job) maintenanceState.job = undefined;
    });
  maintenanceState.job = job;
}
