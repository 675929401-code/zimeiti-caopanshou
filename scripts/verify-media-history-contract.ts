import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyVideoProviderError } from "../src/lib/video-error-policy";

import {
  MEDIA_HISTORY_CATEGORY_KEYS,
  mediaHistoryCategoryFromImageSurface,
  mediaHistoryCategoryFromVideoSource,
  mediaHistoryProjectUuid,
  resolveMediaHistoryRetention,
  upstreamMediaExpiry,
} from "../src/lib/media-history-contract";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-09-29T00:00:00.000Z");

assert.equal(new Set(MEDIA_HISTORY_CATEGORY_KEYS).size, MEDIA_HISTORY_CATEGORY_KEYS.length);
assert.equal(mediaHistoryCategoryFromImageSurface({ surface: "image-workbench" }), "image-workbench");
assert.equal(mediaHistoryCategoryFromImageSurface({ surface: "storyboard-workbench" }), "storyboard-workbench");
assert.equal(mediaHistoryCategoryFromImageSurface({ surface: "short-drama-film-studio" }), "short-drama");
assert.equal(mediaHistoryCategoryFromImageSurface({ surface: "free-canvas" }), "free-canvas");
assert.equal(mediaHistoryCategoryFromImageSurface({ cover: true }), "cover-studio");
assert.equal(mediaHistoryCategoryFromImageSurface({ agentId: "image-workbench" }), "image-workbench");
assert.equal(mediaHistoryCategoryFromImageSurface({}), "agent-output");
assert.equal(mediaHistoryCategoryFromVideoSource({ batchId: "manual-workflow" }), "free-canvas");
assert.equal(mediaHistoryCategoryFromVideoSource({ storyboard: true, batchId: "manual-workflow" }), "storyboard-workbench");
assert.equal(mediaHistoryCategoryFromVideoSource({ shortDrama: true }), "short-drama");
assert.equal(mediaHistoryProjectUuid("batch_1785509647596"), null);
assert.equal(mediaHistoryProjectUuid("manual-workflow"), null);
assert.equal(mediaHistoryProjectUuid("6BC70EA4-18AC-49B5-8EE8-345D1B1F1EDC"), "6BC70EA4-18AC-49B5-8EE8-345D1B1F1EDC");

assert.equal(upstreamMediaExpiry({ upstreamExpiresAt: "2026-09-30T00:00:00Z" }), "2026-09-30T00:00:00.000Z");
assert.equal(upstreamMediaExpiry({ cloudRetentionTargetAt: "2026-10-30T00:00:00Z" }), null);

assert.deepEqual(resolveMediaHistoryRetention({
  kind: "image",
  status: "processing",
  createdAt: "2026-09-20T00:00:00Z",
  now,
}), { expiresAt: null, retentionSource: "none", expired: false });

assert.deepEqual(resolveMediaHistoryRetention({
  kind: "image",
  status: "completed",
  createdAt: "2026-09-27T00:00:01Z",
  now,
}), { expiresAt: null, retentionSource: "none", expired: false });

// Upstream metadata supplies the deadline; its passage does not prove deletion.
for (const sourceExpiredAt of [null, "2026-09-28T12:00:00Z"]) {
  assert.deepEqual(resolveMediaHistoryRetention({
    kind: "image",
    status: "completed",
    createdAt: "2026-09-01T00:00:00Z",
    upstreamExpiresAt: "2026-09-28T00:00:00Z",
    sourceExpiredAt,
    now,
  }), { expiresAt: "2026-09-28T00:00:00.000Z", retentionSource: "upstream", expired: sourceExpiredAt !== null });
}

assert.deepEqual(resolveMediaHistoryRetention({
  kind: "video",
  status: "completed",
  createdAt: "2026-09-25T23:59:59Z",
  now,
}), { expiresAt: null, retentionSource: "none", expired: false });

assert.deepEqual(resolveMediaHistoryRetention({
  kind: "video",
  status: "completed",
  createdAt: "2026-09-01T00:00:00Z",
  upstreamExpiresAt: "2026-10-01T00:00:00Z",
  now,
}), { expiresAt: "2026-10-01T00:00:00.000Z", retentionSource: "upstream", expired: false });

