// 发布已完成的lconai图片canary：恢复proof→派生recordId→发布。
import { createHash } from 'node:crypto';
const ORIGIN = 'http://127.0.0.1:5000';
const sha = v => createHash('sha256').update(v).digest('hex');
const login = await fetch(`${ORIGIN}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '18685178259', password: 'Admin@2026abc' }),
});
const token = (await login.json()).token;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (path, body) => {
  const r = await fetch(ORIGIN + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const userId = 'b5cccb94-1d77-4e14-9391-fb3e6f823486';
const MODELS = process.argv.slice(2);
for (const modelId of MODELS) {
  const ctx = await api(`/api/admin/cover-models/validation?modelId=${modelId}`);
  const key = ctx.data.validationKey;
  console.log(modelId.slice(0, 30), 'busy=' + ctx.data.busy, key ? 'keyOK' : 'noKey', 'attempt=' + (ctx.data.attempt?.state || ctx.data.attempt?.status || '-'));
  if (!key) { console.log('  尝试发布（proof需原始key，无key跳过）'); continue; }
  const proof = { validationKey: key, configurationHash: ctx.data.configurationHash, epoch: ctx.data.epoch, clientIdempotencyKey: key, clientTraceId: key };
  const recordId = sha(`${userId}\u0000${key}`);
  const pub = await api('/api/admin/cover-models/validation/publish', {
    modelId, imageRecordId: recordId, proof, confirmation: 'PUBLISH_VALIDATED_IMAGE_MODEL',
  });
  console.log('  发布:', pub.status, JSON.stringify(pub.data).slice(0, 200));
}
