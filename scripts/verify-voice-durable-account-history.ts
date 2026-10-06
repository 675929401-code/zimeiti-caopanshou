import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createVoiceHistorySnapshot,
  mapDurableVoiceHistoryRow,
  sanitizeLegacyVoiceHistory,
  type DurableVoiceHistoryRow,
  type OwnedVoiceHistoryAsset,
} from "../src/lib/voice-generation-history-mapper";
import type { VoiceGeneration } from "../src/lib/types";

const root = process.cwd();
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const historyRoute = source("src/app/api/voice/history/route.ts");
const historyRepository = source("src/lib/voice-generation-history-repository.ts");
const mapper = source("src/lib/voice-generation-history-mapper.ts");
const ttsRoute = source("src/app/api/voice/tts/route.ts");
const historyComponent = source("src/components/vs/VoiceGenerationHistory.tsx");
const imitatePage = source("src/app/voice-studio/imitate/page.tsx");
const releasePolicy = JSON.parse(source("deploy/policies/release-policy.json")) as { runtime?: { requiredDataFiles?: string[]; requiredDataShapes?: Record<string, string> } };
const releaseReadiness = source("src/app/api/release-readiness/route.ts");

assert.ok(historyRoute.includes("getVoiceGenerationAccountHistory"), "history route must use the durable repository");
assert.equal(historyRoute.includes("getGenerationsPaginated"), false, "history route must not paginate generations.json");
assert.equal(historyRoute.includes("storageManager.getSignedUrl"), false, "history route must not expose object-provider signed URLs");
assert.ok(historyRoute.includes("private, no-store"), "account history responses must remain private and uncached");
assert.ok(historyRepository.includes("VOICE_HISTORY_MIGRATION_NOT_READY"), "migration readiness failure must be explicit through the repository error");

assert.ok(historyRepository.includes('.from("voice_generation_requests")'), "durable history table must be the primary source");
assert.ok(historyRepository.includes('.eq("user_id", userId)') || historyRepository.includes('.eq("user_id", input.userId)'), "durable history queries must be owner-scoped");
assert.ok(historyRepository.includes('.order("started_at", { ascending: false })') && historyRepository.includes('.order("id", { ascending: false })'), "durable history ordering must be deterministic");
assert.ok(historyRepository.includes(".range(offset, offset + input.pageSize - 1)"), "durable history must paginate in the database");
assert.ok(historyRepository.includes('.eq("user_id", input.userId).in("id", durableAssetIds)'), "durable asset lookup must verify account ownership");
assert.ok(historyRepository.includes("generations.json is a read-only compatibility source"), "legacy JSON must be compatibility-only");
assert.ok(historyRepository.includes('source: "voice_generation_requests"'), "response must identify the durable source");

