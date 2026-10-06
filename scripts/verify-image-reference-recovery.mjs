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
vm.runInNewContext(compile(fs.readFileSync(path.join(root, 'src/lib/image-workbench-recovery.ts'), 'utf8')), { module: compiledModule, exports: compiledModule.exports });
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
    actionableJobCount: jobs.length, unknownJobCount: 0, hasRecoverableJobs: jobs.some((job) => job.status === 'recoverable'),
    mode: options.mode || 'image-to-image', references: [], modelSupportsMode: !options.noModel,
    activeReferenceLimit: 9, referenceLimitExceeded: false,
    activeModel: options.noModel ? undefined : { id: 'pm_current', name: 'Current Model' },
    models: [{ id: 'pm_original', name: 'Original Model' }], aspectRatio: '16:9', selectedResolution: '4K',
    setBusy() {}, setNotice() {}, setJobs: (fn) => { jobs = fn(jobs); }, setCashBalance() {},
    setHistory: (fn) => { histories = fn(histories); }, cleanHistory: (entries) => entries,
    uploadReference: async () => { uploads++; throw new Error('unexpected upload'); },
    inspectImageAttempt: async () => { probes++; return { canRecover: options.canRecover !== false }; },
    parseImageWorkbenchRecoveryPayload: helper.parseImageWorkbenchRecoveryPayload,
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
await check('restored reference recovery enables button and uses original complete request', async () => {
  const f = harness(current); assert.equal(f.enabled(), true); await f.run();
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
console.log(JSON.stringify({ pass: true, scenarios: cases.length, cases, upstreamRequests: 0, databaseWrites: 0 }, null, 2));
