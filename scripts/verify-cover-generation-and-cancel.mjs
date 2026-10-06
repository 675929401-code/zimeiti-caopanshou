#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = process.argv.find((value) => value.startsWith('--before='))?.slice(9);
assert.ok(before, 'Use --before=.codex-backups/<snapshot>');
const snapshot = path.resolve(root, before);
assert.ok(snapshot.startsWith(path.join(root, '.codex-backups') + path.sep));
const cases = [];
const check = async (name, fn) => { await fn(); cases.push(name); };
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function loadHelper(file, imports = {}) {
  const compiledModule = { exports: {} };
  const context = vm.createContext({ module: compiledModule, exports: compiledModule.exports, require: (id) => {
    assert.ok(id in imports, `Unexpected import ${id}`); return imports[id];
  }, crypto: webcrypto, URLSearchParams, AbortController, setTimeout, clearTimeout, Error, Date, JSON });
  vm.runInContext(compile(fs.readFileSync(path.join(root, file), 'utf8')), context);
  return compiledModule.exports;
}
const guard = loadHelper('src/lib/image-workbench-attempt-guard.ts');
const composition = loadHelper('src/lib/cover-composition.ts');
const pricing = loadHelper('src/lib/image-resolution-pricing.ts');
const helper = loadHelper('src/lib/cover-generation-attempt.ts', {
  '@/lib/image-workbench-attempt-guard': guard,
  '@/lib/cover-composition': composition,
  '@/lib/image-resolution-pricing': pricing,
});
const plan = { title: 'fixture', subtitle: '', aspectRatio: '3:4', layoutTemplateId: 'gaoding-012', animationStyleId: 'photo-real' };
const payload = { prompt: 'fixture cover', modelId: 'pm_fixture', mode: 'local', style: '', aspectRatio: '3:4', resolution: '1K', coverText: 'fixture', referenceImageUrls: [], referenceUsage: 'general', historySurface: 'cover-studio' };
const task = { id: 'cover-fixture', ratio: '3:4', title: 'fixture', subtitle: '', prompt: payload.prompt, source: '生成', createdAt: '2026-09-25T00:00:00.000Z', taskNo: 1, status: 'running', renderPlan: plan };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(mode = 'success') {
  const entries = new Map(); const calls = []; const states = [];
  const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
  const state = { mode, key: '', phase: 'none', sequence: 0 };
  const attempt = (attemptState = state.phase === 'none' ? 'claimed' : state.phase) => ({
    clientIdempotencyKey: state.key, clientTraceId: state.key, state: attemptState, updatedAt: Date.now(),
    task: { ...task, status: attemptState === 'claimed' ? 'running' : attemptState === 'failed' ? 'failed' : 'unknown',
      error: attemptState === 'claimed' ? '封面任务已由账号安全认领，正在等待首次提交' : '原封面任务正在核验' },
    dispatchInput: attemptState === 'claimed' ? payload : undefined, canDispatch: attemptState === 'claimed',
    requiresReferenceReupload: false, ...(attemptState === 'delivery_pending' ? { backgroundAssetId: 'asset-fixture' } : {}),
  });
  const delivered = (sourceAssetId = 'asset-fixture') => ({ status: 'completed', persisted: true, cloudStored: true,
    url: '/api/storage/owned-image', key: 'image-fixture.png', assetId: 'cover-asset-fixture', historyRecordId: 'history-fixture',
    outputKind: 'cover-composition', sourceAssetId, renderedText: { title: plan.title, subtitle: plan.subtitle },
    width: 768, height: 1024, sourceWidth: 768, sourceHeight: 1024, createdAt: '2026-09-25T00:00:01.000Z', taskNo: 1 });
  const fetcher = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body });
    if (url === '/api/cover/render' && !init.method) return response({ ready: true });
    if (url.startsWith('/api/image/status?')) return state.mode === 'recovery-rejected'
      ? response({ state: 'rejected', canRecover: false, canResubmit: true, sameKeyCanResubmit: false, message: '原任务明确未受理' })
      : response({ state: state.mode === 'success' ? 'completed' : 'unknown', canRecover: state.mode === 'success' });
    assert.ok(url === '/api/cover/attempt' || url.startsWith('/api/cover/attempt?'), `Unexpected cover attempt URL ${url}`);
    if (!init.body) {
      if (state.key) {
        const query = new URL(url, 'http://fixture.local').searchParams;
        assert.equal(query.get('clientIdempotencyKey'), state.key);
        assert.equal(query.get('clientTraceId'), state.key);
      }
      if (!state.key) return response({ success: true, activeAttempt: null });
      if (state.mode === 'recovery-rejected' && state.phase === 'dispatched') {
        const terminalAttempt = attempt('failed'); state.key = ''; state.phase = 'none';
        return response({ success: true, activeAttempt: null, terminalAttempt, message: '原任务明确未受理' });
      }
      if (state.mode === 'success' && state.phase === 'delivery_pending') {
        state.phase = 'completed';
        return response({ success: true, completed: true, backgroundAssetId: 'asset-fixture', result: delivered() });
      }
      return response({ success: true, activeAttempt: attempt() });
    }
    if (body.action === 'claim') {
      if (!state.key) { state.key = body.clientIdempotencyKey; state.sequence++; state.phase = 'claimed'; }
      return response({ success: true, activeAttempt: attempt() });
    }
    assert.equal(body.action, 'dispatch');
    assert.equal(body.clientIdempotencyKey, state.key); assert.equal(body.clientTraceId, state.key);
    state.phase = 'dispatched';
    if (state.mode === 'network' || state.mode === 'recovery-rejected') throw new TypeError('fixture network loss');
    if (state.mode === 'malformed') return new Response('not-json', { status: 200 });
    if (state.mode === 'preflight') return response({ code: 'IMAGE_STORAGE_NOT_READY', upstreamCalled: false, billed: false }, 503);
    if (state.mode === 'balance') return response({ code: 'INSUFFICIENT_BALANCE', error: '余额不足' }, 402);
    if (state.mode === 'publication') return response({ code: 'IMAGE_MODEL_PUBLICATION_REQUIRED', error: '模型不可用', upstreamCalled: false, billed: false, taskSubmitted: false }, 409);
    if (state.mode === 'rejected') return response({ code: 'IMAGE_UPSTREAM_REQUEST_REJECTED', error: '上游明确拒绝', state: 'rejected', canRecover: false, canResubmit: true, sameKeyCanResubmit: false }, 400);
    if (state.mode === 'idempotency-unknown') return response({ success: true, completed: false, activeAttempt: attempt(), message: '原请求待确认' }, 202);
    if (state.mode === 'persist-failure') { state.phase = 'delivery_pending'; return response({ success: true, completed: false, activeAttempt: attempt(), message: 'history unavailable' }, 202); }
    const result = delivered(state.mode === 'wrong-trace' ? 'foreign-source' : 'asset-fixture');
    if (state.mode === 'incomplete') delete result.assetId;
    if (state.mode === 'success') state.phase = 'completed';
    return response({ success: true, completed: true, operationId: 'operation-fixture', backgroundAssetId: 'asset-fixture', result });
  };
  return { storage, calls, states, state, input: { userId: 'user-fixture', token: 'fixture-session', payload, task, storage, fetcher, onState: (value) => states.push(value) } };
}

