import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isIP } from 'node:net';
import vm from 'node:vm';
import ts from 'typescript';

const load = (file, modules) => { const compiledModule = { exports: {} }; vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
  { module: compiledModule, exports: compiledModule.exports, require: name => { assert.ok(name in modules, `UNSTUBBED_${name}`); return modules[name]; }, URL, Headers, Response, Request, AbortController, AbortSignal, Buffer, setTimeout, clearTimeout, process: { env: {} }, ReadableStream }); return compiledModule.exports; };
class PinnedRequestError extends Error { constructor(message, requestDispatched, transportCode) { super(message); this.requestDispatched = requestDispatched; this.transportCode = transportCode; } }
const neverNetwork = () => { throw Error('REAL_NETWORK_FORBIDDEN'); };
const dns = { PinnedRequestError, fetchPinnedPublicAddress: neverNetwork, lookupFixedPublicDns: neverNetwork, usesDevelopmentPublicDns: () => true };
const shared = load('src/lib/safe-fetch.ts', { 'node:dns/promises': { lookup: neverNetwork }, 'node:net': { isIP }, './safe-fetch-public-dns': dns });
const actual = load('src/lib/extract-provider-get-once.ts', { 'node:net': { isIP }, './safe-fetch': shared, './safe-fetch-public-dns': dns });
const input = 'http://configured-fixture.invalid/?clientId=fixture-id&clientSecretKey=fixture-secret&url=https%3A%2F%2Fvideo.invalid%2Fone';
const base = 'http://configured-fixture.invalid/';
const publicAnswers = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
const cases = [];
async function run(name, { url = input, configuredBaseUrl = base, answers = publicAnswers, response, error, timeoutMs = 1000, maxBytes, lookup } = {}, expected) {
  const calls = []; let cancelled = false;
  try {
    const result = await actual.fetchExtractionProviderGetOnce(url, { configuredBaseUrl, timeoutMs, maxBytes }, {
      lookup: lookup || (async () => answers),
      pinnedFetch: async (target, address, init) => {
        calls.push({ origin: target.origin, path: target.pathname, address: address.address, method: init.method, redirect: init.redirect, queryRetained: target.searchParams.get('clientSecretKey') === 'fixture-secret', headers: init.headers });
        if (error) throw error;
        if (response === 'stall-headers') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new PinnedRequestError('secret should not appear', true, 'ETIMEDOUT'))));
        if (response === 'stall-body') return new Response(new ReadableStream({ pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; } }));
        if (response === 'broken-body') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); controller.error(Object.assign(new Error('fixture-secret'), { code: 'ECONNRESET' })); } }));
        return response || Response.json({ code: 200, data: { video_mp4: 'https://media.invalid/one.mp4' } });
      },
    });
    assert.equal(expected.error, undefined, `${name}: expected rejection`); assert.equal(result.status, expected.status || 200); const text = await result.text(); if (expected.text) assert.equal(text, expected.text);
  } catch (error) {
    assert.ok(expected.error, `${name}: unexpected ${error.message}`); assert.equal(error.code, expected.error); assert.equal(error.requestDispatched, expected.dispatched); assert.ok(!error.message.includes('fixture-secret') && !error.message.includes('http')); if (expected.transport) assert.equal(error.transportCode, expected.transport);
  }
  assert.equal(calls.length, expected.calls); if (calls.length) { assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].redirect, 'manual'); assert.equal(calls[0].origin, new URL(configuredBaseUrl).origin); assert.ok(calls[0].queryRetained); assert.equal(calls[0].address, publicAnswers[0].address); }
  if (expected.cancelled) assert.ok(cancelled); cases.push(name);
}
await run('HTTP configured provider keeps exact origin/query and one pinned GET', {}, { calls: 1 });
await run('HTTPS configured provider retains TLS host and exact identity', { url: input.replace('http:', 'https:'), configuredBaseUrl: base.replace('http:', 'https:') }, { calls: 1 });
await run('Different origin rejects before credentials are sent', { url: input.replace('configured-fixture.invalid', 'other.invalid') }, { error: 'EXTRACTION_PROVIDER_TARGET_MISMATCH', dispatched: false, calls: 0 });
await run('Different configured path rejects before request', { url: input.replace('/?', '/other?') }, { error: 'EXTRACTION_PROVIDER_TARGET_MISMATCH', dispatched: false, calls: 0 });
await run('System fake private answer cannot be used as public destination', { answers: [{ address: '198.18.0.166', family: 4 }] }, { error: 'EXTRACTION_PROVIDER_TARGET_UNAVAILABLE', dispatched: false, calls: 0 });
await run('Mixed public/private DNS answers reject the entire answer set', { answers: [...publicAnswers, { address: '127.0.0.1', family: 4 }] }, { error: 'EXTRACTION_PROVIDER_TARGET_UNAVAILABLE', dispatched: false, calls: 0 });
await run('DNS address/family mismatch is rejected before request', { answers: [{ address: '8.8.8.8', family: 6 }] }, { error: 'EXTRACTION_PROVIDER_TARGET_UNAVAILABLE', dispatched: false, calls: 0 });
await run('Connection reset does not try a second public address', { error: new PinnedRequestError('fixture-secret', true, 'ECONNRESET') }, { error: 'EXTRACTION_PROVIDER_TRANSPORT_FAILED', dispatched: true, calls: 1, transport: 'ECONNRESET' });
await run('Explicit pre-send transport failure remains classified but is not retried', { error: new PinnedRequestError('fixture-secret', false, 'ECONNREFUSED') }, { error: 'EXTRACTION_PROVIDER_TARGET_UNAVAILABLE', dispatched: false, calls: 1 });
await run('Redirect response never sends credentials to next origin', { response: new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } }) }, { error: 'EXTRACTION_PROVIDER_REDIRECT_REJECTED', dispatched: true, calls: 1 });
await run('Provider 503 is returned without repeat or fallback', { response: new Response('busy', { status: 503 }) }, { status: 503, text: 'busy', calls: 1 });
await run('Content-length overflow fails before reading another body', { response: new Response('large', { headers: { 'content-length': '99999' } }), maxBytes: 20 }, { error: 'EXTRACTION_PROVIDER_SIZE_INVALID', dispatched: true, calls: 1 });
await run('Undeclared stream overflow is bounded', { response: new Response('oversize'), maxBytes: 3 }, { error: 'EXTRACTION_PROVIDER_SIZE_INVALID', dispatched: true, calls: 1 });
await run('Truncated content-length never becomes a usable response', { response: new Response('{}', { headers: { 'content-length': '10' } }) }, { error: 'EXTRACTION_PROVIDER_BODY_INCOMPLETE', dispatched: true, calls: 1 });
await run('Stream interruption remains unknown and does not repeat GET', { response: 'broken-body' }, { error: 'EXTRACTION_PROVIDER_TRANSPORT_FAILED', dispatched: true, calls: 1, transport: 'ECONNRESET' });
await run('Header deadline never moves to a second address', { response: 'stall-headers', timeoutMs: 20 }, { error: 'EXTRACTION_PROVIDER_DEADLINE', dispatched: true, calls: 1 });
await run('Body deadline cancels the reader without another request', { response: 'stall-body', timeoutMs: 20 }, { error: 'EXTRACTION_PROVIDER_DEADLINE', dispatched: true, calls: 1, cancelled: true });
await run('DNS deadline never dispatches provider request', { lookup: () => new Promise(() => undefined), timeoutMs: 20 }, { error: 'EXTRACTION_PROVIDER_DEADLINE', dispatched: false, calls: 0 });
const report = { passed: true, scenarios: cases.length, cases, actualHelper: true, actualUrlValidation: true, realProviderCalls: 0, realDatabaseWrites: 0 };
fs.mkdirSync('.codex-evidence/toolbox-batch-20260903', { recursive: true }); fs.writeFileSync('.codex-evidence/toolbox-batch-20260903/ppt6-single-get-fixture.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