assert.equal(ttsRoute.includes("addGeneration("), false, "new voice requests must not write single-instance history");
assert.equal(ttsRoute.includes("VOICE_HISTORY_PERSIST_FAILED"), false, "single-instance JSON history must not gate terminal success");
assert.equal((ttsRoute.match(/historySnapshot: createVoiceHistorySnapshot\(/gu) || []).length, 4, "all four voice phases must snapshot their history input before provider work");
assert.ok(ttsRoute.includes("history_snapshot: operation.historySnapshot"), "history snapshot must be stored in the atomic lifecycle row");
assert.ok(ttsRoute.includes("const generationId = lifecycle.requestId"), "generation IDs must be stable across instances");

assert.equal(mapper.includes("responseData.audioUrl"), false, "history mapping must never trust provider media URLs from response JSON");
assert.ok(historyComponent.includes("15_000") && historyComponent.includes("visibilitychange"), "active account history must refresh every 15 seconds and on visibility changes");
assert.ok(imitatePage.includes("item.status==='processing'") && imitatePage.includes("15000"), "voice imitation must retain and refresh in-progress durable records");
assert.equal(releasePolicy.runtime?.requiredDataFiles?.includes("generations.json"), false, "release must not require single-instance generation history");
assert.equal(Object.hasOwn(releasePolicy.runtime?.requiredDataShapes || {}, "generations.json"), false, "release shape checks must not require legacy generation history");
assert.equal(releaseReadiness.includes('"generations.json"'), false, "runtime readiness must not depend on generations.json");

const snapshot = createVoiceHistorySnapshot({
  voiceModelName: "测试音色",
  inputText: "跨实例历史输入",
  outputFormat: "ogg_opus",
  speedRatio: 1.1,
  emotion: "gentle",
  engine: "volcano",
});
const completedRow: DurableVoiceHistoryRow = {
  request_id: "voice_request_12345678",
  user_id: "account-a",
  phase: "tts",
  model_id: "seed-tts-2.0",
  charge_credits: 12,
  refunded_credits: 2,
  state: "completed",
  asset_id: "owned_asset_1",
  generation_id: "voice_request_12345678",
  response: {
    success: true,
    data: {
      audioUrl: "https://provider.invalid/temporary.mp3",
      duration: 8.5,
      billing: { modelName: "不应覆盖快照名称" },
    },
  },
  metadata: { history_snapshot: snapshot },
  started_at: "2026-09-15T01:02:03.000Z",
};
const asset: OwnedVoiceHistoryAsset = {
  id: "owned_asset_1",
  storage_key: "voice/account-a/result.ogg",
  storage_provider: "tencent_cos",
  file_size: 2048,
  content_type: "audio/ogg",
};
const completed = mapDurableVoiceHistoryRow(completedRow, asset);
assert.equal(completed.userId, "account-a");
assert.equal(completed.status, "success");
assert.equal(completed.voiceModelName, "测试音色");
assert.equal(completed.inputText, "跨实例历史输入");
assert.equal(completed.outputFormat, "ogg");
assert.equal(completed.cost, 10);
assert.equal(completed.outputAssetId, "owned_asset_1");
assert.equal(completed.outputAudioUrl, "/api/storage/files/owned_asset_1/content");
assert.equal(completed.outputAudioUrl?.includes("provider.invalid"), false);

const unowned = mapDurableVoiceHistoryRow(completedRow);
assert.equal(unowned.outputAssetId, undefined);
assert.equal(unowned.outputAudioUrl, undefined);

const failed = mapDurableVoiceHistoryRow({
  ...completedRow,
  state: "refunded",
  asset_id: null,
  response: null,
  error: { code: "VOICE_GENERATION_FAILED", message: "供应商失败，已退款" },
});
assert.equal(failed.status, "failed");
assert.equal(failed.errorMessage, "供应商失败，已退款");
assert.equal(failed.inputText, "跨实例历史输入");

const processing = mapDurableVoiceHistoryRow({ ...completedRow, state: "recovery_required", asset_id: null, response: null });
assert.equal(processing.status, "processing");

const legacy: VoiceGeneration = {
  id: "legacy-1",
  userId: "account-a",
  voiceModelId: "seed-tts-1.0",
  voiceModelName: "旧音色",
  inputText: "旧输入",
  textLength: 3,
  outputAudioUrl: "https://legacy-provider.invalid/audio.mp3",
  outputStorageKey: "voice/account-a/legacy.mp3",
  outputStorageProvider: "tencent_cos",
  outputFormat: "mp3",
  speedRatio: 1,
  emotion: "neutral",
  engine: "volcano",
  cost: 1,
  status: "success",
  createdAt: "2026-01-01T00:00:00.000Z",
};
assert.equal(sanitizeLegacyVoiceHistory(legacy).outputAudioUrl, undefined);
assert.equal(sanitizeLegacyVoiceHistory(legacy, { ...asset, id: "legacy-owned" }).outputAudioUrl, "/api/storage/files/legacy-owned/content");

console.log(JSON.stringify({
  passed: true,
  checks: 40,
  realNetworkCalls: 0,
  databaseWrites: 0,
  paidModelCalls: 0,
}, null, 2));
