import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

const output = path.resolve('.codex-evidence/storyboard-delivery-audit-20261023/repair/history/tests.json');
const hashes = {}, checks = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => { const text = fs.readFileSync(file, 'utf8'); hashes[file] = sha(text); return text; };
const globals = { Blob, Response, Headers, URL, Date, Uint8Array, DOMException, AbortController, console,
  fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); } };
function compile(source, imports = {}, extra = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const exports = {}; vm.runInNewContext(compiled.outputText, { ...globals, ...extra, exports, require(name) {
    if (name.endsWith('.css')) return {};
    if (!(name in imports)) throw new Error('UNSTUBBED_IMPORT:' + name);
    return imports[name];
  } }); return exports;
}
function extract(file, names) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found = new Map();
  function visit(node) { if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && names.includes(node.name.getText(tree))) {
    found.set(node.name.getText(tree), (ts.isVariableDeclaration(node) ? 'const ' : '') + node.getText(tree) + (ts.isVariableDeclaration(node) ? ';' : ''));
  } ts.forEachChild(node, visit); }
  visit(tree); for (const name of names) assert.ok(found.has(name), 'MISSING_FUNCTION:' + name);
  return [...found.values()].join('\n') + '\nexports.__picked={' + names.join(',') + '};';
}
async function check(name, test) { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }

const policy = compile(read('src/lib/video-history-policy.ts'));
const archive = compile(read('src/lib/storyboard-video-archive-policy.ts'));
const view = compile(read('src/lib/storyboard-history-view.ts'), { './video-history-policy': policy });
const files = compile(read('src/lib/video-download-file.ts'));
const mapper = compile(extract('src/app/api/video/history/route.ts', ['mapTaskRow']), {}, {
  ...archive, publicModelDisplayName: () => 'Synthetic model', toPublicModelId: () => 'synthetic',
  canRetryVideoHistoryTask: () => false, supportsConfirmedVideoCancellation: () => false,
  getVideoInputContract: () => ({ requiresSourceVideo: false }), videoTokenBillingMessage: () => '',
}).__picked.mapTaskRow;
const createdAt = new Date(Date.now() - 3600000).toISOString();
const legacyRow = { id: 'fixture-legacy-0001', task_label: '分镜工作台', status: 'completed', created_at: createdAt,
  completed_at: createdAt, video_url: 'https://synthetic.invalid/video.mp4', billing_state: null, card_index: 1 };
