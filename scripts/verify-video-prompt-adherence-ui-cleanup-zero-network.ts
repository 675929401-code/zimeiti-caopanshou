import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupVideoReferenceAsset,
  VideoReferenceCleanupError,
  type VideoReferenceAssetRow,
  type VideoReferenceCleanupClaimState,
  type VideoReferenceCleanupDependencies,
} from "../src/lib/video-reference-asset-cleanup";
import {
  restoreVideoGenerateAudio,
  videoGenerateAudioForSubmission,
} from "../src/lib/video-generate-audio-state";

const assetRef = "object://tencent_cos/video-inputs%2Ffixture.png";
const url = "https://fixture.cos.ap-shanghai.myqcloud.com/video-inputs/fixture.png?sign=redacted";
const session = "video_ref_fixture_session_123456";

function row(overrides: Partial<VideoReferenceAssetRow> = {}): VideoReferenceAssetRow {
  return {
    id: "asset-row",
    user_id: "owner",
    storage_key: "video-inputs/fixture.png",
    storage_provider: "tencent_cos",
    file_category: "image",
    source: "video-page-reference",
    meta: { videoPageUploadSession: session },
    ...overrides,
  };
}

function dependencies(input: {
  assets?: VideoReferenceAssetRow[];
  claimError?: VideoReferenceCleanupError;
  objectDeleted?: boolean;
  metadataFailures?: number;
} = {}) {
  const calls = { lookup: [] as unknown[], object: [] as string[], complete: 0, failures: [] as string[] };
  let state: VideoReferenceCleanupClaimState = "claimed";
  let metadataFailures = input.metadataFailures || 0;
  const deps: VideoReferenceCleanupDependencies = {
    async findAssetsByKey(candidate) {
      calls.lookup.push(candidate);
      return input.assets === undefined ? [row()] : input.assets;
    },
    async claimCleanup() {
      if (input.claimError) throw input.claimError;
      return state;
    },
    async deleteObjectOnly(key) {
      calls.object.push(key);
      return input.objectDeleted !== false;
    },
    async markObjectDeleted() {
      state = "object_deleted";
      return true;
    },
    async completeMetadataCleanup() {
      calls.complete += 1;
      if (metadataFailures > 0) {
        metadataFailures -= 1;
        return false;
      }
      state = "completed";
      return true;
    },
    async recordCleanupFailure(_identity, code) { calls.failures.push(code); },
  };
  return { deps, calls, state: () => state };
}

async function rejectsCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => (
    error instanceof VideoReferenceCleanupError && error.code === code
  ));
}

const cleanupInput = { userId: "owner", assetRef, candidateUrl: url, category: "image" as const, uploadSession: session };

