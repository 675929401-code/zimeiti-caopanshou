#!/usr/bin/env node
// Runs actual component callbacks with isolated state/timers, without a browser,
// environment credentials, database writes or upstream requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const beforeArg = process.argv.find(argument => argument.startsWith('--before='));
assert.ok(beforeArg, 'Provide the actual pre-edit component snapshot');
const beforePath = path.resolve(root, beforeArg.slice('--before='.length));
assert.ok(beforePath.startsWith(`${path.join(root, '.codex-backups')}${path.sep}`));
const currentPath = path.join(root, 'src/components/image-workbench.tsx');
const helperPath = path.join(root, 'src/lib/image-workbench-attempt-guard.ts');
const pending = { id: 'pending-fixture', prompt: '原始请求内容', status: 'unknown', generationKey: 'original-request', generationTraceId: 'original-trace', generationModelId: 'original-model', generationFingerprint: 'original-fingerprint' };
const idle = { id: 'idle-fixture', prompt: '普通草稿', status: 'idle' };
const completed = { id: 'completed-fixture', prompt: '完成记录', status: 'done', assetId: 'asset', historyRecordId: 'history', storageKey: 'asset.png' };
const results = [];

function callbacks(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selected = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ['updateJobPrompt', 'removeJob', 'resetDraftJobs', 'generateAll'].includes(node.name.text)) {
      assert.ok(node.initializer && ts.isCallExpression(node.initializer));
      selected[node.name.text] = node.initializer.arguments[0].getText(tree);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('draftExpiryInitializedRef.current')) {
      selected.expiry = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(selected.updateJobPrompt && selected.removeJob && selected.expiry);
  return selected;
}

