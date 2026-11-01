import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (pathname) => fs.readFileSync(pathname, "utf8");
const workspace = read("src/components/admin/WorkspaceModelsAdminTab.tsx");
const storyboard = read("src/components/storyboard-workbench.tsx");
const requestStatus = read("src/app/api/video/request-status/route.ts");
const admin = read("src/app/admin/page.tsx");

const parse = (source, name) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const storyboardAst = parse(storyboard, 'storyboard-workbench.tsx');
const workspaceAst = parse(workspace, 'WorkspaceModelsAdminTab.tsx');
function nodes(root, predicate) {
  const result = [];
  const visit = node => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}
function productionFunction(tree, name) {
  const found = nodes(tree, ts.isFunctionDeclaration).filter(node => node.name?.text === name);
  assert.equal(found.length, 1, `PRODUCTION_FUNCTION_REQUIRED:${name}`);
  return found[0].getText(tree).replace(/^export\s+/u, '');
}
function productionInitializer(tree, name) {
  const found = nodes(tree, ts.isVariableDeclaration).filter(node => node.name.getText(tree) === name);
  assert.equal(found.length, 1, `PRODUCTION_INITIALIZER_REQUIRED:${name}`);
  assert.ok(found[0].initializer);
  return found[0].initializer;
}
function callback(tree, name) {
  const initializer = productionInitializer(tree, name);
  if (ts.isArrowFunction(initializer)) return initializer.getText(tree);
  assert.ok(ts.isCallExpression(initializer) && initializer.expression.getText(tree) === 'useCallback'
    && ts.isArrowFunction(initializer.arguments[0]), `PRODUCTION_CALLBACK_REQUIRED:${name}`);
  return initializer.arguments[0].getText(tree);
}
function context(scope = {}) {
  return vm.createContext({ URLSearchParams, process: { env: Object.freeze({}) },
    fetch() { throw new Error('NETWORK_FORBIDDEN'); },
    require(name) { throw new Error(`UNEXPECTED_IMPORT:${name}`); }, ...scope });
}
function evaluate(source, scope) {
  const code = ts.transpileModule(source, { fileName: 'fixture.tsx', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  return vm.runInContext(code, scope, { timeout: 5000 });
}
const pureStoryboardSource = ['isActiveVideoStatus', 'videoNeedsRequestReconciliation', 'normalizeRemoteVideoStatus']
  .map(name => productionFunction(storyboardAst, name)).join('\n');
const reconciliationCallback = callback(storyboardAst, 'reconcileVideoRequest');
const videoButton = nodes(storyboardAst, ts.isJsxElement).find(node => {
  if (node.openingElement.tagName.getText(storyboardAst) !== 'button') return false;
  return node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
    && attribute.name.getText(storyboardAst) === 'title'
    && attribute.initializer?.getText(storyboardAst).includes('videoNeedsRequestReconciliation(card)'));
});
assert.ok(videoButton, 'PRODUCTION_VIDEO_ACTION_BUTTON_REQUIRED');
const clickAttribute = videoButton.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute)
  && attribute.name.getText(storyboardAst) === 'onClick');
assert.ok(clickAttribute && ts.isJsxExpression(clickAttribute.initializer) && clickAttribute.initializer.expression);
const videoButtonLabel = videoButton.children.find(node => ts.isJsxExpression(node) && node.expression
  && ts.isConditionalExpression(node.expression) && node.expression.getText(storyboardAst).startsWith('preparingVideoIds.has(card.id)'));
assert.ok(videoButtonLabel?.expression, 'PRODUCTION_VIDEO_ACTION_LABEL_REQUIRED');

const behaviorChecks = [];
const originalCard = () => ({ id: 'fixture-card', order: 1, videoStatus: 'queued',
  videoClientRequestId: 'fixture-request-original', videoClientRequestFingerprint: 'fixture-fingerprint-original' });
