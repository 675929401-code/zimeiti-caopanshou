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
const responseStartEvidence = [];
const snapshot = path.join(root, '.codex-backups/chat-stream-errors-20260905');
const oldStreamFixtureAvailable = fs.existsSync(path.join(snapshot, 'src/app/api/llm/handle-stream.ts'));
const beforeRepairFixtureAvailable = fs.existsSync(path.join(root, '.codex-backups/story-copy-repair-20260917/src/app/api/llm/handle-stream.ts'));
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const content = text => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
const originalError = 'event: error\ndata: {"error":{"type":"upstream_error","message":"Upstream service temporarily unavailable"}}\n\n';

function rig({ before = false, beforeRepair = false, upstream, fastTimers = false, requestError, pendingRequest = false, responseStatus = 200, settlementError } = {}) {
  const state = { posts: 0, methods: [], aborts: 0, settlements: 0, releases: 0, saves: 0, failures: [], successes: 0, logs: [], clockOffsetMs: 0, longTimers: { scheduled: [], fired: [], cleared: [] } };
  const cache = new Map();
  const timers = new Map();
  class FixtureDate extends Date {
    static now() { return Date.now() + state.clockOffsetMs; }
  }
  const request = async (...args) => {
    const options = args[1];
    state.posts++;
    state.methods.push(options?.method);
    options?.signal?.addEventListener('abort', () => { state.aborts++; }, { once: true });
    if (requestError) throw requestError instanceof Error ? requestError : new Error(requestError);
    if (pendingRequest) {
      assert.ok(options?.signal instanceof AbortSignal, 'pending fetch must observe the real AbortSignal');
      return await new Promise((_, reject) => {
        // A non-AbortError rejection proves that the local deadline marker is authoritative.
        const onAbort = () => reject(new Error('transport failed SECRET_FIXTURE_MUST_NOT_LEAK'));
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    return new Response(upstream(), { status: responseStatus, headers: { 'content-type': 'text/event-stream' } });
  };
  const fixtureTimeout = (fn, delay, ...args) => {
    const accelerated = fastTimers && delay >= 60_000;
    if (delay >= 60_000) state.longTimers.scheduled.push(delay);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (delay >= 60_000) state.longTimers.fired.push(delay);
      if (accelerated) state.clockOffsetMs += delay - 30;
      fn(...args);
    }, accelerated ? 30 : delay);
    timers.set(timer, delay);
    return timer;
  };
  const fixtureClearTimeout = timer => {
    const delay = timers.get(timer);
    if (delay >= 60_000) state.longTimers.cleared.push(delay);
    timers.delete(timer);
    clearTimeout(timer);
  };
  const captureLog = (level, args) => state.logs.push({ level, args: args.map(value => {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack}\n${String(value.cause)}`;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }) });
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
      URL, Error, Date: FixtureDate, AbortController, AbortSignal, crypto: nodeCrypto.webcrypto,
      fetch: request, process: { env: {} }, console: { log(...args) { captureLog('log', args); }, warn(...args) { captureLog('warn', args); }, error(...args) { captureLog('error', args); } },
      setTimeout: fixtureTimeout, clearTimeout: fixtureClearTimeout, setInterval, clearInterval,
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

async function run({ upstream, provider = 'openai', live = true, before = false, beforeRepair = false, fastTimers = false, requestError, pendingRequest, responseStatus, settlementError, responseStartErrorArgs }) {
  const env = rig({ upstream, before, beforeRepair, fastTimers, requestError, pendingRequest, responseStatus, settlementError });
  const proxy = new (env.load('src/lib/llm-proxy/proxy.ts').LLMProxy)({ apiBase: 'https://fixture.invalid/v1', apiKey: 'fixture-key', retryCount: 0 });
  if (responseStartErrorArgs) {
    const { LlmResponseStartError } = env.load('src/lib/llm-proxy/stream-error.ts');
    const error = new LlmResponseStartError(...responseStartErrorArgs);
    proxy.chatStream = async () => { throw error; };
  }
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

function responseStartLogs(state) {
  return state.logs.flatMap(log => log.args.filter(arg => typeof arg === 'string' && arg.startsWith('{')).map(arg => {
    try { return { level: log.level, payload: JSON.parse(arg) }; } catch { return null; }
  })).filter(log => log?.payload?.kind === 'LLM_RESPONSE_START_FAILURE');
}

function assertSafeResponseStartLog(result, outcome, timeoutMs = 120_000) {
  const logs = responseStartLogs(result.state);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  const payload = logs[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ['code', 'diagnostics', 'kind', 'requestId']);
  assert.equal(payload.requestId, 'fixture-request');
  assert.equal(payload.code, 'LLM_UPSTREAM_RESULT_UNKNOWN');
  assert.deepEqual(Object.keys(payload.diagnostics).sort(), ['elapsedMs', 'outcome', 'phase', 'timeoutMs']);
  assert.equal(payload.diagnostics.phase, 'response_headers');
  assert.equal(payload.diagnostics.outcome, outcome);
  assert.equal(payload.diagnostics.timeoutMs, timeoutMs);
  for (const value of [payload.diagnostics.elapsedMs, payload.diagnostics.timeoutMs]) {
    assert.ok(Number.isFinite(value) && Number.isInteger(value) && value >= 0);
  }
  assert.doesNotMatch(JSON.stringify(result.state.logs), /SECRET_FIXTURE|private-provider-detail|fixture\.invalid|fixture-key/);
  assert.doesNotMatch(result.text, /diagnostics|response_headers|deadline_exceeded|transport_error|elapsedMs|timeoutMs|SECRET_FIXTURE/);
  return payload;
}

async function assertUnknownAttempt(result) {
  let receipt;
  const wrap = result.load('src/lib/llm-request-idempotency.ts').completeLlmAttemptResponse;
  const response = await wrap({ async finalize(value) { receipt = value; return {}; } }, { record: { recordId: 'fixture', attemptNo: 1 }, leaseOwner: 'fixture', leaseToken: 1 }, new Response(result.text, { headers: { 'content-type': 'text/event-stream' } }));
  const delivered = await within(response.text());
  assert.equal(result.state.posts, 1);
  assert.deepEqual(result.state.methods, ['POST']);
  assert.equal(result.state.settlements, 0);
  assert.equal(result.state.saves, 0);
  assert.equal(result.state.releases, 1);
  assert.equal(receipt.state, 'failed_unknown');
  assert.equal(receipt.errorCode, 'LLM_UPSTREAM_RESULT_UNKNOWN');
  assert.equal(receipt.responseBody, undefined, 'unknown response must not be replayable');
  assert.match(delivered, /"retry_safe":false/);
  assert.doesNotMatch(delivered, /billing_complete|data: \[DONE\]|diagnostics|SECRET_FIXTURE/);
  return { state: receipt.state, errorCode: receipt.errorCode, responseBodyAbsent: receipt.responseBody === undefined, retrySafe: false };
}

{
  const env = rig();
  const { LlmResponseStartError, LlmStreamError } = env.load('src/lib/llm-proxy/stream-error.ts');
  const error = new LlmResponseStartError('transport_error', 12.75, 120_000);
  assert.ok(error instanceof LlmStreamError);
  assert.ok(Object.isFrozen(error.diagnostics));
  assert.equal(error.code, 'LLM_UPSTREAM_RESULT_UNKNOWN');
  assert.equal(error.diagnostics.elapsedMs, 12);
  assert.equal('cause' in error, false);
  assert.deepEqual(Object.keys(error.diagnostics).sort(), ['elapsedMs', 'outcome', 'phase', 'timeoutMs']);
  cases.push('response-start safe error has frozen integer-only allowlisted diagnostics and no raw cause');
}

// Deliberately pass runtime JavaScript values beyond the constructor's TypeScript contract.
for (const scenario of [
  { name: 'NaN', args: ['deadline_exceeded', NaN, NaN], outcome: 'deadline_exceeded', elapsedMs: 0, timeoutMs: 0 },
  { name: 'positive Infinity', args: ['deadline_exceeded', Infinity, Infinity], outcome: 'deadline_exceeded', elapsedMs: 0, timeoutMs: 0 },
  { name: 'negative Infinity', args: ['transport_error', -Infinity, -Infinity], outcome: 'transport_error', elapsedMs: 0, timeoutMs: 0 },
  { name: 'negative values', args: ['deadline_exceeded', -12, -120_000], outcome: 'deadline_exceeded', elapsedMs: 0, timeoutMs: 0 },
  { name: 'fractional values', args: ['transport_error', 12.75, 120_000.75], outcome: 'transport_error', elapsedMs: 12, timeoutMs: 120_000 },
  { name: 'invalid outcome string', args: ['SECRET_FIXTURE_MUST_NOT_LEAK', 17, 120_000], outcome: 'transport_error', elapsedMs: 17, timeoutMs: 120_000 },
  { name: 'invalid outcome object', args: [{ token: 'SECRET_FIXTURE_MUST_NOT_LEAK' }, 17, 120_000], outcome: 'transport_error', elapsedMs: 17, timeoutMs: 120_000 },
  { name: 'missing outcome', args: [undefined, 17, 120_000], outcome: 'transport_error', elapsedMs: 17, timeoutMs: 120_000 },
]) {
  const result = await run({ responseStartErrorArgs: scenario.args });
  const payload = assertSafeResponseStartLog(result, scenario.outcome, scenario.timeoutMs);
  assert.equal(payload.diagnostics.elapsedMs, scenario.elapsedMs);
  assert.equal(result.state.posts, 0, 'class normalization fixture must not issue a provider request');
  assert.equal(result.state.settlements, 0);
  assert.equal(result.state.saves, 0);
  assert.equal(result.state.releases, 1);
  responseStartEvidence.push({ scenario: `class normalization: ${scenario.name}`, payload, logs: result.state.logs });
  cases.push(`response-start class normalizes ${scenario.name} before allowlisted server logging without exposing raw values`);
}

{
  const unsafeError = new Error('fetch failed https://fixture.invalid/private SECRET_FIXTURE_MUST_NOT_LEAK', { cause: new Error('private-provider-detail SECRET_FIXTURE_MUST_NOT_LEAK') });
  const env = rig({ fastTimers: true, requestError: unsafeError });
  const proxy = new (env.load('src/lib/llm-proxy/proxy.ts').LLMProxy)({ apiBase: 'https://fixture.invalid/v1', apiKey: 'fixture-key', retryCount: 0 });
  const { LlmResponseStartError } = env.load('src/lib/llm-proxy/stream-error.ts');
  await assert.rejects(proxy.chatStream({ model: 'fixture-model', messages: [] }), error => {
    assert.ok(error instanceof LlmResponseStartError);
    assert.ok(Object.isFrozen(error.diagnostics));
    assert.equal(error.diagnostics.outcome, 'transport_error');
    assert.equal('cause' in error, false);
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /SECRET_FIXTURE|private-provider-detail|fixture\.invalid|fixture-key/);
    return true;
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(env.state.posts, 1);
  assert.equal(env.state.aborts, 0);
  assert.deepEqual(env.state.longTimers.fired, []);
  cases.push('actual fetch rejection is converted to the safe response-start class without retaining raw message, cause, stack or URL');
}

{
  const result = await run({ fastTimers: true, pendingRequest: true });
  const payload = assertSafeResponseStartLog(result, 'deadline_exceeded');
  assert.ok(payload.diagnostics.elapsedMs >= payload.diagnostics.timeoutMs, 'virtual clock must reach the actual response-header deadline');
  assert.equal(result.state.aborts, 1, 'pending fetch must reject only after the real signal is aborted');
  assert.deepEqual(result.state.longTimers.fired, [120_000]);
  const receipt = await assertUnknownAttempt(result);
  responseStartEvidence.push({ scenario: 'pending fetch deadline', payload, receipt, aborts: result.state.aborts, longTimers: result.state.longTimers, logs: result.state.logs });
  cases.push('pending response-header fetch observes AbortSignal, records deadline, and remains a single unpaid non-replayable UNKNOWN attempt');
}

{
  const unsafeError = new Error('fetch failed https://fixture.invalid/private SECRET_FIXTURE_MUST_NOT_LEAK', { cause: new Error('private-provider-detail SECRET_FIXTURE_MUST_NOT_LEAK') });
  unsafeError.name = 'AbortError';
  const result = await run({ fastTimers: true, requestError: unsafeError });
  const payload = assertSafeResponseStartLog(result, 'transport_error');
  await new Promise(resolve => setTimeout(resolve, 60)); // past the accelerated response-header deadline
  assert.equal(result.state.aborts, 0, 'a rejected fetch must not receive a late deadline abort');
  assert.deepEqual(result.state.longTimers.fired, []);
  assert.deepEqual(result.state.longTimers.cleared, [120_000]);
  const receipt = await assertUnknownAttempt(result);
  responseStartEvidence.push({ scenario: 'fast AbortError transport rejection', payload, receipt, aborts: result.state.aborts, longTimers: result.state.longTimers, logs: result.state.logs });
  cases.push('fast transport rejection ignores AbortError name, strips unsafe cause, clears deadline, and retains UNKNOWN accounting semantics');
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
  if (provider === 'openai') {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(stalled.state.aborts, 0, 'successful response headers must clear the fetch deadline');
    assert.deepEqual(stalled.state.longTimers.fired, [60_000], 'only the existing stream-read inactivity deadline may fire');
    assert.ok(stalled.state.longTimers.cleared.includes(120_000));
    assert.equal(responseStartLogs(stalled.state).length, 0, 'a post-header read timeout is not a response-start failure');
    responseStartEvidence.push({ scenario: 'headers succeeded then stream stalled', code: 'LLM_UPSTREAM_TIMEOUT', aborts: stalled.state.aborts, longTimers: stalled.state.longTimers, logs: stalled.state.logs });
    cases.push('successful headers clear response-start deadline while the existing 60-second stream stall error stays unchanged');
  }
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
    const result = await run({ beforeRepair, fastTimers: !beforeRepair, upstream: chunks(scenario.body || ''), requestError: scenario.requestError, responseStatus: scenario.status });
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
      assert.doesNotMatch(JSON.stringify(result.state.logs), /SECRET_FIXTURE|invalid API key|insufficient_user_quota/);
      if (scenario.requestError) {
        assertSafeResponseStartLog(result, 'transport_error');
      } else {
        assert.equal(responseStartLogs(result.state).length, 0, 'HTTP response failures must not be classified as fetch rejections');
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(result.state.aborts, 0);
      assert.deepEqual(result.state.longTimers.fired, []);
      assert.deepEqual(result.state.longTimers.cleared, [120_000]);
      if (scenario.state === 'failed_unknown') {
        assert.match(delivered, /RECONCILIATION_REQUIRED/);
        assert.match(delivered, /"retry_safe":false/);
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

const report = { at: new Date().toISOString(), passed: true, cases, responseStartDiagnostics: responseStartEvidence, realProviderPosts: 0, realDatabaseWrites: 0 };
const evidenceDir = process.env.LLM_PROVIDER_STREAM_EVIDENCE_DIR || path.join(root, '.codex-evidence/story-copy-repair-20260917');
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, 'llm-provider-stream-regression.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
