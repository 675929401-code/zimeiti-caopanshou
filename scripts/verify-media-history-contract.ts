import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}), { expiresAt: "2026-09-29T00:00:01.000Z", retentionSource: "policy", expired: false });

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

  assert(page.includes("普通视频不设平台固定天数"));
  assert(provenance.includes("delivery_asset_id,client_idempotency_key,request_snapshot"));
  assert(provenance.includes("origins.set"));
  assert(route.includes("mediaHistoryProjectUuid(row.batch_id)"));
  assert(route.includes('.select("id, storage_key, content_type, meta")'));
  assert(baseline.includes('"meta" jsonb'));
  const contract = JSON.parse(databaseContract) as { contractVersion: string; tables: Array<{ name: string; columns: string[] }> };
  const mediaHistoryMigrationVersion = "20260929153000";
  assert.match(contract.contractVersion, /^\d{14}$/, "database contract version must remain a timestamped migration version");
  assert.ok(
    contract.contractVersion >= mediaHistoryMigrationVersion,
    `database contract ${contract.contractVersion} predates media-history migration ${mediaHistoryMigrationVersion}`,
  );
  assert.equal(
    migrationNames.filter((name) => name.startsWith(`${contract.contractVersion}_`) && name.endsWith(".sql")).length,
    1,
    `database contract ${contract.contractVersion} must resolve to exactly one authoritative migration`,
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
