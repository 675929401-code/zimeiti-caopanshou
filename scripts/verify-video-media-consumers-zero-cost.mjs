import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const sources = {};
for (const path of ['src/lib/video-media-availability.ts', 'src/components/manual-canvas.tsx', 'src/app/video/page.tsx']) sources[path] = await fs.readFile(path, 'utf8');
function evaluate(source, context = {}) {
  const module = { exports: {} };
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  vm.runInNewContext(result.outputText, { module, exports: module.exports, URLSearchParams, Date, Number, String, Error, ...context });
  return module.exports;
}
const media = evaluate(sources['src/lib/video-media-availability.ts']);
const unavailable = { status: 'completed', mediaAvailable: false, mediaUnavailableReason: 'source_expired', priceCharged: 3.5, billingState: 'settled', errorMessage: '原视频链接已失效', videoUrl: 'stale', storageUrl: 'stale', thumbnailUrl: 'stale' };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
await test('shared terminal mapping preserves billing and clears every playable URL', () => {
  for (const reason of ['source_expired', 'history_hidden']) {
    const patch = media.videoCompletedDeliveryPatch({ ...unavailable, mediaUnavailableReason: reason });
    assert.equal(patch.status, 'completed'); assert.equal(patch.priceCharged, 3.5); assert.equal(patch.billingState, 'settled');
    assert.equal(patch.mediaUnavailableReason, reason); assert.equal(patch.videoUrl, ''); assert.equal(patch.storageUrl, ''); assert.equal(patch.thumbnailUrl, ''); assert.equal(patch.needsProxy, false);
  }
  assert.equal(media.getVideoMediaUnavailable({ status: 'finalizing', mediaAvailable: false }), null);
  assert.equal(media.videoCompletedDeliveryPatch({ status: 'completed', videoUrl: 'valid' }).videoUrl, 'valid');
  assert.equal('priceCharged' in media.videoCompletedDeliveryPatch({ status: 'completed' }), false);
});
const canvas = sources['src/components/manual-canvas.tsx'];
const helper = canvas.split('// VIDEO_MEDIA_UNAVAILABLE_CONSUMER_BEGIN')[1].split('// VIDEO_MEDIA_UNAVAILABLE_CONSUMER_END')[0];
const poll = canvas.slice(canvas.indexOf('  async function pollVideo('), canvas.indexOf('  async function executeNode('));
await test('actual canvas poll stops at unavailable completed and preserves original identity/cost', async () => {
  const node = { id: 'node', data: { modelId: 'fixture', clientRequestId: 'original-key', clientRequestFingerprint: 'fingerprint', taskId: 'task', outputUrl: 'stale', actualCost: 9 } };
  const nodesRef = { current: [node] }; let gets = 0;
  const api = evaluate(helper + poll + '\nexports.pollVideo = pollVideo;', { ...media, nodesRef, VIDEO_POLL_SESSION_LIMIT_MS: 360000,
    waitForBatchPermission: async () => {}, waitForVideoPollSlot: async () => {},
    fetch: async () => { gets++; return { ok: true, json: async () => unavailable }; }, responseJson: async r => r.json(),
    replaceRuntimeNode: (_nodes, id, patch) => { assert.equal(id, node.id); node.data = { ...node.data, ...patch }; },
    delay: () => { throw new Error('UNEXPECTED_POLL'); },
  });
  await assert.rejects(api.pollVideo(node, 'task', '', '', '', 'fixture-token'), /原视频链接已失效/);
  assert.equal(gets, 1); assert.equal(node.data.clientRequestId, 'original-key'); assert.equal(node.data.clientRequestFingerprint, 'fingerprint');
  assert.equal(node.data.taskId, 'task'); assert.equal(node.data.actualCost, 3.5); assert.equal(node.data.outputUrl, ''); assert.equal(node.data.playbackStatus, 'failed'); assert.ok(node.data.generationBlockedReason);
});
const page = sources['src/app/video/page.tsx'];
const cancel = page.slice(page.indexOf('  const cancelTask = async ('), page.indexOf('  /* ── Update task field'));
assert.ok(cancel.includes('const cancelTask')); assert.ok(!cancel.includes('const submitVideoTask'));
await test('actual cancel final status check cannot cancel an already generated unavailable task', async () => {
  let tasks = [{ localId: 1, taskId: 'task', clientRequestId: 'key', status: 'processing', videoUrl: 'stale' }]; const calls = [], notices = [];
  const api = evaluate(cancel + '\nexports.cancelTask = cancelTask;', { ...media, tasksRef: { current: tasks }, auth: { token: 'fixture-token' }, duration: 5,
    setTasks: fn => { tasks = fn(tasks); }, toast: { info: m => notices.push(m), success: m => notices.push(m) },
    fetch: async (url, options) => { calls.push([url, options?.method || 'GET']); if (url.startsWith('/api/video/status?')) return { json: async () => unavailable }; if (url === '/api/cash/balance') return { json: async () => ({ balance: 10 }) }; throw new Error('UNEXPECTED_MUTATION'); },
    setCashBalance: () => {}, refreshHistoryFirstPage: () => {},
  });
  await api.cancelTask(1);
  assert.equal(tasks[0].status, 'completed'); assert.equal(tasks[0].videoUrl, ''); assert.equal(tasks[0].clientRequestId, 'key'); assert.equal(tasks[0].priceCharged, 3.5);
  assert.equal(calls.some(([, method]) => method === 'POST'), false); assert.ok(notices.includes(unavailable.errorMessage));
});
await test('actual submit entry blocks a known unavailable terminal before any submission', async () => {
  const prefix = page.slice(page.indexOf('  const submitVideoTask = async ('), page.indexOf('    if (original && requiresVideoTaskTracking(original))'));
  let notices = 0;
  const api = evaluate(prefix + '\nthrow new Error("UNEXPECTED_SUBMISSION"); }; exports.submitVideoTask=submitVideoTask;', { ...media, tasksRef: { current: [{ ...unavailable, localId: 1 }] }, toast: { info: () => notices++ } });
  await api.submitVideoTask(1); assert.equal(notices, 1);
});
await test('all page delivery paths use common mapping and JSX remains parseable', () => {
  assert.ok((page.match(/\.\.\.videoCompletedDeliveryPatch\(/g) || []).length >= 4);
  assert.ok(page.includes('视频已生成，当前不可播放'));
  // Parse actual full TSX, without importing React or touching runtime services.
  for (const [path, source] of Object.entries(sources)) { const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true); assert.equal(parsed.parseDiagnostics.length, 0, path); }
});
const directory = process.env.VIDEO_TEST_EVIDENCE_DIR;
if (directory) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(`${directory}/video-media-consumers-summary.json`, JSON.stringify({ passed, actualFunctions: ['canvas pollVideo', 'video cancelTask', 'video submitVideoTask entry', 'shared availability mapping'], realUpstreamCalls: 0, databaseWrites: 0, browserCodecTested: false }, null, 2)); }
console.log(JSON.stringify({ passed, realUpstreamCalls: 0, databaseWrites: 0 }));