for (const [name, data, ok, expectedStatus, retryable, polls] of [
  ['unknown original request', { found: false, canResubmit: false }, true, 'queued', false, 0],
  ['confirmed missing original task', { found: false, canResubmit: true, sameRequestKeyRequired: true }, true, 'failed', true, 0],
  ['missing task without same-key permission', { found: false, canResubmit: true }, true, 'queued', false, 0],
  ['recovered existing task', { found: true, taskId: 'fixture-provider-task', businessTaskId: 'fixture-business-task',
    modelId: 'fixture-model', status: 'running' }, true, 'running', false, 1],
  ['unavailable status lookup', { error: 'fixture-status-unavailable' }, false, 'queued', false, 0],
]) {
  const card = originalCard();
  const requests = [];
  const polling = [];
  const reconciliationSet = new Set();
  const scope = context({ card, token: 'fixture-session', runRef: { current: { id: 'fixture-run', cards: [card] } },
    imageDownloadOwnerRef: { current: 'fixture-owner' }, scopeMountedRef: { current: true },
    videoSubmissionsRef: { current: new Set() }, videoRequestReconciliationsRef: { current: reconciliationSet },
    localVideoInternalIdsRef: { current: new Set() },
    patchCard(id, patch) { assert.equal(id, card.id); Object.assign(card, patch); },
    async fetchStoryboardJson(url, options) {
      requests.push({ url, options });
      assert.equal(url, '/api/video/request-status?clientRequestId=fixture-request-original');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.method, undefined, 'reconciliation remains a read');
      return { response: { ok, status: ok ? 200 : 503 }, data };
    },
    startPolling(...args) { polling.push(args); return Promise.resolve(null); },
    setNotice() {}, friendlyVideoError: message => message,
    generateVideo() { throw new Error('RECONCILIATION_PROVIDER_DISPATCH_FORBIDDEN'); },
    prepareAndGenerateVideo() { throw new Error('RECONCILIATION_RESUBMIT_FORBIDDEN'); },
  });
  evaluate(pureStoryboardSource, scope);
  const reconcile = evaluate(`(${reconciliationCallback});`, scope);
  await reconcile(card.id, 'auto');
  assert.equal(requests.length, 1, `${name}: one original-request lookup`);
  assert.equal(card.videoStatus, expectedStatus, name);
  assert.equal(card.videoRetryable, retryable, name);
  assert.equal(card.videoClientRequestId, 'fixture-request-original', `${name}: stable request preserved`);
  assert.equal(card.videoClientRequestFingerprint, 'fixture-fingerprint-original', `${name}: fingerprint preserved`);
  assert.equal(polling.length, polls, name);
  assert.equal(reconciliationSet.size, 0, `${name}: read lock released`);
  if (retryable) assert.equal(card.videoSameRequestKeyRequired, true);
  behaviorChecks.push(name);
}
for (const [name, patch, label, expectedCalls] of [
  ['manual original-request refresh', {}, '刷新视频', [['reconcile', 'fixture-card', 'manual']]],
  ['explicit confirmed-no-task retry', { videoStatus: 'failed', videoRetryable: true, videoSameRequestKeyRequired: true },
    '重试视频', [['generate', 'fixture-card']]],
]) {
  const calls = [];
  const card = { ...originalCard(), ...patch };
  const scope = context({ card, preparingVideoIds: new Set(), videoViewOnly: false,
    switchExistingCardMedia: () => false, showVideoMedia: false,
    reconcileVideoRequest: (...args) => calls.push(['reconcile', ...args]),
    prepareAndGenerateVideo: (...args) => calls.push(['generate', ...args]),
    needsStoryboardBoardExport: () => false, canRequestVideoTermination: () => false,
  });
  evaluate(pureStoryboardSource, scope);
  assert.equal(evaluate(`(${videoButtonLabel.expression.getText(storyboardAst)});`, scope), label, name);
  const click = evaluate(`(${clickAttribute.initializer.expression.getText(storyboardAst)});`, scope);
  assert.deepEqual(calls, [], `${name}: render itself must not submit`);
  click();
  assert.deepEqual(calls, expectedCalls, `${name}: exact action branch`);
  behaviorChecks.push(name);
}
const retryAst = parse(read('src/lib/storyboard-video-retry.ts'), 'storyboard-video-retry.ts');
const retryScope = context();
const retry = evaluate(`const CLIENT_REQUEST_ID_PATTERN = ${productionInitializer(retryAst, 'CLIENT_REQUEST_ID_PATTERN').getText(retryAst)};
  ${productionFunction(retryAst, 'resolveStoryboardVideoSameKeyRetryAttempt')}; resolveStoryboardVideoSameKeyRetryAttempt;`, retryScope);
const stableAttempt = { currentFingerprint: 'fixture-fingerprint-original', previousFingerprint: 'fixture-fingerprint-original',
  previousRequestId: 'fixture-request-original', sameRequestKeyRequired: true };
