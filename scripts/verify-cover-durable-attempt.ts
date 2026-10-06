import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  coverAttemptProjection,
  parseCoverAttemptClaim,
  parseCoverDispatchPayload,
  type CoverAttemptRow,
} from "../src/lib/cover-durable-attempt";
import {
  mergeCoverAccountHistory,
  readCoverGenerationState,
  runCoverGeneration,
  type CoverGenerationPayload,
  type CoverGenerationTask,
} from "../src/lib/cover-generation-attempt";

async function main() {

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const plan = { title: "安全标题", subtitle: "安全副标题", aspectRatio: "3:4" as const,
  layoutTemplateId: "gaoding-teacher-interview", animationStyleId: "pet-3d" as const };
const task: CoverGenerationTask = { id: "task-durable", ratio: "3:4", title: plan.title, subtitle: plan.subtitle,
  prompt: "safe prompt", briefText: "safe brief", source: "生成", createdAt: "2026-09-25T00:00:00.000Z",
  taskNo: 1, status: "running", renderPlan: plan };
const payload: CoverGenerationPayload = { prompt: task.prompt, modelId: "pm_fixture", mode: "local", style: "",
  aspectRatio: "3:4" as const, resolution: "2K" as const, coverText: "", referenceImageUrls: [], referenceUsage: "general",
  historySurface: "cover-studio" };
const key = "cover_fixture_durable_001";
const row: CoverAttemptRow = { id: "11111111-1111-4111-8111-111111111111", user_id: "22222222-2222-4222-8222-222222222222",
  surface: "cover-studio", client_idempotency_key: key, client_trace_id: key, state: "claimed", task: { ...task, renderPlan: plan },
  generation_input: { ...payload, aspectRatio: "3:4", resolution: "2K", referenceImageUrls: [] }, requires_reference_reupload: false,
  created_at: "2026-09-25T00:00:00.000Z", updated_at: "2026-09-25T00:00:01.000Z" };
const active = coverAttemptProjection(row);

assert.ok(parseCoverAttemptClaim({ task, payload, referenceCount: 0 }));
assert.equal(parseCoverAttemptClaim({ task, payload: { ...payload, referenceImageUrls: ["data:image/png;base64,secret"] }, referenceCount: 1 }), null);
assert.ok(parseCoverDispatchPayload({ ...payload, referenceImageUrls: ["data:image/png;base64,fixture"] }));

const storedResult = { status: "completed", persisted: true, cloudStored: true,
  assetId: "33333333-3333-4333-8333-333333333333", key: "owned/final.png", url: "/owned/final.png",
  historyRecordId: "history-final", outputKind: "cover-composition", sourceAssetId: "44444444-4444-4444-8444-444444444444",
  renderedText: { title: plan.title, subtitle: plan.subtitle }, width: 768, height: 1024, sourceWidth: 768, sourceHeight: 1024,
  createdAt: "2026-09-25T00:00:02.000Z", taskNo: 1, historyVisible: true };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const storage = new MemoryStorage();
let state = readCoverGenerationState(storage, "account-a");
let dispatches = 0;
let imageGenerateCalls = 0;
const fetcher: typeof fetch = async (request, options = {}) => {
  const path = String(request);
  if (path === "/api/cover/render") return response({ ready: true });
  if (path === "/api/image/generate") { imageGenerateCalls += 1; throw new Error("client must not call image generate directly"); }
  assert.equal(path.split("?")[0], "/api/cover/attempt");
  if (options.method === "GET") return response({ success: true, activeAttempt: active, completed: false });
  const body = JSON.parse(String(options.body));
  if (body.action === "claim") return response({ success: true, activeAttempt: active, completed: false });
  assert.equal(body.action, "dispatch");
  dispatches += 1;
  return response({ success: true, completed: true, operationId: "operation-fixture", backgroundAssetId: storedResult.sourceAssetId, result: storedResult });
};
const completed = await runCoverGeneration({ userId: "account-a", token: "fixture-token", payload, task, storage,
  fetcher, onState(next) { state = next; } });
assert.equal(completed.state.pending, null);
assert.equal(state.history[0]?.assetId, storedResult.assetId);
assert.equal(dispatches, 1);
assert.equal(imageGenerateCalls, 0);
assert.equal(storage.getItem("cover-generation:v1:account-a")?.includes("safe prompt"), false);

const unknownStorage = new MemoryStorage();
const dispatchedActive = { ...active, state: "dispatched" as const, canDispatch: false,
  task: { ...active.task, status: "unknown" as const, error: "封面任务已提交，正在核验原结果" }, dispatchInput: undefined };
let unknownDispatches = 0;
const unknownFetcher: typeof fetch = async (request, options = {}) => {
  const path = String(request);
  if (path === "/api/cover/render") return response({ ready: true });
  assert.equal(path.split("?")[0], "/api/cover/attempt");
  if (options.method === "GET") return response({ success: true, activeAttempt: unknownDispatches ? dispatchedActive : active });
  const body = JSON.parse(String(options.body));
  if (body.action === "claim") return response({ success: true, activeAttempt: active });
  unknownDispatches += 1;
  return response({ success: true, completed: false, activeAttempt: dispatchedActive,
    message: "原封面任务已提交，系统不会再次调用生图服务" }, 202);
};
await runCoverGeneration({ userId: "account-unknown", token: "fixture-token", payload, task, storage: unknownStorage,
  fetcher: unknownFetcher, onState() {} });
await runCoverGeneration({ userId: "account-unknown", token: "fixture-token", recovery: true, storage: unknownStorage,
  fetcher: unknownFetcher, onState() {} });
assert.equal(unknownDispatches, 1);

const rejectedStorage = new MemoryStorage();
let rejectionDispatches = 0;
const rejectionFetcher: typeof fetch = async (request, options = {}) => {
  const path = String(request);
  if (path === "/api/cover/render") return response({ ready: true });
  assert.equal(path.split("?")[0], "/api/cover/attempt");
  if (options.method === "GET") return response({ success: true, activeAttempt: active });
  const body = JSON.parse(String(options.body));
  if (body.action === "claim") return response({ success: true, activeAttempt: active });
  rejectionDispatches += 1;
  return response({ code: "IMAGE_UPSTREAM_REQUEST_REJECTED", error: "上游明确拒绝该请求", state: "rejected",
    upstreamCalled: true, billed: false, taskSubmitted: false, canRecover: false, canResubmit: true,
    sameKeyCanResubmit: false }, 400);
};
const rejected = await runCoverGeneration({ userId: "account-rejected", token: "fixture-token", payload, task,
  storage: rejectedStorage, fetcher: rejectionFetcher, onState() {} });
assert.equal(rejected.state.pending, null);
assert.equal(rejected.state.history[0]?.status, "failed");
assert.equal(rejected.state.history[0]?.error, "上游明确拒绝该请求");
assert.equal(rejectionDispatches, 1);

const taskScopedStorage = new MemoryStorage();
const projected = mergeCoverAccountHistory(taskScopedStorage, "account-a", [], active);
assert.equal(projected.pending?.clientIdempotencyKey, key);
let duplicatedSameTask = false;
await runCoverGeneration({ userId: "account-a", token: "fixture-token", payload, task, storage: taskScopedStorage,
  fetcher: async () => { duplicatedSameTask = true; throw new Error("the same task storage must not create a duplicate claim"); },
  onState() {} });
assert.equal(duplicatedSameTask, false);

const legacyStorage = new MemoryStorage();
const legacyKey = "cover_legacy_prepost_001";
legacyStorage.setItem("cover-generation:v1:legacy", JSON.stringify({ version: 1, pending: {
  clientIdempotencyKey: legacyKey, clientTraceId: legacyKey, updatedAt: Date.now(), task,
  payload: { ...payload, modelId: "pm_stale_local", referenceImageUrls: ["data:image/png;base64,legacy-secret"] },
}, history: [] }));
const legacy = readCoverGenerationState(legacyStorage, "legacy");
assert.equal(legacy.pending?.payload?.referenceImageUrls.length, 1);
assert.equal(legacyStorage.getItem("cover-generation:v1:legacy")?.includes("data:image"), false);

const authoritativePayload = { ...payload, modelId: "pm_status_authoritative", referenceImageUrls: [], resumeDeliveryOnly: true as const };
const authoritativeRow: CoverAttemptRow = { ...row, id: "55555555-5555-4555-8555-555555555555",
  client_idempotency_key: legacyKey, client_trace_id: legacyKey,
  generation_input: { ...payload, modelId: authoritativePayload.modelId, aspectRatio: "3:4", resolution: "2K", referenceImageUrls: [] }, requires_reference_reupload: true };
const authoritativeActive = coverAttemptProjection(authoritativeRow);
let adoptedModel = "";
let recoveryDispatches = 0;
const recoveryFetcher: typeof fetch = async (request, options = {}) => {
  const path = String(request);
  if (path.startsWith("/api/image/status?")) return response({ success: true, state: "not_found", canRecover: false,
    canResubmit: false, resumeInput: authoritativePayload });
  assert.equal(path.split("?")[0], "/api/cover/attempt");
  if (options.method === "GET") return response({ success: true, activeAttempt: options.headers ? null : null });
  const body = JSON.parse(String(options.body));
  if (body.action === "adopt") {
    adoptedModel = body.payload.modelId;
    return response({ success: true, activeAttempt: authoritativeActive });
  }
  assert.equal(body.action, "dispatch");
  assert.equal(body.payload.modelId, authoritativePayload.modelId);
  assert.equal(body.payload.referenceImageUrls.length, 1);
  recoveryDispatches += 1;
  return response({ success: true, completed: true, backgroundAssetId: storedResult.sourceAssetId, result: storedResult });
};
let getCount = 0;
const wrappedRecoveryFetcher: typeof fetch = async (request, options = {}) => {
  if (String(request).startsWith("/api/cover/attempt?") && options.method === "GET") {
    getCount += 1;
    return response({ success: true, activeAttempt: getCount === 1 ? null : authoritativeActive });
  }
  return recoveryFetcher(request, options);
};
await runCoverGeneration({ userId: "legacy", token: "fixture-token", recovery: true, storage: legacyStorage,
  fetcher: wrappedRecoveryFetcher, onState() {} });
assert.equal(adoptedModel, authoritativePayload.modelId);
assert.equal(recoveryDispatches, 1);

const migration = readFileSync("supabase/migrations/20260925144500_cover_durable_attempts.sql", "utf8");
const route = readFileSync("src/app/api/cover/attempt/route.ts", "utf8");
const component = readFileSync("src/components/cover-studio.tsx", "utf8");
assert.match(migration, /cover_generation_attempts_one_active_idx/u);
assert.match(migration, /position\('data:' in lower\(task::text\)\) = 0/u);
assert.match(route, /begin_cover_generation_dispatch/u);
assert.match(route, /renderDelivered/u);
assert.match(route, /resumeDeliveryOnly:\s*true/u);
assert.doesNotMatch(readFileSync("src/lib/cover-generation-attempt.ts", "utf8"), /fetcher\("\/api\/image\/generate"/u);
assert.match(component, /handleResultImageError/u);
assert.match(component, /displayRenewalRef/u);
assert.match(component, /latestPreviewResult/u);
assert.doesNotMatch(component, /立即恢复|恢复原任务|>恢复</u);

console.log(JSON.stringify({ passed: true, providerCalls: 0, databaseWrites: 0, durableClaims: true,
  taskScopedPending: true, legacyPrePostRecovered: true, authoritativeResumeInput: true,
  brokenImageFallback: true, explicitFailurePreserved: true, noRecoveryButton: true,
  dispatches, unknownDispatches, rejectionDispatches, recoveryDispatches }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
