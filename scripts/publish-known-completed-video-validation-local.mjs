// 从本地任务行与不可变运行轨迹恢复已完成视频 canary 的原始证明并发布。
// 不创建任务、不查询供应商；发布接口仍会复核任务、配置、账务和自有资产。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(ORIGIN), 'local validation origin required');
const MODEL_ID = String(process.argv[2] || '').trim();
const TASK_ID = String(process.argv[3] || '').trim();
assert.ok(MODEL_ID && TASK_ID, 'usage: <modelId> <businessTaskId> --publish-completed');
assert.ok(process.argv.includes('--publish-completed'), 'explicit --publish-completed required');
assert.deepEqual(process.argv.slice(4), ['--publish-completed'], 'unexpected flags');

const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || '').trim();
assert.ok(token && stepUpToken, 'local admin and step-up sessions required');
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'x-admin-step-up': stepUpToken,
};
const runtimeFile = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const sourceRoot = path.resolve(import.meta.dirname, '..');
const traceFile = path.join(sourceRoot, '.runtime', 'canvas-video-generation.ndjson');
const evidenceFile = path.join(sourceRoot, '.codex-evidence', 'model-chain-audit-20261006', `${MODEL_ID}-known-validation-publication.json`);

async function localApi(route, body) {
  const response = await fetch(`${ORIGIN}${route}`, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(new URL(runtime.supabaseUrl).toString(), 'http://127.0.0.1:54321/', 'local database required');
const taskUrl = new URL('/rest/v1/video_tasks', runtime.supabaseUrl);
taskUrl.searchParams.set('select', 'id,user_id,model_id,client_request_id,status,task_id_external,billing_state,price_charged,completed_at');
taskUrl.searchParams.set('id', `eq.${TASK_ID}`);
const taskResponse = await fetch(taskUrl, {
  headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` },
  signal: AbortSignal.timeout(20_000),
});
assert.ok(taskResponse.ok, `task read failed: ${taskResponse.status}`);
const [task] = await taskResponse.json();
assert.equal(task?.id, TASK_ID, 'task missing');
assert.equal(task.model_id, MODEL_ID, 'task model mismatch');
assert.equal(task.status, 'completed', 'task is not completed');
assert.equal(task.billing_state, 'settled', 'task billing is not settled');
assert.ok(Number(task.price_charged) > 0, 'task has no settled charge');
assert.ok(Number.isFinite(Date.parse(String(task.completed_at || ''))), 'task completion time missing');
assert.match(String(task.client_request_id || ''), /^vav_[a-f0-9]{64}$/u, 'task is not an admin validation task');

const traceLines = (await fs.readFile(traceFile, 'utf8')).split(/\r?\n/u).filter(Boolean);
const trace = traceLines
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .findLast((entry) => entry?.phase === 'admin_validation_authorized'
    && entry.modelId === MODEL_ID
    && entry.clientRequestId === task.client_request_id);
assert.ok(trace, 'original signed validation trace missing');
assert.match(String(trace.configurationHash || ''), /^[a-f0-9]{64}$/u, 'trace configuration hash missing');
assert.match(String(trace.healthEpoch || ''), /^[a-f0-9]{64}$/u, 'trace health epoch missing');
const proof = {
  validationKey: task.client_request_id,
  clientRequestId: task.client_request_id,
  configurationHash: trace.configurationHash,
  healthEpoch: trace.healthEpoch,
};

const query = new URLSearchParams({
  modelId: MODEL_ID,
  validationKey: proof.validationKey,
  configurationHash: proof.configurationHash,
  healthEpoch: proof.healthEpoch,
});
const restored = await localApi(`/api/admin/video-models/validation?${query}`);
assert.equal(restored.status, 200, `proof restore failed: ${restored.data?.code || restored.data?.error || 'unknown'}`);
assert.equal(restored.data?.existingTask?.businessTaskId, TASK_ID, 'restored task identity mismatch');
assert.equal(restored.data?.existingTask?.status, 'completed', 'restored task is not completed');

const published = await localApi('/api/admin/video-models/validation/publish', {
  modelId: MODEL_ID,
  taskId: TASK_ID,
  confirmation: 'PUBLISH_VALIDATED_VIDEO_MODEL',
  ...proof,
});
const report = {
  checkedAt: new Date().toISOString(),
  modelId: MODEL_ID,
  taskId: TASK_ID,
  providerTaskIdPresent: Boolean(task.task_id_external),
  noProviderSubmission: true,
  restoredOriginalProof: true,
  taskStatus: task.status,
  billingState: task.billing_state,
  priceCharged: Number(task.price_charged),
  publicationHttp: published.status,
  publicationSuccess: published.data?.success === true,
  alreadyPublished: published.data?.alreadyPublished === true,
  code: published.data?.code || null,
};
await fs.mkdir(path.dirname(evidenceFile), { recursive: true });
await fs.writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
assert.equal(published.status, 200, `publish failed: ${published.data?.code || published.data?.error || 'unknown'}`);
assert.equal(published.data?.success, true, 'publish did not succeed');
