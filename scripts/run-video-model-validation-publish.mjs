// 视频模型正规验证发布：默认只读；新建 canary 和发布都必须显式授权。
// 只读核对: node scripts/run-video-model-validation-publish.mjs <modelId>
// 新建 canary: ... <modelId> --submit-new-canary
// 发布已完成 canary: ... <modelId> --publish-completed
// 新建并在完成后发布: ... <modelId> --submit-new-canary --publish-completed
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(ORIGIN), 'local validation origin required');
const MODEL_ID = process.argv[2];
assert.ok(MODEL_ID, '缺少 modelId 参数');
const CLI_FLAGS = new Set(process.argv.slice(3));
const ALLOW_NEW_CANARY = CLI_FLAGS.has('--submit-new-canary');
const ALLOW_PUBLISH = CLI_FLAGS.has('--publish-completed');
for (const flag of CLI_FLAGS) {
  assert.ok(
    ['--submit-new-canary', '--publish-completed'].includes(flag),
    `未知参数: ${flag}`,
  );
}
const CANARY_PROMPT = 'gray hoodie product photo on clean white background';
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || '').trim();
assert.ok(stepUpToken, 'LOCAL_ADMIN_STEP_UP_TOKEN_REQUIRED');
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'x-admin-step-up': stepUpToken,
};
const LOCAL_RUNTIME = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const DEFAULT_IMAGE_ASSET_ID = '6eb959db-9957-42cc-acc9-bc5cdd40d28a';
const api = async (path, body, method) => {
  const r = await fetch(ORIGIN + path, { method: method || (body ? 'POST' : 'GET'), headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300000) });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};
const stopWithoutReplay = (code, reason, details = {}) => {
  console.error(JSON.stringify({
    stopped: true,
    retrySubmitted: false,
    reason,
    modelId: MODEL_ID,
    ...details,
  }));
  process.exit(code);
};

