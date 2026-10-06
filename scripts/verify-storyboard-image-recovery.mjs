import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Run the actual component callbacks, draft serializer/loader and browser
// attempt helper. Every HTTP, image/storage and browser effect is an in-memory
// fixture. No environment, real session, database or provider is reachable.
const componentPath = 'src/components/storyboard-workbench.tsx';
const componentSource = readFileSync(componentPath, 'utf8');
const tree = ts.createSourceFile(componentPath, componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');

function callback(name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const value = node.initializer;
      const candidate = value && ts.isCallExpression(value) ? value.arguments[0] : value;
      if (candidate && ts.isArrowFunction(candidate)) found = candidate;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `actual ${name} callback must exist`);
  return found.getText(tree);
}

const helperNames = [
  'isWorkbenchRatio', 'createId', 'stableImageRequestDigest', 'normalizeVideoContract',
  'normalizeRun', 'publicModelName', 'modelChannelCode', 'storyboardImageModelName',
  'storyboardImageModelSelectionIssue',
  'preferredStoryboardImageResolution', 'effectiveImageResolution',
  'storyboardImageFingerprintPayload', 'isStoryboardImageRequestSnapshot',
  'deriveStoryboardImageTraceId',
];
const helpers = tree.statements.filter((node) => (
  ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)
) || (ts.isClassDeclaration(node) && node.name?.text === 'RetryableImageFileError'))
  .map((node) => node.getText(tree).replace(/^export\s/u, '')).join('\n');
const constantNames = ['WORKBENCH_RATIOS', 'MAX_REFERENCES', 'IMAGE_GENERATION_ATTEMPTS', 'STRICT_GPT_IMAGE_PUBLIC_ID'];
const constants = tree.statements.filter(ts.isVariableStatement)
  .flatMap((node) => node.declarationList.declarations)
  .filter((node) => constantNames.includes(node.name.getText(tree)))
  .map((node) => `const ${node.getText(tree)};`).join('\n');
assert.equal(constantNames.length, (constants.match(/const /gu) || []).length);