function harness(sourcePath, rows, expired = false, scenario = 'upload-failure') {
  let state = structuredClone(rows);
  const calls = { posts: 0, statusReads: 0, busy: false };
  const timers = [];
  const storage = new Map([['image_workbench_draft_expiry_v1', expired ? '1' : '']]);
  const compiledModule = { exports: {} };
  const context = vm.createContext({
    module: compiledModule, exports: compiledModule.exports, Date, Error, Response,
    jobs: state, draftExpiryInitializedRef: { current: false },
    IMAGE_WORKBENCH_DRAFT_EXPIRY_KEY: 'image_workbench_draft_expiry_v1',
    IMAGE_WORKBENCH_DRAFT_TTL_MS: 20 * 60 * 1000,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {}, dispatchEvent() {} },
    generationInFlightRef: { current: false }, token: 'fixture-session',
    actionableJobCount: rows.filter(row => ['idle', 'failed', 'recoverable'].includes(row.status)).length,
    unknownJobCount: rows.filter(row => row.status === 'unknown').length,
    activeModel: { id: 'fixture-model', name: 'fixture-model' },
    aspectRatio: '1:1', selectedResolution: '1K',
    mode: scenario === 'upload-failure' ? 'image-to-image' : 'text-to-image',
    references: [{ id: 'fixture-reference' }],
    uploadReference: async () => { throw new Error('Synthetic upload failure'); },
    setBusy: value => { calls.busy = value; },
    createId: prefix => `${prefix}-fixture-identity`,
    inspectImageAttempt: async () => { calls.statusReads += 1; return { canRecover: false }; },
    fetch: async () => {
      calls.posts += 1;
      return Response.json({ code: 'IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY', error: 'Synthetic preflight failure',
        ...(scenario === 'preflight-failure' ? { upstreamCalled: false, billed: false } : {}),
      }, { status: 503 });
    },
    setNotice() {},
    createPromptCards: () => Array.from({ length: 4 }, (_, index) => ({ id: `empty-${index}`, prompt: '', status: 'idle' })),
    clearJobs() { state = []; },
    setJobs(update) { state = typeof update === 'function' ? update(state) : update; },
  });
  vm.runInContext(ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  Object.assign(context, compiledModule.exports);
  const selected = callbacks(sourcePath);
  const loaded = {};
  for (const [name, callback] of Object.entries(selected)) {
    loaded[name] = vm.runInContext(ts.transpileModule(`(${callback});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    context[name] = loaded[name];
  }
  return { callbacks: loaded, timers, calls, confirmsUnsubmitted: compiledModule.exports.isConfirmedUnsubmittedImageFailure, rows: () => JSON.parse(JSON.stringify(state)) };
}

{
  const oldEdit = harness(beforePath, [pending]);
  oldEdit.callbacks.updateJobPrompt(pending.id, '已修改');
  assert.equal(oldEdit.rows()[0].status, 'idle');
  assert.equal(oldEdit.rows()[0].generationKey, undefined);
  const oldExpiry = harness(beforePath, [pending], true);
  oldExpiry.callbacks.expiry();
  assert.equal(oldExpiry.rows().some(row => row.id === pending.id), false);
  results.push('actual old callbacks reproduce lost request identity after edit and expiry');
}

for (const status of ['queued', 'generating', 'storing', 'recoverable', 'unknown']) {
  const row = { ...pending, status };
  const current = harness(currentPath, [row, idle]);
  current.callbacks.updateJobPrompt(row.id, '不可覆盖');
  current.callbacks.removeJob(row.id);
  assert.deepEqual(current.rows()[0], row);
  current.callbacks.updateJobPrompt(idle.id, '新草稿');
  assert.equal(current.rows()[1].prompt, '新草稿');
  current.callbacks.removeJob(idle.id);
  assert.equal(current.rows().length, 1);
  results.push(`${status}: edit/delete preserve exact request; ordinary draft stays editable`);
}

for (const expired of [true, false]) {
  const current = harness(currentPath, [pending, idle, completed], expired);
  current.callbacks.expiry();
  if (!expired) {
    assert.equal(current.timers.length, 1);
    current.timers[0]();
  }
  assert.deepEqual(current.rows(), [pending]);
  results.push(expired ? 'already-expired restored draft retains unresolved card' : 'active twenty-minute timer retains unresolved card');
}

{
  const current = harness(currentPath, [pending, idle, completed]);
  current.callbacks.resetDraftJobs();
  assert.deepEqual(current.rows(), [pending]);
  const ordinary = harness(currentPath, [idle, completed]);
  ordinary.callbacks.resetDraftJobs();
  assert.equal(ordinary.rows().length, 4);
  assert.ok(ordinary.rows().every(row => row.status === 'idle' && !row.prompt));
  results.push('manual reset preserves pending request and still resets ordinary drafts');
}

{
  const incomplete = { ...pending, status: 'done', assetId: 'asset' };
  const current = harness(currentPath, [incomplete], true);
  current.callbacks.expiry();
  assert.deepEqual(current.rows(), [incomplete], 'Old incomplete delivery must survive before normalization');
  results.push('incomplete restored delivery retains its identity before effects normalize it');
}

{
  const recoverable = { ...pending, status: 'recoverable' };
  const old = harness(beforePath, [idle, recoverable]);
  await assert.rejects(old.callbacks.generateAll(), /Synthetic upload failure/u);
  assert.ok(old.rows().every(row => row.status === 'queued'));
  const current = harness(currentPath, [idle, recoverable]);
  await current.callbacks.generateAll();
  assert.deepEqual(current.rows().map(row => { const original = { ...row }; delete original.error; return original; }), [idle, recoverable]);
  assert.equal(current.calls.posts, 0);
  assert.equal(current.calls.busy, false);
  results.push('actual upload failure restores original idle/recoverable cards without a generation POST');
}

for (const scenario of ['preflight-failure', 'unproven-failure']) {
  const current = harness(currentPath, [idle], false, scenario);
  await current.callbacks.generateAll();
  assert.equal(current.calls.posts, 1);
  assert.equal(current.rows()[0].status, scenario === 'preflight-failure' ? 'failed' : 'unknown');
  assert.equal(current.calls.statusReads, scenario === 'preflight-failure' ? 0 : 1);
  assert.equal(current.calls.busy, false);
  results.push(`${scenario}: actual submit callback requires proof before unlocking an error`);
}

{
  const current = harness(currentPath, []);
  const confirmed = { code: 'IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY', upstreamCalled: false, billed: false };
  assert.equal(current.confirmsUnsubmitted(confirmed), true);
  assert.equal(current.confirmsUnsubmitted({ code: 'IMAGE_UPSTREAM_RESULT_UNKNOWN', upstreamCalled: false, billed: false }), true);
  assert.equal(current.confirmsUnsubmitted({ code: 'INSUFFICIENT_BALANCE' }), true);
  assert.equal(current.confirmsUnsubmitted({ code: 'IMAGE_UPSTREAM_RESULT_UNKNOWN' }), false);
  for (const patch of [{ upstreamCalled: undefined }, { billed: undefined }, { billed: true }, { upstreamCalled: true }, { upstreamCalled: 'false' }]) {
    assert.equal(current.confirmsUnsubmitted({ ...confirmed, ...patch }), false);
  }
  results.push('absence of upstream/charge proof or an unrelated error cannot unlock the request');
}

const result = { checkedAt: new Date().toISOString(), passed: true, caseCount: results.length, cases: results, networkCalls: 0, upstreamCalls: 0, databaseWrites: 0, beforeSnapshot: path.relative(root, beforePath) };
const evidenceDir = path.join(root, '.codex-evidence/image-pending-guard-20260902');
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
