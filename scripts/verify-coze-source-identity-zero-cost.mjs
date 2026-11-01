import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = process.cwd(), nativeRequire = createRequire(import.meta.url), cases = [];
const expectedId = '7668612213666346491', otherId = '6952639370138520844';
const sourceUrl = `https://www.douyin.com/video/${expectedId}`;
const otherUrl = `https://www.douyin.com/video/${otherId}`;
function load(relative, imports = {}, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, URL, Response, Headers, Request, AbortSignal, Date, Buffer,
    console: { log() {}, error() {}, warn() {} },
    require(name) { if (Object.hasOwn(imports, name)) return imports[name]; if (name.startsWith('node:')) return nativeRequire(name); throw Error(`UNEXPECTED_IMPORT_${name}`); },
    ...globals,
  }, { filename: relative });
  return module.exports;
}
function check(name, fn) { fn(); cases.push(name); }
const identity = load('src/lib/coze-source-identity.ts');
const result = load('src/lib/coze-extraction-result.ts');
const caption = { aweme_id: expectedId, url: sourceUrl, caption: '真实口播夹具', error: '' };
const output = { mode: 'video', captions: [caption], success_count: 1 };
const state = (input, mode, value) => identity.inspectCozeSourceIdentity(input, mode, value).status;
for (const [name, input, mode, value, expected] of [
  ['matching string IDs', sourceUrl, 'video', output, 'verified'],
  ['share prose and punctuation', `分享视频：${sourceUrl}。`, 'single_video', output, 'verified'],
  ['duplicate identical input URL', `${sourceUrl} ${sourceUrl}`, 'video', output, 'verified'],
  ['aweme mismatch even when URL matches', sourceUrl, 'video', { captions: [{ ...caption, aweme_id: otherId }] }, 'mismatch'],
  ['URL mismatch even when aweme matches', sourceUrl, 'video', { captions: [{ ...caption, url: otherUrl }] }, 'mismatch'],
  ['video_url mismatch independently', sourceUrl, 'video', { captions: [{ ...caption, video_url: otherUrl }] }, 'mismatch'],
  ['later caption mismatch never truncated away', sourceUrl, 'video', { captions: [caption, { ...caption, aweme_id: otherId }] }, 'mismatch'],
  ['return mode cannot override requested video identity', sourceUrl, 'video', { ...output, mode: 'homepage', captions: [{ ...caption, aweme_id: otherId }] }, 'mismatch'],
  ['original wrong-source pair', sourceUrl, 'video', { captions: [{ aweme_id: otherId, url: otherUrl, caption: '古诗夹具' }] }, 'mismatch'],
  ['homepage allows multiple video identities', sourceUrl, 'homepage', { captions: [{ ...caption, aweme_id: otherId }] }, 'not_applicable'],
  ['search allows multiple video identities', sourceUrl, 'search', { captions: [{ ...caption, aweme_id: otherId }] }, 'not_applicable'],
  ['short link is not falsely verified', 'https://v.douyin.com/fixture/', 'video', output, 'unverified'],
  ['multiple input video identities are ambiguous', `${sourceUrl} ${otherUrl}`, 'video', output, 'unverified'],
  ['missing caption identity remains unverified', sourceUrl, 'video', { captions: [{ caption: '口播' }] }, 'unverified'],
  ['mixed identified and missing captions unverified', sourceUrl, 'video', { captions: [caption, { caption: '口播' }] }, 'unverified'],
  ['legacy final_result remains unverified', sourceUrl, 'video', { final_result: '口播', success_count: 1 }, 'unverified'],
  ['unsafe numeric ID does not manufacture precise identity', sourceUrl, 'video', { captions: [{ aweme_id: Number(expectedId), caption: '口播' }] }, 'unverified'],
  ['foreign lookalike host cannot supply source identity', `https://douyin.com.example.invalid/video/${expectedId}`, 'video', output, 'unverified'],
  ['unrelated CDN URL is not an aweme identifier', sourceUrl, 'video', { captions: [{ ...caption, video_url: 'https://cdn.example.invalid/video/111111' }] }, 'verified'],
  ['iesdouyin long share link', `https://www.iesdouyin.com/share/video/${expectedId}/`, 'video', output, 'verified'],
]) check(name, () => assert.equal(state(input, mode, value), expected));

