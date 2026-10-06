// 将已完成真实 canary 并已发布的一个视频模型，按版本化候选流程加入指定工作台。
// 只修改本地工作台分配；不提交生成任务、不调用供应商。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicModelDisplayName } from '../src/lib/public-model-dto.ts';

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(ORIGIN), 'local origin required');
const MODEL_ID = String(process.argv[2] || '').trim();
assert.ok(MODEL_ID, 'model id required');
const surfaces = (process.argv.find((value) => value.startsWith('--surfaces='))?.slice(11) || 'storyboard-video,video-page')
  .split(',').map((value) => value.trim()).filter(Boolean);
assert.ok(surfaces.length > 0 && surfaces.every((value) => ['storyboard-video', 'video-page'].includes(value)), 'unsupported surface');
assert.ok(process.argv.includes('--publish'), 'explicit --publish required');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || '').trim();
assert.ok(token && stepUp, 'admin and step-up sessions required');
const headers = { Authorization: `Bearer ${token}`, 'x-admin-step-up': stepUp, 'Content-Type': 'application/json' };

async function api(route, body) {
  const response = await fetch(`${ORIGIN}${route}`, {
    method: body ? 'POST' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store', signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}:HTTP_${response.status}:${data.code || data.error || 'unknown'}`);
  return { status: response.status, data };
}

async function catalog() {
  return (await api('/api/admin/workspace-models')).data;
}
function entry(source, surface) {
  return source.surfaces?.find((item) => item.id === surface)?.models?.find((item) => item.id === MODEL_ID);
}
async function publishRelease(releaseId) {
  const validated = await api('/api/admin/workspace-model-releases', { action: 'validate', releaseId });
  assert.equal(validated.data.release?.status, 'validated', 'candidate validation failed');
  const preview = await api(`/api/admin/workspace-model-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.data.preview?.previewSha256 || '');
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, 'preview fingerprint missing');
  const published = await api('/api/admin/workspace-model-releases', { action: 'publish', releaseId, previewSha256 });
  assert.equal(published.data.release?.status, 'published', 'candidate publication failed');
  return { releaseId, previewSha256, version: published.data.release?.release_version };
}

const before = await catalog();
const report = { checkedAt: new Date().toISOString(), modelId: MODEL_ID, providerRequests: 0, paidGenerationRequests: 0, surfaces: [] };
for (const surface of surfaces) {
  const current = await catalog();
  const model = entry(current, surface);
  assert.ok(model, `${surface}: model is not a compatible published candidate`);
  assert.equal(model.publishable, true, `${surface}: model is not publishable`);
  if (model.assigned === true) {
    report.surfaces.push({ surface, changed: false, assigned: true });
    continue;
  }
  const staged = await api('/api/admin/workspace-models', {
    action: 'assign', kind: 'video', surface, modelId: MODEL_ID, enabled: true,
  });
  assert.equal(staged.status, 202, `${surface}: assignment was not staged`);
  const releaseId = String(staged.data.result?.release?.id || '');
  assert.ok(releaseId, `${surface}: release id missing`);
  const release = await publishRelease(releaseId);
  const readback = await catalog();
  assert.equal(entry(readback, surface)?.assigned, true, `${surface}: published assignment readback failed`);
  report.surfaces.push({ surface, changed: true, assigned: true, ...release });
}

const publicSurfaces = { 'storyboard-video': 'storyboard-workbench', 'video-page': 'video-page' };
for (const surface of surfaces) {
  const publicCatalog = await api(`/api/video/models?surface=${publicSurfaces[surface]}`);
  const adminModel = entry(await catalog(), surface);
  const expectedDisplayName = publicModelDisplayName({ name: adminModel?.name });
  const publicModel = publicCatalog.data.models?.find((item) => item.displayName === expectedDisplayName);
  assert.ok(publicModel?.id, `${surface}: public catalog mapping missing`);
  const item = report.surfaces.find((value) => value.surface === surface);
  Object.assign(item, { publicId: publicModel.id, displayName: publicModel.displayName });
}
const sourceRoot = path.resolve(import.meta.dirname, '..');
const evidence = path.join(sourceRoot, '.codex-evidence', 'model-chain-audit-20261006', `${MODEL_ID}-workspace-assignment.json`);
await fs.mkdir(path.dirname(evidence), { recursive: true });
await fs.writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
