import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
const directory = '.codex-evidence/hidden-video-publication-plan-20260903';
const plan = JSON.parse(await fs.readFile(`${directory}/plan.json`, 'utf8'));
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ mode: 'plan', count: plan.rows.length, generationRequests: 0 }));
  process.exit(0);
}
const config = JSON.parse(await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
assert.ok(config.localOnly && config.ownerConnection.host === '127.0.0.1' && config.ownerConnection.port === 54322);
assert.ok(process.env.LOCAL_NAV_ADMIN_TOKEN);
const headers = { Authorization: `Bearer ${process.env.LOCAL_NAV_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
async function api(path, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  return { status: response.status, data: await response.json() };
}
const actor = await api('/api/auth/me');
assert.equal(actor.data.user.role, 'admin');
const ownerHash = createHash('sha256').update(actor.data.user.id).digest('hex');
const summary = { at: new Date().toISOString(), origin, generationRequests: 0, rows: [] };
for (const row of plan.rows) {
  assert.ok(row.readyForExistingPublicationApi && Object.values(row.checks).every(Boolean));
  assert.equal(ownerHash, row.originalOwnerHash);
  const proofBytes = await fs.readFile(row.proofSource.path);
  assert.equal(createHash('sha256').update(proofBytes).digest('hex'), row.proofSource.sha256);
  const proof = JSON.parse(proofBytes);
  const query = new URLSearchParams({ modelId: row.modelId, validationKey: proof.clientRequestId, configurationHash: proof.configurationHash, healthEpoch: proof.healthEpoch });
  const original = await api(`/api/admin/video-models/validation?${query}`);
  assert.equal(original.status, 200);
  assert.equal(original.data.existingTask.businessTaskId, row.taskId);
  assert.equal(original.data.existingTask.status, 'completed');
  const request = { modelId: row.modelId, taskId: row.taskId, validationKey: proof.clientRequestId, clientRequestId: proof.clientRequestId, configurationHash: proof.configurationHash, healthEpoch: proof.healthEpoch, confirmation: 'PUBLISH_VALIDATED_VIDEO_MODEL' };
  const record = { modelId: row.modelId, taskId: row.taskId, at: new Date().toISOString(), phase: 'dispatching' };
  const path = `${directory}/${row.modelId}.publication.json`;
  await fs.writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx' });
  try {
    const response = await api(plan.targetEndpoint, request);
    Object.assign(record, { phase: 'responded', http: response.status, success: response.data.success === true, returnedTaskId: response.data.taskId, code: response.data.code });
    assert.equal(response.status, 200);
    assert.equal(response.data.taskId, row.taskId);
    assert.equal(response.data.success, true);
    const catalog = await api('/api/video/models?surface=video-page');
    assert.equal(catalog.status, 200);
    record.publicVisible = catalog.data.models.some(model => model.id === row.publicModelId);
    assert.equal(record.publicVisible, true);
    record.passed = true;
  } catch (error) {
    record.passed = false;
    record.error = error?.name || 'Error';
    if (record.phase === 'dispatching') record.phase = 'unknown';
  }
  await fs.writeFile(path, JSON.stringify(record, null, 2));
  summary.rows.push(record);
  await fs.writeFile(`${directory}/execution.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(record));
}
summary.passed = summary.rows.length === plan.rows.length && summary.rows.every(row => row.passed);
await fs.writeFile(`${directory}/execution.json`, JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
