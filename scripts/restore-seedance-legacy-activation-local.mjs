import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const MODEL_ID = "seedance-2-0-fast-digital-human-gaorui";
const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const HISTORICAL_STATE_PATH = ".codex-evidence/admin-video-model-crud-20260903/local-video-crud-f328c390-02ba-426d-8e49-92f7f2ca317d/before.json";
const EVIDENCE_PATH = ".codex-evidence/r275-funding-health-policy/legacy-activation-restore.json";

if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({
    mode: "plan",
    modelId: MODEL_ID,
    databaseWrites: 0,
    providerRequests: 0,
    paidRequests: 0,
    action: "Restore a pre-existing model from an incorrectly retained pending activation gate",
  }, null, 2));
  process.exit(0);
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(new URL(runtime.supabaseUrl).origin, "http://127.0.0.1:54321", "Only the local database may be changed");
const headers = {
  apikey: runtime.serviceRoleKey,
  Authorization: `Bearer ${runtime.serviceRoleKey}`,
};

async function get(table, query) {
  const url = new URL(`/rest/v1/${table}`, runtime.supabaseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, `GET ${table} failed: ${response.status}`);
  return response.json();
}

const [models, tasks, healthRows, historicalRows] = await Promise.all([
  get("video_models", {
    select: "id,name,provider,protocol_type,api_endpoint,is_active,is_hidden,created_at,api_protocol_config",
    id: `eq.${MODEL_ID}`,
  }),
  get("video_tasks", {
    select: "id,status,task_id_external,storage_url,completed_at",
    model_id: `eq.${MODEL_ID}`,
    status: "eq.completed",
    order: "completed_at.asc",
  }),
  get("video_channel_health", {
    select: "channel_id,is_healthy,last_success_at,last_fail_at,last_error",
    channel_id: `eq.${MODEL_ID}`,
  }),
  fs.readFile(HISTORICAL_STATE_PATH, "utf8").then(JSON.parse),
]);

assert.equal(models.length, 1, "Target model is missing");
const model = models[0];
const gate = model.api_protocol_config?.__model_activation_gate;
assert.equal(model.provider, "gaorui");
assert.equal(model.protocol_type, "gaorui_video");
assert.equal(new URL(model.api_endpoint).hostname, "gaorui.cc");
assert.equal(model.is_active, false);
assert.equal(model.is_hidden, false);
assert.equal(gate?.schema, "media_model_activation_gate.v1");
assert.equal(gate?.state, "pending");
assert.ok(!gate?.evidence, "Accepted publication evidence must not be overwritten");
assert.ok(tasks.length >= 1, "No historical completed provider task exists");
assert.ok(tasks.every((task) => task.task_id_external && task.storage_url && task.completed_at));

const health = healthRows[0];
assert.ok(health?.last_success_at, "No historical provider success exists");
assert.match(String(health?.last_error || ""), /balance|quota|arrearage|额度|余额/iu);

const historical = historicalRows.find((row) => row.id === MODEL_ID && row.type === "video");
assert.equal(historical?.active, true, "Historical public activation evidence is missing");
assert.equal(historical?.hidden, false, "Historical visibility evidence is missing");

const { __model_activation_gate: ignoredGate, ...restoredConfig } = model.api_protocol_config || {};
void ignoredGate;
const updateUrl = new URL("/rest/v1/video_models", runtime.supabaseUrl);
updateUrl.searchParams.set("id", `eq.${MODEL_ID}`);
updateUrl.searchParams.set("is_active", "eq.false");
const updateResponse = await fetch(updateUrl, {
  method: "PATCH",
  headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ is_active: true, api_protocol_config: restoredConfig }),
  signal: AbortSignal.timeout(10_000),
});
assert.ok(updateResponse.ok, `PATCH video_models failed: ${updateResponse.status}`);
const updatedRows = await updateResponse.json();
assert.equal(updatedRows.length, 1, "Concurrent model update prevented restoration");
const updated = updatedRows[0];
assert.equal(updated.is_active, true);
assert.equal(updated.is_hidden, false);
assert.equal(updated.api_protocol_config?.__model_activation_gate, undefined);

const evidence = {
  at: new Date().toISOString(),
  localDatabaseOnly: true,
  modelId: MODEL_ID,
  provider: "gaorui",
  endpointHost: "gaorui.cc",
  classification: "relay",
  reason: "The existing model was publicly active before the stricter activation gate became authoritative and has completed provider tasks. A later funding failure must not suspend it.",
  currentPaidAcceptancePerformed: false,
  providerRequests: 0,
  paidRequests: 0,
  before: { active: model.is_active, hidden: model.is_hidden, gate },
  historicalPublicState: { source: HISTORICAL_STATE_PATH, active: historical.active, hidden: historical.hidden },
  completedTaskEvidence: tasks.map((task) => ({ id: task.id, hasProviderTaskId: Boolean(task.task_id_external), hasStableStorage: Boolean(task.storage_url), completedAt: task.completed_at })),
  healthEvidence: { healthyFlag: health.is_healthy, lastSuccessAt: health.last_success_at, lastFailAt: health.last_fail_at, lastErrorClass: "UPSTREAM_QUOTA_OR_BALANCE" },
  after: { active: updated.is_active, hidden: updated.is_hidden, activationGatePresent: Boolean(updated.api_protocol_config?.__model_activation_gate) },
  rollback: { is_active: false, restoreActivationGate: gate },
};
await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  modelId: MODEL_ID,
  active: true,
  hidden: false,
  historicalCompletedTasks: tasks.length,
  providerRequests: 0,
  paidRequests: 0,
  evidence: EVIDENCE_PATH,
}, null, 2));