await check('public DTO names, reference capabilities and zero price', () => {
  const [model] = helper.parseCoverGenerationModels([{ id: 'pm_fixture', displayName: 'Nano', variantLabel: 'A', publicPrice: 0, capabilities: { defaultResolution: '2K', supportsReferenceInput: true } }]);
  assert.equal(model.name, 'Nano A'); assert.equal(model.price, 0); assert.equal(model.resolution, '2K'); assert.equal(model.supportsReferenceInput, true);
  assert.equal(helper.parseCoverGenerationModels([{ id: 'legacy', name: 'old' }]).length, 0);
});
await check('complete generated asset is reused and history persisted', async () => {
  const f = fixture(); const result = await helper.runCoverGeneration(f.input);
  assert.equal(result.state.pending, null); assert.equal(result.state.history[0].historyRecordId, 'history-fixture');
  assert.equal(f.calls.filter((call) => call.body?.action === 'dispatch').length, 1);
  assert.equal(helper.readCoverGenerationState(f.storage, 'user-fixture').history.length, 0, 'completed history is account-backed, not duplicated in browser storage');
});
for (const mode of ['network', 'malformed', 'incomplete', 'wrong-trace', 'persist-failure']) {
  await check(`${mode} retains original pending identity and suppresses new submission`, async () => {
    const f = fixture(mode); const result = await helper.runCoverGeneration(f.input); const original = result.state.pending.clientIdempotencyKey;
    assert.ok(['running', 'unknown'].includes(result.state.pending.task.status));
    const count = f.calls.length;
    const repeated = await helper.runCoverGeneration({ ...f.input, payload: { ...payload, prompt: 'changed' } });
    assert.equal(f.calls.length, count); assert.equal(repeated.state.pending.clientIdempotencyKey, original);
    assert.throws(() => helper.clearCompletedCoverHistory(f.storage, 'user-fixture'));
  });
}
await check('confirmed delivery recovery completes the same key without a second provider dispatch', async () => {
  const f = fixture('persist-failure'); await helper.runCoverGeneration(f.input);
  const first = f.calls.find((call) => call.body?.action === 'dispatch').body;
  f.state.mode = 'success';
  const result = await helper.runCoverGeneration({ ...f.input, recovery: true, payload: { ...payload, prompt: 'edited' } });
  const submissions = f.calls.filter((call) => call.body?.action === 'dispatch');
  assert.equal(submissions.length, 1); assert.deepEqual(submissions[0].body, first); assert.equal(result.state.pending, null);
});
await check('unknown status query never calls generation again', async () => {
  const f = fixture('network'); await helper.runCoverGeneration(f.input); await helper.runCoverGeneration({ ...f.input, recovery: true });
  assert.equal(f.calls.filter((call) => call.body?.action === 'dispatch').length, 1);
});
await check('confirmed rejected status releases pending without replay and the next explicit submit uses a new key', async () => {
  const f = fixture('recovery-rejected'); await helper.runCoverGeneration(f.input);
  const originalKey = f.calls.find((call) => call.body?.action === 'dispatch').body.clientIdempotencyKey;
  const recovered = await helper.runCoverGeneration({ ...f.input, recovery: true });
  assert.equal(recovered.state.pending, null); assert.equal(recovered.state.history[0].status, 'failed');
  assert.equal(f.calls.filter((call) => call.body?.action === 'dispatch').length, 1);
  f.state.mode = 'success'; await helper.runCoverGeneration(f.input);
  const submissions = f.calls.filter((call) => call.body?.action === 'dispatch');
  assert.equal(submissions.length, 2); assert.notEqual(submissions[1].body.clientIdempotencyKey, originalKey);
});
await check('explicit preflight no-call/no-bill releases only unsubmitted attempt', async () => {
  const f = fixture('preflight'); const result = await helper.runCoverGeneration(f.input);
  assert.equal(result.state.pending, null); assert.equal(result.state.history[0].status, 'failed');
});
for (const mode of ['balance', 'publication', 'rejected']) {
  await check(`${mode} terminal response releases the old attempt for a user-confirmed new submission`, async () => {
    const f = fixture(mode); const result = await helper.runCoverGeneration(f.input);
    assert.equal(result.state.pending, null); assert.equal(result.state.history[0].status, 'failed');
  });
}
await check('idempotency conflict keeps the original request pending', async () => {
  const f = fixture('idempotency-unknown'); const result = await helper.runCoverGeneration(f.input);
  assert.ok(result.state.pending); assert.equal(result.state.pending.task.status, 'unknown');
});
await check('storage failure precedes all generation calls', async () => {
  const f = fixture(); f.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(helper.runCoverGeneration(f.input));
  assert.equal(f.calls.filter((call) => call.body?.action === 'dispatch').length, 0);
});
await check('pending state is isolated by account', async () => {
  const f = fixture('network'); await helper.runCoverGeneration(f.input);
  assert.equal(helper.readCoverGenerationState(f.storage, 'another-user').pending, null);
});

