import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { safeFetch, safeFetchStream, safeFetchJsonPost } from '../src/lib/safe-fetch.ts';
import { fetchPinnedPublicAddress, PinnedRequestError } from '../src/lib/safe-fetch-public-dns.ts';

const previous = { mode: process.env.NODE_ENV, dns: process.env.SAFE_FETCH_PUBLIC_DNS };
const url = new URL('https://fixture.example.invalid/media?signature=synthetic-secret');
const addresses = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222'].map(address => ({ address, family: 4 }));
let cases = 0;
async function scenario(work) { await work(); cases += 1; }
const response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });
const connectionError = (code = 'ECONNRESET') => new PinnedRequestError('PINNED_REQUEST_FAILED', true, code);
try {
  process.env.NODE_ENV = 'development'; process.env.SAFE_FETCH_PUBLIC_DNS = 'cloudflare-doh-v1';
  await scenario(async () => {
    const requests = []; let lookups = 0;
    const result = await safeFetch(url, { headers: { Range: 'bytes=0-2', Authorization: 'synthetic-secret' } }, {
      lookup: async () => { lookups++; return addresses; },
      pinnedFetch: (target, address, init) => fetchPinnedPublicAddress(target, address, init, {
        request: (options, callback) => {
          requests.push(options);
          const req = new EventEmitter(); req.end = () => {
            if (requests.length === 1) { req.emit('error', Object.assign(new Error('private socket details'), { code: 'ECONNRESET' })); return; }
            const incoming = new PassThrough(); incoming.statusCode = 206; incoming.rawHeaders = ['content-type', 'video/mp4'];
            callback(incoming); incoming.end(new Uint8Array([1, 2, 3]));
          }; return req;
        },
      }),
      fetch: () => { throw new Error('Unpinned transport forbidden'); },
    });
    assert.equal(lookups, 1); assert.deepEqual(requests.map(x => x.hostname), ['1.1.1.1', '8.8.8.8']); assert.equal(result.status, 206);
    for (const req of requests) { assert.equal(req.servername, url.hostname); assert.equal(req.headers.host, url.host); assert.equal(req.rejectUnauthorized, true); assert.equal(req.headers.range, 'bytes=0-2'); assert.equal(req.headers.authorization, undefined); }
  });
  await scenario(async () => {
    const calls = []; const started = Date.now();
    const result = await safeFetchStream(url, { timeoutMs: 12000 }, { lookup: async () => addresses,
      pinnedFetch: async (_target, address, init) => {
        calls.push(address.address);
        if (calls.length > 1) return response();
        await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(connectionError('ABORT_ERR')), { once: true }));
        throw new Error('unreachable');
      } });
    assert.equal(calls.length, 2); assert.ok(Date.now() - started >= 4900); assert.ok(Date.now() - started < 8000); await result.response.body.cancel();
  });
  await scenario(async () => {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(() => safeFetchStream(url, { signal: controller.signal }, { lookup: async () => addresses,
      pinnedFetch: async () => { calls++; controller.abort(); throw connectionError(); } }), error => error.code === 'FETCH_ABORTED');
    assert.equal(calls, 1);
  });
  await scenario(async () => {
    let calls = 0;
    await assert.rejects(() => safeFetchStream(url, { timeoutMs: 1000 }, { lookup: async () => addresses,
      pinnedFetch: async (_url, _address, init) => {
        calls++; await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(connectionError('ABORT_ERR')), { once: true }));
      } }), error => error.code === 'FETCH_ABORTED');
    assert.equal(calls, 1);
  });
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', undefined]) {
    await scenario(async () => {
      let calls = 0;
      await assert.rejects(() => safeFetchStream(url, {}, { lookup: async () => addresses,
        pinnedFetch: async () => { calls++; throw new PinnedRequestError('PINNED_REQUEST_FAILED', true, code); } }), error => error.code === 'FETCH_FAILED');
      assert.equal(calls, 1);
    });
  }
  await scenario(async () => {
    let calls = 0;
    await assert.rejects(() => safeFetch(url, {}, { lookup: async () => addresses,
      pinnedFetch: async () => { calls++; throw connectionError('ECONNREFUSED'); } }), error => error.code === 'FETCH_FAILED');
    assert.equal(calls, 3);
  });
  await scenario(async () => {
    let calls = 0;
    await assert.rejects(() => safeFetchStream(url, {}, { lookup: async () => [...addresses, { address: '198.18.0.1', family: 4 }],
      pinnedFetch: async () => { calls++; return response(); } }), error => error.code === 'IP_FORBIDDEN');
    assert.equal(calls, 0);
  });
  for (const status of [302, 403, 500]) {
    await scenario(async () => {
      let calls = 0;
      const result = await safeFetchStream(url, {}, { lookup: async () => addresses,
        pinnedFetch: async () => { calls++; return new Response(null, { status }); } });
      assert.equal(calls, 1); assert.equal(result.response.status, status);
    });
  }
  await scenario(async () => {
    let calls = 0;
    await assert.rejects(() => safeFetch(url, {}, { lookup: async () => addresses,
      pinnedFetch: async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.error(connectionError()); } })); } }), error => error.code === 'FETCH_FAILED');
    assert.equal(calls, 1);
  });
  await scenario(async () => {
    let calls = 0;
    await assert.rejects(() => safeFetchJsonPost(url, '{}', {}, { lookup: async () => addresses,
      pinnedFetch: async (_target, _address, init) => { calls++; assert.equal(init.method, 'POST'); throw connectionError(); } }), error => error.code === 'FETCH_FAILED' && error.requestDispatched === true);
    assert.equal(calls, 1);
  });
  await scenario(async () => {
    let reads = 0;
    const result = await safeFetchStream(url, { authorization: { origin: url.origin, value: 'Bearer scoped-synthetic-secret' } }, {
      lookup: async () => [addresses[0], addresses[0], addresses[1]],
      pinnedFetch: async (_target, address, init) => { reads++; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer scoped-synthetic-secret'); if (reads === 1) throw connectionError('EHOSTUNREACH'); assert.equal(address.address, addresses[1].address); return response(); },
    }); assert.equal(reads, 2); await result.response.body.cancel();
  });
  const report = { passed: true, cases, actualNativeTransportAndSharedFunctions: true, realNetworkRequests: 0, generationRequests: 0, connectionTimeoutFallback: true, noPostReplay: true, noTlsBypass: true, noHttpOrBodyRetry: true, allDnsAnswersCheckedBeforeDispatch: true };
  const reportPath = process.argv.find(value => value.startsWith('--report='))?.slice(9);
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
} finally {
  if (previous.mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.mode;
  if (previous.dns === undefined) delete process.env.SAFE_FETCH_PUBLIC_DNS; else process.env.SAFE_FETCH_PUBLIC_DNS = previous.dns;
}
