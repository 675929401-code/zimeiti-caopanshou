import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const source = fs.readFileSync('src/lib/video-adapter.ts', 'utf8');
const tree = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'generateNewApiVideo');
const unknownFn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'videoSubmissionUnknown');
assert.ok(fn);
assert.ok(unknownFn);
const code = ts.transpileModule('export ' + unknownFn.getText(tree) + '\nexport ' + fn.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const config = { api_endpoint: 'https://provider.example', api_key: 'fixture-key', model_name: 'veo-fixture', duration_seconds: 8 };
const params = { prompt: 'fixture', imageUrl: 'https://image.example/input.png' };
let calls = 0;
let response;
const module = { exports: {} };
new Function('module', 'exports', 'fetch', 'safeStr', code)(module, module.exports, async (_url, init) => {
  calls++; const body = JSON.parse(init.body); assert.equal(body.model, config.model_name); assert.deepEqual(body.images, [params.imageUrl]); assert.equal(body.ratio, '16:9'); assert.equal(body.retry_times, undefined);
  return response();
}, value => typeof value === 'string' ? value : '');
const invoke = async factory => { calls = 0; response = factory; const result = await module.exports.generateNewApiVideo(config, params); assert.equal(calls, 1); return result; };
const overloaded = await invoke(() => new Response('unavailable', { status: 503 }));
assert.equal(overloaded.status, 'processing'); assert.equal(overloaded.submissionOutcome, 'unknown');
for (const factory of [() => { throw new TypeError('connection reset'); }, () => new Response('invalid json'), () => new Response('{}')]) {
  const result = await invoke(factory); assert.equal(result.submissionOutcome, 'unknown'); assert.equal(result.status, 'processing'); assert.equal(result.taskId, '');
}
assert.equal((await invoke(() => new Response('{"message":"invalid key"}', { status: 401 }))).status, 'failed');
assert.equal((await invoke(() => new Response('{"id":"provider-original"}'))).taskId, 'provider-original');
const route = fs.readFileSync('src/app/api/video/generate/route.ts', 'utf8');
const routeTree = ts.createSourceFile('route.ts', route, ts.ScriptTarget.Latest, true);
let block;
function walk(node) { if (ts.isIfStatement(node) && node.expression.getText(routeTree) === 'result.submissionOutcome === "unknown"') block = node.getText(routeTree); ts.forEachChild(node, walk); }
walk(routeTree); assert.ok(block);
const updates = [], traces = [], persistedReceipts = [];
const db = { from(table) { assert.equal(table, 'video_tasks'); const chain = { update(value) { updates.push(value); return chain; }, eq() { return chain; }, is() { return chain; }, select() { return chain; }, async maybeSingle() { return { data: { id: "vt_fixture" }, error: null }; } }; return chain; } };
const guard = new Function('db', 'NextResponse', 'writeVideoTrace', 'persistVideoProviderSubmissionReceipt', `return async function(result) { const taskIdInternal='vt_fixture', userId='owner', requestFingerprint='same', traceId='trace', selectedModel={id:'model'}, normalizedClientRequestId='original-key', model_id='public-model'; ${block} }`)(db, { json: (body, init) => ({body, ...init}) }, async trace => traces.push(trace), async input => persistedReceipts.push(input));
const receipt = {
  schemaVersion: 1,
  receiptState: 'response_received',
  endpointHost: 'provider.example',
  providerRequestKeySha256: 'a'.repeat(64),
  httpStatus: 202,
  responseBodySha256: 'b'.repeat(64),
  candidateFieldPaths: [],
};
const guarded = await guard({ submissionOutcome: 'unknown', submissionReceipt: receipt });
assert.equal(guarded.status, 202); assert.equal(guarded.body.task_submitted, null); assert.equal(guarded.body.task_id, 'vt_fixture');
assert.deepEqual(updates, []);
assert.equal(persistedReceipts.length, 1); assert.equal(persistedReceipts[0].outcome, 'unknown');
assert.deepEqual(persistedReceipts[0].receipt, receipt);
assert.equal(traces[0].phase, 'submission_unknown');
assert.deepEqual(traces[0].submissionReceipt, receipt);
console.log('PASS one POST per attempt, transport/malformed/missing-id remain unknown, explicit rejection and acknowledgement, caller keeps original pending task with redacted receipt evidence');
