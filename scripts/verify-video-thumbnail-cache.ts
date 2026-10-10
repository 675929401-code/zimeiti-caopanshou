import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pruneVideoThumbnailCache,
  readVideoThumbnailCacheFile,
  readVideoThumbnailCachePolicy,
  resolveVideoThumbnailCacheFile,
  writeVideoThumbnailCacheFile,
} from "../src/lib/video-thumbnail-cache";

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true).catch(() => false);
}

async function setAge(filePath: string, timestamp: number): Promise<void> {
  const date = new Date(timestamp);
  await utimes(filePath, date, date);
}

async function main() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "video-thumbnail-cache-"));
  try {
    const cacheRoot = path.join(fixtureRoot, "cache");
    const limitRoot = path.join(fixtureRoot, "limit-cache");
    const outsideRoot = path.join(fixtureRoot, "outside");
    const now = Date.now();
    const policy = { ttlMs: 60_000, maxFiles: 100, maxBytes: 1_000_000 };

    assert.deepEqual(readVideoThumbnailCachePolicy({
      VIDEO_THUMBNAIL_CACHE_TTL_MS: "1234",
      VIDEO_THUMBNAIL_CACHE_MAX_FILES: "12",
      VIDEO_THUMBNAIL_CACHE_MAX_BYTES: "3456",
      VIDEO_THUMBNAIL_CACHE_PRUNE_INTERVAL_MS: "789",
    }), { ttlMs: 1234, maxFiles: 12, maxBytes: 3456, pruneIntervalMs: 789 });

  const expiredPath = await writeVideoThumbnailCacheFile(cacheRoot, "expired", Buffer.from("expired"));
  const freshPath = await writeVideoThumbnailCacheFile(cacheRoot, "fresh", Buffer.from("fresh"));
  await setAge(expiredPath, now - policy.ttlMs - 1_000);
  await setAge(freshPath, now - 1_000);
  assert.equal(
    await readVideoThumbnailCacheFile(cacheRoot, "expired", policy.ttlMs, now),
    null,
    "expired cache files must not be served before cleanup runs",
  );
  const ttlReport = await pruneVideoThumbnailCache({ cacheRoot, policy, now });
  assert.equal(await exists(expiredPath), false, "expired thumbnails must be removed");
  assert.equal(await exists(freshPath), true, "fresh thumbnails must remain");
  assert.equal(ttlReport.removedFiles, 1);

  const oldestPath = await writeVideoThumbnailCacheFile(limitRoot, "oldest", Buffer.alloc(5, 1));
  const middlePath = await writeVideoThumbnailCacheFile(limitRoot, "middle", Buffer.alloc(5, 2));
  const newestPath = await writeVideoThumbnailCacheFile(limitRoot, "newest", Buffer.alloc(5, 3));
  await setAge(oldestPath, now - 3_000);
  await setAge(middlePath, now - 2_000);
  await setAge(newestPath, now - 1_000);
  const limitReport = await pruneVideoThumbnailCache({
    cacheRoot: limitRoot,
    policy: { ttlMs: 60_000, maxFiles: 2, maxBytes: 1_000_000 },
    now,
  });
  assert.equal(limitReport.remainingFiles, 2, "file count cap must be enforced");
  assert.equal(await exists(oldestPath), false, "oldest unprotected entry must be evicted first");
  const largePath = await writeVideoThumbnailCacheFile(limitRoot, "large", Buffer.alloc(8, 4));
  await setAge(largePath, now);
  const byteLimitReport = await pruneVideoThumbnailCache({
    cacheRoot: limitRoot,
    policy: { ttlMs: 60_000, maxFiles: 100, maxBytes: 10 },
    now,
  });
  assert.ok(byteLimitReport.remainingBytes <= 10, "byte cap must be enforced independently");
  assert.equal(await exists(largePath), true, "newest file should survive byte-based eviction");

  const protectedPath = await writeVideoThumbnailCacheFile(cacheRoot, "current", Buffer.alloc(20, 4));
  const evictablePath = await writeVideoThumbnailCacheFile(cacheRoot, "evictable", Buffer.alloc(20, 5));
  const currentTemporaryPath = path.join(cacheRoot, ".current.request.tmp");
  await writeFile(currentTemporaryPath, Buffer.alloc(20, 6), { flag: "wx" });
  await setAge(protectedPath, now - 120_000);
  await setAge(evictablePath, now - 119_000);
  await setAge(currentTemporaryPath, now - 120_000);
  await pruneVideoThumbnailCache({
    cacheRoot,
    policy: { ttlMs: 1, maxFiles: 1, maxBytes: 1 },
    protectedPaths: [protectedPath],
    now,
  });
  assert.equal(await exists(protectedPath), true, "the current response file must be protected");
  assert.equal(await exists(evictablePath), false, "unprotected entries remain eligible for eviction");
  assert.equal(await exists(currentTemporaryPath), true, "current request temporary files must be ignored");

  await mkdir(outsideRoot, { recursive: true });
  await writeFile(path.join(outsideRoot, "keep.jpg"), "outside", { flag: "wx" });
  const outsideFile = path.join(outsideRoot, "keep.jpg");
  const cacheLink = path.join(cacheRoot, "linked.jpg");
  await symlink(outsideFile, cacheLink, "file");
  const rootLink = path.join(fixtureRoot, "cache-root-link");
  await symlink(outsideRoot, rootLink, "junction");
  const linkedRootReport = await pruneVideoThumbnailCache({
    cacheRoot: rootLink,
    policy: { ttlMs: 1, maxFiles: 1, maxBytes: 1 },
    now,
  });
  await pruneVideoThumbnailCache({
    cacheRoot,
    policy: { ttlMs: 1, maxFiles: 1, maxBytes: 1 },
    now,
  });
  assert.equal(linkedRootReport.rootStatus, "symbolic-link", "a linked cache root must never be traversed");
  assert.equal(
    await readVideoThumbnailCacheFile(rootLink, "keep", 60_000, now),
    null,
    "cache reads must refuse a linked cache root",
  );
  await assert.rejects(
    writeVideoThumbnailCacheFile(rootLink, "outside-write", Buffer.from("blocked")),
    /ROOT_UNSAFE/u,
    "atomic writes must also refuse a linked cache root",
  );
  assert.equal(await readFile(outsideFile, "utf8"), "outside", "cleanup must not follow links outside the cache root");
  assert.equal(await exists(cacheLink), true, "cleanup must not delete symbolic-link entries");
  assert.throws(
    () => resolveVideoThumbnailCacheFile(cacheRoot, "../outside"),
    /TASK_ID_INVALID/u,
    "cache paths must remain direct children of the fixed root",
  );

  const atomicPath = await writeVideoThumbnailCacheFile(cacheRoot, "atomic", Buffer.from("complete-image"));
  assert.equal(await readFile(atomicPath, "utf8"), "complete-image");
  assert.equal((await readdir(cacheRoot)).some((name) => name.includes(".atomic.") && name.endsWith(".tmp")), false);

  const routeSource = await readFile(
    path.join(process.cwd(), "src", "app", "api", "video", "thumbnail", "[taskId]", "route.ts"),
    "utf8",
  );
  assert.match(routeSource, /resolveAppRuntimeDir\(\)[\s\S]*?"video-thumbnails"/u);
  assert.match(routeSource, /readVideoThumbnailCacheFile\([\s\S]*?cachePolicy\.ttlMs/u);
  assert.match(routeSource, /writeVideoThumbnailCacheFile\(thumbnailDirectory, task\.id, thumbnail\)/u);
  assert.match(routeSource, /scheduleVideoThumbnailCachePrune\(/u);

  console.log(JSON.stringify({
    status: "passed",
    checks: [
      "ttl expiry",
      "file and byte caps",
      "current file and temporary protection",
      "root and entry symlink boundaries",
      "direct-child path boundary",
      "atomic publish without partial files",
      "environment policy overrides",
    ],
    realCacheTouched: false,
  }));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