const projected = JSON.parse(JSON.stringify(mapper(legacyRow)));
await check('legacy null billing survives JSON as absent and remains playable', () => {
  assert.equal('billingState' in projected, false);
  assert.equal(projected.mediaAvailable, true);
  assert.equal(view.storyboardRecordState({ ...projected, taskId: projected.id }), 'playable');
  assert.equal(policy.isVideoHistoryProtected(projected), false);
});
await check('explicit unresolved billing and delete protection are unchanged', () => {
  for (const billing_state of ['', 'unknown', 'billing_review', 'settled_pending_commit']) {
    const row = mapper({ ...legacyRow, billing_state });
    assert.equal(row.billingState, billing_state); assert.equal(policy.isVideoHistoryProtected(row), true);
    assert.equal(view.storyboardRecordState({ ...row, taskId: row.id }), 'active');
  }
});
await check('expired media needs a verified local copy; unfinished work remains active', () => {
  const expired = { taskId: 'expired', status: 'completed', createdAt, deliveryState: 'expired', mediaAvailable: false };
  assert.equal(view.storyboardRecordState(expired), 'unavailable'); assert.equal(view.storyboardRecordState(expired, true), 'playable');
  assert.equal(view.storyboardRecordState({ ...expired, status: 'processing' }, true), 'active');
});
const source = extract('src/components/video-history-panel.tsx', ['fetchVideoBlob', 'isPickerActivationError', 'saveWithPicker', 'saveManyToDirectory']);
function saveFixture({ mime = 'video/mp4', status = 200, pickerError, available = true, signal } = {}) {
  const writes = [], fallbacks = [], selected = [], body = new Uint8Array([1, 3, 5, 7]);
  const handle = name => ({ createWritable: async () => ({ write: async blob => writes.push({ name, mime: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] }), close: async () => {} }) });
  const pickerWindow = () => available ? {
    showSaveFilePicker: async options => { selected.push(options); if (pickerError) throw pickerError; return handle(options.suggestedName); },
    showDirectoryPicker: async () => { if (pickerError) throw pickerError; return { getFileHandle: async name => handle(name) }; },
  } : {};
  const api = compile(source, {}, { videoDownloadFile: files.videoDownloadFile, pickerWindow,
    downloadBlob: (blob, name) => fallbacks.push({ name, mime: blob.type, size: blob.size }),
    fetch: async () => { signal?.throwIfAborted(); return new Response(body, { status, headers: { 'content-type': mime } }); },
  }).__picked;
  return { api, writes, fallbacks, selected };
}
for (const [mime, extension] of [['video/mp4', 'mp4'], ['video/webm', 'webm'], ['video/quicktime', 'mov']]) {
  await check(mime + ' single and batch save names match original byte container', async () => {
    const fixture = saveFixture({ mime });
    await fixture.api.saveWithPicker('/synthetic', '分镜-1.mp4');
    await fixture.api.saveManyToDirectory([{ url: '/synthetic', name: '分镜-2.mp4' }]);
    assert.equal(fixture.writes.length, 2);
    assert.ok(fixture.writes.every(write => write.name.endsWith('.' + extension) && write.mime === mime));
    assert.deepEqual(fixture.writes[0].bytes, [1, 3, 5, 7]);
    assert.deepEqual(Object.keys(fixture.selected[0].types[0].accept), [mime]);
  });
}
await check('no-picker and lost user activation fall back with correct WebM filename', async () => {
  for (const options of [{ available: false }, { pickerError: new DOMException('Activation expired', 'SecurityError') }]) {
    const fixture = saveFixture({ mime: 'video/webm', ...options });
    assert.equal(await fixture.api.saveWithPicker('/synthetic', 'single.mp4'), 'fallback');
    assert.equal(await fixture.api.saveManyToDirectory([{ url: '/synthetic', name: 'batch.mp4' }]), 'fallback');
    assert.equal(fixture.fallbacks.length, 2); assert.ok(fixture.fallbacks.every(file => file.name.endsWith('.webm')));
  }
});
await check('cancelled picker never silently downloads a fallback', async () => {
  const fixture = saveFixture({ pickerError: new DOMException('Cancelled', 'AbortError') });
  await assert.rejects(fixture.api.saveWithPicker('/synthetic', 'file.mp4'), { name: 'AbortError' });
  await assert.rejects(fixture.api.saveManyToDirectory([{ url: '/synthetic', name: 'file.mp4' }]), { name: 'AbortError' });
  assert.equal(fixture.writes.length + fixture.fallbacks.length, 0);
});
await check('HTTP failures, error documents, aborted reads do not create video files', async () => {
  for (const options of [{ status: 503 }, { mime: 'application/json' }]) {
    const fixture = saveFixture(options);
    await assert.rejects(fixture.api.saveWithPicker('/synthetic', 'file.mp4'));
    assert.equal(fixture.writes.length + fixture.fallbacks.length, 0);
  }
  const controller = new AbortController(); controller.abort();
  const fixture = saveFixture({ signal: controller.signal });
  await assert.rejects(fixture.api.saveWithPicker('/synthetic', 'file.mp4', controller.signal), { name: 'AbortError' });
  assert.equal(fixture.selected.length, 0);
});
const gallery = compile(read('src/components/storyboard-history-browser.tsx'), {
  react: React, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '@/lib/video-history-policy': policy, '@/lib/storyboard-history-view': view,
}).StoryboardHistoryBrowser;
function render(items, extra = {}) {
  return renderToStaticMarkup(React.createElement(gallery, { items, localTaskIds: new Set(), renderCover: () => 'Cover',
    loading: false, onBack() {}, onRefresh() {}, onRequestClear() {}, batchBusy: '', onDownloadBatch() {}, onDownloadVideo() {}, onPreview() {}, ...extra }));
}
await check('simple gallery summarizes unfinished work without task details or IDs', () => {
  const markup = render([{ taskId: 'private-queued-task-id', status: 'queued', createdAt, cardIndex: 0, statusDetail: '等待上游资源' },
    { taskId: 'private-failed-task-id', status: 'failed', createdAt, cardIndex: 1, errorMessage: '上游任务已失败' },
    { taskId: 'private-cancelled-task-id', status: 'cancelled', createdAt, cardIndex: 2 }]);
  for (const label of ['进行中 1', '失败或取消 2', '暂无已完成的视频', '返回工作台查看']) assert.ok(markup.includes(label), label);
  for (const hidden of ['<details', '<summary', '<ul', 'private-', '等待上游资源', '上游任务已失败', '参数恢复']) assert.equal(markup.includes(hidden), false, hidden);
  assert.equal(markup.includes('sbh-storyboard-cover'), false);
});
await check('legacy completed video renders an enabled play control alongside unfinished work', () => {
  const markup = render([{ ...projected, taskId: projected.id }, { taskId: 'queued', status: 'queued', createdAt }]);
  assert.match(markup, /class="sbh-storyboard-cover sbh-card-play"[^>]*>/u);
  assert.doesNotMatch(markup, /class="sbh-storyboard-cover sbh-card-play"[^>]*disabled/u);
  assert.ok(markup.includes('进行中 1'));
  assert.doesNotMatch(markup, /<(?:details|summary)\b/u);
});
await check('error, pagination and recovery states remain actionable in the simple gallery', () => {
  const markup = render([], { error: 'Synthetic history unavailable', hasMore: true, onLoadMore() {}, hasRecovery: true,
    recoveryContent: React.createElement('span', null, 'Private project parameters and task ID') });
  for (const label of ['历史暂时无法读取', 'Synthetic history unavailable', '加载更多视频', '未完成项目可返回工作台继续制作。', '返回工作台查看']) assert.ok(markup.includes(label), label);
  assert.doesNotMatch(markup, /<(?:details|summary)\b/u);
  assert.equal(markup.includes('Private project parameters and task ID'), false);
});
const report = { passed: true, checks, sourceHashes: hashes, networkCalls: 0, databaseCalls: 0, modelCalls: 0,
  realBrowserTested: false, note: 'Current-source function and actual React static-render contracts. Root owns served-build browser acceptance.' };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, checks: checks.length, evidence: output }));