assert.deepEqual(JSON.parse(JSON.stringify(retry(stableAttempt))), {
  clientRequestId: 'fixture-request-original', clientRequestFingerprint: 'fixture-fingerprint-original', reused: true,
});
assert.throws(() => retry({ ...stableAttempt, currentFingerprint: 'changed' }), /VIDEO_RETRY_FINGERPRINT_MISMATCH_NOT_DISPATCHED/u);
assert.throws(() => retry({ ...stableAttempt, previousRequestId: '' }), /VIDEO_RETRY_ORIGINAL_REQUEST_ID_REQUIRED_NOT_DISPATCHED/u);
const attemptScope = context({ card: { ...originalCard(), videoSameRequestKeyRequired: true },
  videoClientRequestFingerprint: 'fixture-fingerprint-original', videoClientAttemptScope: 'fixture-scope',
  resolveStoryboardVideoSameKeyRetryAttempt: retry,
  resolveBrowserClientAttempt() { throw new Error('SAME_KEY_RETRY_MUST_NOT_FALL_BACK_TO_A_NEW_ATTEMPT'); },
});
const actualAttemptSource = `(${productionInitializer(storyboardAst, 'videoClientAttempt').getText(storyboardAst)});`;
assert.deepEqual(JSON.parse(JSON.stringify(evaluate(actualAttemptSource, attemptScope))), {
  clientRequestId: 'fixture-request-original', clientRequestFingerprint: 'fixture-fingerprint-original', reused: true,
}, 'actual submit path uses the same-key helper before the ordinary attempt resolver');
attemptScope.videoClientRequestFingerprint = 'changed';
assert.throws(() => evaluate(actualAttemptSource, attemptScope), /VIDEO_RETRY_FINGERPRINT_MISMATCH_NOT_DISPATCHED/u);
behaviorChecks.push('manual retry reuses original identity and rejects changed payload or missing identity');

for (const mismatch of [false, true]) {
  const requests = [];
  const errors = [];
  let loads = 0;
  let scope;
  const update = name => value => { scope[name] = typeof value === 'function' ? value(scope[name]) : value; };
  scope = context({ canManage: true, token: 'fixture-session', currentOrderSaveState: 'dirty',
    currentSurface: { id: 'storyboard-video', kind: 'video', label: 'Fixture storyboard' },
    draftOrders: { 'video-page': ['other-b', 'other-a'] }, orderSaveStates: { 'video-page': 'dirty' },
    setDraftOrders: update('draftOrders'), setOrderSaveStates: update('orderSaveStates'),
    setNotice() {}, setError: message => errors.push(message), setBusyKey() {}, setCatalog() {},
    setWorkspaceReleaseRefreshKey() {}, load: async () => { loads += 1; }, messageOf: cause => cause.message,
    window: { setTimeout() {} }, responseJson: response => response.json(),
    async fetch(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method || 'GET', body });
      assert.equal(options.cache, 'no-store');
      let result;
      if (url === '/api/admin/workspace-models' && body?.action === 'reorder') {
        result = { result: { release: { id: 'fixture-release' } } };
      } else if (url === '/api/admin/workspace-model-releases' && ['validate', 'publish'].includes(body?.action)) {
        result = { success: true };
      } else if (url === '/api/admin/workspace-model-releases?previewReleaseId=fixture-release') {
        result = { preview: { previewSha256: 'a'.repeat(64) } };
      } else if (url === '/api/admin/workspace-models' && !body) {
        result = { surfaces: [{ id: 'storyboard-video', models: (mismatch ? ['card-a', 'card-b'] : ['card-b', 'card-a'])
          .map(id => ({ id, assigned: true })) }, { id: 'video-page', models: [] }] };
      } else throw new Error(`UNEXPECTED_WORKSPACE_REQUEST:${url}`);
      return { json: async () => result };
    },
  });
  const stage = evaluate(`(${callback(workspaceAst, 'stageOrder')});`, scope);
  stage([{ id: 'card-b' }, { id: 'card-a' }], 'fixture-stage');
  assert.equal(requests.length, 0, 'staging cannot persist order');
  assert.deepEqual(JSON.parse(JSON.stringify(scope.draftOrders)), {
    'video-page': ['other-b', 'other-a'], 'storyboard-video': ['card-b', 'card-a'],
  }, 'each surface retains its independent draft');
  const save = evaluate(`(${callback(workspaceAst, 'saveCurrentOrder')});`, scope);
  await save();
  assert.deepEqual(requests.map(request => request.body?.action || 'read'), ['reorder', 'validate', 'read', 'publish', 'read']);
  assert.deepEqual(requests[0].body, { action: 'reorder', kind: 'video', surface: 'storyboard-video', modelIds: ['card-b', 'card-a'] });
  assert.deepEqual(requests[3].body, { action: 'publish', releaseId: 'fixture-release', previewSha256: 'a'.repeat(64) });
  assert.deepEqual(Array.from(scope.draftOrders['video-page']), ['other-b', 'other-a'], 'saving one surface keeps the other draft');
  assert.equal(scope.orderSaveStates['video-page'], 'dirty', 'saving one surface keeps the other save state');
  assert.equal(scope.orderSaveStates['storyboard-video'], mismatch ? 'failed' : 'saved');
  assert.equal(loads, mismatch ? 1 : 0);
  if (mismatch) assert.ok(errors.some(message => message.includes('排序发布后的数据库回读不一致')));
  behaviorChecks.push(mismatch ? 'published order with mismatched readback fails and reloads' : 'explicit surface order save validates previews publishes and verifies actual readback');
}

