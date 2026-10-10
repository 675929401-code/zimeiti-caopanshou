// Executes the actual providers and settlement handler with isolated upstream streams.
// No credentials, real provider requests or database writes are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as nodeCrypto from 'node:crypto';
import ts from 'typescript';

const root = process.cwd();
const encoder = new TextEncoder();
const cases = [];
const snapshot = path.join(root, '.codex-backups/chat-stream-errors-20260905');
const oldStreamFixtureAvailable = fs.existsSync(path.join(snapshot, 'src/app/api/llm/handle-stream.ts'));
const beforeRepairFixtureAvailable = fs.existsSync(path.join(root, '.codex-backups/story-copy-repair-20260917/src/app/api/llm/handle-stream.ts'));
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const content = text => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
const originalError = 'event: error\ndata: {"error":{"type":"upstream_error","message":"Upstream service temporarily unavailable"}}\n\n';

function rig({ before = false, beforeRepair = false, upstream, fastTimers = false, requestError, responseStatus = 200, settlementError } = {}) {
  const state = { posts: 0, settlements: 0, releases: 0, saves: 0, failures: [], successes: 0 };
  const cache = new Map();
  const request = async () => {
    state.posts++;
    if (requestError) throw new Error(requestError);
    return new Response(upstream(), { status: responseStatus, headers: { 'content-type': 'text/event-stream' } });
  };
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const selectedSnapshot = beforeRepair ? path.join(root, '.codex-backups/story-copy-repair-20260917') : snapshot;
    const disk = (before || beforeRepair) && fs.existsSync(path.join(selectedSnapshot, relative)) ? path.join(selectedSnapshot, relative) : path.join(root, relative);
    const module = { exports: {} };
    cache.set(relative, module.exports);
    const dependency = name => {
      if (name === 'node:crypto') return nodeCrypto;
      if (name === '@/lib/server-runtime-env') return { ensureServerRuntimeEnvLoaded() {} };
      if (name === './native-fetch') return { nativeFetch: request };
      if (name === '@/lib/llm-proxy') return { getLLMProxy() { throw Error('Unexpected non-stream call'); } };
      if (name === '@/lib/llm-billing') return { async settleLlmUsage() { state.settlements++; if (settlementError) throw new Error(settlementError); return { operationId: 'fixture-op', billing: { creditsCharged: 1 } }; } };
      if (name === '@/lib/llm-credit-reservation') return { async releaseLlmStreamCredits() { state.releases++; } };
      if (name === '@/storage/database/supabase-client') return { getSupabaseClient() { return { from() { return { insert() { state.saves++; return Promise.resolve({ error: null }); } }; } }; } };
      if (name === '@/lib/llm-fallback') return { recordModelFailure(_model, why) { state.failures.push(why); }, recordModelSuccess() { state.successes++; } };
      if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${name}.ts`)));
      throw Error(`Unexpected dependency: ${name}`);
    };
    const compiled = ts.transpileModule(fs.readFileSync(disk, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, {
      module, exports: module.exports, require: dependency,
      Response, Headers, Request, ReadableStream, WritableStream, TextEncoder, TextDecoder, Buffer,
      URL, Error, AbortController, AbortSignal, crypto: nodeCrypto.webcrypto,
      fetch: request, process: { env: {} }, console: { log() {}, warn() {}, error() {} },
      setTimeout: (fn, delay, ...args) => setTimeout(fn, fastTimers && delay >= 60_000 ? 30 : delay, ...args),
      clearTimeout, setInterval, clearInterval,
    }, { filename: relative });
    cache.set(relative, module.exports);
    return module.exports;
  }
  return { state, load };
}

function chunks(text, size) {
  const bytes = encoder.encode(text);
  return () => new ReadableStream({ start(c) {
    if (size) for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
    else c.enqueue(bytes);
    c.close();
  } });
}

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}

async function run({ upstream, provider = 'openai', live = true, before = false, beforeRepair = false, fastTimers = false, requestError, responseStatus, settlementError }) {
  const env = rig({ upstream, before, beforeRepair, fastTimers, requestError, responseStatus, settlementError });
  const proxy = new (env.load('src/lib/llm-proxy/proxy.ts').LLMProxy)({ apiBase: 'https://fixture.invalid/v1', apiKey: 'fixture-key', retryCount: 0 });
  const ctx = {
    verifiedUserId: 'fixture-user', userRole: 'user', agentId: 'fixture-agent', agentName: 'fixture', conversationId: 'fixture-history',
    useModel: 'fixture-model', apiBase: 'https://fixture.invalid/v1', useApiKey: 'fixture-key', isZhipuAI: provider === 'zhipu',
    agentTimeout: 120, agentDeepThinkingType: 0, agentDeductDeepThink: 1, agentMaxReplyTokens: 100,
    clientRequestId: 'fixture-request', selectedModelBillingSnapshot: {}, allowLiveStreamDelivery: live,
    reservation: { requestId: 'fixture-request' }, messages: [], userMessageSaved: { value: true },
  };
  const response = env.load('src/app/api/llm/handle-stream.ts').handleStreamResponse(ctx, { model: ctx.useModel, messages: [{ role: 'user', content: 'test' }] }, proxy);
  const text = await within(response.text());
  await new Promise(resolve => setTimeout(resolve, 0));
  return { ...env, text };
}

{
  let upstreamController;
  const env = rig({ upstream: () => new ReadableStream({ start(controller) { upstreamController = controller; } }) });
  const proxy = new (env.load('src/lib/llm-proxy/proxy.ts').LLMProxy)({ apiBase: 'https://fixture.invalid/v1', apiKey: 'fixture-key', retryCount: 0 });
  const ctx = {
    verifiedUserId: 'fixture-user', userRole: 'user', agentId: 'fixture-agent', agentName: 'fixture', conversationId: 'fixture-history',
    useModel: 'fixture-model', apiBase: 'https://fixture.invalid/v1', useApiKey: 'fixture-key', isZhipuAI: false,
    agentTimeout: 120, agentDeepThinkingType: 0, agentDeductDeepThink: 1, agentMaxReplyTokens: 100,
    clientRequestId: 'fixture-live-reservation', selectedModelBillingSnapshot: {}, allowLiveStreamDelivery: true,
    streamDeliveryReason: 'reservation_authorized_live_delivery',
    reservation: { requestId: 'fixture-live-reservation' }, messages: [], userMessageSaved: { value: true },
  };
  const response = env.load('src/app/api/llm/handle-stream.ts').handleStreamResponse(ctx, { model: ctx.useModel, messages: [{ role: 'user', content: 'test' }] }, proxy);
  const reader = response.body.getReader();
  await reader.read(); // immediate heartbeat
  const delivery = await within(reader.read());
  assert.match(new TextDecoder().decode(delivery.value), /"stream_delivery":"live"/);
  assert.match(new TextDecoder().decode(delivery.value), /reservation_authorized_live_delivery/);
  upstreamController.enqueue(encoder.encode(frame(content('预留成功后首段立即显示'))));
  const early = await within(reader.read());
  assert.match(new TextDecoder().decode(early.value), /预留成功后首段立即显示/);
  assert.equal(env.state.settlements, 0, 'first text must arrive before final settlement');
  upstreamController.enqueue(encoder.encode(frame(stop) + 'data: [DONE]\n\n'));
  upstreamController.close();
  while (!(await within(reader.read())).done) {}
  assert.equal(env.state.settlements, 1);
  cases.push('reserved paid response delivers first text before upstream completion and final settlement');
}

{
  const result = await run({ live: true, settlementError: 'fixture settlement outage', upstream: chunks(frame(content('已在预留保护下交付')) + frame(stop) + 'data: [DONE]\n\n') });
  assert.match(result.text, /已在预留保护下交付/);
  assert.match(result.text, /LLM_BILLING_FAILED/);
  assert.match(result.text, /"reconciliation_required":true/);
  assert.equal(result.state.releases, 0, 'a delivered reserved response must retain its hold for reconciliation');
  cases.push('post-delivery settlement outage retains the wallet hold and marks reconciliation required');
}

for (const partial of oldStreamFixtureAvailable ? [false, true] : []) {
  const result = await run({ before: true, upstream: chunks((partial ? frame(content('未完成')) : '') + originalError) });
  if (!partial) assert.match(result.text, /LLM_EMPTY_RESPONSE/);
  else assert.equal(result.state.settlements, 1, 'The original handler settles partial content despite an explicit upstream error');
  cases.push(`actual old source reproduces ${partial ? 'incorrect settlement after partial failure' : 'upstream error overwritten as empty response'}`);
}

for (const provider of ['openai', 'zhipu']) {
  for (const live of [true, false]) for (const partial of [true, false]) {
    const result = await run({ provider, live, upstream: chunks((partial ? frame(content('未完成')) : '') + originalError, 3) });
    assert.match(result.text, /LLM_UPSTREAM_ERROR/);
    assert.doesNotMatch(result.text, /LLM_EMPTY_RESPONSE|billing_complete|data: \[DONE\]/);
    assert.equal(result.state.settlements, 0);
    assert.equal(result.state.saves, 0);
    assert.equal(result.state.releases, 1);
    assert.equal(result.state.posts, 1);
    if (!live) assert.doesNotMatch(result.text, /未完成"/);
    cases.push(`${provider}: explicit error, partial=${partial}, live=${live}, no settlement or success history, hold released`);
  }
  const text = `data:${JSON.stringify(content('中文😀 [DONE] 继续'))}\r\n\r\ndata: ${JSON.stringify(stop)}`;
  const result = await run({ provider, upstream: chunks(text, 1) });
  assert.match(result.text, /中文😀 \[DONE\] 继续/);
  assert.match(result.text, /billing_complete/);
  assert.equal(result.state.settlements, 1);
  assert.equal(result.state.saves, 1);
  assert.equal(result.state.releases, 1);
  cases.push(`${provider}: byte-split UTF8, CRLF, optional data space, literal DONE and EOF tail all preserved`);
  const interrupted = await run({ provider, upstream: chunks(frame(content('只有半句话'))) });
  assert.match(interrupted.text, /LLM_STREAM_INTERRUPTED/);
  assert.equal(interrupted.state.settlements, 0);
  cases.push(`${provider}: EOF without terminal cannot settle partial text`);
  const stalled = await run({ provider, fastTimers: true, upstream: () => new ReadableStream({ start(c) { c.enqueue(encoder.encode(frame(content('中断前')))); } }) });
  assert.match(stalled.text, /LLM_UPSTREAM_TIMEOUT/);
  assert.equal(stalled.state.settlements, 0);
  assert.equal(stalled.state.releases, 1);
  cases.push(`${provider}: inactivity timeout fails and releases hold`);
  const keptOpen = await run({ provider, upstream: () => new ReadableStream({ start(c) { c.enqueue(encoder.encode(frame(content('已完成')) + frame(stop) + 'data: [DONE]\n\n')); } }) });
  assert.equal(keptOpen.state.settlements, 1);
  assert.match(keptOpen.text, /billing_complete/);
  cases.push(`${provider}: DONE finishes promptly even if the provider keeps its socket open`);
}

for (const [type, code] of [['authentication_error', 'LLM_UPSTREAM_AUTH'], ['rate_limit', 'LLM_UPSTREAM_BUSY'], ['insufficient_quota', 'LLM_UPSTREAM_BALANCE']]) {
  const result = await run({ upstream: chunks(frame({ error: { type, message: 'private-provider-detail SECRET_FIXTURE_MUST_NOT_LEAK' } })) });
  assert.match(result.text, new RegExp(code));
  assert.doesNotMatch(result.text, /SECRET_FIXTURE|private-provider-detail/);
  cases.push(`safe specific ${code} without leaking provider diagnostic payload`);
}

{
  let upstream;
  const env = rig({ upstream: () => new ReadableStream({ start(c) { upstream = c; } }) });
  const proxy = new (env.load('src/lib/llm-proxy/proxy.ts').LLMProxy)({ apiBase: 'https://fixture.invalid/v1', apiKey: 'fixture', retryCount: 0 });
  let callbackText = '';
  const stream = await proxy.chatStream({ model: 'test', messages: [] }, { onContent(value) { callbackText += value; } });
  const reader = stream.getReader();
  await reader.read(); // initial heartbeat
  upstream.enqueue(encoder.encode(frame(content('边生成边显示'))));
  const early = await within(reader.read());
  assert.match(new TextDecoder().decode(early.value), /边生成边显示/);
  assert.equal(callbackText, '边生成边显示');
  upstream.enqueue(encoder.encode(frame(stop) + 'data: [DONE]\n\n'));
  upstream.close();
  while (!(await within(reader.read())).done) {}
  cases.push('first content delivered while upstream remains open');
}

{
  const env = rig({ upstream: chunks('event: content_block_delta\ndata:{"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude中文"}}\n\ndata:{"type":"message_stop"}', 2) });
  const proxy = new (env.load('src/lib/llm-proxy/proxy.ts').LLMProxy)({ apiBase: 'https://api.anthropic.com/v1', apiKey: 'fixture', retryCount: 0, protocol: 'anthropic_messages' });
  let value = '';
  const stream = await proxy.chatStream({ model: 'claude-sonnet-4', messages: [] }, { onContent(part) { value += part; } });
  const text = await within(new Response(stream).text());
  assert.equal(value, 'Claude中文');
  assert.match(text, /data: \[DONE\]/);
  cases.push('Claude converted delta and final message_stop remain compatible');
}

for (const withBilling of [false, true]) {
  const env = rig({ upstream: chunks('') });
  const wrap = env.load('src/lib/llm-request-idempotency.ts').completeLlmAttemptResponse;
  let receipt;
  const input = new Response((withBilling ? frame({ billing_complete: true }) : '') + frame({ error: '上游故障', code: 'LLM_UPSTREAM_ERROR', done: false }), { headers: { 'content-type': 'text/event-stream' } });
  const output = await wrap({ async finalize(value) { receipt = value; return {}; } }, { record: { recordId: 'fixture', attemptNo: 1 }, leaseOwner: 'fixture', leaseToken: 1 }, input);
  await within(output.text());
  assert.equal(receipt.state, withBilling ? 'reconciliation_required' : 'failed');
  if (!withBilling) assert.match(receipt.responseBody, /LLM_UPSTREAM_ERROR/);
  cases.push(withBilling ? 'contradictory billing and failure cannot be called a known unpaid failure' : 'explicit upstream failure persists a replayable failed receipt without manual-reconciliation state');
}

// Reproduce and cover errors thrown before the proxy can return its stream.
for (const scenario of [
  { name: 'authentication', status: 401, body: 'invalid API key SECRET_FIXTURE_MUST_NOT_LEAK', code: 'LLM_UPSTREAM_AUTH', state: 'failed' },
  { name: 'quota', status: 403, body: 'insufficient_user_quota SECRET_FIXTURE_MUST_NOT_LEAK', code: 'LLM_UPSTREAM_BALANCE', state: 'failed' },
  { name: 'rate limit', status: 429, body: 'too many requests SECRET_FIXTURE_MUST_NOT_LEAK', code: 'LLM_UPSTREAM_BUSY', state: 'failed' },
  { name: 'transport', requestError: 'fetch failed SECRET_FIXTURE_MUST_NOT_LEAK', code: 'LLM_UPSTREAM_RESULT_UNKNOWN', state: 'failed_unknown' },
  { name: 'gateway', status: 524, body: 'SECRET_FIXTURE_MUST_NOT_LEAK', code: 'LLM_UPSTREAM_RESULT_UNKNOWN', state: 'failed_unknown' },
]) {
  for (const beforeRepair of beforeRepairFixtureAvailable ? [true, false] : [false]) {
    const result = await run({ beforeRepair, upstream: chunks(scenario.body || ''), requestError: scenario.requestError, responseStatus: scenario.status });
    let receipt;
    const wrap = result.load('src/lib/llm-request-idempotency.ts').completeLlmAttemptResponse;
    const output = await wrap({ async finalize(value) { receipt = value; return {}; } }, { record: { recordId: 'fixture', attemptNo: 1 }, leaseOwner: 'fixture', leaseToken: 1 }, new Response(result.text, { headers: { 'content-type': 'text/event-stream' } }));
    const delivered = await within(output.text());
    assert.equal(result.state.posts, 1);
    assert.equal(result.state.settlements, 0);
    assert.equal(result.state.saves, 0);
    assert.equal(result.state.releases, 1);
    if (beforeRepair) {
      assert.equal(receipt.errorCode, 'LLM_STREAM_TERMINAL_UNKNOWN');
    } else {
      assert.equal(receipt.errorCode, scenario.code);
      assert.equal(receipt.state, scenario.state);
      assert.match(receipt.errorMessage, new RegExp(scenario.code));
      assert.doesNotMatch(delivered, /SECRET_FIXTURE|invalid API key|insufficient_user_quota/);
      if (scenario.state === 'failed_unknown') {
        assert.match(delivered, /RECONCILIATION_REQUIRED/);
        assert.equal(receipt.responseBody, undefined, 'unknown must not become replayable');
      }
    }
    cases.push(`response start ${scenario.name}: ${beforeRepair ? 'old source reproduces lost error classification' : 'classified and sanitized, no retry or settlement'}`);
  }
}

{
  const env = rig({ upstream: chunks('') });
  let receipt;
  const wrap = env.load('src/lib/llm-request-idempotency.ts').completeLlmAttemptResponse;
  const response = await wrap({ async finalize(value) { receipt = value; return {}; } }, { record: { recordId: 'fixture', attemptNo: 1 } }, new Response(frame(content('partial')), { headers: { 'content-type': 'text/event-stream' } }));
  const text = await within(response.text());
  assert.equal(receipt.state, 'failed_unknown');
  assert.match(text, /RECONCILIATION_REQUIRED/);
  assert.doesNotMatch(text, /data: \[DONE\]|billing_complete/);
  cases.push('unclassified premature close explicitly informs the client without false completion');
}

const report = { at: new Date().toISOString(), passed: true, cases, realProviderPosts: 0, realDatabaseWrites: 0 };
fs.mkdirSync('.codex-evidence/story-copy-repair-20260917', { recursive: true });
fs.writeFileSync('.codex-evidence/story-copy-repair-20260917/llm-provider-stream-regression.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