async function main() {
  const success = dependencies();
  assert.deepEqual(await cleanupVideoReferenceAsset(cleanupInput, success.deps), { deleted: true, alreadyDeleted: false });
  assert.deepEqual(success.calls.lookup, [{ key: "video-inputs/fixture.png", provider: "tencent_cos" }]);
  assert.deepEqual(success.calls.object, ["video-inputs/fixture.png"]);

  const missing = dependencies({ assets: [] });
  assert.deepEqual(await cleanupVideoReferenceAsset(cleanupInput, missing.deps), { deleted: false, alreadyDeleted: true });
  assert.equal(missing.calls.object.length, 0);

  const ambiguous = dependencies({ assets: [row(), row({ id: "asset-row-2" })] });
  await rejectsCode(() => cleanupVideoReferenceAsset(cleanupInput, ambiguous.deps), "VIDEO_REFERENCE_DELETE_AMBIGUOUS");
  assert.equal(ambiguous.calls.object.length, 0, "ambiguous metadata must never delete the object");

  await rejectsCode(() => cleanupVideoReferenceAsset(cleanupInput,
    dependencies({ assets: [row({ user_id: "other" })] }).deps), "VIDEO_REFERENCE_DELETE_FORBIDDEN");
  await rejectsCode(() => cleanupVideoReferenceAsset(cleanupInput,
    dependencies({ assets: [row({ storage_key: "other/fixture.png" })] }).deps), "VIDEO_REFERENCE_DELETE_FORBIDDEN");
  await rejectsCode(() => cleanupVideoReferenceAsset({ ...cleanupInput, category: "audio" },
    dependencies().deps), "VIDEO_REFERENCE_DELETE_FORBIDDEN");
  await rejectsCode(() => cleanupVideoReferenceAsset({ ...cleanupInput, uploadSession: "video_ref_another_session_123456" },
    dependencies().deps), "VIDEO_REFERENCE_DELETE_FORBIDDEN");

  const active = dependencies({ claimError: new VideoReferenceCleanupError(
    "VIDEO_REFERENCE_DELETE_ACTIVE_TASK", "active", 409,
  ) });
  await rejectsCode(() => cleanupVideoReferenceAsset(cleanupInput, active.deps), "VIDEO_REFERENCE_DELETE_ACTIVE_TASK");
  assert.equal(active.calls.object.length, 0);

  // First request deletes the object and durably reaches object_deleted, but
  // metadata finalization fails. The second request resumes finalization and
  // must not call object deletion again.
  const resumable = dependencies({ metadataFailures: 1 });
  await rejectsCode(() => cleanupVideoReferenceAsset(cleanupInput, resumable.deps), "VIDEO_REFERENCE_DELETE_METADATA_FAILED");
  assert.equal(resumable.state(), "object_deleted");
  assert.deepEqual(resumable.calls.object, ["video-inputs/fixture.png"]);
  assert.deepEqual(await cleanupVideoReferenceAsset(cleanupInput, resumable.deps), { deleted: true, alreadyDeleted: false });
  assert.equal(resumable.state(), "completed");
  assert.deepEqual(resumable.calls.object, ["video-inputs/fixture.png"]);
  assert.equal(resumable.calls.complete, 2);

  // Task state survives a model that hides the capability and becomes false
  // again when switching back to a supporting model.
  const taskGenerateAudio = false;
  assert.equal(videoGenerateAudioForSubmission(true, taskGenerateAudio), false);
  assert.equal(videoGenerateAudioForSubmission(false, taskGenerateAudio), undefined);
  assert.equal(videoGenerateAudioForSubmission(true, taskGenerateAudio), false);
  assert.equal(restoreVideoGenerateAudio(false), false, "history retry must preserve explicit false");
  assert.equal(restoreVideoGenerateAudio(null), undefined);

  const root = process.cwd();
  const dto = readFileSync(resolve(root, "src/lib/public-model-dto.ts"), "utf8");
  const modelsRoute = readFileSync(resolve(root, "src/app/api/video/models/route.ts"), "utf8");
  const page = readFileSync(resolve(root, "src/app/video/page.tsx"), "utf8");
  const uploadRoute = readFileSync(resolve(root, "src/app/api/video/reference-upload/route.ts"), "utf8");
  const generateRoute = readFileSync(resolve(root, "src/app/api/video/generate/route.ts"), "utf8");
  const migration = readFileSync(resolve(root, "supabase/migrations/20261010135000_video_reference_asset_cleanup_outbox.sql"), "utf8");
  const rollback = readFileSync(resolve(root, "supabase/rollbacks/20261010135000_video_reference_asset_cleanup_outbox.rollback.sql"), "utf8");

  assert.match(dto, /"supportsGenerateAudioToggle"/u);
  assert.match(modelsRoute, /protocolConfig\.supports_generate_audio_toggle === true/u);
  assert.match(page, /cardModel\?\.supportsGenerateAudioToggle === true/u);
  assert.match(page, />\s*生成声音\s*</u);
  assert.match(page, />\s*静音\s*</u);
  assert.match(page, /videoGenerateAudioForSubmission\(/u);
  assert.match(page, /restoreVideoGenerateAudio\(snapshot\?\.generateAudio\)/u);
  assert.match(page, /submittedGenerateAudio !== undefined \? \{ generate_audio: submittedGenerateAudio \} : \{\}/u);
  assert.match(page, /reference_asset_refs: submittedReferenceAssetRefs/u);
  assert.match(generateRoute, /resolveOwnedPageReferenceAssetRefs/u);
  assert.match(uploadRoute, /\.eq\("storage_provider", input\.provider\)/u);
  assert.match(uploadRoute, /\.limit\(2\)/u);
  assert.match(uploadRoute, /register_video_reference_asset_guard_v1/u);
  assert.match(migration, /for update of cleanup/u);
  assert.match(migration, /before insert or update of request_snapshot/u);
  assert.match(migration, /join public\.video_reference_asset_cleanup_outbox cleanup/u);
  assert.match(migration, /cleanup\.state in \('claimed','object_deleted','completed'\)/u);
  assert.match(migration, /registered_at timestamptz not null default clock_timestamp\(\)/u);
  assert.match(migration, /claimed_at timestamptz,/u);
  assert.match(migration, /claimed_at=case when state='available' then clock_timestamp\(\) else claimed_at end/u);
  assert.doesNotMatch(migration, /pg_advisory_xact_lock/u);
  assert.match(rollback, /VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL/u);
  assert.equal((migration.match(/lock table public\.video_tasks in access share mode;/gu) || []).length, 6);
  assert.match(rollback, /lock table public\.video_tasks in access exclusive mode;/u);
  assert.match(rollback, /lock table public\.video_reference_asset_cleanup_outbox in access exclusive mode/u);
  assert.match(rollback, /state in \(''claimed'',''object_deleted''\)/u);

  // This product has history retry, but no task-copy/duplicate action. Keep
  // that absence explicit instead of fabricating copy-state behavior.
  assert.doesNotMatch(page, /\b(?:copyTask|duplicateTask|cloneTask)\b/u);

  console.log("video prompt-adherence UI, audio state, and durable reference cleanup zero-network contract: PASS");
  console.log("task copy behavior: NOT PRESENT (explicitly not fabricated)");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
