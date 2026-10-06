import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// This verifier executes the current recovery effect and generation callback
// against in-memory fixtures. Fetch is fully intercepted; no real API,
// database, wallet or provider can be reached.
const componentPath = 'src/components/storyboard-workbench.tsx';
const source = fs.readFileSync(componentPath, 'utf8');
const tree = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const transpile = (text) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');

function namedCallback(name) {
  let found = '';
  function visit(node) {
    if (!found && ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
      const initializer = node.initializer;
      const candidate = initializer && ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
      if (candidate && ts.isArrowFunction(candidate)) found = candidate.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `${name} callback must exist`);
  return found;
}

function effectContaining(marker) {
  let found = '';
  function visit(node) {
    if (
      !found
      && ts.isCallExpression(node)
      && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes(marker)
    ) found = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `useEffect containing ${marker} must exist`);
  return found;
}

const helperNames = [
  'isWorkbenchRatio',
  'storyboardImageFingerprintPayload',
  'isStoryboardImageRequestSnapshot',
  'deriveStoryboardImageTraceId',
  'stableImageRequestDigest',
];
const helperCode = tree.statements.filter((node) => (
  ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)
) || (ts.isClassDeclaration(node) && node.name?.text === 'RetryableImageFileError'))
  .map((node) => node.getText(tree).replace(/^export\s/u, '')).join('\n');
assert.equal((helperCode.match(/function /gu) || []).length, helperNames.length);

