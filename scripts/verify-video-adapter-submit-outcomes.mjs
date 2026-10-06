import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Execute the complete actual adapter, actual endpoint builder and actual dispatch
// audit wrapper. Replace network only; unrelated protocol modules cannot run.
const nativeRequire = createRequire(import.meta.url);
let calls = [], factory, auditReceipts = [];
const unrelated = new Proxy({}, { get: (_target, name) => name === 'AUTODL_COMFYUI_WORKFLOW_PROTOCOL' ? 'unrelated-fixture-protocol' : () => { throw new Error('UNEXPECTED_PROTOCOL'); } });
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} };
  cache.set(file, loadedModule.exports);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, {
    module: loadedModule, exports: loadedModule.exports,
    require: name => {
      if (name.startsWith('node:')) return nativeRequire(name);
      if (['./video-provider-request-audit', './api-endpoints', './video-prompt-timing'].includes(name)) return load(path.join(path.dirname(file), name + '.ts'));
      return unrelated;
    },
    Request, Response, Headers, URL, FormData, AbortSignal, DOMException, Buffer,
    crypto: nativeRequire('node:crypto').webcrypto,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      assert.ok(calls.length <= 1, 'one adapter invocation must never dispatch twice');
      return factory(url, init);
    },
  }, { filename: file });
  return loadedModule.exports;
}
const adapter = load('src/lib/video-adapter.ts');
const config = protocol_type => ({
  id: 'fixture-' + protocol_type, name: 'fixture', provider: 'fixture', protocol_type,
  api_endpoint: 'https://provider.example/v1', api_key: 'fixture-only', price_per_use: 0,
  supports_image_input: true, duration_seconds: 8,
  model_name: protocol_type === 'gaorui_video' ? 'omni_flash_10s' : 'grok-imagine-video-1.5',
});
const params = { prompt: 'A paper boat moves.', imageUrl: 'https://image.example/reference.png', duration: 8, idempotencyKey: 'original-business-key' };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
async function invoke(protocol, responseFactory, extra = {}) {
  calls = []; auditReceipts = []; factory = responseFactory;
  const result = await adapter.submitVideoTask({ ...config(protocol), ...extra }, {
    ...params, onProviderRequest: async receipt => { auditReceipts.push(receipt); },
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
  assert.equal(auditReceipts.length, 1); assert.equal(auditReceipts[0].submittedModel, extra.model_name || config(protocol).model_name);
  return result;
}
const json = (data, status = 200) => () => Response.json(data, { status });
const protocols = ['gaorui_video', 'secure_skill_flow_jobs', 'secure_skill_grok_video', 'yunwu_video'];
for (const protocol of protocols) {
  for (const [name, responseFactory] of [
    ['connection reset', () => { throw new TypeError('fetch failed'); }],
    ['timeout', () => { throw new DOMException('timed out', 'TimeoutError'); }],
    ['acknowledgement body interrupted', () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('body reset')); } }))],
    ['unexplained 503', json({ error: { message: 'internal service unavailable' } }, 503)],
    ['unstructured 502', () => new Response('no accounts available', { status: 502 })],
    ['HTML success has no fallback POST', () => new Response('<!doctype html><html>Gateway</html>')],
    ['malformed success', () => new Response('{')],
    ['empty success', json({})],
    ['busy success has no retry POST', json({ message: 'busy 排队繁忙', code: 200 })],
    ['generic structured error is inconclusive', json({ error: 'Internal error' })],
    ['objects are not task IDs', json({ id: {}, task_id: false, job_id: [], request_id: {} })],
    ['whitespace is not a task ID', json({ id: '  ', task_id: '\n' })],
  ]) {
    await test(protocol + ' ' + name, async () => {
      const result = await invoke(protocol, responseFactory);
      assert.equal(result.submissionOutcome, 'unknown'); assert.equal(result.status, 'processing'); assert.equal(result.taskId, '');
    });
  }
  for (const status of [400, 401, 403, 404, 408, 429]) {
    await test(protocol + ' explicit HTTP ' + status + ' refusal remains failed', async () => {
      const result = await invoke(protocol, () => new Response('refused', { status }));
      assert.equal(result.status, 'failed'); assert.equal(result.submissionOutcome, undefined);
    });
  }
  for (const [name, payload, status] of [
    ['missing model in 503', { error: { code: 'model_not_found', message: 'Unavailable' } }, 503],
    ['no accounts in 503', { error: { message: 'No accounts available' } }, 503],
    ['nested no accounts in 200', { data: { error: { code: 'no_available_accounts' } } }, 200],
    ['invalid parameter in 200', { error: { type: 'invalid_request_error' } }, 200],
    ['explicit task refusal in 200', { code: 'task_failed', message: 'Request rejected' }, 200],
  ]) {
    await test(protocol + ' ' + name, async () => {
      const result = await invoke(protocol, json(payload, status));
      assert.equal(result.status, 'failed'); assert.equal(result.submissionOutcome, undefined);
    });
  }
  for (const status of [200, 503]) {
    await test(protocol + ' acknowledged task survives envelope error HTTP ' + status, async () => {
      const result = await invoke(protocol, json({ id: 'provider-original', error: { message: 'no accounts available' }, status: 'queued' }, status));
      assert.equal(result.taskId, 'provider-original'); assert.equal(result.submissionOutcome, undefined); assert.notEqual(result.status, 'failed');
    });
  }
  await test(protocol + ' malformed primary ID does not hide valid task_id', async () => {
    const result = await invoke(protocol, json({ id: {}, task_id: 'provider-secondary' }));
    assert.equal(result.taskId, 'provider-secondary');
  });
}
await test('Gaorui Location acknowledgement excludes query/hash', async () => {
  const result = await invoke('gaorui_video', () => new Response('{}', { status: 202, headers: { Location: '/v1/videos/provider-location?access=private#fragment' } }));
  assert.equal(result.taskId, 'provider-location');
});
await test('Yunwu nested acknowledgement and original request body survive', async () => {
  const result = await invoke('yunwu_video', json({ code: 200, data: { task_id: 'yunwu-nested', status: 'processing' } }));
  assert.equal(result.taskId, 'yunwu-nested'); assert.equal(calls[0].body.prompt, params.prompt); assert.deepEqual(calls[0].body.images, [params.imageUrl]);
});
await test('Flow nested job acknowledgement is preserved', async () => {
  assert.equal((await invoke('secure_skill_flow_jobs', json({ data: { job_id: 'flow-original' } }))).taskId, 'flow-original');
});
await test('Secure Skill alias retains original supported idempotency header', async () => {
  assert.equal((await invoke('secure_skill_video', json({ data: { request_id: 'secure-original' } }))).taskId, 'secure-original');
  assert.equal(calls[0].headers['X-Idempotency-Key'], params.idempotencyKey); assert.equal(calls[0].path, '/openai/v1/videos');
});
await test('Secure Skill Grok accepts each allowlisted body receipt family', async () => {
  assert.equal((await invoke('secure_skill_grok_video', json({ video_id: 'secure-video-id' }))).taskId, 'secure-video-id');
  assert.equal((await invoke('secure_skill_grok_video', json({ data: { job_id: 'secure-job-id' } }))).taskId, 'secure-job-id');
  assert.equal((await invoke('secure_skill_grok_video', json({ data: { task: { request_id: 'secure-nested-task-id' } } }))).taskId, 'secure-nested-task-id');
});
await test('Secure Skill Grok accepts a same-host Location task receipt', async () => {
  const result = await invoke('secure_skill_grok_video', () => new Response('{}', {
    status: 202,
    headers: { Location: '/openai/v1/videos/secure-location-id?opaque=not-an-id#fragment' },
  }));
  assert.equal(result.taskId, 'secure-location-id');
});
await test('Secure Skill Grok unknown receipt evidence is structural and redacted', async () => {
  const secret = 'SENSITIVE-fixture-key-and-prompt';
  const result = await invoke('secure_skill_grok_video', () => Response.json({
    api_key: secret,
    prompt: secret,
    error: { message: secret, token: secret },
    data: { task_id: { secret }, authorization: secret },
  }, {
    status: 503,
    headers: { Location: `/openai/v1/videos/content?token=${secret}` },
  }));
  assert.equal(result.submissionOutcome, 'unknown');
  assert.equal(result.taskId, '');
  assert.equal(result.submissionReceipt.schemaVersion, 1);
  assert.equal(result.submissionReceipt.receiptState, 'response_received');
  assert.equal(result.submissionReceipt.endpointHost, 'provider.example');
  assert.equal(result.submissionReceipt.httpStatus, 503);
  assert.equal(result.submissionReceipt.responseParseState, 'json_object');
  assert.equal(result.submissionReceipt.responseBodySha256.length, 64);
  assert.equal(result.submissionReceipt.providerRequestKeySha256.length, 64);
  assert.deepEqual(Array.from(result.submissionReceipt.candidateFieldPaths), ['data.task_id']);
  const persisted = JSON.stringify(result.submissionReceipt);
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('api_key'), false);
  assert.equal(persisted.includes('authorization'), false);
  assert.equal(persisted.includes('prompt'), false);
  assert.equal(persisted.includes('token='), false);
});
await test('MiniMax uses its original endpoint and a single unknown POST', async () => {
  const result = await invoke('secure_skill_grok_video', () => new Response('<!doctype html>'), { model_name: 'minimax-h3' });
  assert.equal(result.submissionOutcome, 'unknown'); assert.equal(calls[0].path, '/v1/videos'); assert.deepEqual(calls[0].body.image_urls, [params.imageUrl]);
});
await test('Existing NewAPI unknown submission remains single dispatch', async () => {
  assert.equal((await invoke('newapi_video', json({}, 503))).submissionOutcome, 'unknown');
});
for (const protocol of protocols) {
  await test(protocol + ' polling retains actual explicit terminal failure', async () => {
    calls = []; factory = json({ status: 'failed', error: { message: 'rendering failed' } });
    const result = await adapter.pollVideoTask(config(protocol), 'original-poll-task');
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
    assert.equal(result.taskId, 'original-poll-task'); assert.equal(result.status, 'failed'); assert.equal(result.submissionOutcome, undefined);
  });
}
if (process.argv[2]) {
  await test('all poll functions match the pre-edit snapshot exactly', async () => {
    const parse = source => {
      const tree = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true);
      return tree.statements.filter(node => ts.isFunctionDeclaration(node) && /^poll/u.test(node.name?.text || '')).map(node => node.getText(tree));
    };
    assert.deepEqual(parse(fs.readFileSync('src/lib/video-adapter.ts', 'utf8')), parse(fs.readFileSync(process.argv[2], 'utf8')));
  });
}
console.log(JSON.stringify({ passed, failed: 0, realNetworkRequests: 0, databaseWrites: 0 }));
