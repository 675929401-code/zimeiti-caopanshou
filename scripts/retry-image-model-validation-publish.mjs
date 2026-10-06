// 图片模型恢复重验：查现有行 → 上下文 → 受控canary → 发布。不重复创建。
// 用法: node scripts/retry-image-model-validation-publish.mjs <model_name>
import assert from 'node:assert/strict';
const ORIGIN = 'http://127.0.0.1:5000';
const MODEL_NAME = process.argv[2];
assert.ok(MODEL_NAME, '缺少 model_name 参数');

const login = await fetch(`${ORIGIN}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '18685178259', password: 'Admin@2026abc' }),
});
const token = (await login.json()).token;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (path, body) => {
  const r = await fetch(ORIGIN + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300000) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const list = await api(`/api/admin/models?type=image&query=${encodeURIComponent(MODEL_NAME)}`);
const rows = (list.data.models || list.data || []).filter(m => (m.model_name || m.name).includes(MODEL_NAME));
assert.ok(rows.length, '未找到模型行');
console.log('候选行:', rows.map(m => `${m.id} active=${m.is_active !== false} provider=${m.provider || '?'}`).join(' | '));

// 优先未激活行（激活行若未发布会拒生成）
const target = rows.find(m => m.is_active === false) || rows[0];
const modelId = target.id;
console.log('目标:', modelId);

const ctx = await api(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(modelId)}`);
if (ctx.status !== 200) { console.log('上下文失败', ctx.status, JSON.stringify(ctx.data).slice(0, 200)); process.exit(1); }
const key = ctx.data.validationKey;
if (!key) { console.log('busy或无key:', JSON.stringify(ctx.data).slice(0, 200)); process.exit(1); }
const proof = { validationKey: key, configurationHash: ctx.data.configurationHash, epoch: ctx.data.epoch, clientIdempotencyKey: key, clientTraceId: key };
console.log('[1] 上下文OK epoch=' + ctx.data.epoch);

const gen = await api('/api/image/generate', {
  mode: 'local', modelId, prompt: 'a clean product photo of a gray hoodie on pure white background, studio lighting',
  aspectRatio: '1:1', resolution: '1K', style: '', coverText: '',
  clientIdempotencyKey: key, clientTraceId: key,
  adminValidation: { confirmation: ctx.data.confirmation || 'RUN_SINGLE_REAL_IMAGE_VALIDATION', ...proof },
});
const recId = gen.data?.traceId || gen.data?.recordId || gen.data?.record_id || gen.data?.imageRecordId;
console.log('[2] canary', gen.status, 'recId=' + (recId || '-'), 'state=' + (gen.data?.status || gen.data?.state || '-'), (gen.data?.error || '').slice(0, 120));
if (gen.status >= 400 || !recId) process.exit(1);

let ready = gen.data?.status === 'completed';
for (let i = 0; !ready && i < 36; i += 1) {
  await new Promise(r => setTimeout(r, 5000));
  const st = await api(`/api/image/status?recordId=${encodeURIComponent(recId)}`);
  const state = st.data?.state || st.data?.status;
  if (state === 'completed' || state === 'delivered') { ready = true; break; }
  if (state === 'failed') break;
  if (i % 4 === 3) console.log('   轮询', state);
}
console.log('[3] 生成状态:', ready ? '完成' : '未就绪');
if (!ready) process.exit(1);

const pub = await api('/api/admin/cover-models/validation/publish', {
  modelId, imageRecordId: recId, proof, confirmation: 'PUBLISH_VALIDATED_IMAGE_MODEL',
});
console.log('[4] 发布:', pub.status, JSON.stringify(pub.data).slice(0, 200));