function storageFixture(seed = []) {
  const entries = new Map(seed);
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function actualModule(filename, globals = {}) {
  const compiledModule = { exports: {} };
  const forbidden = () => { throw new Error('fixture cannot import runtime services or use the network'); };
  runInNewContext(transpile(readFileSync(filename, 'utf8')), {
    module: compiledModule, exports: compiledModule.exports, require: forbidden, fetch: forbidden,
    crypto: webcrypto, TextEncoder, URL, ...globals,
  }, { filename });
  return compiledModule.exports;
}

const capabilities = actualModule('src/lib/image-model-capabilities.ts');
const outputContract = actualModule('src/lib/image-output-contract.ts');
const persistence = actualModule('src/lib/storyboard-local-persistence.ts');
const normalModel = {
  id: 'fixture-nano-model', name: 'Nano Banana 2', family: 'gemini',
  supports_reference_input: true, max_reference_images: 3,
  resolution_options: ['1K', '2K', '4K'], default_resolution: '2K',
  available: true, priceReady: true,
};

function fixture(options = {}) {
  const storage = options.storage || storageFixture();
  const probe = { requests: [], persists: [], patches: [], notices: [], delays: [], saves: [], serialized: '' };
  const faults = { persist: [], decode: [], ...options.faults };
  const runRef = { current: options.run ? clone(options.run) : {
    id: 'fixture-storyboard-run', title: 'Offline fixture', createdAt: 1, updatedAt: 1,
    ratio: '16:9', imageResolution: '2K', imageModelId: normalModel.id,
    videoModelId: '', videoResolution: '720p', videoDuration: 10,
    cards: [{ id: 'fixture-shot', order: 1, narration: '', imagePrompt: 'A simple blue cube.',
      videoPrompt: '', referenceImageUrls: [], imageStatus: 'idle', videoStatus: 'idle' }],
  } };
  const imageSubmissionsRef = { current: new Set() };
  const browser = { localStorage: storage };
  const attempts = actualModule('src/lib/browser-client-attempt.ts', { window: browser });
  const globals = {
    exports: {}, crypto: webcrypto, TextEncoder, URL, Error, window: browser,
    // The callback only needs the timeout signal. No timer or real fetch starts.
    AbortSignal: { timeout: () => undefined },
    ...capabilities, ...outputContract, ...attempts,
    runRef, imageSubmissionsRef, submittedRunIdsRef: { current: new Set() },
    scopeMountedRef: { current: true },
    imageModels: [normalModel, { ...normalModel, id: 'fixture-other-model' }],
    token: 'offline-fixture-only',
    isActiveVideoStatus: (status) => ['running', 'queued'].includes(status),
    inferStoryboardNarration: () => '', archiveRunSnapshot() {}, storyboardImagePrice: () => 0.25,
    createStoryboardPersistenceSnapshot: persistence.createStoryboardPersistenceSnapshot,
    saveStoryboardProject: async snapshot => {
      probe.saves.push(clone(snapshot));
      probe.serialized = JSON.stringify(snapshot);
      return options.saveFailure !== true;
    },
    inspectStoryboardImageAttempt: async () => ({
      state: 'provider_completed_pending_delivery',
      canRecover: true,
      sameKeyCanResubmit: true,
      message: 'offline fixture result is ready for same-key recovery',
    }),
    readOwnedStoryboardImage: async () => { throw new Error('fixture has no completed asset'); },
    setNotice: (message) => probe.notices.push(message),
    setRun: (update) => {
      // Preserve React's immutable state semantics. generateImage holds the
      // pre-patch card, including its previous terminal state.
      runRef.current = typeof update === 'function' ? update(runRef.current) : update;
      probe.patches.push(clone(runRef.current.cards[0]));
      probe.serialized = JSON.stringify(persistence.createStoryboardPersistenceSnapshot(runRef.current));
    },
    delay: async (ms) => { probe.delays.push(ms); },
    fetch: async (url, init) => {
      assert.equal(url, '/api/image/generate');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      probe.requests.push(body);
      assert.ok(probe.saves.length > 0, 'project save is attempted before image provider dispatch');
      assert.equal(runRef.current.cards[0].imageClientRequestId, body.clientIdempotencyKey,
        'the key is saved on the card before API submission');
      assert.ok(JSON.parse(probe.serialized).cards[0].imageClientRequestFingerprint,
        'the actual draft serializer retains the fingerprint before API submission');
      return { ok: true, json: async () => ({ images: [options.legacyResult
        ? { url: 'https://fixture.invalid/completed-image.png' }
        : {
            url: 'https://fixture.invalid/completed-image.png',
            assetId: 'fixture-generated-asset', storageKey: 'images/generated/fixture.png',
            width: 1920, height: 1080,
          }] }) };
    },
    persistImage: async (url, order) => {
      probe.persists.push({ url, order });
      const fault = faults.persist.shift();
      if (fault === 'retryable') throw new globals.exports.RetryableImageFileError('offline image persistence failure');
      if (fault === 'error') throw new Error('offline image persistence failure');
      return { url: 'https://fixture.invalid/owned-image.png', key: 'fixture/owned-image.png' };
    },
    browserImageReady: async () => {
      if (faults.decode.shift()) throw new Error('offline decode failure');
      if (runRef.current.ratio === '9:16') return { width: 1080, height: 1920 };
      if (runRef.current.ratio === '1:1') return { width: 1024, height: 1024 };
      return { width: 1920, height: 1080 };
    },
  };
  runInNewContext(transpile(`${constants}\n${helpers}\n`
    + `const patchCard = ${callback('patchCard')};\nconst generateImage = ${callback('generateImage')};\n`
    + 'Object.assign(exports, { generateImage, stableImageRequestDigest, RetryableImageFileError, STRICT_GPT_IMAGE_PUBLIC_ID });'), globals);
  if (options.strict) {
    runRef.current.imageModelId = globals.exports.STRICT_GPT_IMAGE_PUBLIC_ID;
    globals.imageModels.push({ ...normalModel, id: runRef.current.imageModelId, family: 'gpt' });
  }
  return {
    probe, faults, storage, attempts, runRef, imageSubmissionsRef,
    send: () => globals.exports.generateImage('fixture-shot'),
    card: () => runRef.current.cards[0],
    saved: () => JSON.parse(probe.serialized),
    scope: () => `storyboard-image:${runRef.current.id}:fixture-shot`,
    strictId: globals.exports.STRICT_GPT_IMAGE_PUBLIC_ID,
  };
}

let groups = 0;
const failed = fixture({ legacyResult: true, faults: { persist: ['error', 'error'] } });
assert.equal(await failed.send(), null);
assert.equal(failed.probe.requests.length, 1, JSON.stringify({ notices: failed.probe.notices, card: failed.card() }));
assert.equal(failed.probe.persists.length, 1, 'API succeeded before local persistence failed');
assert.equal(failed.card().imageStatus, 'running');
assert.equal(failed.imageSubmissionsRef.current.size, 0);
const first = failed.probe.requests[0];
assert.equal(first.clientTraceId, first.clientIdempotencyKey);
assert.equal(failed.attempts.readBrowserClientAttempt(failed.scope()).clientRequestId, first.clientIdempotencyKey);
groups++;

assert.equal(await failed.send(), null);
assert.equal(failed.probe.requests.length, 2);
assert.deepEqual(failed.probe.requests[1], first, 'explicit retry retains the complete API payload and trace');
groups++;

const saved = failed.saved();
assert.equal(saved.cards[0].imageClientRequestId, first.clientIdempotencyKey);
assert.equal(saved.cards[0].imageClientRequestFingerprint, failed.card().imageClientRequestFingerprint);
// A fresh VM with empty helper storage proves the serialized card is sufficient.
const reloaded = fixture({ run: saved });
assert.ok(await reloaded.send());
assert.deepEqual(reloaded.probe.requests[0], first, 'actual draft loading resumes the original request');
assert.equal(reloaded.card().imageStatus, 'done');
assert.equal(reloaded.attempts.readBrowserClientAttempt(reloaded.scope()), null, 'success clears the browser attempt');
groups++;

assert.ok(await reloaded.send());
assert.notEqual(reloaded.probe.requests[1].clientIdempotencyKey, first.clientIdempotencyKey,
  'a new explicit generation after success gets a new key, even with unchanged parameters');
assert.equal(reloaded.probe.requests[1].clientTraceId, reloaded.probe.requests[1].clientIdempotencyKey);
assert.equal(reloaded.card().imageClientRequestFingerprint, saved.cards[0].imageClientRequestFingerprint);
groups++;

for (const change of ['prompt', 'model', 'ratio', 'resolution', 'references']) {
  const changed = clone(saved);
  changed.cards[0].imageRecoveryReady = false;
  changed.cards[0].imageRetryBlocked = false;
  if (change === 'prompt') changed.cards[0].imagePrompt += ' New prompt.';
  if (change === 'model') changed.imageModelId = 'fixture-other-model';
  if (change === 'ratio') changed.ratio = '9:16';
  if (change === 'resolution') changed.imageResolution = '4K';
  if (change === 'references') changed.cards[0].referenceImageUrls = ['https://fixture.invalid/reference.png'];
  const next = fixture({ run: changed, storage: storageFixture(failed.storage.entries) });
  assert.ok(await next.send(), `${change}: ${JSON.stringify({ notices: next.probe.notices, card: next.card() })}`);
  assert.notEqual(next.probe.requests[0].clientIdempotencyKey, first.clientIdempotencyKey, `${change} changes the logical request`);
  assert.notEqual(next.card().imageClientRequestFingerprint, saved.cards[0].imageClientRequestFingerprint);
}
groups++;

const automatic = fixture({ legacyResult: true, faults: { persist: ['retryable'] } });
assert.ok(await automatic.send(), JSON.stringify({ notices: automatic.probe.notices, card: automatic.card(), requests: automatic.probe.requests.length, persists: automatic.probe.persists.length }));
assert.equal(automatic.probe.requests.length, 2);
assert.deepEqual(automatic.probe.requests[0], automatic.probe.requests[1], 'automatic file retry reuses the original complete request');
assert.equal(automatic.probe.delays.length, 1);
assert.equal(automatic.attempts.readBrowserClientAttempt(automatic.scope()), null);
groups++;

const decode = fixture({ legacyResult: true, faults: { decode: [true] } });
assert.ok(await decode.send());
assert.equal(decode.probe.requests.length, 2);
assert.deepEqual(decode.probe.requests[0], decode.probe.requests[1], 'decode retry cannot become a new model request');
assert.equal(decode.card().imageStatus, 'done');
groups++;

const strict = fixture({ strict: true, legacyResult: true, faults: { persist: ['retryable'] } });
const originalRun = clone(strict.runRef.current);
assert.equal(await strict.send(), null);
assert.equal(strict.probe.requests.length, 1, 'strict models do not auto-retry persistence failures');
const exactDigest = hash(JSON.stringify({
  runId: originalRun.id, cardId: 'fixture-shot',
  prompt: originalRun.cards[0].imagePrompt, modelId: strict.strictId,
  aspectRatio: originalRun.ratio, resolution: originalRun.imageResolution, exactText: '', referenceImageUrls: [],
  attemptOrdinal: 1,
  cardOrder: 1,
}));
assert.equal(strict.probe.requests[0].clientIdempotencyKey, `imgkey_${exactDigest}`);
assert.equal(strict.probe.requests[0].clientTraceId, `imgtrace_${exactDigest}`);
assert.equal(strict.probe.requests[0].strictSingleSubmit, true);
assert.equal(strict.probe.requests[0].noRetry, true);
assert.ok(await strict.send());
assert.ok(await strict.send());
assert.deepEqual(strict.probe.requests[1], strict.probe.requests[0]);
assert.notEqual(strict.probe.requests[2].clientIdempotencyKey, strict.probe.requests[0].clientIdempotencyKey,
  'a new explicit strict generation after success gets a new persisted ordinal');
assert.equal(strict.storage.entries.size, 0, 'strict requests never use the non-strict browser attempt cache');
groups++;

const unsaved = fixture({ saveFailure: true });
assert.equal(await unsaved.send(), null);
assert.equal(unsaved.probe.saves.length, 1);
assert.equal(unsaved.probe.requests.length, 0, 'project-index failure must block provider POST so a paid result cannot become unbound');
assert.notEqual(unsaved.card().imageStatus, 'done');
assert.equal(unsaved.probe.persists.length, 0, 'a blocked provider request cannot enter the persistence path');
groups++;

const direct = fixture();
const directResult = await direct.send();
assert.ok(directResult);
assert.equal(direct.probe.requests.length, 1);
assert.equal(direct.probe.persists.length, 0, 'stable asset from image/generate is already persisted');
assert.equal(direct.card().imageAssetId, 'fixture-generated-asset');
assert.equal(direct.card().imageStorageKey, 'images/generated/fixture.png');
assert.equal(direct.card().imageUrl, 'https://fixture.invalid/completed-image.png');
groups++;

console.log(JSON.stringify({
  passed: true, dynamicGroups: groups, parameterChangeCases: 5,
  actualCallbacks: ['storyboard.generateImage', 'storyboard.patchCard'],
  actualHelpers: ['browser-client-attempt', 'storyboard-local-persistence', 'storyboard.stableImageRequestDigest'],
  componentSha256: hash(componentSource),
  providerRequests: 0, realNetworkRequests: 0, realDatabaseWrites: 0,
}));
