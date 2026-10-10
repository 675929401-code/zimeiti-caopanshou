import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildVideoGenerationRequestSnapshot,
  hashVideoProviderPayload,
  parseVideoGenerationRequestSnapshot,
  videoGenerationRequestSnapshotHash,
} from "@/lib/video-budget-reservation";

async function main() {
  const root = process.cwd();
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("Network access is forbidden in video request snapshot verification");
  }) as typeof fetch;

const providerPayloadA = {
  model: "provider-video-model",
  prompt: "effective prompt, 6 seconds",
  duration: 6,
  nested: { generate_audio: true, seed: "42" },
};
const providerPayloadB = {
  nested: { seed: "42", generate_audio: true },
  duration: 6,
  prompt: "effective prompt, 6 seconds",
  model: "provider-video-model",
};

const fixture = buildVideoGenerationRequestSnapshot({
  userPrompt: "  user prompt  ",
  effectivePrompt: "effective prompt, 6 seconds",
  promptNormalizations: [
    { name: "trim", applied: true },
    { name: "duration_suffix", applied: true, detail: "6 seconds" },
  ],
  negativePrompt: "watermark",
  referenceAssets: [
    { role: "first_frame", index: 0, ref: "object://tencent_cos/users%2Fu1%2Ffirst.png" },
    { role: "reference_image", index: 0, ref: "object://tencent_cos/users%2Fu1%2Freference-1.png" },
    { role: "reference_image_list", index: 0, ref: "object://tencent_cos/users%2Fu1%2Freference-2.png" },
    { role: "reference_audio_list", index: 0, ref: "object://tencent_cos/users%2Fu1%2Fvoice.wav" },
    { role: "source_video", index: 0, ref: "object://tencent_cos/users%2Fu1%2Fsource.mp4" },
  ],
  targetDurationSeconds: 8,
  effectiveDurationSeconds: 6,
  aspectRatio: "16:9",
  resolution: "1080p",
  fps: 30,
  seed: "42",
  generateAudio: true,
  publicModelId: "pm_video_fixture",
  routingConfigHash: "a".repeat(64),
  adapterVersion: "video-adapter:fixture:v1",
  providerPayload: providerPayloadA,
});

assert.equal(fixture.schema, "video_generation_request_snapshot.v1");
assert.equal(fixture.userPrompt, "  user prompt  ");
assert.equal(fixture.effectivePrompt, "effective prompt, 6 seconds");
assert.equal(fixture.negativePrompt, "watermark");
assert.equal(fixture.referenceAssets.length, 5);
assert.equal(fixture.targetDurationSeconds, 8);
assert.equal(fixture.effectiveDurationSeconds, 6);
assert.equal(fixture.aspectRatio, "16:9");
assert.equal(fixture.resolution, "1080p");
assert.equal(fixture.fps, 30);
assert.equal(fixture.seed, "42");
assert.equal(fixture.generateAudio, true);
assert.equal(fixture.publicModelId, "pm_video_fixture");
assert.equal(fixture.routingConfigHash, "a".repeat(64));
assert.equal(fixture.adapterVersion, "video-adapter:fixture:v1");
assert.match(fixture.providerPayloadHash, /^[a-f0-9]{64}$/u);
assert.equal(hashVideoProviderPayload(providerPayloadA), hashVideoProviderPayload(providerPayloadB));
assert.deepEqual(parseVideoGenerationRequestSnapshot(JSON.parse(JSON.stringify(fixture))), fixture);
assert.equal(videoGenerationRequestSnapshotHash(fixture), videoGenerationRequestSnapshotHash({ ...fixture }));

assert.throws(() => parseVideoGenerationRequestSnapshot({
  ...fixture,
  referenceAssets: [fixture.referenceAssets[0], fixture.referenceAssets[0]],
}), /VIDEO_REQUEST_ASSET_ROLE_DUPLICATE/u);
assert.throws(() => parseVideoGenerationRequestSnapshot({
  ...fixture,
  providerPayloadHash: "not-a-hash",
}), /VIDEO_REQUEST_SNAPSHOT_INVALID/u);
assert.throws(() => parseVideoGenerationRequestSnapshot({
  ...fixture,
  referenceAssets: [{ role: "source_video", index: 0, ref: "blob:transient" }],
}), /VIDEO_REQUEST_ASSET_REF_INVALID/u);
assert.throws(() => parseVideoGenerationRequestSnapshot({
  ...fixture,
  referenceAssets: [{ role: "source_video", index: 0, ref: "https://media.example/video.mp4?signature=temporary" }],
}), /VIDEO_REQUEST_ASSET_REF_INVALID/u);