async function verifySourceContracts() {
  const [route, page, provenance, baseline, databaseContract, generatedContract, migrationNames] = await Promise.all([
    readFile(path.join(root, "src/app/api/media-history/route.ts"), "utf8"),
    readFile(path.join(root, "src/app/media-history/page.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/media-image-provenance.ts"), "utf8"),
    readFile(path.join(root, "deploy/local/task-baseline.sql"), "utf8"),
    readFile(path.join(root, "deploy/policies/database-contract.v1.json"), "utf8"),
    readFile(path.join(root, "src/lib/generated/database-contract.ts"), "utf8"),
    readdir(path.join(root, "supabase/migrations")),
  ]);

  // Execute the actual route's pure status/error projection in RAM.
  const statusBody = route.match(/function safeStatus\(value: unknown\): MediaStatus \{([\s\S]*?)\r?\n\}/u)?.[1];
  assert.ok(statusBody, "actual media-history status mapping must be found");
  const mappingStart = route.indexOf("const retainedVideos = videoRows.map");
  const mappingEnd = route.indexOf("const videos = retainedVideos.filter", mappingStart);
  assert.ok(mappingStart >= 0 && mappingEnd > mappingStart);
  const errorExpression = route.slice(mappingStart, mappingEnd).match(/errorMessage:([\s\S]*?),\s*aspectRatio:/u)?.[1];
  assert.ok(errorExpression, "actual video error projection must be found");
  const normalizeStatus = new Function("value", statusBody);
  const projectError = new Function("rawStatus", "hasAuthenticatedDeliverySource", "rawError", "modelName", "classifyVideoProviderError", `return (${errorExpression});`);
  const errorFor = (status: string, rawError: string, hasDelivery = true) => projectError(normalizeStatus(status), hasDelivery, rawError, "公开视频模型", classifyVideoProviderError);
  for (const status of ["pending", "queued", "processing", "generating", "finalizing", "submitting"]) {
    assert.equal(errorFor(status, "供应商已接收任务，等待生成终态"), "", `${status} progress must not become a failure`);
  }
  assert.equal(errorFor("failed", "fixture generation failure"), classifyVideoProviderError("fixture generation failure", "公开视频模型").publicMessage);
  assert.equal(errorFor("failed", ""), "");
  assert.equal(errorFor("completed", "供应商已接收任务，等待生成终态"), "");
  assert.equal(errorFor("completed", "", false), "任务已标记完成，但没有可验证的交付地址，暂不可预览或下载。");
  assert.equal(errorFor("cancelled", "任务已取消"), "");

  for (const token of [
    '.from("short_drama_projects")',
    "mediaHistoryCategoryFromVideoSource",
    'freeCanvas ? "/free-canvas"',
    "expiredCount: snapshot.expiredCount",
    'strategy: "image-fallback-video-upstream-lifetime"',
  ]) assert(route.includes(token), `media history route missing ${token}`);

  for (const forbidden of [
    "cacheVideoLocally",
    "listUserMediaCache",
    "保存浏览器副本",
    "浏览器视频副本",
  ]) assert(!page.includes(forbidden), `media history page still exposes local cache: ${forbidden}`);

  assert(page.includes("图片和普通视频随上游资源有效期提供预览与下载，确认失效后自动移出历史，不在平台备份"));
  assert(provenance.includes("delivery_asset_id,client_idempotency_key,request_snapshot"));
  assert(provenance.includes("origins.set"));
  assert(route.includes("mediaHistoryProjectUuid(row.batch_id)"));
  assert(route.includes('.select("id, storage_key, content_type, meta")'));
  assert(baseline.includes('"meta" jsonb'));
  const contract = JSON.parse(databaseContract) as { contractVersion: string; tables: Array<{ name: string; columns: string[] }> };
  const mediaHistoryMigrationVersion = "20260929153000";
  assert.match(contract.contractVersion, /^\d{14}$/, "database contract version must remain a timestamped contract revision");
  assert.ok(
    contract.contractVersion >= mediaHistoryMigrationVersion,
    `database contract ${contract.contractVersion} predates media-history migration ${mediaHistoryMigrationVersion}`,
  );
  assert.equal(
    migrationNames.filter((name) => name.startsWith(`${mediaHistoryMigrationVersion}_`) && name.endsWith(".sql")).length,
    1,
    `media-history dependency ${mediaHistoryMigrationVersion} must resolve to exactly one authoritative migration`,
  );
  assert.equal(contract.tables.find(table => table.name === "user_files")?.columns.includes("meta"), true);
  const generatedContractVersion = generatedContract.match(/"contractVersion":\s*"(\d{14})"/)?.[1];
  assert.equal(generatedContractVersion, contract.contractVersion, "generated database contract must mirror the authoritative policy version");
  assert(generatedContract.includes('"meta"'));
}

verifySourceContracts().then(() => {
  console.log("media history contract verification passed");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