function storageFixture() {
  const entries = new Map();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function actualModule(filename, globals = {}) {
  const compiledModule = { exports: {} };
  const forbidden = () => { throw new Error('offline fixture cannot import runtime services'); };
  vm.runInNewContext(transpile(fs.readFileSync(filename, 'utf8')), {
    module: compiledModule,
    exports: compiledModule.exports,
    require: forbidden,
    fetch: forbidden,
    crypto: webcrypto,
    TextEncoder,
    URL,
    Date,
    Math,
    ...globals,
  }, { filename });
  return compiledModule.exports;
}

const requestSnapshot = {
  runId: 'owned-project',
  cardId: 'shot-1',
  cardOrder: 1,
  prompt: 'Original immutable prompt',
  modelId: 'retired-image-model',
  aspectRatio: '16:9',
  resolution: '2K',
  referenceImageUrls: ['https://fixture.invalid/reference.png'],
  strictSingleSubmit: false,
};
const oldRequestId = 'sbw-image-old-request-0001';
const oldTraceId = oldRequestId;
const browserStorage = storageFixture();
const attempts = actualModule('src/lib/browser-client-attempt.ts', {
  window: { localStorage: browserStorage },
});
const imageOutputContract = actualModule('src/lib/image-output-contract.ts');
const oldFingerprint = await attempts.buildClientRequestFingerprint({
  runId: requestSnapshot.runId,
  cardId: requestSnapshot.cardId,
  prompt: requestSnapshot.prompt,
  modelId: requestSnapshot.modelId,
  aspectRatio: requestSnapshot.aspectRatio,
  resolution: requestSnapshot.resolution,
  exactText: "",
  referenceImageUrls: requestSnapshot.referenceImageUrls,
});

function baseCard(overrides = {}) {
  return {
    id: requestSnapshot.cardId,
    order: 1,
    narration: '',
    imagePrompt: 'Edited after submission; recovery must ignore this value',
    videoPrompt: '',
    referenceImageUrls: [],
    imageStatus: 'running',
    imageClientRequestId: oldRequestId,
    imageClientTraceId: oldTraceId,
    imageClientRequestFingerprint: oldFingerprint,
    imageRequestSnapshot: clone(requestSnapshot),
    imageRecoveryReady: false,
    imageRetryBlocked: false,
    imageModelIdUsed: requestSnapshot.modelId,
    imageModelNameUsed: 'Retired fixture model',
    videoStatus: 'idle',
    ...overrides,
  };
}

function baseRun(card) {
  return {
    id: requestSnapshot.runId,
    title: 'Owned submitted project',
    createdAt: 1,
    updatedAt: 2,
    ratio: '9:16',
    imageResolution: '4K',
    videoResolution: '720p',
    videoDuration: 10,
    imageModelId: 'different-current-model',
    videoModelId: '',
    cards: [card],
  };
}

const monitorEffect = effectContaining('const inspectActiveImages = async');
const inspectCallback = namedCallback('inspectStoryboardImageAttempt');
const readOwnedCallback = namedCallback('readOwnedStoryboardImage');

async function runMonitorCase(status) {
  const card = baseCard();
  const runRef = { current: baseRun(card) };
  const requests = [];
  const cleared = [];
  const context = {
    exports: {},
    crypto: webcrypto,
    TextEncoder,
    URL,
    URLSearchParams,
    Error,
    Promise,
    String,
    Boolean,
    token: 'offline-token',
    storageReady: true,
    run: runRef.current,
    runRef,
    imageStatusChecksRef: { current: new Set() },
    imageSubmissionsRef: { current: new Set() },
    VIDEO_POLL_INTERVAL_MS: 5_000,
    WORKBENCH_RATIOS: ['16:9', '9:16', '1:1'],
    window: { setInterval: () => 1, clearInterval() {} },
    browserImageReady: async () => ({ width: 1920, height: 1080 }),
    imageDimensionsMatchAspectRatio: imageOutputContract.imageDimensionsMatchAspectRatio,
    fetch: async (url, init = {}) => {
      const request = { url: String(url), method: init.method || 'GET' };
      requests.push(request);
      if (request.url.startsWith('/api/image/status?')) {
        return { ok: true, json: async () => status };
      }
      if (request.url.startsWith('/api/storyboard/image?')) {
        return {
          ok: true,
          json: async () => ({
            url: 'https://fixture.invalid/signed-owned.png',
            assetId: status.assetId,
            storageKey: 'owned/storyboard.png',
          }),
        };
      }
      throw new Error(`unexpected offline request: ${request.url}`);
    },
    clearBrowserClientAttempt: (scope, requestId) => cleared.push({ scope, requestId }),
    patchCard: (cardId, patch) => {
      runRef.current = {
        ...runRef.current,
        cards: runRef.current.cards.map((item) => item.id === cardId ? { ...item, ...patch } : item),
      };
    },
  };
  vm.runInNewContext(transpile(`${helperCode}\n`
    + `const inspectStoryboardImageAttempt = ${inspectCallback};\n`
    + `const readOwnedStoryboardImage = ${readOwnedCallback};\n`
    + `globalThis.startImageMonitor = ${monitorEffect};`), context);
  const cleanup = context.startImageMonitor();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  cleanup?.();
  return { card: runRef.current.cards[0], requests, cleared };
}

const unknown = await runMonitorCase({ state: 'unknown', canRecover: false, canResubmit: false, message: 'UNKNOWN' });
assert.equal(unknown.card.imageRetryBlocked, true);
assert.equal(unknown.card.imageRecoveryReady, false);
assert.equal(unknown.card.imageClientRequestId, oldRequestId, 'UNKNOWN must preserve the original request');
assert.deepEqual(unknown.requests.map((item) => item.method), ['GET']);

const notFound = await runMonitorCase({ state: 'not_found', canRecover: false, canResubmit: false, message: 'not found' });
assert.equal(notFound.card.imageRetryBlocked, true);
assert.equal(notFound.card.imageClientRequestId, oldRequestId, 'not_found must remain locked instead of becoming a new request');
assert.deepEqual(notFound.requests.map((item) => item.method), ['GET']);

const rejected = await runMonitorCase({ state: 'rejected', canRecover: false, canResubmit: true, sameKeyCanResubmit: false, message: 'rejected' });
assert.equal(rejected.card.imageRetryBlocked, false);
assert.equal(rejected.card.imageRecoveryReady, false);
assert.equal(rejected.card.imageClientRequestId, undefined, 'confirmed rejection must clear the old key before a user retry');
assert.equal(rejected.card.imageRequestSnapshot, undefined);
assert.equal(rejected.cleared.length, 1);
assert.deepEqual(rejected.requests.map((item) => item.method), ['GET']);

const completed = await runMonitorCase({
  state: 'completed', canRecover: true, canResubmit: false, assetId: 'owned-asset-1', message: 'completed',
});
assert.equal(completed.card.imageStatus, 'done');
assert.equal(completed.card.imageRecoveryReady, false);
assert.equal(completed.card.imageRetryBlocked, false);
assert.equal(completed.card.imageAssetId, 'owned-asset-1');
assert.equal(completed.card.imageStorageKey, 'owned/storyboard.png');
assert.equal(completed.card.imageUrl, 'https://fixture.invalid/signed-owned.png');
assert.deepEqual(completed.requests.map((item) => item.method), ['GET', 'GET']);
assert.equal(completed.requests.some((item) => item.url === '/api/image/generate'), false,
  'completed assets must be restored without the generation endpoint');

const pendingDelivery = await runMonitorCase({
  state: 'provider_completed_pending_delivery', canRecover: true, canResubmit: false, message: 'delivery pending',
});
assert.equal(pendingDelivery.card.imageRecoveryReady, true);
assert.equal(pendingDelivery.card.imageRetryBlocked, false);
assert.equal(pendingDelivery.card.imageClientRequestId, oldRequestId, 'pending delivery must retain the exact key');
assert.deepEqual(pendingDelivery.card.imageRequestSnapshot, requestSnapshot);
assert.deepEqual(pendingDelivery.requests.map((item) => item.method), ['GET']);

function generateFixture(card, options = {}) {
  const storage = storageFixture();
  const browserAttempts = actualModule('src/lib/browser-client-attempt.ts', { window: { localStorage: storage } });
  const runRef = { current: baseRun(clone(card)) };
  const probe = { generatePosts: [], statusChecks: [], assetReads: [], persists: [], projectSaves: [], notices: [], clears: [] };
  const normalModel = {
    id: 'current-image-model', name: 'Current fixture model', family: 'gemini',
    supports_reference_input: true, max_reference_images: 3,
    resolution_options: ['1K', '2K', '4K'], default_resolution: '2K',
  };
  runRef.current.imageModelId = normalModel.id;
  const context = {
    exports: {},
    crypto: webcrypto,
    TextEncoder,
    URL,
    Error,
    Date,
    Math,
    JSON,
    String,
    Boolean,
    Array,
    AbortSignal: { timeout: () => undefined },
    token: 'offline-token',
    scopeMountedRef: { current: true },
    runRef,
    imageSubmissionsRef: { current: new Set() },
    submittedRunIdsRef: { current: new Set() },
    imageModels: [normalModel],
    STRICT_GPT_IMAGE_PUBLIC_ID: 'strict-fixture-model',
    WORKBENCH_RATIOS: ['16:9', '9:16', '1:1'],
    IMAGE_GENERATION_ATTEMPTS: 2,
    isActiveVideoStatus: (status) => status === 'running' || status === 'queued',
    getImageModelCapabilities: () => ({ supportsReferenceInput: true, maxReferenceImages: 3 }),
    storyboardImageModelSelectionIssue: () => "",
    storyboardImageModelName: (model) => model.name,
    storyboardImagePrice: () => 0.34,
    effectiveImageResolution: (_model, resolution) => resolution || '2K',
    buildClientRequestFingerprint: browserAttempts.buildClientRequestFingerprint,
    resolveBrowserClientAttempt: browserAttempts.resolveBrowserClientAttempt,
    clearBrowserClientAttempt: (scope, requestId) => {
      probe.clears.push({ scope, requestId });
      browserAttempts.clearBrowserClientAttempt(scope, requestId);
    },
    inspectStoryboardImageAttempt: async (target) => {
      probe.statusChecks.push({ key: target.imageClientRequestId, trace: target.imageClientTraceId });
      return options.status || { state: 'provider_completed_pending_delivery', canRecover: true, canResubmit: false };
    },
    readOwnedStoryboardImage: async (reference) => {
      probe.assetReads.push(reference);
      return {
        url: 'https://fixture.invalid/signed-owned.png',
        assetId: reference.assetId,
        storageKey: 'owned/storyboard.png',
      };
    },
    fetch: async (url, init = {}) => {
      assert.equal(url, '/api/image/generate');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      probe.generatePosts.push(body);
      assert.ok(probe.projectSaves.length > 0, 'owned project snapshot must be saved before image dispatch');
      return {
        ok: true,
        json: async () => ({ images: [{ url: 'https://fixture.invalid/completed.png', storageKey: 'owned/completed.png' }] }),
      };
    },
    persistImage: async (url, order) => {
      probe.persists.push({ url, order });
      return { url: 'https://fixture.invalid/owned.png', key: 'owned/completed.png' };
    },
    browserImageReady: async () => options.outputDimensions || ({ width: 1920, height: 1080 }),
    imageDimensionsMatchAspectRatio: imageOutputContract.imageDimensionsMatchAspectRatio,
    archiveRunSnapshot() {},
    delay: async () => {},
    setNotice: (message) => probe.notices.push(message),
    setRun: (value) => {
      runRef.current = typeof value === 'function' ? value(runRef.current) : value;
    },
    createStoryboardPersistenceSnapshot: (value) => value,
    saveStoryboardProject: async (snapshot) => {
      probe.projectSaves.push(snapshot);
      return options.projectSave !== false;
    },
    patchCard: (cardId, patch, runPatch) => {
      runRef.current = {
        ...runRef.current,
        ...runPatch,
        cards: runRef.current.cards.map((item) => item.id === cardId ? { ...item, ...patch } : item),
      };
    },
  };
  vm.runInNewContext(transpile(`${helperCode}\n`
    + `globalThis.generateImage = ${namedCallback('generateImage')};`), context);
  return {
    probe,
    runRef,
    send: () => context.generateImage(requestSnapshot.cardId),
    card: () => runRef.current.cards[0],
  };
}

const blockedGenerate = generateFixture(baseCard({ imageStatus: 'failed', imageRetryBlocked: true }));
assert.equal(await blockedGenerate.send(), null);
assert.equal(blockedGenerate.probe.statusChecks.length, 0);
assert.equal(blockedGenerate.probe.generatePosts.length, 0, 'UNKNOWN/not_found lock must prevent every POST');

const recoverGenerate = generateFixture(baseCard({
  imageStatus: 'failed',
  imageRecoveryReady: true,
  imageRetryBlocked: false,
}), {
  status: { state: 'provider_completed_pending_delivery', canRecover: true, canResubmit: false },
});
const recoverResult = await recoverGenerate.send();
assert.ok(recoverResult, JSON.stringify({ notices: recoverGenerate.probe.notices, card: recoverGenerate.card() }));
assert.equal(recoverGenerate.probe.statusChecks.length, 1, 'explicit recovery must re-confirm the read status first');
assert.equal(recoverGenerate.probe.projectSaves.length, 1, 'recovery must persist its immutable request snapshot before POST');
assert.equal(recoverGenerate.probe.assetReads.length, 0);
assert.equal(recoverGenerate.probe.generatePosts.length, 1, 'only pending delivery may use the exactly-once endpoint after an explicit click');
assert.equal(recoverGenerate.probe.generatePosts[0].clientIdempotencyKey, oldRequestId);
assert.equal(recoverGenerate.probe.generatePosts[0].clientTraceId, oldTraceId);
assert.equal(recoverGenerate.probe.generatePosts[0].prompt, requestSnapshot.prompt);
assert.equal(recoverGenerate.probe.generatePosts[0].modelId, requestSnapshot.modelId);
assert.equal(recoverGenerate.probe.generatePosts[0].aspectRatio, requestSnapshot.aspectRatio);
assert.equal(recoverGenerate.probe.generatePosts[0].resolution, requestSnapshot.resolution);
assert.deepEqual(recoverGenerate.probe.generatePosts[0].referenceImageUrls, requestSnapshot.referenceImageUrls);
assert.equal(recoverGenerate.card().imageStatus, 'done');

const completedAssetGenerate = generateFixture(baseCard({
  imageStatus: 'failed',
  imageRecoveryReady: true,
  imageRetryBlocked: false,
}), {
  status: { state: 'completed', canRecover: true, canResubmit: false, assetId: 'owned-asset-1' },
});
assert.ok(await completedAssetGenerate.send());
assert.equal(completedAssetGenerate.probe.statusChecks.length, 1);
assert.equal(completedAssetGenerate.probe.projectSaves.length, 0, 'owned completed assets do not need a new submission save');
assert.equal(completedAssetGenerate.probe.assetReads.length, 1);
assert.equal(completedAssetGenerate.probe.generatePosts.length, 0,
  'a completed owned asset must never POST to the generation endpoint, even from a stale recovery button');
assert.equal(completedAssetGenerate.card().imageStatus, 'done');
assert.equal(completedAssetGenerate.card().imageAssetId, 'owned-asset-1');

const unsavedRecovery = generateFixture(baseCard({
  imageStatus: 'failed',
  imageRecoveryReady: true,
  imageRetryBlocked: false,
}), {
  status: { state: 'provider_completed_pending_delivery', canRecover: true, canResubmit: false },
  projectSave: false,
});
assert.equal(await unsavedRecovery.send(), null);
assert.equal(unsavedRecovery.probe.projectSaves.length, 1);
assert.equal(unsavedRecovery.probe.generatePosts.length, 0, 'project save failure must block every image provider POST');
assert.equal(unsavedRecovery.card().imageRecoveryReady, true, 'failed pre-dispatch save keeps the original recovery action available');
assert.equal(unsavedRecovery.card().imageRetryBlocked, false);

const rejectedRetry = generateFixture({
  ...clone(rejected.card),
  imagePrompt: 'A newly confirmed retry',
  referenceImageUrls: [],
  imageStatus: 'failed',
}, { outputDimensions: { width: 1080, height: 1920 } });
assert.ok(await rejectedRetry.send(), JSON.stringify({ notices: rejectedRetry.probe.notices, card: rejectedRetry.card() }));
assert.equal(rejectedRetry.probe.generatePosts.length, 1);
assert.notEqual(rejectedRetry.probe.generatePosts[0].clientIdempotencyKey, oldRequestId,
  'confirmed rejection must generate a fresh key on the next explicit user retry');
assert.equal(rejectedRetry.card().imageStatus, 'done');

assert.match(source, /fetch\(`\/api\/image\/status\?\$\{query\.toString\(\)\}`/u,
  'automatic recovery must use the read-only status route');
assert.match(source, /fetch\(`\/api\/storyboard\/image\?\$\{query\.toString\(\)\}`/u,
  'completed assets must use the owned read-only asset route');
assert.match(source, /if \(card\.imageRetryBlocked\)[\s\S]*?return null;/u,
  'blocked recovery must stop before generation');
assert.match(source, /card\.imageRecoveryReady[\s\S]*?正在保存结果/u,
  'pending delivery must be presented as automatic platform work');
const visibleStoryboardCopy = [];
function collectVisibleStoryboardCopy(node) {
  if (ts.isJsxText(node)) visibleStoryboardCopy.push(node.text);
  if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression)) {
    visibleStoryboardCopy.push(node.expression.text);
  }
  ts.forEachChild(node, collectVisibleStoryboardCopy);
}
collectVisibleStoryboardCopy(tree);
assert.doesNotMatch(visibleStoryboardCopy.join('\n'), /立即恢复|恢复原图片/u,
  'the UI must not ask the user to manually recover a generated result');

console.log(JSON.stringify({
  ok: true,
  componentSha256: hash(source),
  cases: {
    automaticRecoveryUsesGetOnly: true,
    unknownLockedAndOriginalKeyPreserved: true,
    notFoundLockedAndOriginalKeyPreserved: true,
    rejectedClearsOldKey: true,
    rejectedExplicitRetryUsesNewKey: true,
    completedAssetRestoresByGetWithoutGenerationPost: true,
    providerCompletedPendingDeliveryBecomesAutomaticDelivery: true,
    automaticPendingDeliveryUsesSameKeyAndSnapshot: true,
    staleRecoveryButtonForCompletedAssetStillUsesGetOnly: true,
    projectSaveFailureBlocksProviderDispatch: true,
  },
  automaticStatusAndAssetGetRequests: unknown.requests.length + notFound.requests.length
    + rejected.requests.length + completed.requests.length + pendingDelivery.requests.length,
  automaticGenerationPosts: 0,
  completedAssetGenerationPosts: completedAssetGenerate.probe.generatePosts.length,
  explicitPendingDeliveryExactlyOncePosts: recoverGenerate.probe.generatePosts.length,
  providerRequests: 0,
  paidRequests: 0,
  realNetworkRequests: 0,
  realDatabaseWrites: 0,
}, null, 2));
