import assert from "node:assert/strict";
import {
  MEDIA_CACHE_TTL_MS,
  cacheExpiryFrom,
  cacheFailureMessage,
  cacheStateWithBlob,
  createMediaCacheKey,
  decideCacheWrite,
  expiredCacheKeys,
  mediaScopeKey,
  recordsForScope,
  renewCacheExpiry,
  type MediaCacheMetadata,
} from "../src/lib/media-cache-policy";
import { responseToDownloadBlob } from "../src/lib/media-cache";

const now = Date.UTC(2026, 7, 14, 8, 0, 0);

function record(partial: Partial<MediaCacheMetadata> = {}): MediaCacheMetadata {
  return {
    key: "scope-a:video:1",
    scopeKey: "scope-a",
    mediaId: "video:1",
    kind: "video",
    title: "测试视频",
    sourcePath: "/api/video/storage/1",
    cachedAt: now - 10_000,
    expiresAt: now - 1,
    pinned: false,
    sizeBytes: 1024,
    state: "ready",
    failureReason: "",
    ...partial,
  };
}

async function main() {
  assert.deepEqual(expiredCacheKeys([record()], "scope-a", now), ["scope-a:video:1"], "过期副本应进入清理计划");
  assert.deepEqual(expiredCacheKeys([record({ pinned: true })], "scope-a", now), [], "尽量保留的副本不得被站内到期任务自动清理");

  const insufficient = decideCacheWrite({ usage: 900, quota: 1000 }, 200);
  assert.equal(insufficient.allowed, false, "配额不足必须阻止缓存写入");
  const enough = decideCacheWrite({ usage: 100 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 }, 40 * 1024 * 1024);
  assert.equal(enough.allowed, true, "空间充足时应允许缓存写入");

  assert.match(cacheFailureMessage(new Error("网络中断")), /网络中断/, "缓存失败原因应可诊断");

  const missing = cacheStateWithBlob(record({ expiresAt: now + MEDIA_CACHE_TTL_MS }), false);
  assert.equal(missing.state, "missing", "刷新后元数据存在但无 Blob 时应标为 missing");
  assert.match(missing.failureReason, /副本已丢失/, "缺失副本应给出恢复说明");
  const restored = cacheStateWithBlob(missing, true);
  assert.equal(restored.state, "ready", "重新发现 Blob 后应恢复 ready");

  const mixed = [record(), record({ key: "scope-b:video:2", scopeKey: "scope-b", mediaId: "video:2" })];
  assert.deepEqual(recordsForScope(mixed, "scope-a").map((item) => item.mediaId), ["video:1"], "换账号不得列出其他 scope 媒体");
  const scopeA = await mediaScopeKey("user-a");
  const scopeB = await mediaScopeKey("user-b");
  assert.notEqual(scopeA, scopeB, "不同账号必须使用不同缓存 scope");
  assert.equal(createMediaCacheKey(scopeA, "video:1").startsWith(`${scopeA}:`), true, "缓存 key 必须带用户 scope");

  assert.equal(cacheExpiryFrom(now), now + MEDIA_CACHE_TTL_MS, "默认缓存期必须为三天");
  assert.equal(renewCacheExpiry(now), now + MEDIA_CACHE_TTL_MS, "续期应从当前时间重新计算三天");

  const blob = await responseToDownloadBlob(new Response("download-fixture", { status: 200, headers: { "content-type": "video/mp4" } }));
  assert.equal(await blob.text(), "download-fixture", "下载应保留响应内容");
  await assert.rejects(() => responseToDownloadBlob(new Response("missing", { status: 404 })), /媒体下载失败/, "下载失败必须抛出明确错误");

  console.log("media-cache verification: 16 assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
