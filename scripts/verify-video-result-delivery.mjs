import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.1:5000';
const taskId = process.argv.find(value => value.startsWith('--task-id='))?.slice(10);
const modelId = process.argv.find(value => value.startsWith('--model-id='))?.slice(11);
const evidence = process.argv.find(value => value.startsWith('--evidence='))?.slice(11);
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.match(taskId || '', /^vt_[A-Za-z0-9]{20,100}$/u);
assert.match(modelId || '', /^[A-Za-z0-9_-]{2,160}$/u);
assert.ok(evidence && !evidence.includes('..'));
assert.ok(token, 'Normal admin session required');

async function json(route) {
  const response = await fetch(`${origin}${route}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${route} failed: ${response.status}`);
  return body;
}

async function media(scope) {
  const ticket = await json(`/api/video/access-ticket?${new URLSearchParams({ taskId, scope, name: `acceptance-${taskId}.mp4` })}`);
  assert.ok(typeof ticket?.url === 'string' && ticket.url.startsWith('/api/'));
  const response = await fetch(new URL(ticket.url, origin), {
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.status === 200 || response.status === 206);
  assert.match(response.headers.get('content-type') || '', /^video\//u);
  assert.ok(bytes.length > 1024);
  return {
    http: response.status,
    contentType: response.headers.get('content-type'),
    bytesRead: bytes.length,
    contentRange: response.headers.get('content-range'),
    attachment: /attachment/iu.test(response.headers.get('content-disposition') || ''),
  };
}

const history = await json('/api/video/history?limit=200&offset=0');
const items = Array.isArray(history?.tasks) ? history.tasks : Array.isArray(history?.items) ? history.items : Array.isArray(history?.records) ? history.records : [];
const row = items.find(item => item.id === taskId);
assert.ok(row, 'Completed task absent from history');
assert.equal(row.status, 'completed');
assert.equal(row.modelId, modelId);
assert.equal(Number(row.priceCharged || 0), 0);
assert.ok(!row.errorMessage, 'Completed history must not retain an error');

const report = {
  at: new Date().toISOString(),
  taskId,
  modelId,
  history: { present: true, status: row.status, billingState: row.billingState || null, priceCharged: Number(row.priceCharged || 0), errorMessageEmpty: !row.errorMessage },
  playback: await media('playback'),
  download: await media('download'),
  providerSubmissions: 0,
};
const target = path.resolve(evidence);
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
