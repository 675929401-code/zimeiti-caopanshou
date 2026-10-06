import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import {
  ImageUpstreamResponseTooLargeError,
  parseImageUpstreamResponse,
  readImageUpstreamResponseText,
} from '../src/lib/image-upstream-response.ts';
import { imageReferenceContractIssue, resolveImageProviderContract } from '../src/lib/image-provider-contract.ts';

const require = createRequire(import.meta.url);
const read = file => fs.readFileSync(file, 'utf8');
const routeFile = 'src/app/api/image/generate/route.ts';
const currentSource = read(routeFile);
const previousSource = read('任务快照/image-reference-rejection-20260903-014400/src/app/api/image/generate/route.ts');
const checkpointHarness = read('scripts/verify-image-provider-checkpoint.mjs').split('let scenarios = 0;')[0];
function evaluate(source, globals = {}) {
  const compiledModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
    { module: compiledModule, exports: compiledModule.exports, require, Buffer, Blob, FormData, URL, Request, Response, Headers, Number, String, Date, structuredClone, AbortSignal, console, ...globals });
  return compiledModule.exports;
}
const { fixture } = evaluate(`${checkpointHarness}\nmodule.exports = { fixture };`);
const validator = evaluate(read('src/lib/file-upload-security.ts'));
const image = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#223344' } }).png().toBuffer();
const completeSignedUrl = 'https://owned-fixture.invalid/original.png?q-sign-algorithm=sha1&q-signature=' + 'a'.repeat(40);
const providerResultUrl = 'https://provider-media.invalid/private-image.png?signature=fixture-private-signature';
const report = { actualAdapter: true, actualUploadValidator: true, actualDatabaseStore: true, actualStatusHandler: true, realNetworkCalls: 0, realDatabaseWrites: 0, cases: [] };
const declarations = ['SIZE_MAP', 'DALLE3_SIZE_MAP', 'SEEDREAM_SIZE_MAP', 'RESOLUTION_SIZE_MAPS', 'isSecureSkillEndpoint', 'safeUpstreamTarget', 'loadReferenceImage', 'summarizeUpstreamImageError', 'hasImageUpstreamAcceptanceSignal', 'explicitImageProviderRejection', 'ImageCandidateFailure', 'generateLocalImageCandidate', 'extractImageUrlFromChatResponse'];
function setup(text = currentSource) {
  const f = fixture(), calls = { gets: [], posts: [], referenceFailure: false, badReference: false, httpStatus: 200, body: { choices: [{ message: { images: [{ image_url: { url: providerResultUrl } }] } }] }, rawBody: null, contentType: 'application/json', transportFailure: false, logs: [] };
  const ast = ts.createSourceFile(routeFile, text, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) ? declarations.includes(node.name?.text) : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => declarations.includes(item.name.getText(ast))));
  const globals = {
    ...f.lib, validateUploadBuffer: validator.validateUploadBuffer,
    console: { error: (...args) => calls.logs.push(args), log() {}, warn() {} },
    assertAutodlH3SelfhostModelBinding: () => false, resolveProviderSecret: () => 'fixture-private-key',
    buildOpenAIEndpoint: (base, endpoint) => `${base}/v1/${endpoint}`, isRetryableImageUpstreamStatus: status => status >= 500,
    ImageUpstreamResponseTooLargeError, parseImageUpstreamResponse, readImageUpstreamResponseText,
    imageReferenceContractIssue, resolveImageProviderContract,
    safeFetch: async url => { calls.gets.push(url); if (calls.referenceFailure) throw new Error('fixture 403'); return { buffer: calls.badReference ? Buffer.from('<svg onload="alert(1)"></svg>') : image, contentType: 'image/png' }; },
    fetchImageUpstream: async (url, init) => { calls.posts.push({ url, body: JSON.parse(init.body), headers: init.headers }); if (calls.transportFailure) throw new Error('fixture disconnected'); return new Response(calls.rawBody ?? JSON.stringify(calls.body), { status: calls.httpStatus, headers: { 'Content-Type': calls.contentType } }); },
  };
  const functions = evaluate(nodes.map(node => node.getText(ast)).join('\n') + '\nmodule.exports = { generateLocalImageCandidate, summarizeUpstreamImageError' + (text.includes('function explicitImageProviderRejection') ? ', explicitImageProviderRejection' : '') + ' };', globals);
  const options = { model: { id: 'fixture-nano', name: 'Fixture Nano', provider: 'secure_skill_chat', model_name: 'gemini-3.1-flash-image', api_endpoint: 'https://token.secure-skill.com', api_key: 'fixture-private-key', supports_image_input: true }, ratio: '1:1', effectiveResolution: '1K', references: [completeSignedUrl], identityReferenceOnly: false, fullPrompt: 'A blue cup', idempotencyKey: 'image-fixture-original-operation', strictSingleSubmit: true };
  const candidate = () => functions.generateLocalImageCandidate(options);
  const run = () => f.lib.runImageExactlyOnce({ ...f.options(), submitOnce: candidate });
  const post = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
  const catchBody = post.body.statements.find(ts.isTryStatement).catchClause.block.getText(ast);
  const catchResponse = evaluate(`module.exports = async function(error) { const traceId='fixture_image_trace', traceNodeId='', traceNodeTitle='', tracePromptHash='', traceStartedAt=Date.now(); let validationControl = null, billingReservation = null, deductResult = null; const imageBudgetState = { deduction: null, reservation: null }; ${catchBody} };`, {
    ...globals,
    ImageCandidateFailure: class extends Error {},
    ImageGenerationInputError: class extends Error {},
    ImageAdminValidationError: class extends Error {},
    ImageRequestRejectedError: f.lib.ImageRequestRejectedError,
    ImageExactlyOnceError: f.lib.ImageExactlyOnceError,
    NextResponse: { json: (data, init) => Response.json(data, init) },
    writeImageTrace: async () => {},
    resumeDeliveryOnly: false,
  });
  return { f, calls, options, functions, candidate, run, catchResponse };
}
const rejects = (fn, code) => assert.rejects(fn, error => error.code === code);
async function test(name, fn) { await fn(); report.cases.push({ name, passed: true }); console.log('PASS ' + name); }
await test('old actual adapter sent the complete signed URL to provider without application read', async () => {
  const s = setup(previousSource); await s.candidate(); assert.equal(s.calls.gets.length, 0); assert.equal(s.calls.posts[0].body.messages[0].content[1].image_url.url, completeSignedUrl);
});
await test('new actual adapter reads full signature then sends identical PNG bytes inline with one POST', async () => {
  const s = setup(); await s.candidate(); assert.equal(s.calls.gets[0], completeSignedUrl); assert.equal(s.calls.posts.length, 1);
  const body = s.calls.posts[0].body, encoded = body.messages[0].content[1].image_url.url;
  assert.equal(encoded.startsWith('data:image/png;base64,'), true); assert.deepEqual(Buffer.from(encoded.split(',')[1], 'base64'), image);
  assert.equal(JSON.stringify(body).includes('q-signature'), false); assert.equal(body.model, 'gemini-3.1-flash-image'); assert.equal(s.calls.posts[0].headers['Idempotency-Key'], 'image-fixture-original-operation');
});
await test('multiple references retain character-identity order and existing inline inputs avoid GET', async () => {
  const s = setup(); s.options.identityReferenceOnly = true; s.options.references = [completeSignedUrl, `data:image/png;base64,${image.toString('base64')}`]; await s.candidate();
  const content = s.calls.posts[0].body.messages[0].content; assert.deepEqual(content.map(item => item.type), ['image_url', 'image_url', 'text']); assert.equal(s.calls.gets.length, 1);
});
await test('no-reference text generation retains string content and never downloads', async () => { const s = setup(); s.options.references = []; await s.candidate(); assert.equal(s.calls.gets.length, 0); assert.equal(s.calls.posts[0].body.messages[0].content, s.options.fullPrompt); });
await test('unreadable or invalid reference is durably input-rejected before provider POST', async () => {
  for (const fault of ['referenceFailure', 'badReference']) { const s = setup(); s.calls[fault] = true; await rejects(s.run, 'IMAGE_REFERENCE_READ_FAILED'); assert.equal(s.calls.posts.length, 0); const status = await s.f.status(); assert.equal(status.state, 'rejected'); assert.equal(status.canResubmit, true); assert.equal(status.sameKeyCanResubmit, false); }
});
await test('explicit reference HTTP400 preserves bound rejection receipt and original key never POSTs again', async () => {
  const s = setup(); s.calls.httpStatus = 400; s.calls.body = { error: { message: `Failed to load image from ${completeSignedUrl}` } };
  await rejects(s.run, 'IMAGE_REFERENCE_REJECTED'); assert.equal(s.f.first().state, 'failed_unknown'); assert.equal(s.f.first().response.schema, 'image_request_rejection.v1');
  assert.equal((await s.f.status()).state, 'rejected'); await rejects(s.run, 'IMAGE_REFERENCE_REJECTED'); await rejects(() => s.f.preflight(), 'IMAGE_REFERENCE_REJECTED'); assert.equal(s.calls.posts.length, 1);
  assert.equal(JSON.stringify(s.calls.logs).includes('q-signature'), false); assert.equal(JSON.stringify(s.f.first().response).includes('http'), false);
});
await test('400 with a task ID acceptance flag or actual output stays unknown', async () => {
  for (const extra of [{ task_id: 'accepted-task' }, { data: { jobId: 'accepted-job' } }, { accepted: true }, { accepted: 'true' }, { status: 'processing' }, { data: { url: 'https://provider.invalid/result.png' } }]) {
    const s = setup(); s.calls.httpStatus = 400; s.calls.body = { error: { message: 'Failed to load image from fixture' }, ...extra };
    await rejects(s.run, 'IMAGE_UPSTREAM_ERROR'); assert.equal(s.f.first().response, null); assert.equal((await s.f.status()).state, 'unknown'); assert.equal(s.calls.posts.length, 1);
  }
});
await test('explicit no-account 503 is terminal while an opaque 503 remains fail-closed', async () => {
  const rejected = setup(); rejected.calls.httpStatus = 503; rejected.calls.body = { error: { message: 'No available compatible accounts' } };
  await assert.rejects(rejected.run, error => ['IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE', 'IMAGE_UPSTREAM_REQUEST_REJECTED'].includes(error.code)); assert.equal((await rejected.f.status()).state, 'rejected');
  await assert.rejects(rejected.run, error => ['IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE', 'IMAGE_UPSTREAM_REQUEST_REJECTED'].includes(error.code)); assert.equal(rejected.calls.posts.length, 1);
  const unknown = setup(); unknown.calls.httpStatus = 503; unknown.calls.body = { error: { message: 'Temporary upstream failure' } };
  await rejects(unknown.run, 'IMAGE_UPSTREAM_ERROR'); assert.equal((await unknown.f.status()).state, 'unknown'); assert.equal((await unknown.f.status()).canResubmit, false); assert.equal(unknown.calls.posts.length, 1);
});
await test('structured SSE error is terminal only when it has no accepted task signal', async () => {
  const rejected = setup(); rejected.calls.contentType = 'text/event-stream'; rejected.calls.rawBody = 'event: error\ndata: {"error":{"code":"no_channel","message":"No route available"}}\n\n';
  await rejects(rejected.run, 'IMAGE_UPSTREAM_TERMINAL_EVENT'); assert.equal((await rejected.f.status()).state, 'rejected');
  await rejects(rejected.run, 'IMAGE_UPSTREAM_TERMINAL_EVENT'); assert.equal(rejected.calls.posts.length, 1);
  const unknown = setup(); unknown.calls.contentType = 'text/event-stream'; unknown.calls.rawBody = 'event: error\ndata: {"error":{"message":"late failure"},"task_id":"accepted-task"}\n\n';
  await rejects(unknown.run, 'IMAGE_UPSTREAM_EVENT_ERROR'); assert.equal((await unknown.f.status()).state, 'unknown'); assert.equal(unknown.calls.posts.length, 1);
});
await test('ordinary 4xx rejects once while timeout throttle proxy and 5xx outcomes stay unknown', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) { const s = setup(); s.calls.httpStatus = status; s.calls.body = { error: { message: 'Opaque upstream rejection' } }; await rejects(s.run, 'IMAGE_UPSTREAM_REQUEST_REJECTED'); const state = await s.f.status(); assert.equal(state.state, 'rejected'); assert.equal(state.canResubmit, true); await rejects(s.run, 'IMAGE_UPSTREAM_REQUEST_REJECTED'); assert.equal(s.calls.posts.length, 1); }
  for (const status of [408, 425, 429, 499, 500, 502, 503, 504]) { const s = setup(); s.calls.httpStatus = status; s.calls.body = { error: { message: 'Opaque upstream failure' } }; await rejects(s.run, 'IMAGE_UPSTREAM_ERROR'); const state = await s.f.status(); assert.equal(state.state, 'unknown'); assert.equal(state.canResubmit, false); await rejects(s.run, 'IMAGE_IDEMPOTENCY_FAIL_CLOSED'); assert.equal(s.calls.posts.length, 1); }
  const s = setup(); s.calls.transportFailure = true; await rejects(s.run, 'IMAGE_UPSTREAM_RESULT_UNKNOWN'); assert.equal(s.f.first().response, null);
});
await test('rejection CAS cannot overwrite an existing provider checkpoint', async () => {
  const s = setup(), options = s.f.options(), { record } = await s.f.store.claim(options);
  const result = { schema: 'image_provider_result.v1', rawUrl: providerResultUrl, mode: 'local', selectedModelId: 'fixture-image-model', selectedCostPrice: .1, provider: 'fixture-provider', apiEndpoint: 'https://provider.invalid/v1/images/generations', source: 'image-generation' };
  await s.f.store.claimProviderPersistence(record, result, 'fixture-lease'); assert.equal(await s.f.store.recordRejection(record, { source: 'provider', code: 'IMAGE_REFERENCE_REJECTED', upstreamStatus: 400 }), null); assert.equal(s.f.first().response.schema, 'image_provider_checkpoint.v1');
});
await test('receipt acknowledgement loss returns unknown but later GET confirms rejection without resubmission', async () => {
  const s = setup(); s.calls.httpStatus = 400; s.calls.body = { error: { message: 'Failed to load image from fixture' } };
  const save = s.f.store.recordRejection.bind(s.f.store); s.f.store.recordRejection = async (...args) => { await save(...args); throw new Error('fixture acknowledgement lost'); };
  let failure; try { await s.run(); } catch (error) { failure = error; }
  assert.equal(failure.code, 'IMAGE_REJECTION_RECEIPT_UNCONFIRMED'); const response = await s.catchResponse(failure), body = await response.json(); assert.equal(response.status, 503); assert.equal(body.state, 'unknown'); assert.equal(body.canResubmit, false);
  assert.equal((await s.f.status()).state, 'rejected'); await rejects(s.run, 'IMAGE_REFERENCE_REJECTED'); assert.equal(s.calls.posts.length, 1);
});
await test('failed receipt write remains unresolved and never advertises safe resubmission', async () => {
  const s = setup(); s.calls.httpStatus = 400; s.calls.body = { error: { message: 'Failed to load image from fixture' } }; s.f.store.recordRejection = async () => { throw new Error('fixture unavailable'); };
  await rejects(s.run, 'IMAGE_REJECTION_RECEIPT_UNCONFIRMED'); assert.equal((await s.f.status()).canResubmit, false); await rejects(s.run, 'IMAGE_IDEMPOTENCY_FAIL_CLOSED'); assert.equal(s.calls.posts.length, 1);
});
await test('legacy NULL failed_unknown is not retrospectively classified or resubmitted', async () => {
  const s = setup(), { record } = await s.f.store.claim(s.f.options()); record.state = 'failed_unknown'; await s.f.store.save(record);
  assert.equal((await s.f.status()).state, 'unknown'); await rejects(s.run, 'IMAGE_IDEMPOTENCY_FAIL_CLOSED'); assert.equal(s.calls.posts.length, 0);
});
await test('receipt fingerprint tampering does not establish a terminal rejection', async () => {
  const s = setup(); s.calls.httpStatus = 400; s.calls.body = { error: { message: 'Failed to load image from fixture' } }; await rejects(s.run, 'IMAGE_REFERENCE_REJECTED'); s.f.first().response.payloadFingerprint = 'other'; assert.equal((await s.f.status()).state, 'unknown'); await rejects(s.run, 'IMAGE_IDEMPOTENCY_FAIL_CLOSED'); assert.equal(s.calls.posts.length, 1);
});
await test('actual generation error response exposes explicit rejected semantics only after receipt', async () => {
  const s = setup(); s.calls.httpStatus = 400; s.calls.body = { error: { message: 'Failed to load image from fixture' } }; let failure; try { await s.run(); } catch (error) { failure = error; }
  const response = await s.catchResponse(failure), body = await response.json(); assert.equal(response.status, 502); assert.equal(body.state, 'rejected'); assert.equal(body.canResubmit, true); assert.equal(body.sameKeyCanResubmit, false); assert.equal(body.upstreamStatus, 400);
});
report.passed = report.cases.length; report.sourceHashes = {};
for (const file of [routeFile, 'src/lib/image-exactly-once.ts', 'src/app/api/image/status/route.ts']) report.sourceHashes[file] = createHash('sha256').update(read(file)).digest('hex');
const output = '.codex-evidence/image-reference-rejection-20260903'; fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'fixtures.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, actualAdapter: true, actualDatabaseStore: true, realNetworkCalls: 0, realDatabaseWrites: 0 }));

