import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { resolveStoryboardInitialVideoModelId, storyboardVideoErrorMessage, storyboardTaskCanCancel, storyboardTaskCanRequestTermination } from '../src/lib/storyboard-video-model-selection.ts';

const component = 'src/components/storyboard-workbench.tsx';
const before = '.codex-backups/20260902-232120-storyboard-video-binding/storyboard-workbench.tsx';
const cases = [];
const check = async (name, action) => { await action(); cases.push(name); };
function actual(file, names, globals = {}) {
  const text = fs.readFileSync(file, 'utf8'); const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const snippets = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) snippets.set(node.name.text, node.getText(tree));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) {
      const expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
      snippets.set(node.name.text, `const ${node.name.text} = ${expression.getText(tree)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); for (const name of names) assert.ok(snippets.has(name), name);
  const source = [...snippets.values()].join('\n') + `\nglobalThis.result = { ${names.join(',')} };`;
  const context = vm.createContext({ Date, Number, String, JSON, Error, Set, Map, AbortController, ...globals });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.result;
}
const identity = { id: 'pm_selected', name: 'Omni Flash 10s', supportsImageInput: true, requiresSourceVideo: false, aspectRatios: ['16:9'], available: true };
await check('missing saved selection is preserved, fresh default remains selectable', () => {
  assert.equal(resolveStoryboardInitialVideoModelId('pm_unavailable', [identity]), 'pm_unavailable');
  assert.equal(resolveStoryboardInitialVideoModelId('', [identity]), identity.id);
  assert.equal(resolveStoryboardInitialVideoModelId('', [{ ...identity, available: false }]), '');
});
await check('explicit model switch and its settings survive restore of a contracted draft', () => {
  const draft = { id: 'contract-fixture', ratio: '9:16', imageResolution: '2K', videoResolution: '720p', videoDuration: 15,
    videoModelId: 'pm_selected_other', videoContract: { modelId: 'pm_old_preset', ratio: '16:9', resolution: '2K', duration: 10 },
    cards: [{ id: 'card', order: 1, narration: '', referenceImageUrls: [], imageStatus: 'idle', videoStatus: 'idle' }] };
  const globals = { WORKBENCH_RATIOS: ['16:9', '9:16', '1:1'], MAX_REFERENCES: 9, inferStoryboardNarration: () => '' };
  const names = ['normalizeRun', 'normalizeVideoContract', 'isWorkbenchRatio'];
  const old = actual(before, names, globals).normalizeRun(draft); assert.equal(old.videoModelId, 'pm_old_preset');
  const next = actual(component, [...names, 'normalizeLegacyImageError'], globals).normalizeRun(draft);
  assert.equal(next.videoModelId, 'pm_selected_other'); assert.equal(next.ratio, '9:16'); assert.equal(next.videoDuration, 15); assert.equal(next.videoResolution, '720p');
});
const oldError = actual(before, ['friendlyVideoError']).friendlyVideoError;
const newError = actual(component, ['friendlyVideoError'], { storyboardVideoErrorMessage }).friendlyVideoError;
for (const [message, status] of [['Provider quota insufficient', 402], ['Download video failed: 403 Forbidden', 403], ['渠道账户额度暂不可用', 503]]) {
  await check(`provider message is not renamed to account error: ${status}`, () => {
    if (status !== 503) assert.notEqual(oldError(message, status), message);
    assert.equal(newError(message, status), message);
  });
}
await check('explicit user balance/session errors retain actionable labels', () => {
  assert.equal(storyboardVideoErrorMessage('余额不足：还需1元', 402), '余额不足：还需1元');
  assert.equal(storyboardVideoErrorMessage('请先登录', 401), '登录或权限异常：请先登录');
});
await check('remote capability remains bound to the submitted model while termination also accepts a stable pre-dispatch request', () => {
  const task = { videoTaskId: 'task_original', videoTaskModelId: 'pm_original', videoSupportsRemoteCancel: false };
  assert.equal(storyboardTaskCanCancel(task, [{ id: 'pm_new_selection', supportsRemoteCancel: true }]), false);
  assert.equal(storyboardTaskCanCancel({ ...task, videoSupportsRemoteCancel: true }, []), true);
  assert.equal(storyboardTaskCanCancel({ ...task, videoSupportsRemoteCancel: true }, [{ id: 'pm_original', supportsRemoteCancel: false }]), false);
  assert.equal(storyboardTaskCanCancel({ ...task, videoTaskId: undefined, videoSupportsRemoteCancel: true }, []), false);
  assert.equal(storyboardTaskCanRequestTermination({ videoClientRequestId: 'sbw-video-stable-request' }), true);
  assert.equal(storyboardTaskCanRequestTermination({ videoTaskId: 'task_original' }), true);
  assert.equal(storyboardTaskCanRequestTermination({}), false);
});
await check('actual history hydrator persists public model, duration and cancellation-only changes', () => {
  const run = { id: 'run', cards: [{ id: 'card', order: 1, videoTaskId: 'task', videoTaskModelId: 'internal-old', videoStatus: 'failed' }] };
  const tasks = [{ id: 'business', batchId: 'run', cardIndex: 1, taskIdExternal: 'task', modelId: 'internal-old', publicModelId: 'pm_original', modelName: 'Original model', durationSeconds: 15, supportsRemoteCancel: false, status: 'failed', canRetry: true, billingState: 'failed', priceCharged: 0 }];
  const old = actual(before, ['hydrateRunVideoTasks', 'normalizeRemoteVideoStatus']).hydrateRunVideoTasks(run, tasks);
  assert.equal(old, run);
  const next = actual(component, ['hydrateRunVideoTasks', 'normalizeRemoteVideoStatus']).hydrateRunVideoTasks(run, tasks);
  assert.notEqual(next, run); assert.equal(next.cards[0].videoTaskModelId, 'pm_original'); assert.equal(next.cards[0].videoTaskDuration, 15); assert.equal(next.cards[0].videoTaskModelName, 'Original model'); assert.equal(next.cards[0].videoSupportsRemoteCancel, false); assert.equal(next.cards[0].videoRetryable, true); assert.equal(next.cards[0].videoBillingState, 'failed'); assert.equal(next.cards[0].videoPriceCharged, 0);
});
function generateFixture(file, mode, cardPatch = {}) {
  const model = { ...identity, supportsPrompt: true, supportsRemoteCancel: false };
  const runRef = { current: { id: 'run', videoModelId: model.id, ratio: '16:9', videoDuration: 10, videoResolution: '720p', cards: [{ id: 'card', order: 1, imageUrl: 'https://fixture.invalid/image.png', imagePrompt: 'fixture', videoPrompt: 'fixture motion', videoStatus: 'idle', ...cardPatch }] } };
  const requests = []; const notices = []; const saves = []; let release;
  const holding = new Promise(resolve => { release = resolve; });
  const globals = {
    runRef, videoModels: [model], token: 'synthetic-session', videoSubmissionsRef: { current: new Set() }, videoSubmissionControllersRef: { current: new Map() }, submittedRunIdsRef: { current: new Set() }, videoSectionsRef: { current: {} },
    patchCard: (_id, patch) => { runRef.current = { ...runRef.current, cards: [{ ...runRef.current.cards[0], ...patch }] }; },
    setRun: value => { runRef.current = typeof value === 'function' ? value(runRef.current) : value; },
    setNotice: value => notices.push(value), isActiveVideoStatus: value => ['running', 'queued'].includes(value), hasValidatedImage: () => true,
    effectiveVideoDuration: (_model, value) => value, effectiveVideoResolution: (_model, value) => value, inferStoryboardNarration: () => '', narrationCharacterCount: () => 0,
    submittedVideoPrompt: value => value, storyboardVideoModelSelectionIssue: () => '', storyboardImageRatioIssue: () => '', validateVideoInputContract: () => null, getAiVideoPageInputCapabilities: () => ({}), publicModelName: item => item.name, compactVideoModelName: item => item.name,
    archiveRunSnapshot() {}, setExpandedVideoCards() {}, window: { setTimeout() {} }, STRICT_AUTODL_H3_SELFHOST_PUBLIC_ID: 'selfhost', isMultiPanelStoryboardPrompt: () => false, isPublicHttpMediaUrl: () => true,
    buildClientRequestFingerprint: async () => 'original-payload-fingerprint', resolveBrowserClientAttempt: input => ({ clientRequestId: input.previousTerminal ? 'new-client-request' : 'original-client-request' }), clearBrowserClientAttempt() {},
    createStoryboardPersistenceSnapshot: value => value,
    saveStoryboardProject: async snapshot => { saves.push(snapshot); return mode !== 'save-fail'; },
    friendlyVideoError: newError, isAbortError: () => false, normalizeRemoteVideoStatus: status => status === 'pending' ? 'queued' : status,
    startPolling: async () => { if (mode === 'poll-error') throw new Error('status network lost'); return null; },
    fetch: async (url, init) => {
      assert.equal(url, '/api/video/generate'); const body = JSON.parse(init.body); requests.push(body);
      assert.ok(saves.length > 0, 'owned project snapshot must be saved before provider dispatch');
      assert.equal(runRef.current.cards[0].videoClientRequestId, body.client_request_id);
      if (mode === 'hold') await holding;
      if (mode === 'network') throw new TypeError('network lost after dispatch');
      if (mode === 'preflight') return { ok: false, status: 503, json: async () => ({ task_submitted: false, error: 'model not ready' }) };
      if (mode === 'accepted-503') return { ok: false, status: 503, json: async () => ({ task_submitted: true, business_task_id: 'vt_accepted_original', task_id: 'provider-original', status: 'processing', message: 'accepted' }) };
      return { ok: true, status: 200, json: async () => ({ task_id: 'task_original', model_id: 'internal-original', status: 'pending' }) };
    },
  };
  const handler = actual(file, ['generateVideo'], globals).generateVideo;
  return { handler, runRef, requests, notices, saves, release };
}
await check('old actual callback mislabeled unknown submission failed; new keeps same identity queued', async () => {
  const old = generateFixture(before, 'network'); await old.handler('card'); assert.equal(old.runRef.current.cards[0].videoStatus, 'failed');
  const next = generateFixture(component, 'network'); await next.handler('card'); const card = next.runRef.current.cards[0];
  assert.equal(card.videoStatus, 'queued'); assert.equal(card.videoClientRequestId, 'original-client-request'); assert.equal(card.videoTaskModelId, identity.id); assert.equal(card.videoTaskDuration, 10); assert.equal(card.videoSupportsRemoteCancel, false);
  await next.handler('card'); assert.equal(next.requests.length, 1);
});
await check('actual callback uses selected public model and binds returned internal task to that selection', async () => {
  const next = generateFixture(component, 'accepted'); await next.handler('card');
  assert.equal(next.requests[0].model_id, identity.id); assert.equal(next.runRef.current.cards[0].videoTaskModelId, identity.id); assert.equal(next.runRef.current.cards[0].videoTaskId, 'task_original');
});
await check('actual callback retains accepted task after polling transport error', async () => {
  const next = generateFixture(component, 'poll-error'); await next.handler('card');
  assert.equal(next.runRef.current.cards[0].videoStatus, 'running'); assert.equal(next.runRef.current.cards[0].videoTaskId, 'task_original');
});
await check('accepted 503 receipt binds the original business task before polling', async () => {
  const next = generateFixture(component, 'accepted-503'); await next.handler('card');
  assert.equal(next.runRef.current.cards[0].videoTaskId, 'vt_accepted_original');
  assert.equal(next.requests.length, 1);
});
await check('optional project index failure preserves one durable video submission identity', async () => {
  const next = generateFixture(component, 'save-fail'); await next.handler('card');
  assert.equal(next.saves.length, 1); assert.equal(next.requests.length, 1);
  assert.equal(next.runRef.current.cards[0].videoClientRequestId, 'original-client-request');
  await next.handler('card');
  assert.equal(next.requests.length, 1);
});
await check('confirmed retryable failure creates a fresh request on the first click', async () => {
  const next = generateFixture(component, 'accepted', { videoStatus: 'failed', videoRetryable: true, videoClientRequestId: 'old-client-request', videoClientRequestFingerprint: 'original-payload-fingerprint' });
  await next.handler('card');
  assert.equal(next.requests.length, 1);
  assert.equal(next.requests[0].client_request_id, 'new-client-request');
});
await check('unconfirmed failure cannot dispatch a second provider request', async () => {
  const next = generateFixture(component, 'accepted', { videoStatus: 'failed', videoRetryable: false, videoClientRequestId: 'old-client-request' });
  await next.handler('card');
  assert.equal(next.requests.length, 0);
  assert.match(next.notices.at(-1), /尚未确认/);
});
await check('confirmed unsubmitted error can be edited and retried', async () => {
  const next = generateFixture(component, 'preflight'); await next.handler('card'); assert.equal(next.runRef.current.cards[0].videoStatus, 'failed');
});
await check('actual callback synchronously prevents double submission', async () => {
  const next = generateFixture(component, 'hold'); const first = next.handler('card'); await next.handler('card'); next.release(); await first; assert.equal(next.requests.length, 1);
});
await check('missing saved model cannot dispatch another model', async () => {
  const next = generateFixture(component, 'accepted'); next.runRef.current.videoModelId = 'pm_unavailable'; await next.handler('card'); assert.equal(next.requests.length, 0); assert.match(next.notices.at(-1), /手动选择/);
});
await check('unsupported upstream cancellation pauses only browser monitoring and preserves the original task', () => {
  const task = { id: 'card', order: 1, videoStatus: 'running', videoTaskId: 'task_original', videoTaskModelId: identity.id, videoClientRequestId: 'original-client-request' };
  const runRef = { current: { id: 'run', cards: [task] } };
  let aborted = 0;
  const pollingTasks = new Set(['task_original']);
  const controllers = new Map([['task_original', { abort: () => { aborted += 1; } }]]);
  const notices = [];
  const pause = actual(component, ['pauseVideoMonitoring'], {
    runRef,
    isActiveVideoStatus: value => ['queued', 'running'].includes(value),
    canRemotelyCancelVideoTask: () => false,
    videoPollControllersRef: { current: controllers },
    pollingTasksRef: { current: pollingTasks },
    patchCard: (_id, patch) => { runRef.current.cards[0] = { ...runRef.current.cards[0], ...patch }; },
    setNotice: value => notices.push(value),
  }).pauseVideoMonitoring;
  pause('card');
  assert.equal(aborted, 1);
  assert.equal(controllers.has('task_original'), false);
  assert.equal(pollingTasks.has('task_original'), false);
  assert.equal(runRef.current.cards[0].videoStatus, 'running');
  assert.equal(runRef.current.cards[0].videoTaskId, 'task_original');
  assert.equal(runRef.current.cards[0].videoClientRequestId, 'original-client-request');
  assert.equal(runRef.current.cards[0].videoMonitoringPaused, true);
  assert.match(runRef.current.cards[0].videoStatusDetail, /上游任务未取消/u);
  assert.match(notices.at(-1), /后台仍会查询原任务/u);
});
await check('paused browser monitoring resumes the same task without a new submission', async () => {
  const task = { id: 'card', order: 1, videoStatus: 'running', videoTaskId: 'task_original', videoTaskModelId: identity.id, videoClientRequestId: 'original-client-request', videoMonitoringPaused: true };
  const runRef = { current: { id: 'run', cards: [task] } };
  const polls = [];
  const resume = actual(component, ['resumeVideoMonitoring'], {
    runRef,
    isActiveVideoStatus: value => ['queued', 'running'].includes(value),
    patchCard: (_id, patch) => { runRef.current.cards[0] = { ...runRef.current.cards[0], ...patch }; },
    setNotice() {},
    startPolling: async (...args) => { polls.push(args); return null; },
    reconcileVideoRequest: async () => { throw new Error('must not reconcile a task that already has a task id'); },
    isAbortError: () => false,
    friendlyVideoError: newError,
  }).resumeVideoMonitoring;
  await resume('card');
  assert.equal(runRef.current.cards[0].videoMonitoringPaused, undefined);
  assert.deepEqual(polls, [['card', 'task_original', identity.id, '']]);
});
const report = { passed: true, cases: cases.length, scenarios: cases, actualCallbacks: true, providerRequests: 0, browserRequests: 0, databaseWrites: 0 };
fs.mkdirSync('.codex-evidence/storyboard-video-binding-20260902', { recursive: true });
fs.writeFileSync('.codex-evidence/storyboard-video-binding-20260902/fixture.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
