#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentOnly = process.argv.includes('--current-only');
const before = process.argv.find((value) => value.startsWith('--before='))?.slice(9);
if (!currentOnly) assert.ok(before, 'use --before=<backup> for comparison or --current-only for current contract verification');
const snapshot = before ? path.resolve(root, before) : '';
if (snapshot) assert.ok(snapshot.startsWith(path.join(root, '.codex-backups') + path.sep));
const current = path.join(root, 'src/components/image-workbench.tsx');
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const compiledModule = { exports: {} };
// Both pure modules share one realm so the public input parser keeps its
// plain-object check; no application or network imports are evaluated.
const helperContext = vm.createContext({ module: compiledModule, exports: compiledModule.exports, URL });
const requestSource = compile(fs.readFileSync(path.join(root, 'src/lib/image-generation-request.ts'), 'utf8'));
vm.runInContext(requestSource, helperContext);
const requestModule = compiledModule.exports;
compiledModule.exports = {};
helperContext.exports = compiledModule.exports;
helperContext.require = name => { assert.equal(name, './image-generation-request'); return requestModule; };
vm.runInContext(compile(fs.readFileSync(path.join(root, 'src/lib/image-workbench-recovery.ts'), 'utf8')), helperContext);
const helper = compiledModule.exports;
const original = { prompt: 'original prompt', modelId: 'pm_original', aspectRatio: '3:4', resolution: '2K', referenceImageUrls: ['https://public.example/original.png'] };
const recovering = { id: 'recovering-card', prompt: 'original prompt', status: 'recoverable', generationKey: 'image_original_key', generationTraceId: 'image_original_trace', generationModelId: 'pm_original', generationFingerprint: JSON.stringify(original) };
function extract(file) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let fn; let enabled;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'generateAll') fn = node.initializer.arguments[0].getText(tree);
      if (node.name.text === 'canGenerate') enabled = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(fn && enabled); return { fn, enabled };
}
function harness(file, rows = [recovering], options = {}) {
  let jobs = structuredClone(rows); const posts = []; let uploads = 0; let probes = 0; let histories = [];
  const code = extract(file);
  const context = vm.createContext({
    jobs, token: 'fixture-session', generationInFlightRef: { current: false }, busy: false,
    newGenerationJobCount: jobs.filter(job => ["idle", "failed"].includes(job.status) && job.prompt.trim()).length,
    recoverableJobCount: jobs.filter(job => job.status === "recoverable").length,
    actionableJobCount: jobs.length, unknownJobCount: 0, hasRecoverableJobs: jobs.some((job) => job.status === 'recoverable'),
    mode: options.mode || 'image-to-image', references: [], modelSupportsMode: !options.noModel,
    activeReferenceLimit: 9, referenceLimitExceeded: false,
    activeModel: options.noModel ? undefined : { id: 'pm_current', name: 'Current Model', available: true, price_ready: true },
    models: [{ id: 'pm_original', name: 'Original Model' }], aspectRatio: '16:9', selectedResolution: '4K',
    setBusy() {}, setNotice() {}, setJobs: (fn) => { jobs = fn(jobs); }, setCashBalance() {},
    setHistory: (fn) => { histories = fn(histories); }, cleanHistory: (entries) => entries,
    uploadReference: async () => { uploads++; throw new Error('unexpected upload'); },
    inspectImageAttempt: async () => { probes++; return { canRecover: options.canRecover !== false }; },
    parseImageWorkbenchRecoveryPayload: helper.parseImageWorkbenchRecoveryPayload,
    projectGeneratedImageClientReceipt: () => null, persistAccountHistoryRecord: async () => {},
    isConfirmedUnsubmittedImageFailure: () => false, isImageResolution: (value) => ['1K', '2K', '4K'].includes(value),
    normalizeImageUrl: (url) => url, createId: (prefix) => `${prefix}_new_fixture`,
    persistGeneratedImage: async () => ({ url: '/api/storage/owned', key: 'image.png', assetId: 'asset', historyRecordId: 'history' }),
    fetch: async (url, init) => {
      assert.equal(url, '/api/image/generate'); const body = JSON.parse(init.body); posts.push(body);
      return new Response(JSON.stringify({ images: [{ url: '/api/storage/owned', storageKey: 'image.png', assetId: 'asset' }], operationId: 'operation', resolution: body.resolution, cashCharged: 0 }), { status: 200 });
    }, Response, window: { dispatchEvent() {} },
  });
  vm.runInContext(compile(`globalThis.enabled = (${code.enabled}); globalThis.run = ${code.fn};`), context);
  return { run: () => context.run(), enabled: () => context.enabled, jobs: () => jobs, posts, uploads: () => uploads, probes: () => probes, history: () => histories };
}
const cases = [];
async function check(name, run) { await run(); cases.push(name); }
if (!currentOnly) {
  await check('old refreshed image-to-image recovery disabled and callback returns without submission', async () => {
    const f = harness(snapshot); assert.equal(f.enabled(), false); await f.run(); assert.equal(f.posts.length, 0);
  });
}
await check('restored reference recovery keeps fresh generation disabled and uses original complete request', async () => {
  const f = harness(current); assert.equal(f.enabled(), false); await f.run();
  assert.equal(f.posts.length, 1); const body = f.posts[0];
  for (const key of Object.keys(original)) assert.deepEqual(body[key], original[key]);
  assert.equal(body.clientIdempotencyKey, recovering.generationKey); assert.equal(body.clientTraceId, recovering.generationTraceId);
  assert.equal(f.uploads(), 0); assert.equal(f.probes(), 1); assert.equal(f.jobs()[0].status, 'done');
  assert.equal(f.history()[0].mode, 'image-to-image'); assert.equal(f.history()[0].aspectRatio, '3:4'); assert.equal(f.history()[0].modelName, 'Original Model');
});
await check('new draft fields and missing current model never replace original recovery payload', async () => {
  const f = harness(current, [{ ...recovering, prompt: 'edited draft' }], { mode: 'text-to-image', noModel: true }); await f.run();
  assert.equal(f.posts[0].prompt, original.prompt); assert.equal(f.posts[0].modelId, original.modelId);
  assert.equal(f.jobs()[0].prompt, original.prompt);
});
await check('unconfirmed status preserves key without generation', async () => {
  const f = harness(current, [recovering], { canRecover: false }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.jobs()[0].status, 'unknown'); assert.equal(f.jobs()[0].generationKey, recovering.generationKey);
});
await check('SHA digest is never mistaken for stored JSON request fields', async () => {
  const f = harness(current, [{ ...recovering, generationFingerprint: 'a'.repeat(64) }]); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.probes(), 0); assert.equal(f.jobs()[0].status, 'unknown');
});
await check('mismatched saved model and malformed references fail closed', async () => {
  assert.equal(helper.parseImageWorkbenchRecoveryPayload({ ...recovering, generationModelId: 'pm_other' }), null);
  assert.equal(helper.parseImageWorkbenchRecoveryPayload({ ...recovering, generationFingerprint: JSON.stringify({ ...original, referenceImageUrls: [null] }) }), null);
});
await check('ordinary fresh text generation keeps existing request fields', async () => {
  const f = harness(current, [{ id: 'new', prompt: 'new prompt', status: 'idle' }], { mode: 'text-to-image' }); await f.run();
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].modelId, 'pm_current'); assert.equal(f.posts[0].prompt, 'new prompt'); assert.equal(f.posts[0].aspectRatio, '16:9'); assert.equal(f.probes(), 0);
});
await check('recovery proceeds while unready fresh image-to-image draft stays idle', async () => {
  const f = harness(current, [recovering, { id: 'new', prompt: 'new prompt', status: 'idle' }]); await f.run();
  assert.equal(f.posts.length, 1); assert.equal(f.jobs()[1].status, 'idle');
});
// Extract the actual storyboard consumer. All I/O below is injected; these
// fixtures cannot call a provider, browser, database, or filesystem mutator.
const storyboardSource = fs.readFileSync(path.join(root, 'src/components/storyboard-workbench.tsx'), 'utf8');
const storyboardTree = ts.createSourceFile('storyboard-workbench.tsx', storyboardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let recoverAssetCallback;
(function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'recoverPendingAssets') recoverAssetCallback = node.initializer.arguments[0].getText(storyboardTree);
  ts.forEachChild(node, visit);
})(storyboardTree);
assert.ok(recoverAssetCallback);
const assetAttempt = { projectId: 'original-project', planId: 'character-plan', role: 'character',
  name: 'Original character', prompt: 'original native reference prompt', tags: ['native'],
  modelId: 'pm_original', modelName: 'Original model', ratio: '1:1', resolution: '1K',
  quotedPrice: 0.30, clientIdempotencyKey: 'image_original_asset_key', clientTraceId: 'image_original_asset_trace', createdAt: '2026-10-20T00:00:00Z' };
