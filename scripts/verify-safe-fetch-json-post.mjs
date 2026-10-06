import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { safeFetchJsonPost, SafeFetchError } from '../src/lib/safe-fetch.ts';
import { fetchPinnedPublicAddress, PINNED_MAX_REQUEST_BYTES } from '../src/lib/safe-fetch-public-dns.ts';

const url = 'https://fixture.example.invalid/v1/chat/completions';
const public4 = { address: '209.145.63.211', family: 4 };
const public6 = { address: '2606:4700:10::6814:179a', family: 6 };
const originalMode = process.env.NODE_ENV;
const originalDns = process.env.SAFE_FETCH_PUBLIC_DNS;
const json = () => Response.json({ ok: true });
let cases = 0;
async function rejected(operation, code, dispatched, upstreamStatus) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof SafeFetchError);
    assert.equal(error.code, code); assert.equal(error.requestDispatched, dispatched);
    if (upstreamStatus !== undefined) assert.equal(error.upstreamStatus, upstreamStatus);
    assert.ok(!error.message.includes('fixture-secret'));
    return true;
  });
  cases += 1;
}
function nativeFixture({ status = 200, body = '{"ok":true}' } = {}) {
  const observed = [];
  return { observed, request: (options, callback) => {
    const req = new EventEmitter();
    req.end = (bytes) => {
      observed.push({ options, bytes });
      const incoming = new PassThrough(); incoming.rawHeaders = ['content-type', 'application/json']; incoming.statusCode = status;
      callback(incoming); incoming.end(body);
    };
    return req;
  } };
}
try {
  process.env.NODE_ENV = 'production'; process.env.SAFE_FETCH_PUBLIC_DNS = 'cloudflare-doh-v1';
  for (const body of [' { "message": "原样传送 😀" }\n', new TextEncoder().encode('{"message":"字节原样"}')]) {
    let lookups = 0;
    const fixture = nativeFixture();
    const result = await safeFetchJsonPost(url, body, {
      headers: { authorization: 'stale-fixture-secret', cookie: 'fixture-secret', 'x-api-key': 'fixture-secret',
        'proxy-authorization': 'fixture-secret', host: 'evil.invalid', 'content-length': '1', 'transfer-encoding': 'chunked' },
      authorization: { origin: 'https://fixture.example.invalid', value: 'Bearer scoped-fixture-secret' },
      // Runtime callers cannot reintroduce the legacy production DNS bypass.
      trustedHostnames: ['fixture.example.invalid'],
    }, { lookup: async () => { lookups += 1; return [public4, public6]; },
      pinnedFetch: (target, address, init) => fetchPinnedPublicAddress(target, address, init, { request: fixture.request }) });
    assert.deepEqual(result.json, { ok: true }); assert.equal(result.status, 200); assert.equal(lookups, 1);
    assert.equal(fixture.observed.length, 1);
    const { options, bytes } = fixture.observed[0];
    assert.equal(options.method, 'POST'); assert.equal(options.hostname, public4.address); assert.equal(options.servername, 'fixture.example.invalid');
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent.options.rejectUnauthorized, true);
    assert.equal(options.path, '/v1/chat/completions'); assert.equal(options.headers.host, 'fixture.example.invalid');
    assert.deepEqual(bytes, typeof body === 'string' ? Buffer.from(body) : Buffer.from(body));
    assert.equal(options.headers['content-length'], String(bytes.byteLength)); assert.equal(options.headers['transfer-encoding'], undefined);
    assert.equal(options.headers.authorization, 'Bearer scoped-fixture-secret');
    for (const name of ['cookie', 'proxy-authorization', 'x-api-key']) assert.equal(options.headers[name], undefined);
    options.lookup('unused.invalid', {}, (error) => assert.equal(error.message, 'PINNED_DNS_LOOKUP_FORBIDDEN'));
    cases += 1;
  }
  // Direct native POST supports exactly the two body forms and counts UTF-8 bytes.
  const transport = nativeFixture();
  const nativeResponse = await fetchPinnedPublicAddress(new URL(url), public4, { method: 'POST', body: '中文' }, { request: transport.request });
  await nativeResponse.arrayBuffer(); assert.equal(transport.observed[0].options.headers['content-length'], '6');
  assert.deepEqual(transport.observed[0].bytes, Buffer.from('中文')); cases += 1;

  let posts = 0;
  const deps = { lookup: async () => [public4], pinnedFetch: async () => { posts += 1; return json(); } };
  for (const scope of ['https://other.example.invalid', 'https://fixture.example.invalid:8443', 'http://fixture.example.invalid', ['https://', 'user:password@fixture.example.invalid'].join(''), 'invalid']) {
    await safeFetchJsonPost(url, '{}', { headers: { authorization: 'fixture-secret' }, authorization: { origin: scope, value: 'fixture-secret' } }, {
      ...deps, pinnedFetch: async (_url, _pin, init) => { assert.equal(new Headers(init.headers).has('authorization'), false); return json(); },
    }); cases += 1;
  }
  for (const [status, code] of [[403, 'UPSTREAM_STATUS'], [302, 'REDIRECT_FORBIDDEN'], [307, 'REDIRECT_FORBIDDEN'], [308, 'REDIRECT_FORBIDDEN']]) {
    posts = 0;
    await rejected(() => safeFetchJsonPost(url, '{}', { authorization: { origin: new URL(url).origin, value: 'fixture-secret' } }, {
      ...deps, pinnedFetch: async (_url, _pin, init) => { posts += 1; assert.equal(init.redirect, 'manual'); return new Response('fixture-secret', { status, headers: { location: 'https://evil.example.invalid/steal' } }); },
    }), code, true, status); assert.equal(posts, 1);
  }
  for (const mode of ['development', 'production']) {
    process.env.NODE_ENV = mode;
    for (const address of ['127.0.0.1', '169.254.169.254', '198.18.0.167', 'fdfe:dcba:9876::90']) {
      posts = 0;
      await rejected(() => safeFetchJsonPost(url, '{}', { trustedHostnames: ['fixture.example.invalid'] }, {
        ...deps, lookup: async () => [public4, { address, family: address.includes(':') ? 6 : 4 }],
      }), 'IP_FORBIDDEN', false); assert.equal(posts, 0);
    }
  }
  for (const [target, code] of [[['https://', 'user:password@fixture.example.invalid/a'].join(''), 'URL_CREDENTIALS_FORBIDDEN'], ['http://fixture.example.invalid/a', 'HTTPS_REQUIRED'], ['https://fixture.example.invalid:8443/a', 'PORT_FORBIDDEN'], ['https://127.0.0.1/a', 'IP_FORBIDDEN']]) {
    posts = 0; let lookups = 0;
    await rejected(() => safeFetchJsonPost(target, '{}', {}, { ...deps, lookup: async () => { lookups++; return [public4]; } }), code, false);
    assert.equal(posts, 0); assert.equal(lookups, 0);
  }
  await rejected(() => safeFetchJsonPost(url, '{}', {}, { ...deps, lookup: async () => [{ address: public4.address, family: 6 }] }), 'IP_FORBIDDEN', false);
  await rejected(() => safeFetchJsonPost(url, '{}', {}, { ...deps, lookup: async () => { throw new Error('fixture-secret'); } }), 'DNS_LOOKUP_FAILED', false);
  for (const body of ['not-json', new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]), { a: 1 }]) {
    await rejected(() => safeFetchJsonPost(url, body, {}, deps), 'INVALID_JSON_BODY', false);
  }
  await rejected(() => safeFetchJsonPost(url, '{"中":1}', { maxRequestBytes: 8 }, deps), 'REQUEST_TOO_LARGE', false);
  await rejected(() => safeFetchJsonPost(url, '{}', { maxRequestBytes: PINNED_MAX_REQUEST_BYTES + 1 }, deps), 'INVALID_FETCH_LIMITS', false);
  await assert.rejects(() => fetchPinnedPublicAddress(new URL(url), public4, { method: 'POST', body: 'x'.repeat(PINNED_MAX_REQUEST_BYTES + 1) }), (e) => e.requestDispatched === false && e.message === 'PINNED_REQUEST_TOO_LARGE'); cases += 1;
  for (const init of [{ method: 'PUT', body: '{}' }, { method: 'GET', body: '{}' }, { method: 'POST', body: new URLSearchParams('a=1') }]) {
    await assert.rejects(() => fetchPinnedPublicAddress(new URL(url), public4, init), (e) => e.requestDispatched === false); cases += 1;
  }
  const mutable = new TextEncoder().encode('{"a":1}');
  await safeFetchJsonPost(url, mutable, {}, { lookup: async () => { mutable.fill(120); return [public4]; }, pinnedFetch: async (_url, _pin, init) => { assert.equal(Buffer.from(init.body).toString(), '{"a":1}'); return json(); } }); cases += 1;

  for (const [response, options, code] of [
    [new Response('{}', { headers: { 'content-type': 'text/html' } }), {}, 'CONTENT_TYPE_FORBIDDEN'],
    [new Response('broken', { headers: { 'content-type': 'application/json' } }), {}, 'INVALID_JSON_RESPONSE'],
    [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '100' } }), { maxBytes: 10 }, 'RESPONSE_TOO_LARGE'],
    [new Response('{"large":true}', { headers: { 'content-type': 'application/json' } }), { maxBytes: 5 }, 'RESPONSE_TOO_LARGE'],
    [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': 'invalid' } }), {}, 'INVALID_CONTENT_LENGTH'],
  ]) await rejected(() => safeFetchJsonPost(url, '{}', options, { ...deps, pinnedFetch: async () => response }), code, true);
  assert.deepEqual((await safeFetchJsonPost(url, '{}', {}, { ...deps, pinnedFetch: async () => new Response('{}', { headers: { 'content-type': 'application/problem+json; charset=utf-8' } }) })).json, {}); cases += 1;
  posts = 0;
  await rejected(() => safeFetchJsonPost(url, '{}', {}, { ...deps, pinnedFetch: async () => { posts++; throw new Error('fixture-secret'); } }), 'FETCH_FAILED', true); assert.equal(posts, 1);
  await rejected(() => safeFetchJsonPost(url, '{}', {}, { ...deps, pinnedFetch: (target, address, init) => fetchPinnedPublicAddress(target, address, init, { request: () => { throw new Error('fixture-secret'); } }) }), 'FETCH_FAILED', false);
  for (const onEnd of ['throw', 'error']) {
    posts = 0;
    await rejected(() => safeFetchJsonPost(url, '{}', {}, { ...deps, pinnedFetch: (target, address, init) => fetchPinnedPublicAddress(target, address, init, {
      request: () => { const req = new EventEmitter(); req.end = () => { posts++; if (onEnd === 'throw') throw new Error('fixture-secret'); else req.emit('error', new Error('fixture-secret')); }; return req; },
    }) }), 'FETCH_FAILED', true); assert.equal(posts, 1);
  }
  await rejected(() => safeFetchJsonPost(url, '{}', {}, { ...deps, pinnedFetch: (target, address, init) => fetchPinnedPublicAddress(target, address, init, {
    request: (_options, callback) => {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const incoming = new PassThrough(); incoming.rawHeaders = ['content-type', 'application/json\nfixture-secret']; incoming.statusCode = 200;
        callback(incoming); incoming.end('{}');
      });
      return req;
    },
  }) }), 'FETCH_FAILED', true);
  const aborted = new AbortController(); aborted.abort();
  await rejected(() => safeFetchJsonPost(url, '{}', { signal: aborted.signal }, { lookup: async () => { throw new Error('must not resolve'); } }), 'FETCH_ABORTED', false);
  await rejected(() => safeFetchJsonPost(url, '{}', { timeoutMs: 15 }, { ...deps, lookup: () => new Promise(() => {}) }), 'FETCH_ABORTED', false);
  posts = 0;
  await rejected(() => safeFetchJsonPost(url, '{}', { timeoutMs: 15 }, { ...deps, pinnedFetch: () => { posts++; return new Promise(() => {}); } }), 'FETCH_ABORTED', true); assert.equal(posts, 1);
  let cancelled = false;
  await rejected(() => safeFetchJsonPost(url, '{}', { timeoutMs: 15 }, { ...deps, pinnedFetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) }), 'FETCH_ABORTED', true);
  assert.equal(cancelled, true);

  const report = { passed: true, cases, actualJsonPostHelper: true, actualPinnedHttpTransport: true,
    productionAndDevelopmentPinned: true, requestDispatchClassification: true, bodyBytesPreserved: true,
    noRedirectsOrRetries: true, boundedRequestAndResponse: true, scopedCredentials: true, realProviderRequests: 0 };
  mkdirSync('.codex-evidence/safe-json-post-20260902', { recursive: true });
  writeFileSync('.codex-evidence/safe-json-post-20260902/fixture.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  if (originalDns === undefined) delete process.env.SAFE_FETCH_PUBLIC_DNS; else process.env.SAFE_FETCH_PUBLIC_DNS = originalDns;
}