function clientFor(completedOutput) {
  const calls = [], checkpoints = [], taskId = 'fixture-original-task';
  const client = load('src/lib/coze-workflow-client.ts', {
    '@/lib/coze-extraction-result': result,
    '@/lib/coze-source-identity': identity,
    '@/lib/extraction-exactly-once': { checkpointExtractionProviderTask: async id => checkpoints.push(id) },
  }, {
    setTimeout: callback => { queueMicrotask(callback); return 0; },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (calls.length === 1 && url === 'https://fixture.invalid/async_run' && options.method === 'POST') return Response.json({ task_id: taskId });
      if (calls.length === 2 && url === `https://fixture.invalid/task/${taskId}` && !options.method) return Response.json({ task_id: taskId, status: 'completed', result: completedOutput });
      throw Error('UNEXPECTED_NETWORK_OR_SECOND_SUBMIT');
    },
  });
  return { ...client, calls, checkpoints, taskId };
}
const config = { apiUrl: 'https://fixture.invalid/run', apiToken: 'FIXTURE_ONLY_NOT_A_CREDENTIAL', pricePerUse: 0.02, costPrice: 0.01, maxVideosPerBatch: 10 };
const mismatch = { ...output, captions: [{ aweme_id: otherId, url: otherUrl, caption: '古诗夹具' }] };
const failed = clientFor(JSON.stringify({ output: mismatch }));
let identityError;
try { await failed.runCozeCaptionWorkflow(config, sourceUrl); } catch (error) { identityError = error; }
check('real completed client rejects mismatch with original task', () => {
  assert.ok(identityError instanceof result.CozeWorkflowExecutionError);
  assert.equal(identityError.terminal, true); assert.equal(identityError.providerTaskId, failed.taskId);
  assert.equal(identityError.code, 'COZE_SOURCE_IDENTITY_MISMATCH');
  assert.equal(failed.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(failed.calls.length, 2); assert.deepEqual(failed.checkpoints, [failed.taskId]);
});
const failure = result.cozeWorkflowFailure(identityError);
check('failure payload is definitive, uncharged, readable and retains task', () => {
  assert.equal(failure.charged, false); assert.equal(failure.upstream_completed, true);
  assert.equal(failure.error_code, 'COZE_SOURCE_IDENTITY_MISMATCH');
  assert.equal(failure.provider_task_id, failed.taskId); assert.match(failure.error, /其他视频/u);
});
const matching = clientFor(output), delivered = await matching.runCozeCaptionWorkflow(config, sourceUrl);
check('real client delivers matching result without second submit', () => {
  assert.equal(delivered.captions[0].caption, caption.caption); assert.equal(delivered.provider_task_id, matching.taskId);
  assert.equal(matching.calls.length, 2);
});
for (const mode of ['homepage', 'search']) {
  const collection = clientFor(mismatch);
  const value = await collection.runCozeCaptionWorkflow(config, sourceUrl, mode);
  check(`real client ${mode} is not incorrectly rejected`, () => assert.equal(value.provider_task_id, collection.taskId));
}

// Execute the actual shared handler with the actual client/parser/helper. Only
// authentication, wallet I/O and provider transport are inert offline fixtures.
const pricing = load('src/lib/extract-pricing.ts');
for (const actor of ['fixture-actor-a', 'fixture-actor-b']) {
  const client = clientFor(mismatch), writes = { debit: 0, revenue: 0, resultCheckpoint: 0 };
  const database = { from(table) { assert.equal(table, 'users'); return { select() { return this; }, eq(field, value) { assert.equal(field, 'id'); assert.equal(value, actor); return this; }, async single() { return { data: { cash_balance: 10 }, error: null }; } }; } };
  const handler = load('src/lib/coze-extraction-handler.ts', {
    '@/lib/coze-workflow-client': client, '@/lib/coze-extraction-result': result,
    '@/storage/database/supabase-client': { getSupabaseClient: () => database },
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/extraction-auth': { authorizeExtractionRequest: async () => ({ ok: true, userId: actor, role: 'student' }) },
    '@/lib/billing': { deductCash: async () => { writes.debit++; throw Error('DEBIT_MUST_NOT_RUN'); } },
    '@/lib/extract-pricing': pricing,
    '@/lib/revenue': { recordRevenue: async () => { writes.revenue++; throw Error('REVENUE_MUST_NOT_RUN'); } },
    '@/lib/extraction-exactly-once': { checkpointExtractionProviderResult: async () => { writes.resultCheckpoint++; throw Error('WRONG_RESULT_MUST_NOT_PERSIST'); } },
    '@/lib/extraction-provider-error': { extractionProviderProblem: () => undefined, readableExtractionError: text => text },
  });
  const response = await handler.handleCozeExtraction(new Request('https://fixture.invalid/api/extract/coze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `fixture-request-${actor}` }, body: JSON.stringify({ share_text: sourceUrl }) }), { config });
  const body = await response.json();
  check(`actual handler rejects before persistence/debit for ${actor}`, () => {
    assert.equal(response.status, 503); assert.equal(body.success, false); assert.equal(body.charged, false);
    assert.equal(body.error_code, 'COZE_SOURCE_IDENTITY_MISMATCH'); assert.equal(body.provider_task_id, client.taskId);
    assert.equal(body.upstream_completed, true); assert.deepEqual(writes, { debit: 0, revenue: 0, resultCheckpoint: 0 });
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 1); assert.equal(client.calls.length, 2);
  });
}
const exactlyOnce = load('src/lib/extraction-exactly-once.ts', {
  'next/server': {}, '@/lib/extraction-auth': {}, '@/storage/database/supabase-client': {},
  '@/lib/extraction-history': {}, '@/lib/extraction-provider-error': {},
});
check('real durable outcome classifier marks source mismatch terminal failed', () => assert.equal(exactlyOnce.classifyExtractionOutcome(503, failure), 'failed'));
console.log(JSON.stringify({ passed: cases.length, cases, realProviderCalls: 0, realDatabaseCalls: 0, realCharges: 0, scope: 'actual TypeScript helper/client/handler with isolated offline transport and storage fixtures' }, null, 2));