async function ownedCanaryImageUrl() {
  const me = await api('/api/auth/me');
  assert.equal(me.status, 200, 'admin session lookup failed');
  const userId = String(me.data?.user?.id || '');
  assert.ok(userId, 'admin user id missing');
  const runtime = JSON.parse((await fs.readFile(LOCAL_RUNTIME, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(new URL(runtime.supabaseUrl).toString(), 'http://127.0.0.1:54321/', 'local database required');
  const lookup = new URL('/rest/v1/user_files', runtime.supabaseUrl);
  lookup.searchParams.set('select', 'id,storage_key,content_type');
  lookup.searchParams.set('user_id', `eq.${userId}`);
  lookup.searchParams.set('content_type', 'in.(image/png,image/jpeg,image/webp)');
  lookup.searchParams.set('order', 'created_at.desc');
  lookup.searchParams.set('limit', '20');
  const response = await fetch(lookup, {
    headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.ok, `owned image lookup failed: ${response.status}`);
  const rows = await response.json();
  const row = rows.find(item => item.id === DEFAULT_IMAGE_ASSET_ID) || rows[0];
  assert.ok(row?.storage_key && /^image\//u.test(String(row.content_type || '')), 'owned image asset missing');
  const signed = await api(`/api/file?key=${encodeURIComponent(row.storage_key)}`);
  assert.equal(signed.status, 200, 'owned image signing failed');
  const url = new URL(String(signed.data?.url || ''));
  assert.equal(url.protocol, 'https:', 'provider image must use HTTPS');
  const probe = await fetch(url, { headers: { Range: 'bytes=0-1023' }, redirect: 'manual', signal: AbortSignal.timeout(25_000) });
  assert.ok([200, 206].includes(probe.status), `owned image probe failed: ${probe.status}`);
  assert.match(probe.headers.get('content-type') || '', /^image\//u, 'owned image content type invalid');
  const reader = probe.body?.getReader();
  assert.ok(reader, 'owned image probe body missing');
  const first = await reader.read();
  assert.ok(!first.done && first.value.byteLength > 0, 'owned image probe body empty');
  await reader.cancel();
  return url.toString();
}

// 1. 验证上下文
const ctx = await api(`/api/admin/video-models/validation?modelId=${encodeURIComponent(MODEL_ID)}`);
assert.equal(ctx.status, 200, `context failed: ${JSON.stringify(ctx.data).slice(0, 200)}`);
const proof = { validationKey: ctx.data.validationKey, clientRequestId: ctx.data.validationKey, configurationHash: ctx.data.configurationHash, healthEpoch: ctx.data.healthEpoch };
console.log(`[1] 上下文OK ch=${proof.configurationHash.slice(0, 12)} he=${proof.healthEpoch.slice(0, 12)}`);
const modelRow = await api(`/api/admin/video-models?query=${encodeURIComponent(MODEL_ID)}`).catch(() => ({ status: 0, data: {} }));
const modelInfo = (modelRow.data.models || []).find(m => m.id === MODEL_ID);
const minimumInput = ctx.data.minimumInput && typeof ctx.data.minimumInput === 'object' ? ctx.data.minimumInput : {};
const canaryResolution = minimumInput.resolution || modelInfo?.api_protocol_config?.default_resolution || ctx.data.outputCapabilities?.defaultResolution || '720p';
const configuredDurations = Array.isArray(modelInfo?.api_protocol_config?.duration_options)
  ? modelInfo.api_protocol_config.duration_options.map(Number).filter(value => Number.isFinite(value) && value > 0)
  : [];
const canaryDuration = Number(minimumInput.durationSeconds) > 0
  ? Number(minimumInput.durationSeconds)
  : configuredDurations.length
  ? Math.min(...configuredDurations)
  : Math.max(1, Number(modelInfo?.api_protocol_config?.min_duration) || Number(modelInfo?.duration_seconds) || 4);
console.log(`[1b] canary分辨率=${canaryResolution} 时长=${canaryDuration}`);
const existingTask = ctx.data.existingTask;
let businessTaskId = '';
let taskId = '';
let shouldPoll = false;
if (existingTask?.status === 'completed') {
  businessTaskId = String(existingTask.businessTaskId || '');
  assert.ok(businessTaskId, 'completed proof is missing businessTaskId');
  console.log('[1b] 该证明已有完成任务，跳过提交并直接发布:', businessTaskId);
} else if (existingTask && ['pending', 'queued', 'processing'].includes(String(existingTask.status || '').toLowerCase())) {
  businessTaskId = String(existingTask.businessTaskId || '');
  assert.ok(businessTaskId, 'processing proof is missing businessTaskId');
  if (!ALLOW_PUBLISH) stopWithoutReplay(2, 'EXISTING_CANARY_STILL_PROCESSING', { businessTaskId, status: String(existingTask.status || '') });
  taskId = businessTaskId;
  shouldPoll = true;
  console.log('[1c] 恢复原验证任务，仅轮询不重提:', businessTaskId);
}

if (!businessTaskId) {
  if (!ALLOW_NEW_CANARY) {
    stopWithoutReplay(0, 'READ_ONLY_NO_COMPLETED_CANARY', {
      actionRequired: '如确需产生新的上游费用，请显式传入 --submit-new-canary',
    });
  }

  // 2. 受控 canary 提交（lconai -i2v 渠道SKU需要参考图；用与A/B一致的公开卫衣图）
  const CANARY_IMAGE = 'https://daai-asset.da-ai.vip/users/4d2e20eb-4cfb-4d72-acbc-e60e8ff0b86e/assets/31ac1940-9a1e-4934-af6d-853b5d92515f.png';
  const minimumImageCount = Math.max(0, Number(minimumInput.imageCount) || 0);
  const needsImage = minimumImageCount > 0 || /i2v|grok-imagine-video/i.test(String(modelInfo?.model_name || ''));
  const canaryImage = needsImage ? await ownedCanaryImageUrl() : CANARY_IMAGE;
  const imageInput = !needsImage
    ? {}
    : minimumInput.firstFrameRequired === true || ctx.data.capabilities?.mode === 'flexible_image'
      ? { image_url: canaryImage }
      : { reference_image_urls: Array(Math.max(1, minimumImageCount)).fill(canaryImage) };
  const submit = await api('/api/video/generate', {
    model_id: MODEL_ID, prompt: CANARY_PROMPT, duration: canaryDuration, aspect_ratio: '16:9', resolution: canaryResolution,
    client_request_id: proof.clientRequestId,
    admin_validation: true, admin_validation_key: proof.validationKey,
    admin_validation_confirmation: 'AUTHORIZE_ONE_REAL_VIDEO_CANARY',
    ...imageInput,
  });
  if (submit.status === 202 && submit.data?.submission_outcome === 'unknown') {
    businessTaskId = String(submit.data.business_task_id || '');
    assert.ok(businessTaskId, 'unknown submission is missing businessTaskId');
    taskId = businessTaskId;
    shouldPoll = true;
    console.log('[2] 提交结果未知，改为只轮询原业务任务:', businessTaskId);
  } else {
    assert.equal(submit.status, 200, `submit failed: ${JSON.stringify(submit.data).slice(0, 300)}`);
    taskId = String(submit.data.taskId || submit.data.task_id || '');
    assert.ok(taskId, `no taskId: ${JSON.stringify(submit.data).slice(0, 200)}`);
    shouldPoll = true;
    console.log(`[2] canary已提交 taskId=${taskId}`);
  }
}

if (shouldPoll) {
  // 3. 轮询到 completed
  let final = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise(r => setTimeout(r, 15000));
    const s = await api(`/api/video/status?taskId=${encodeURIComponent(taskId)}&modelId=${encodeURIComponent(MODEL_ID)}&prompt=${encodeURIComponent(CANARY_PROMPT)}`);
    if (s.status === 200 && (s.data.status === 'completed' || s.data.status === 'failed')) { final = s.data; break; }
    if (i % 4 === 3) console.log(`[3] 轮询中 ${i + 1}/60 status=${s.data.status ?? s.status} stage=${s.data.processingStage ?? ''} err=${s.data.errorCode ?? ''}`);
  }
  if (!final) {
    stopWithoutReplay(2, 'CANARY_STILL_PROCESSING_AFTER_POLL_WINDOW', { providerTaskId: taskId });
  }
  assert.equal(final.status, 'completed', `canary失败: ${final.errorMessage || ''}`);
  console.log('[3] canary已完成');

  // 3b. 用 proof 恢复上下文拿确定性的业务任务ID（generate 返回的是外部任务号）
  const restore = await api(`/api/admin/video-models/validation?modelId=${encodeURIComponent(MODEL_ID)}&validationKey=${proof.validationKey}&configurationHash=${proof.configurationHash}&healthEpoch=${proof.healthEpoch}`);
  assert.equal(restore.status, 200, `restore failed: ${JSON.stringify(restore.data).slice(0, 200)}`);
  businessTaskId = String(restore.data.existingTask?.businessTaskId || '');
  assert.ok(businessTaskId, `no businessTaskId: ${JSON.stringify(restore.data).slice(0, 200)}`);
  assert.equal(restore.data.existingTask.status, 'completed', `restore task not completed: ${restore.data.existingTask?.status}`);
  console.log(`[3b] 业务任务ID=${businessTaskId}`);
}

// 4. 发布
if (!ALLOW_PUBLISH) {
  stopWithoutReplay(0, 'COMPLETED_CANARY_NOT_PUBLISHED_IN_READ_ONLY_MODE', {
    businessTaskId,
    actionRequired: '如确需发布已完成证明，请显式传入 --publish-completed',
  });
}
const pub = await api('/api/admin/video-models/validation/publish', {
  modelId: MODEL_ID, taskId: businessTaskId, confirmation: 'PUBLISH_VALIDATED_VIDEO_MODEL', ...proof,
});
console.log('[4] 发布响应:', pub.status, JSON.stringify(pub.data).slice(0, 300));
assert.equal(pub.status, 200, 'publish failed');
assert.equal(pub.data.success, true, 'publish not success');
console.log(`[OK] ${MODEL_ID} 已发布 evidence_ready`);
