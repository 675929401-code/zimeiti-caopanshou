// 只读复算：用本地库当前模型行 + 候选健康纪元，重建提交时验证证明。
// 不写库、不调供应商；仅当 HMAC 与原任务 client_request_id 一致时输出 proof。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';

const SCHEMA = 'video_admin_validation.v1';
const NON_EXECUTION_FIELDS = new Set([
  'created_at', 'updated_at', 'total_requests', 'success_count', 'fail_count', 'last_success_at',
  'name', 'display_name', 'public_name', 'avatar_url', 'icon_url', 'sort_order', 'admin_notes',
]);
const MODEL_IDS = [
  'secure-skill-doubao-seedance-2-0-g37',
  'secure-skill-doubao-seedance-2-0-fast-g37',
  'secure-skill-doubao-seedance-2-5-g37',
  'secure-skill-video-2-0-fast-g16',
  'secure-skill-video-2-0-pro-g16',
];

const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const cfg = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).origin, 'http://127.0.0.1:54321');
const headers = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };

const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : (value && typeof value === 'object')
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
    : value;
const sha = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const terminalTimestamp = (value) => {
  const text = typeof value === 'string' ? value : '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const healthEpochOf = (health) => sha({
  lastSuccessAt: terminalTimestamp(health?.last_success_at),
  lastFailAt: terminalTimestamp(health?.last_fail_at),
  consecutiveFailures: Math.max(0, Number(health?.consecutive_failures) || 0),
  healthy: health?.is_healthy === true,
});

async function get(route, query = {}) {
  const url = new URL(route, cfg.supabaseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `GET ${route} failed: ${response.status}`);
  return response.json();
}

const [models, tasks] = await Promise.all([
  get('/rest/v1/video_models', { select: '*', id: `in.(${MODEL_IDS.join(',')})` }),
  get('/rest/v1/video_tasks', { select: 'id,model_id,client_request_id,status', model_id: `in.(${MODEL_IDS.join(',')})`, order: 'created_at.asc' }),
]);
const userId = tasks[0] ? undefined : undefined;
assert.equal(models.length, MODEL_IDS.length);

// 管理员身份：任务行里的 user_id（提交者本人）
const ownerByModel = new Map(tasks.map(t => [t.model_id, t.user_id]));
// 重新取 user_id（上面 select 漏了）
const tasksFull = await get('/rest/v1/video_tasks', { select: 'id,model_id,client_request_id,status,user_id', model_id: `in.(${MODEL_IDS.join(',')})`, order: 'created_at.asc' });
for (const t of tasksFull) ownerByModel.set(t.model_id, t.user_id);

const epochCandidates = (health) => [
  { label: 'null-health', health: null },
  { label: 'healthy-noterminal', health: { last_success_at: null, last_fail_at: null, consecutive_failures: 0, is_healthy: true } },
  ...(health ? [{ label: 'current', health }] : []),
];

const jwtSecret = cfg.jwtSecret;
assert.ok(jwtSecret && jwtSecret.length >= 16, 'jwtSecret missing');

const out = [];
for (const model of models) {
  const credential = String(model.api_key || '').trim();
  const executionConfig = Object.fromEntries(Object.entries(model).filter(([key]) => !NON_EXECUTION_FIELDS.has(key)));
  const configurationHash = sha({ schema: SCHEMA, model: executionConfig, resolvedCredentialHash: sha(credential) });
  const task = tasksFull.find(t => t.model_id === model.id);
  if (!task) { out.push({ modelId: model.id, error: 'no task' }); continue; }
  const uid = task.user_id;
  let matched = null;
  for (const candidate of epochCandidates(null)) {
    const healthEpoch = healthEpochOf(candidate.health);
    const expected = `vav_${createHmac('sha256', jwtSecret).update(JSON.stringify({ schema: SCHEMA, userId: uid, modelId: model.id, configurationHash, healthEpoch })).digest('hex')}`;
    if (expected === task.client_request_id) { matched = { label: candidate.label, healthEpoch }; break; }
  }
  out.push({
    modelId: model.id,
    taskId: task.id,
    status: task.status,
    matched: !!matched,
    epochLabel: matched?.label || null,
    proof: matched ? { validationKey: task.client_request_id, clientRequestId: task.client_request_id, configurationHash, healthEpoch: matched.healthEpoch } : null,
  });
}
console.log(JSON.stringify(out, null, 2));