const [reservationSource, historySource, pageSource, migrationSource, rollbackSource, databaseContract] = await Promise.all([
  readFile(path.join(root, "src/lib/video-budget-reservation.ts"), "utf8"),
  readFile(path.join(root, "src/app/api/video/history/route.ts"), "utf8"),
  readFile(path.join(root, "src/app/video/page.tsx"), "utf8"),
  readFile(path.join(root, "supabase/migrations/20261010023000_video_generation_request_snapshot_v1.sql"), "utf8"),
  readFile(path.join(root, "supabase/rollbacks/20261010023000_video_generation_request_snapshot_v1.rollback.sql"), "utf8"),
  readFile(path.join(root, "src/lib/generated/database-contract.ts"), "utf8"),
]);

for (const required of [
  "VIDEO_REQUEST_SNAPSHOT_REQUIRED",
  "reserve_video_generation_task_request_snapshot_v1_atomic",
  "reserve_queued_digital_video_task_request_snapshot_v1_atomic",
  "p_request_snapshot_hash",
]) assert.match(reservationSource, new RegExp(required, "u"));

for (const required of ["request_snapshot", "requestSnapshot", "retryInputs", "referenceAudioUrls", "sourceVideoUrl"]) {
  assert.match(historySource, new RegExp(required, "u"));
}
for (const required of ["negativePrompt: snapshot?.negativePrompt", "fps: snapshot?.fps", "generate_audio", "referenceAudioUrls"]) {
  assert.match(pageSource, new RegExp(required.replace(/[?.]/gu, "\\$&"), "u"));
}
for (const required of [
  "video_generation_request_snapshot.v1",
  "persist_video_generation_request_snapshot_v1_atomic",
  "reserve_video_generation_task_request_snapshot_v1_atomic",
  "reserve_queued_digital_video_task_request_snapshot_v1_atomic",
  "VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT",
]) assert.match(migrationSource, new RegExp(required, "u"));
assert.match(
  migrationSource,
  /IF coalesce\(\(v_result->>'created'\)::boolean, false\) THEN[\s\S]*persist_video_generation_request_snapshot_v1_atomic[\s\S]*IF v_existing_snapshot IS NULL THEN[\s\S]*request_snapshot_unavailable/u,
  "legacy idempotent replays must remain snapshot-unavailable instead of fabricating current request history",
);

assert.match(rollbackSource, /DROP FUNCTION IF EXISTS public\.reserve_video_generation_task_request_snapshot_v1_atomic/u);
assert.match(rollbackSource, /DROP COLUMN IF EXISTS request_snapshot/u);
assert.match(rollbackSource, /VIDEO_REQUEST_SNAPSHOT_ROLLBACK_EXPLICIT_CONFIRMATION_REQUIRED/u);
assert.match(rollbackSource, /VIDEO_REQUEST_SNAPSHOT_ROLLBACK_WOULD_DELETE_HISTORY/u);
assert.equal(
  createHash("sha256").update(rollbackSource, "utf8").digest("hex"),
  "edf1fd423c6199c0267cc15104d9ce93e15fba267c3a4ae64450c75c0b048a72",
  "video request snapshot rollback must remain byte-exact at the canonical rollback root",
);
for (const required of [
  '"request_snapshot"',
  '"request_snapshot_hash"',
  '"request_snapshot_version"',
  '"persist_video_generation_request_snapshot_v1_atomic"',
]) assert.match(databaseContract, new RegExp(required, "u"));

assert.equal(networkCalls, 0);
  console.log(JSON.stringify({
    passed: true,
    fixtureAssetRoles: fixture.referenceAssets.map((asset) => `${asset.role}:${asset.index}`),
    snapshotHash: videoGenerationRequestSnapshotHash(fixture),
    providerPayloadHash: fixture.providerPayloadHash,
    realNetworkCalls: networkCalls,
    databaseWrites: 0,
    providerCalls: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