const serverResumeInput = { prompt: 'SERVER WRAPPER\noriginal native reference prompt', modelId: assetAttempt.modelId, mode: 'local',
  style: '', aspectRatio: '1:1', resolution: '1K', coverText: '', referenceImageUrls: [],
  referenceUsage: 'character-identity', historySurface: 'storyboard-workbench', resumeDeliveryOnly: true };
const recoverableReceipt = { state: 'provider_completed_pending_delivery', canRecover: true, canResubmit: false, deliveryReady: false,
  resumeInput: serverResumeInput };
const completedReceipt = { state: 'completed', canRecover: false, canResubmit: false, deliveryReady: true, recordId: 'original-record' };
const helperOriginal = { ...assetAttempt, historySurface: 'storyboard-workbench', referenceUsage: 'character-identity' };
const nativeCards = Array.from({ length: 13 }, (_, i) => ({ id: 'native-' + i, videoPrompt: '完整原生提示词 ' + i, imagePrompt: '原生分镜 ' + i }));
const plain = value => JSON.parse(JSON.stringify(value));
function assetHarness(options = {}) {
  let attempts = [structuredClone({ ...assetAttempt, ...options.attempt })];
  let statusCount = 0;
  const posts = [], queries = [], saves = [], restores = [], errors = [], notices = [], generating = [];
  const runRef = { current: { id: options.currentId || assetAttempt.projectId, cards: structuredClone(nativeCards), visualAssetWorkspace: { drafts: [], candidates: [] } } };
  const originalProject = { id: assetAttempt.projectId, cards: structuredClone(nativeCards), visualAssetWorkspace: { drafts: [], candidates: [] } };
  const scopeMountedRef = { current: true }, imageDownloadOwnerRef = { current: 'owner\0ram-token' };
  const visualAssetGenerationRef = { current: false };
  const withCandidate = (run, candidate) => ({ ...run, visualAssetWorkspace: { ...run.visualAssetWorkspace, candidates: [candidate] } });
  const sandbox = {
    Error, URLSearchParams, AbortSignal, JSON, token: 'ram-token', userId: 'owner',
    window: { localStorage: {} }, scopeMountedRef, imageDownloadOwnerRef, visualAssetGenerationRef, runRef,
    contextReadyRef: { current: options.ready !== false }, restoredReferenceContextsRef: { current: new WeakMap() },
    imageDeliveryRecoveryRequest: helper.imageDeliveryRecoveryRequest,
    readStoryboardAssetAttempts: (_storage, user) => { assert.equal(user, 'owner'); return structuredClone(attempts); },
    updateAssetAttempts: value => { attempts = plain(value); },
    setVisualAssetGenerating: value => generating.push(value), setVisualAssetError: value => errors.push(value), setNotice: value => notices.push(value),
    readOwnedStoryboardImage: async ({ assetId }) => { assert.equal(assetId, 'owned-asset'); options.afterOwned?.(sandbox); return { url: '/api/image/assets/owned-asset', storageKey: 'owner/original.png' }; },
    rememberVisualAssetCandidate: (candidate, context) => { assert.equal(context, runRef.current.id); runRef.current = withCandidate(runRef.current, candidate); return runRef.current; },
    withVisualAssetCandidate: withCandidate,
    restoreVisualAssetContext: async scope => {
      restores.push(plain(scope)); options.afterRestore?.(sandbox);
      return options.restoreMismatch ? { ...originalProject, id: 'wrong-project' } : originalProject;
    },
    saveVisualAssetContext: async (run, manual) => {
      assert.equal(manual, true); assert.equal(attempts.length, 1, 'pending must remain until save confirmation');
      saves.push(plain(run)); options.afterSave?.(sandbox); return options.saveOk !== false;
    },
    fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer ram-token');
      if (url.startsWith('/api/image/status?')) {
        const params = new URL(url, 'http://fixture.invalid').searchParams;
        assert.equal(params.get('clientIdempotencyKey'), assetAttempt.clientIdempotencyKey);
        assert.equal(params.get('clientTraceId'), assetAttempt.clientTraceId);
        queries.push(url);
        const index = statusCount++;
        if (options.statusBarrier) await options.statusBarrier;
        options.afterStatus?.(sandbox, index);
        return { ok: options.statusOk !== false, json: async () => structuredClone((options.receipts || [recoverableReceipt, completedReceipt])[index] || completedReceipt) };
      }
      if (url === '/api/image/generate') {
        assert.equal(init.method, 'POST'); posts.push(JSON.parse(init.body)); options.afterPost?.(sandbox);
        if (options.throwPost) throw new Error('transport unknown');
        return { ok: options.postOk !== false, json: async () => options.postOk === false ? { error: 'persistence pending' } : { images: [{ url: '/untrusted-response-not-used' }] } };
      }
      assert.equal(url, '/api/storyboard/visual-assets?recordId=original-record');
      options.afterOwned?.(sandbox);
      return { ok: true, json: async () => ({ reference: { previewUrl: '/api/image/provider-reference/original-record' } }) };
    },
  };
  vm.runInNewContext(compile('globalThis.recoverAsset = ' + recoverAssetCallback + ';'), sandbox);
  return { run: () => sandbox.recoverAsset(), posts, queries, saves, restores, errors, notices, generating, sandbox,
    attempts: () => attempts, current: () => plain(runRef.current), originalProject };
}
await check('asset checkpoint recovery uses only original server snapshot and original keys', async () => {
  const f = assetHarness(); await f.run();
  assert.equal(f.posts.length, 1); assert.equal(f.queries.length, 2);
  const body = f.posts[0];
  for (const [key, value] of Object.entries(serverResumeInput)) assert.deepEqual(body[key], value);
  assert.equal(body.clientIdempotencyKey, assetAttempt.clientIdempotencyKey); assert.equal(body.clientTraceId, assetAttempt.clientTraceId);
  assert.equal(body.noRetry, true); assert.equal(body.strictSingleSubmit, true); assert.equal(body.resumeDeliveryOnly, true);
  assert.equal(f.saves.length, 1); assert.equal(f.attempts().length, 0);
  assert.deepEqual(f.saves[0].cards, nativeCards); assert.equal(f.saves[0].visualAssetWorkspace.candidates[0].prompt, assetAttempt.prompt);
  assert.equal(f.saves[0].visualAssetWorkspace.candidates[0].quotedPrice, 0.30);
});
await check('completed original asset is read and saved without resume POST', async () => {
  const f = assetHarness({ receipts: [{ ...completedReceipt, assetId: 'owned-asset' }] }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.saves.length, 1); assert.equal(f.attempts().length, 0);
  assert.equal(f.saves[0].visualAssetWorkspace.candidates[0].assetId, 'owned-asset');
});
await check('consumer never substitutes an edited draft for authoritative recovery prompt', async () => {
  const f = assetHarness({ attempt: { prompt: 'changed local display draft' } }); await f.run();
  assert.equal(f.posts[0].prompt, serverResumeInput.prompt);
});
for (const [name, receipt] of [
  ['unknown', { ...recoverableReceipt, state: 'unknown' }],
  ['processing', { ...recoverableReceipt, state: 'processing' }],
  ['active lease', { ...recoverableReceipt, canRecover: false, retryAfterMs: 999 }],
  ['missing snapshot', { ...recoverableReceipt, resumeInput: undefined }],
  ['conflicting recovery lease', { ...recoverableReceipt, retryAfterMs: 999 }],
  ['resubmit conflict', { ...recoverableReceipt, canResubmit: true }],
  ['delivery state conflict', { ...recoverableReceipt, deliveryReady: true }],
]) await check('asset ' + name + ' remains pending without POST', async () => {
  const f = assetHarness({ receipts: [receipt] }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.attempts().length, 1);
});
for (const [name, patch] of [
  ['model', { modelId: 'pm_other' }], ['ratio', { aspectRatio: '16:9' }], ['resolution', { resolution: '2K' }],
  ['surface', { historySurface: 'image-workbench' }], ['mode', { mode: 'workflow' }],
  ['reference usage', { referenceUsage: 'general' }], ['fresh flag', { resumeDeliveryOnly: false }],
  ['missing style', { style: undefined }], ['missing cover text', { coverText: undefined }],
  ['new key', { clientIdempotencyKey: 'spoofed-new-key' }], ['extra image', { imageUrl: 'https://fixture.invalid/new.png' }],
  ['extra reference', { referenceImageUrls: ['https://fixture.invalid/new.png'] }],
  ['admin bypass', { adminValidation: {} }], ['empty prompt', { prompt: '  ' }],
]) await check('asset recovery rejects ' + name + ' snapshot conflict', async () => {
  const receipt = { ...recoverableReceipt, resumeInput: { ...serverResumeInput, ...patch } };
  const f = assetHarness({ receipts: [receipt] }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.attempts().length, 1);
});
await check('invalid original key and trace cannot become new normalized keys', async () => {
  assert.equal(helper.imageDeliveryRecoveryRequest(recoverableReceipt, { ...helperOriginal, clientIdempotencyKey: 'x' }), null);
  assert.equal(helper.imageDeliveryRecoveryRequest(recoverableReceipt, { ...helperOriginal, clientTraceId: '  original_key  ' }), null);
});
await check('explicit original delivery requirement and snapshot fields survive normalization', async () => {
  const input = { ...serverResumeInput, deliveryRequirement: 'recoverable_reference', style: 'original style', coverText: '原画面文字' };
  const body = helper.imageDeliveryRecoveryRequest({ ...recoverableReceipt, resumeInput: input }, helperOriginal);
  for (const [key, value] of Object.entries(input)) assert.deepEqual(plain(body[key]), value);
});
for (const [name, options] of [
  ['transport uncertainty', { throwPost: true }], ['failed persistence', { postOk: false }],
  ['unconfirmed post status', { receipts: [recoverableReceipt, { state: 'unknown', canRecover: false }] }],
  ['save not confirmed', { saveOk: false }],
]) await check('asset ' + name + ' retains original pending with no automatic retry', async () => {
  const f = assetHarness(options); await f.run(); assert.equal(f.posts.length, 1); assert.equal(f.attempts().length, 1);
});
await check('duplicate query clicks share the existing in-flight guard', async () => {
  let release; const statusBarrier = new Promise(resolve => { release = resolve; });
  const f = assetHarness({ statusBarrier }); const first = f.run(); await f.run(); release(); await first;
  assert.equal(f.posts.length, 1); assert.equal(f.saves.length, 1);
});
await check('owner change after status prevents recovery dispatch', async () => {
  const f = assetHarness({ afterStatus: ctx => { ctx.imageDownloadOwnerRef.current = 'different-owner\0token'; } }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.attempts().length, 1);
  assert.equal(f.generating.at(-1), false);
});
await check('owner change after POST prevents stale result attachment and pending removal', async () => {
  const f = assetHarness({ afterPost: ctx => { ctx.imageDownloadOwnerRef.current = 'different-owner\0token'; } }); await f.run();
  assert.equal(f.posts.length, 1); assert.equal(f.queries.length, 1); assert.equal(f.saves.length, 0); assert.equal(f.attempts().length, 1);
});
await check('old owner finally cannot clear a later generation operation lock', async () => {
  const f = assetHarness({ afterStatus: ctx => {
    ctx.imageDownloadOwnerRef.current = 'different-owner\0token';
    ctx.visualAssetGenerationRef.current = true;
  } }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.sandbox.visualAssetGenerationRef.current, true);
  assert.equal(f.generating.at(-1), true); assert.equal(f.attempts().length, 1);
});
await check('owner change during media read cannot save into the new owner', async () => {
  const f = assetHarness({ afterOwned: ctx => { ctx.imageDownloadOwnerRef.current = 'different-owner\0token'; } }); await f.run();
  assert.equal(f.saves.length, 0); assert.equal(f.attempts().length, 1);
});
await check('owner change during save keeps pending until that owner can recheck', async () => {
  const f = assetHarness({ afterSave: ctx => { ctx.imageDownloadOwnerRef.current = 'different-owner\0token'; } }); await f.run();
  assert.equal(f.saves.length, 1); assert.equal(f.attempts().length, 1); assert.equal(f.notices.length, 0);
});
await check('unmount after status prevents all new recovery I/O', async () => {
  const f = assetHarness({ afterStatus: ctx => { ctx.scopeMountedRef.current = false; } }); await f.run();
  assert.equal(f.posts.length, 0); assert.equal(f.attempts().length, 1);
});
await check('cross-project recovery saves original project and leaves current thirteen cards unchanged', async () => {
  const f = assetHarness({ currentId: 'different-open-project' }); const before = f.current(); await f.run();
  assert.deepEqual(f.restores, [{ kind: 'project', projectId: assetAttempt.projectId }]);
  assert.equal(f.saves[0].id, assetAttempt.projectId); assert.deepEqual(f.saves[0].cards, nativeCards);
  assert.deepEqual(f.current(), before); assert.equal(f.attempts().length, 0);
});
await check('restored project identity mismatch preserves pending without cross-project attachment', async () => {
  const f = assetHarness({ currentId: 'different-open-project', restoreMismatch: true }); await f.run();
  assert.equal(f.saves.length, 0); assert.equal(f.attempts().length, 1);
});
await check('owner change during original project restore prevents stale save', async () => {
  const f = assetHarness({ currentId: 'different-open-project', afterRestore: ctx => { ctx.imageDownloadOwnerRef.current = 'different-owner\0token'; } }); await f.run();
  assert.equal(f.saves.length, 0); assert.equal(f.attempts().length, 1);
});

console.log(JSON.stringify({ pass: true, scenarios: cases.length, cases, upstreamRequests: 0, databaseWrites: 0 }, null, 2));