const stageStart = workspace.indexOf("const stageOrder");
const stageEnd = workspace.indexOf("const moveToIndex", stageStart);
assert.ok(stageStart >= 0 && stageEnd > stageStart, "WORKSPACE_LOCAL_ORDER_STAGE_REQUIRED");
const stageBody = workspace.slice(stageStart, stageEnd);
assert.doesNotMatch(stageBody, /fetch\(/u, "WORKSPACE_REORDER_MUST_NOT_WRITE_BEFORE_SAVE");
assert.match(stageBody, /setDraftOrders/u, "WORKSPACE_SURFACE_DRAFT_REQUIRED");
assert.match(stageBody, /\[targetSurface\]: "dirty"/u, "WORKSPACE_DIRTY_STATE_REQUIRED");

assert.match(workspace, /data-testid="workspace-model-order-save"/u, "WORKSPACE_EXPLICIT_SAVE_BUTTON_REQUIRED");
assert.match(workspace, /action: "reorder"[\s\S]*surface: targetSurface/u, "WORKSPACE_SURFACE_SCOPED_REORDER_REQUIRED");
assert.match(workspace, /action: "validate", releaseId/u, "WORKSPACE_ORDER_VALIDATE_REQUIRED");
assert.match(workspace, /previewReleaseId=/u, "WORKSPACE_ORDER_PREVIEW_REQUIRED");
assert.match(workspace, /action: "publish", releaseId, previewSha256/u, "WORKSPACE_ORDER_PUBLISH_REQUIRED");
assert.match(workspace, /排序发布后的数据库回读不一致/u, "WORKSPACE_ORDER_READBACK_REQUIRED");

assert.match(requestStatus, /sameRequestKeyRequired: true/u, "VIDEO_RECONCILIATION_SAME_KEY_REQUIRED");
assert.match(requestStatus, /\.eq\('user_id', authorization\.user\.userId\)\.eq\('client_request_id', requestId\)/u, "VIDEO_RECONCILIATION_OWNER_SCOPE_REQUIRED");
assert.doesNotMatch(requestStatus, /generateVideo\(|generateVideoTask\(|from ['"]@\/lib\/video-adapter/u, "VIDEO_STATUS_LOOKUP_MUST_NOT_DISPATCH_PROVIDER");

const reconcileStart = storyboard.indexOf("const reconcileVideoRequest");
const reconcileEnd = storyboard.indexOf("useEffect(() => {", reconcileStart);
assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart, "VIDEO_CLIENT_RECONCILIATION_REQUIRED");
const reconcileBody = storyboard.slice(reconcileStart, reconcileEnd);
assert.match(reconcileBody, /\/api\/video\/request-status/u, "VIDEO_REQUEST_STATUS_LOOKUP_REQUIRED");
assert.match(reconcileBody, /data\.found/u, "VIDEO_EXISTING_TASK_BIND_REQUIRED");
assert.match(reconcileBody, /data\.canResubmit && data\.sameRequestKeyRequired/u, "VIDEO_CONFIRMED_NO_TASK_GATE_REQUIRED");
assert.doesNotMatch(reconcileBody, /generateVideo\(/u, "VIDEO_RECONCILIATION_MUST_NOT_AUTO_RESUBMIT");
assert.ok(behaviorChecks.includes('manual original-request refresh') && behaviorChecks.includes('explicit confirmed-no-task retry'),
  "VIDEO_MANUAL_REFRESH_AND_EXPLICIT_RETRY_BRANCHES_REQUIRED");
assert.ok(behaviorChecks.includes('manual retry reuses original identity and rejects changed payload or missing identity'),
  "VIDEO_RECOVERY_MUST_REUSE_STABLE_KEY");

assert.match(admin, /data-testid="admin-operation-toast"/u, "ADMIN_SAVE_FEEDBACK_REQUIRED");
assert.match(admin, /z-\[260\]/u, "ADMIN_SAVE_FEEDBACK_MUST_CLEAR_MODAL_LAYER");
assert.match(admin, /aria-live=/u, "ADMIN_SAVE_FEEDBACK_ACCESSIBILITY_REQUIRED");

console.log(JSON.stringify({
  passed: true,
  networkCalls: 0,
  providerCalls: 0,
  walletCalls: 0,
  behaviorChecks,
  contracts: [
    "workspace order changes remain local until explicit save",
    "each workspace surface saves through validate preview publish and readback",
    "lost video responses reconcile by owned stable request id",
    "reconciliation never auto-resubmits a paid request",
    "confirmed missing tasks reuse the original idempotency key on explicit retry",
    "agent save feedback renders above the edit modal",
  ],
}, null, 2));
