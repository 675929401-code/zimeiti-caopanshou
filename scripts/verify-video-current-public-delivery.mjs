import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.equal(origin, 'http://127.0.0.1:5000');
assert.ok(token, 'Verified local administrator token required');
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || '';
const runId = argument('run-id');
assert.match(runId, /^[A-Za-z0-9_-]{6,100}$/u);
const sourceDirs = argument('source-dirs').split(',').filter(Boolean).map((value) => path.resolve(value));
assert.ok(sourceDirs.length > 0 && sourceDirs.length <= 8, 'Bounded source directories required');
const outputDir = path.resolve('.codex-evidence/video-current-public-delivery', runId);
await fs.mkdir(outputDir, { recursive: true });
const headers = { Authorization: `Bearer ${token}` };

async function json(pathname) {
  const response = await fetch(new URL(pathname, origin), { headers, cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${new URL(pathname, origin).pathname} returned ${response.status}`);
  return body;
}

async function boundedMedia(url, label, attachment = false) {
  const target = new URL(url, origin);
  const response = await fetch(target, {
    headers: { ...(target.origin === origin ? headers : {}), Range: 'bytes=0-65535' },
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000),
  });
  assert.ok(response.ok || response.status === 206, `${label} returned ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /video|octet-stream/iu, `${label} did not return video bytes`);
  if (attachment) assert.match(response.headers.get('content-disposition') || '', /attachment/iu, `${label} is not a download response`);
  const reader = response.body?.getReader();
  let bytes = 0;
  if (reader) {
    while (bytes <= 65_536) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
    }
    await reader.cancel();
  }
  assert.ok(bytes > 1_024, `${label} returned incomplete media`);
  return { http: response.status, bytes, contentType: response.headers.get('content-type') || '', attachment };
}

const candidates = [];
for (const sourceDir of sourceDirs) {
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const result = JSON.parse(await fs.readFile(path.join(sourceDir, entry.name, 'result.json'), 'utf8'));
      if (result.state === 'completed' && result.selectedModel?.internalId && result.clientRequestId) candidates.push(result);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
const byModel = new Map();
for (const result of candidates) byModel.set(result.selectedModel.internalId, result);
const catalog = await json('/api/video/models?surface=video-page');
assert.ok(Array.isArray(catalog.models) && catalog.models.length > 0);
const current = new Map(catalog.models.map((model) => [model.id, model]));
assert.equal(byModel.size, current.size, 'Latest successful result count differs from the public video catalog');
for (const result of byModel.values()) assert.ok(current.has(result.selectedModel.publicId), `Completed model is not public: ${result.selectedModel.internalId}`);

const historyPayload = await json('/api/video/history?limit=200&offset=0');
const history = Array.isArray(historyPayload.tasks) ? historyPayload.tasks : [];
const report = { runId, checkedAt: new Date().toISOString(), publicModels: current.size, historyRecovered: 0, playbackVerified: 0, downloadVerified: 0, providerPosts: 0, databaseWrites: 0, models: [] };
for (const result of [...byModel.values()].sort((left, right) => left.selectedModel.internalId.localeCompare(right.selectedModel.internalId))) {
  const row = history.find((item) => item.clientRequestId === result.clientRequestId);
  assert.ok(row, `History missing ${result.selectedModel.internalId}`);
  assert.equal(row.status, 'completed');
  assert.equal(row.modelId, result.selectedModel.publicId);
  assert.equal(row.publicModelId, result.selectedModel.publicId);
  assert.ok(row.videoUrl, `Playback URL missing ${result.selectedModel.internalId}`);
  const playback = await boundedMedia(row.videoUrl, `${result.selectedModel.internalId} playback`);
  const ticket = await json(`/api/video/access-ticket?taskId=${encodeURIComponent(row.id)}&scope=download&name=${encodeURIComponent(`${result.selectedModel.internalId}.mp4`)}`);
  assert.ok(ticket.url);
  const download = await boundedMedia(ticket.url, `${result.selectedModel.internalId} download`, true);
  report.historyRecovered += 1;
  report.playbackVerified += 1;
  report.downloadVerified += 1;
  report.models.push({ internalId: result.selectedModel.internalId, publicId: result.selectedModel.publicId, taskId: row.id, playback, download });
  console.log(JSON.stringify({ model: result.selectedModel.internalId, history: true, playback: true, download: true }));
}
report.passed = report.historyRecovered === report.publicModels && report.playbackVerified === report.publicModels && report.downloadVerified === report.publicModels;
await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, publicModels: report.publicModels, historyRecovered: report.historyRecovered, playbackVerified: report.playbackVerified, downloadVerified: report.downloadVerified, providerPosts: 0, output: path.join(outputDir, 'report.json') }));
