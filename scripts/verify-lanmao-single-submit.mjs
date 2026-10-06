import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const sourcePath = 'src/lib/video-lanmao-proxy.ts';
const source = fs.readFileSync(sourcePath, 'utf8');
const snapshot = process.argv[2];
assert.ok(snapshot, 'Pass the pre-edit Lanmao source snapshot');
const before = fs.readFileSync(snapshot, 'utf8');
const report = { at: new Date().toISOString(), sourceSha256: createHash('sha256').update(source).digest('hex'), snapshotSha256: createHash('sha256').update(before).digest('hex'), realNetworkRequests: 0, databaseWrites: 0, cases: [] };
const state = {};
const config = { id: 'grok-imagine-1.0-super-10s-ch4', name: 'Fixture model', provider: 'fixture', protocol_type: 'lanmao_video', api_endpoint: 'http://fixture.example.invalid:3000/v1', api_key: 'fixture-only', model_name: 'grok-imagine-1.0-video-super', supports_image_input: true, price_per_use: 0.73, duration_seconds: 10 };
const params = { prompt: 'A paper boat moves.', duration: 10, aspectRatio: '16:9' };
const json = (body, status = 200) => () => Response.json(body, { status });
function reset() {
  Object.assign(state, { requests: [], receipts: [], listedModels: [config.model_name], preflightStatus: 200, preflightError: false,
    responseFactory: json({ id: 'provider-original', status: 'queued' }),
  });
}
const cache = new Map();
function compile(contents, file) {
  const loadedModule = { exports: {} };
  const output = ts.transpileModule(contents, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file }).outputText;
  vm.runInNewContext(output, {
    module: loadedModule, exports: loadedModule.exports,
    require: name => {
      if (name.startsWith('node:')) return nativeRequire(name);
      if (['./video-provider-request-audit', './api-endpoints', './video-prompt-timing', './video-lanmao-proxy'].includes(name)) return load(path.join(path.dirname(file), name + '.ts'));
      return new Proxy({}, { get: (_target, key) => key === 'AUTODL_COMFYUI_WORKFLOW_PROTOCOL' ? 'unused-workflow-fixture' : () => { throw new Error('UNEXPECTED_PROTOCOL'); } });
    },
    Request, Response, Headers, FormData, URL, Buffer, AbortSignal, DOMException, Error, crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: callback => { callback(); return 1; },
    fetch: async (input, init) => {
      const url = new URL(input); const method = init.method || 'GET';
      state.requests.push({ method, path: url.pathname, body: init.body ? JSON.parse(init.body) : null });
      if (method === 'GET' && url.pathname === '/v1/models') {
        if (state.preflightError) throw new TypeError('fixture preflight reset');
        return Response.json({ data: state.listedModels.map(id => ({ id })) }, { status: state.preflightStatus });
      }
      return state.responseFactory();
    },
  }, { filename: file });
  return loadedModule.exports;
}
function load(file) { file = path.resolve(file); if (!cache.has(file)) cache.set(file, compile(fs.readFileSync(file, 'utf8'), file)); return cache.get(file); }
const adapter = load('src/lib/video-adapter.ts');
const audit = load('src/lib/video-provider-request-audit.ts');
const oldLanmao = compile(before, path.resolve(sourcePath));
const postCount = () => state.requests.filter(request => request.method === 'POST').length;
async function submit(patch = {}, input = params) {
  return adapter.submitVideoTask({ ...config, ...patch }, { ...input, onProviderRequest: async receipt => state.receipts.push(receipt) });
}
async function test(name, run) {
  reset();
  try { await run(); report.cases.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.cases.push({ name, passed: false, errorType: error.name, message: String(error.message).slice(0, 300) }); console.log('FAIL ' + name); }
}
await test('actual previous adapter reproduces two provider dispatches after a structured 503 rejection', async () => {
  state.responseFactory = json({ error: { message: 'no available channel for configured model' } }, 503);
  const result = await audit.withVideoProviderRequestAudit(async receipt => state.receipts.push(receipt), () => oldLanmao.generateLanmaoVideo(config, params));
  assert.equal(result.status, 'failed'); assert.equal(postCount(), 2); assert.equal(state.receipts.length, 2);
});
for (const modelName of ['grok-imagine-1.0-video-super', 'grok-imagine-1.0-video-super-720p', 'grok-imagine-1.0-video-super-20s', 'grok-imagine-1.0-video-super-720p-10s']) {
  await test('configured model remains exact with one dispatch: ' + modelName, async () => {
    state.listedModels = [modelName]; state.responseFactory = json({ error: { message: 'no available channel for model' } }, 503);
    const result = await submit({ model_name: modelName }, { ...params, imageUrl: 'https://image.example/reference.png' });
    assert.equal(result.status, 'failed'); assert.equal(result.submissionOutcome, undefined); assert.equal(postCount(), 1); assert.equal(state.receipts.length, 1);
    assert.equal(state.receipts[0].submittedModel, modelName);
    const post = state.requests.find(request => request.method === 'POST'); assert.equal(post.path, '/v1/videos'); assert.equal(post.body.model, modelName);
    assert.deepEqual(post.body.images, ['https://image.example/reference.png']); assert.equal(post.body.duration, 10);
    assert.equal(post.body.size, modelName.includes('720p') ? '1280x720' : '1792x1024');
  });
}
for (const [name, factory] of [
  ['transport reset', () => { throw new TypeError('fixture connection reset'); }],
  ['timeout', () => { throw new DOMException('fixture timeout', 'TimeoutError'); }],
  ['body interrupted', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture body error')); } }))],
  ['unknown 503', json({ error: { message: 'render cluster temporarily offline' } }, 503)],
  ['unstructured 502', () => new Response('no available channel', { status: 502 })],
  ['generic error in 200', json({ error: { message: 'internal server error' } })],
  ['empty 200', json({})],
  ['HTML 200', () => new Response('<!doctype html>')],
  ['invalid task IDs', json({ task_id: {}, id: false })],
]) await test(name + ' stays unknown without another POST', async () => {
  state.responseFactory = factory; const result = await submit();
  assert.equal(result.status, 'processing'); assert.equal(result.submissionOutcome, 'unknown'); assert.equal(result.taskId, ''); assert.equal(postCount(), 1); assert.equal(state.receipts.length, 1);
});
for (const [name, factory] of [
  ['401', json({ error: 'unauthorized' }, 401)], ['429', json({ error: 'rate limited' }, 429)],
  ['model_not_found', json({ error: { code: 'model_not_found' } }, 503)],
  ['no accounts', json({ error: { message: 'no accounts available' } }, 503)],
  ['Chinese no channel', json({ error: { message: '当前分组下模型无可用渠道' } }, 503)],
  ['200 explicit refusal', json({ code: 'task_failed', message: 'request rejected' })],
]) await test('definite ' + name + ' is failed after exactly one POST', async () => {
  state.responseFactory = factory; const result = await submit(); assert.equal(result.status, 'failed'); assert.equal(result.submissionOutcome, undefined); assert.equal(postCount(), 1);
});
await test('real task ID is preserved even with 503 error envelope', async () => {
  state.responseFactory = json({ task_id: 'provider-original', status: 'queued', error: { message: 'no available channel' } }, 503);
  const result = await submit(); assert.equal(result.taskId, 'provider-original'); assert.equal(result.status, 'queued'); assert.equal(result.submissionOutcome, undefined); assert.equal(postCount(), 1);
});
await test('accepted failed task retains its ID and terminal error', async () => {
  state.responseFactory = json({ data: { id: 'provider-original' }, status: 'failed', error: { message: 'fixture render failure' } });
  const result = await submit(); assert.equal(result.taskId, 'provider-original'); assert.equal(result.status, 'failed'); assert.match(result.error, /fixture render failure/u);
});
await test('complete synchronous result leaves stable task identity to the caller', async () => {
  state.responseFactory = json({ status: 'completed', video_url: 'https://video.example/result.mp4' });
  const result = await submit(); assert.equal(result.status, 'success'); assert.equal(result.taskId, ''); assert.equal(result.videoUrl, 'https://video.example/result.mp4'); assert.equal(postCount(), 1);
});
await test('no configured model cannot silently choose a default', async () => {
  const result = await submit({ model_name: '' }); assert.equal(result.status, 'failed'); assert.equal(state.requests.length, 0); assert.equal(state.receipts.length, 0);
});
await test('authenticated directory omission fails without POST or model substitution', async () => {
  state.listedModels = ['some-other-model']; const result = await submit(); assert.equal(result.status, 'failed'); assert.match(result.error, /model_not_found/u); assert.equal(postCount(), 0); assert.equal(state.receipts.length, 0);
});
await test('unavailable directory still allows one selected-model POST only', async () => {
  state.preflightError = true; state.responseFactory = json({}, 503); const result = await submit(); assert.equal(result.submissionOutcome, 'unknown'); assert.equal(postCount(), 1); assert.equal(state.receipts[0].submittedModel, config.model_name);
});
await test('poll function remains identical and real terminal failures are not converted to success', async () => {
  const poll = text => { const ast = ts.createSourceFile('lanmao.ts', text, ts.ScriptTarget.Latest, true); return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'pollLanmaoVideo').getText(ast); };
  assert.equal(poll(source), poll(before)); state.responseFactory = json({ status: 'failed', error: { message: 'fixture terminal failure' } });
  const result = await adapter.pollVideoTask(config, 'provider-original'); assert.equal(result.status, 'failed'); assert.equal(result.taskId, 'provider-original'); assert.equal(postCount(), 0);
});
await test('recorded hidden canaries matched model names; host-versus-hostname caused false routing mismatch', async () => {
  const base = '.codex-evidence/hidden-video-real-e2e-20260902/hidden-bindings-canary-v2-20260902';
  const plan = JSON.parse(fs.readFileSync(path.join(base, 'plan.json'), 'utf8'));
  const entries = Array.isArray(plan) ? plan : Object.values(plan).find(value => Array.isArray(value) && value.some(item => item.validation?.model));
  assert.ok(entries);
  for (const folder of ['grok-imagine-1_0-super-10s-ch4', 'grok-imagine-1_0-super-720p-10s-ch4']) {
    const result = JSON.parse(fs.readFileSync(path.join(base, folder, 'result.json'), 'utf8'));
    const expected = entries.find(item => item.validation?.model.id === result.modelId).validation.model;
    assert.equal(result.providerRequests.length, 2);
    for (const receipt of result.providerRequests) {
      assert.equal(receipt.submittedModel, expected.upstreamModel); assert.notEqual(receipt.endpointHost, expected.endpointHost);
      assert.equal(new URL('http://' + receipt.endpointHost).hostname, expected.endpointHost);
    }
  }
});
report.passed = report.cases.every(item => item.passed); report.passedCount = report.cases.filter(item => item.passed).length; report.failedCount = report.cases.length - report.passedCount;
if (process.argv[3]) { fs.mkdirSync(path.dirname(process.argv[3]), { recursive: true }); fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
console.log(JSON.stringify({ passed: report.passed, passedCount: report.passedCount, failedCount: report.failedCount, realNetworkRequests: 0, databaseWrites: 0 }));
if (!report.passed) process.exitCode = 1;