function callback(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let code;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(tree);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
      code = `const ${name} = ${expression.getText(tree)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(code, `Missing callback ${name}`); return compile(`${code}\nglobalThis.selectedCallback = ${name};`);
}
function coverCallback(file, hold = false, fail = false) {
  let done; let runs = 0; const bodies = []; const runInputs = [];
  const wait = new Promise((resolve) => { done = resolve; });
  const context = vm.createContext({
    prompt: payload.prompt, materialSourceId: 'text', referenceImage: '', hasReferenceMaterial: false,
    usesBuiltInTemplate: false, usesUploadedReference: false, layoutTemplate: { previewImage: '' },
    planNeedsRebuild: false,
    currentUserId: 'user-fixture', currentUserIdRef: { current: 'user-fixture' }, activeModel: { id: 'pm_fixture', resolution: '1K', supportsReferenceInput: true, available: true, priceReady: true },
    hasPendingGeneration: false, submissionInFlightRef: { current: false }, setGenerationBusy() {},
    historyClearing: false,
    localStorage: { getItem: () => 'fixture-session' }, TOKEN_KEY: 'test', setLoginOpen() {}, setNotice() {},
    taskCounterRef: { current: 0 }, ratio: '3:4', title: 'fixture', subtitle: '', briefText: 'fixture brief', modelId: 'pm_fixture',
    coverModeId: 'cartoon', animationStyle: { name: 'fixture style' },
    layoutTemplateId: 'gaoding-012', animationStyleId: 'photo-real', historyRequestRef: { current: 0 },
    setResults() {}, setSelectedResultId() {}, setSelectedImage() {}, setHistoryLoading() {}, setPrompt() {}, getTaskLabel: String, showGenerationState() {}, loadBalance: async () => {}, loadAccountHistory: async () => {},
    syncCoverCopySemantics: (value) => value, createTaskStorage: () => ({}), applyTaskRunState() {}, readCoverReferenceAsDataUrl: async () => '',
    runCoverGeneration: async (input) => { runs++; runInputs.push(input); if (fail) throw new Error('fixture launch failure'); if (hold) await wait; return { state: { pending: null }, message: 'ok' }; },
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return response({ images: [{ url: '/fixture' }] }); },
  });
  vm.runInContext(callback(file, 'generateImage'), context);
  return {
    invoke: (...args) => context.selectedCallback(...args), release: done, runs: () => runs,
    runInputs: () => runInputs, publish: (index = 0) => runInputs[index].onState({ version: 1, pending: { task }, history: [] }), bodies,
  };
}
await check('actual legacy cover callback either lacks request identifiers or delegates them to the durable helper', async () => {
  const f = coverCallback(path.join(snapshot, 'src/components/cover-studio.tsx'));
  await f.invoke();
  if (f.runs() === 1) {
    assert.equal(f.bodies.length, 0, 'durable legacy callback must not bypass the helper');
    assert.equal(f.runInputs()[0].payload.clientIdempotencyKey, undefined);
    assert.equal(f.runInputs()[0].payload.clientTraceId, undefined);
  } else {
    assert.equal(f.runs(), 0);
    assert.equal(f.bodies.length, 1, 'pre-durable callback should issue one direct request');
    assert.equal(f.bodies[0].clientIdempotencyKey, undefined);
    assert.equal(f.bodies[0].clientTraceId, undefined);
  }
});
await check('actual new cover callback blocks duplicates until durable handoff, then permits another task', async () => {
  const f = coverCallback(path.join(root, 'src/components/cover-studio.tsx'), true);
  await f.invoke(); await f.invoke(); assert.equal(f.runs(), 1);
  f.publish(); await f.invoke(); assert.equal(f.runs(), 2, 'durable handoff must release the short submit gate');
  f.release(); await new Promise((resolve) => setTimeout(resolve, 0));
});
await check('actual new cover callback releases the short submit gate after launch failure', async () => {
  const f = coverCallback(path.join(root, 'src/components/cover-studio.tsx'), false, true);
  await f.invoke(); await new Promise((resolve) => setTimeout(resolve, 0));
  await f.invoke(); assert.equal(f.runs(), 2);
});

function cancelFixture(file, storyboard, scenario) {
  let aborts = 0; let cancels = 0;
  const active = { localId: 1, cardIndex: 1, id: 'card', order: 1, status: 'processing', videoStatus: 'running', taskId: 'task-fixture', videoTaskId: 'task-fixture', modelId: 'model', videoTaskModelId: 'model', clientRequestId: 'request-original', videoClientRequestId: 'request-original' };
  if (scenario === 'no-task-id') { active.taskId = ''; active.videoTaskId = ''; }
  const tasksRef = { current: [active] }; const runRef = { current: { cards: [active] } }; const cancelledRef = { current: new Set() };
  const abort = { abort() { aborts++; } };
  const context = vm.createContext({
    tasksRef, runRef, cancelledRef, models: [{ id: 'model', supportsRemoteCancel: true }], selectedModel: { supportsRemoteCancel: true }, auth: { token: 'fixture-session' }, token: 'fixture-session', duration: 5,
    canRemotelyCancelVideoTask: () => true, boundVideoTaskModel: (task, rows) => rows.find(row => row.id === task.modelId), setNotice() {}, toast: { info() {}, success() {} }, loadHistory() {}, setCashBalance() {},
    isActiveVideoTaskStatus: (status) => ['pending', 'processing', 'queued'].includes(status), isActiveVideoStatus: (status) => ['running', 'queued'].includes(status),
    sseRefs: { current: new Map([['task-fixture', { abortController: abort }]]) }, videoPollControllersRef: { current: new Map([['task-fixture', abort]]) }, videoSubmissionControllersRef: { current: new Map([['card', abort]]) },
    friendlyVideoError: (message) => message, normalizeRemoteVideoStatus: (status) => status === 'completed' ? 'done' : status,
    setTasks: (fn) => { tasksRef.current = fn(tasksRef.current); }, patchCard: (_id, patch) => { runRef.current.cards[0] = { ...runRef.current.cards[0], ...patch }; }, URLSearchParams,
    fetch: async (url) => {
      if (url.startsWith('/api/video/status')) return response({ status: 'processing' });
      assert.equal(url, '/api/video/cancel'); cancels++;
      if (scenario === 'network') throw new TypeError('fixture network');
      if (scenario === 'completed-race') { tasksRef.current[0].status = 'completed'; runRef.current.cards[0].videoStatus = 'done'; }
      if (scenario === 'confirmed' || scenario === 'completed-race') return response({ success: true, status: 'cancelled' });
      if (scenario === 'unknown202') return response({ success: false, status: 'processing' }, 202);
      if (scenario === 'empty200') return response({});
      if (scenario === 'terminal409') return response({ success: false, status: 'completed' }, 409);
      return response({ success: false, status: 'processing', error: 'not supported' }, 409);
    },
  });
  vm.runInContext(callback(file, storyboard ? 'cancelVideo' : 'cancelTask'), context);
  return { run: () => context.selectedCallback(storyboard ? 'card' : 1), current: () => storyboard ? runRef.current.cards[0] : tasksRef.current[0], aborts: () => aborts, cancels: () => cancels, cancelledRef };
}
await check('old video callback falsely cancelled on rejected cancellation', async () => {
  const f = cancelFixture(path.join(snapshot, 'src/app/video/page.tsx'), false, 'unsupported'); await f.run(); await Promise.resolve();
  assert.equal(f.current().status, 'cancelled'); assert.equal(f.aborts(), 1);
});
await check('old storyboard callback abandoned an unknown in-flight submission', async () => {
  const f = cancelFixture(path.join(snapshot, 'src/components/storyboard-workbench.tsx'), true, 'no-task-id'); await f.run();
  assert.equal(f.current().videoStatus, 'cancelled'); assert.equal(f.aborts(), 1);
});
for (const storyboard of [false, true]) {
  for (const scenario of ['unsupported', 'network', 'unknown202', 'empty200', 'terminal409', 'no-task-id', 'confirmed', 'completed-race']) {
    await check(`actual ${storyboard ? 'storyboard' : 'video'} cancellation ${scenario}`, async () => {
      const file = storyboard ? 'src/components/storyboard-workbench.tsx' : 'src/app/video/page.tsx';
      const f = cancelFixture(path.join(root, file), storyboard, scenario); await f.run();
      const state = f.current()[storyboard ? 'videoStatus' : 'status'];
      assert.equal(state, scenario === 'confirmed' ? 'cancelled' : scenario === 'completed-race' ? storyboard ? 'done' : 'completed' : storyboard ? 'running' : 'processing');
      assert.equal(f.aborts(), scenario === 'confirmed' ? 1 : 0);
      assert.equal(f.current()[storyboard ? 'videoClientRequestId' : 'clientRequestId'], 'request-original');
      if (scenario === 'no-task-id') assert.equal(f.cancels(), 0);
    });
  }
}
console.log(JSON.stringify({ pass: true, scenarios: cases.length, cases, upstreamRequests: 0, databaseWrites: 0 }, null, 2));
