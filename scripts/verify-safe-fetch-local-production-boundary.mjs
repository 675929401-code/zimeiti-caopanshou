import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { safeFetch, safeFetchStream, SafeFetchError } from '../src/lib/safe-fetch.ts';
import { fetchPinnedPublicAddress, lookupFixedPublicDns, usesDevelopmentPublicDns } from '../src/lib/safe-fetch-public-dns.ts';

// Isolated process only. No DNS query, network socket, credentials or database.
const local = { NODE_ENV: 'production', LOCAL_ACCEPTANCE_PREVIEW: 'true', LOCAL_VALIDATION_DIST_DIR: '.next-local-acceptance', COZE_SUPABASE_URL: 'http://127.0.0.1:54321', SAFE_FETCH_PUBLIC_DNS: 'cloudflare-doh-v1' };
const required = ['LOCAL_ACCEPTANCE_PREVIEW', 'LOCAL_VALIDATION_DIST_DIR', 'COZE_SUPABASE_URL', 'SAFE_FETCH_PUBLIC_DNS'];
const previous = Object.fromEntries(Object.keys(local).map(key => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
const report = { at: new Date().toISOString(), actualSource: true, realNetworkRequests: 0, databaseWrites: 0, sourceSha256: Object.fromEntries(['src/lib/safe-fetch-public-dns.ts', 'src/lib/safe-fetch.ts'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])), cases: [] };
const public4 = { address: '1.1.1.1', family: 4 };
const public6 = { address: '2606:4700:4700::1111', family: 6 };
const payload = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const setEnv = environment => { for (const key of Object.keys(local)) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; } };
const assertCode = (run, code) => assert.rejects(run, error => error instanceof SafeFetchError && error.code === code);
async function test(name, run) {
  setEnv(local);
  try { await run(); report.cases.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.cases.push({ name, passed: false, errorType: error.name, message: String(error.message).slice(0, 250) }); console.log('FAIL ' + name); }
}
try {
  globalThis.fetch = () => { throw new Error('UNEXPECTED_REAL_FETCH'); };
  await test('local production requires all three exact flags plus exact local REST URL', async () => {
    for (const distDir of ['.next-local-acceptance', '.next-local-acceptance-next']) for (let mask = 0; mask < 16; mask++) {
      const environment = { NODE_ENV: 'production' };
      required.forEach((key, index) => { if (mask & (1 << index)) environment[key] = local[key]; });
      if (environment.LOCAL_VALIDATION_DIST_DIR) environment.LOCAL_VALIDATION_DIST_DIR = distDir;
      assert.equal(usesDevelopmentPublicDns(environment), mask === 15);
    }
    report.environmentCombinationsChecked = 32;
  });
  await test('false, whitespace, case and alternate flag values cannot activate production mode', async () => {
    const mutations = [
      ['LOCAL_ACCEPTANCE_PREVIEW', 'false'], ['LOCAL_ACCEPTANCE_PREVIEW', '1'], ['LOCAL_ACCEPTANCE_PREVIEW', 'TRUE'], ['LOCAL_ACCEPTANCE_PREVIEW', 'true '],
      ['LOCAL_VALIDATION_DIST_DIR', '.next'], ['LOCAL_VALIDATION_DIST_DIR', '.next-validation'], ['LOCAL_VALIDATION_DIST_DIR', './.next-local-acceptance'],
      ['SAFE_FETCH_PUBLIC_DNS', 'cloudflare'], ['SAFE_FETCH_PUBLIC_DNS', 'cloudflare-doh-v1 '], ['SAFE_FETCH_PUBLIC_DNS', ''],
    ];
    for (const [key, value] of mutations) assert.equal(usesDevelopmentPublicDns({ ...local, [key]: value }), false);
    report.invalidFlagValuesChecked = mutations.length;
  });
  await test('similar hosts, ports, paths, credentials and query URLs do not match exact local REST origin', async () => {
    const urls = ['http://localhost:54321', 'http://127.0.0.1:54322', 'https://127.0.0.1:54321', 'http://127.0.0.1:54321/', 'http://127.0.0.1:54321/rest/v1', 'http://127.0.0.1:54321?x=1', 'http://127.0.0.1:54321#fragment', ['http://', 'fixture:fixture@127.0.0.1:54321'].join(''), 'http://127.0.0.1:54321.example.invalid', 'https://remote.example.invalid'];
    for (const url of urls) assert.equal(usesDevelopmentPublicDns({ ...local, COZE_SUPABASE_URL: url }), false);
    report.invalidDatabaseUrlsChecked = urls.length;
  });
  await test('existing development opt-in remains explicit', async () => {
    assert.equal(usesDevelopmentPublicDns({ NODE_ENV: 'development', SAFE_FETCH_PUBLIC_DNS: 'cloudflare-doh-v1' }), true);
    assert.equal(usesDevelopmentPublicDns({ NODE_ENV: 'development' }), false);
    assert.equal(usesDevelopmentPublicDns({ NODE_ENV: 'development', SAFE_FETCH_PUBLIC_DNS: 'other' }), false);
  });
  await test('ordinary production cannot enter pinned public DNS mode with the DNS flag alone', async () => {
    setEnv({ NODE_ENV: 'production', SAFE_FETCH_PUBLIC_DNS: 'cloudflare-doh-v1' });
    let normalCalls = 0, pinnedCalls = 0;
    await safeFetch('https://fixture.example.invalid/image', {}, { lookup: async () => [public4], fetch: async () => { normalCalls++; return payload(); }, pinnedFetch: async () => { pinnedCalls++; throw new Error('UNEXPECTED_PIN'); } });
    assert.equal(normalCalls, 1); assert.equal(pinnedCalls, 0);
    await assertCode(() => safeFetch('https://fixture.example.invalid/image', {}, { lookup: async () => [{ address: '10.0.0.1', family: 4 }], fetch: async () => { throw new Error('UNSAFE_FETCH'); } }), 'IP_FORBIDDEN');
  });
  await test('an explicit buffered or streaming policy pins production traffic without enabling the environment globally', async () => {
    setEnv({ NODE_ENV: 'production' });
    for (const run of [safeFetch, safeFetchStream]) {
      let normalCalls = 0, pinnedCalls = 0, lookups = 0;
      const result = await run('https://fixture.example.invalid/image', { networkPolicy: 'fixed-public-dns-pinned', trustedHostnames: ['fixture.example.invalid'] }, {
        lookup: async () => { lookups++; return [public4]; },
        fetch: async () => { normalCalls++; throw new Error('UNPINNED_TRANSPORT'); },
        pinnedFetch: async (_url, address) => { pinnedCalls++; assert.deepEqual(address, public4); return payload(); },
      });
      if (result.response) await result.response.body.cancel();
      assert.equal(lookups, 1); assert.equal(normalCalls, 0); assert.equal(pinnedCalls, 1);
    }
    assert.equal(usesDevelopmentPublicDns(), false);
  });
  await test('stream explicit system DNS pins and overrides the local fixed DNS default', async () => {
    let lookups = 0, normalCalls = 0, pinnedCalls = 0;
    const result = await safeFetchStream('https://fixture.example.invalid/media', { networkPolicy: 'system-dns-pinned', trustedHostnames: ['fixture.example.invalid'] }, {
      lookup: async () => { lookups++; return [public4]; },
      fetch: async () => { normalCalls++; throw new Error('UNPINNED_TRANSPORT'); },
      pinnedFetch: async (_url, address) => { pinnedCalls++; assert.deepEqual(address, public4); return payload(); },
    });
    await result.response.body.cancel();
    assert.equal(lookups, 1); assert.equal(normalCalls, 0); assert.equal(pinnedCalls, 1);
  });
  await test('stream explicit default keeps the reviewed legacy transport and no-policy production remains unchanged', async () => {
    for (const policy of ['default', undefined]) {
      if (policy === undefined) setEnv({ NODE_ENV: 'production' });
      let normalCalls = 0, pinnedCalls = 0, lookups = 0;
      const result = await safeFetchStream('https://reviewed.example.invalid/media', { networkPolicy: policy, trustedHostnames: ['reviewed.example.invalid'] }, {
        lookup: async () => { lookups++; throw new Error('TRUSTED_LEGACY_TARGET'); },
        fetch: async () => { normalCalls++; return payload(); },
        pinnedFetch: async () => { pinnedCalls++; throw new Error('UNEXPECTED_PIN'); },
      });
      await result.response.body.cancel();
      assert.equal(normalCalls, 1); assert.equal(pinnedCalls, 0); assert.equal(lookups, 0);
    }
  });
  await test('stream pinned policies reject all mixed DNS answers and resolver failure without a fallback', async () => {
    setEnv({ NODE_ENV: 'production' });
    let dispatches = 0;
    for (const networkPolicy of ['fixed-public-dns-pinned', 'system-dns-pinned']) {
      for (const bad of [{ address: '198.18.0.1', family: 4 }, { address: '2001:2::1', family: 6 }, { address: '10.0.0.1', family: 4 }]) {
        await assertCode(() => safeFetchStream('https://fixture.example.invalid/media', { networkPolicy, trustedHostnames: ['fixture.example.invalid'] }, {
          lookup: async () => [public4, bad],
          fetch: async () => { dispatches++; throw new Error('UNSAFE_FETCH'); },
          pinnedFetch: async () => { dispatches++; throw new Error('UNSAFE_PIN'); },
        }), 'IP_FORBIDDEN');
      }
      await assertCode(() => safeFetchStream('https://fixture.example.invalid/media', { networkPolicy }, {
        lookup: async () => { throw new Error('resolver unavailable'); },
        fetch: async () => { dispatches++; throw new Error('NO_FALLBACK'); },
        pinnedFetch: async () => { dispatches++; throw new Error('NO_FALLBACK'); },
      }), 'DNS_LOOKUP_FAILED');
    }
    assert.equal(dispatches, 0);
  });
  await test('stream fixed policy scopes authorization to one origin and never follows redirects', async () => {
    setEnv({ NODE_ENV: 'production' });
    for (const origin of ['https://fixture.example.invalid', 'https://other.example.invalid', 'not-a-url']) {
      let calls = 0;
      const result = await safeFetchStream('https://fixture.example.invalid/models', {
        networkPolicy: 'fixed-public-dns-pinned',
        headers: { authorization: 'must-strip', cookie: 'must-strip', 'x-api-key': 'must-strip' },
        authorization: { origin, value: 'Bearer scoped-synthetic-only' },
      }, {
        lookup: async () => [public4],
        fetch: async () => { throw new Error('UNPINNED_TRANSPORT'); },
        pinnedFetch: async (_url, _address, init) => {
          calls++; const headers = new Headers(init.headers);
          assert.equal(headers.get('authorization'), origin === 'https://fixture.example.invalid' ? 'Bearer scoped-synthetic-only' : null);
          assert.equal(headers.has('cookie'), false); assert.equal(headers.has('x-api-key'), false); assert.equal(init.redirect, 'manual');
          return new Response(null, { status: 302, headers: { location: 'https://other.example.invalid/models' } });
        },
      });
      assert.equal(result.response.status, 302); assert.equal(calls, 1);
    }
  });
  await test('system DNS can be validated once and pinned without depending on the fixed DoH resolver', async () => {
    setEnv({ NODE_ENV: 'production' });
    let lookups = 0, normalCalls = 0, pinnedCalls = 0;
    await safeFetch('https://fixture.example.invalid/image', { networkPolicy: 'system-dns-pinned', trustedHostnames: ['fixture.example.invalid'] }, {
      lookup: async hostname => { lookups++; assert.equal(hostname, 'fixture.example.invalid'); return [public4]; },
      fetch: async () => { normalCalls++; throw new Error('UNPINNED_TRANSPORT'); },
      pinnedFetch: async (_url, address) => { pinnedCalls++; assert.deepEqual(address, public4); return payload(); },
    });
    assert.equal(lookups, 1); assert.equal(normalCalls, 0); assert.equal(pinnedCalls, 1);
  });
  await test('explicit system DNS overrides the local production fixed DoH default', async () => {
    let systemLookups = 0, pinnedCalls = 0;
    await safeFetch('https://fixture.example.invalid/video.mp4', { networkPolicy: 'system-dns-pinned' }, {
      lookup: async hostname => { systemLookups++; assert.equal(hostname, 'fixture.example.invalid'); return [public4]; },
      pinnedFetch: async (_url, address) => { pinnedCalls++; assert.deepEqual(address, public4); return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'content-type': 'video/mp4' } }); },
    });
    assert.equal(systemLookups, 1); assert.equal(pinnedCalls, 1);
  });
  await test('explicit default policy preserves one reviewed hostname under synthetic local DNS', async () => {
    let nativeCalls = 0, fixedCalls = 0;
    await safeFetch('https://reviewed.example.invalid/video.mp4', { networkPolicy: 'default', trustedHostnames: ['reviewed.example.invalid'] }, {
      lookup: async () => { fixedCalls++; throw new Error('FIXED_DNS_MUST_NOT_RUN'); },
      fetch: async () => { nativeCalls++; return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'content-type': 'video/mp4' } }); },
      pinnedFetch: async () => { fixedCalls++; throw new Error('PINNED_TRANSPORT_MUST_NOT_RUN'); },
    });
    assert.equal(nativeCalls, 1); assert.equal(fixedCalls, 0);
  });
  await test('local production buffered and streaming GETs pin public IP and preserve Host, TLS SNI and certificate checks', async () => {
    const requests = [];
    const url = new URL('https://fixture.example.invalid/media?signature=fixture-only');
    const deps = {
      lookup: async () => [public4],
      fetch: async () => { throw new Error('UNPINNED_TRANSPORT'); },
      pinnedFetch: (target, address, init) => fetchPinnedPublicAddress(target, address, init, { request(options, callback) {
        requests.push(options);
        const req = new EventEmitter();
        req.end = () => { const incoming = new PassThrough(); incoming.rawHeaders = ['content-type', 'image/png']; incoming.statusCode = 200; callback(incoming); incoming.end(Buffer.from([1, 2, 3])); };
        return req;
      } }),
    };
    const options = { headers: { Host: 'wrong.example.invalid', Authorization: 'fixture-only', Cookie: 'fixture-only' } };
    assert.deepEqual([...(await safeFetch(url, options, deps)).buffer], [1, 2, 3]);
    const stream = await safeFetchStream(url, options, deps); assert.deepEqual([...new Uint8Array(await stream.response.arrayBuffer())], [1, 2, 3]);
    setEnv({ NODE_ENV: 'production' });
    const explicitStream = await safeFetchStream(url, { ...options, networkPolicy: 'fixed-public-dns-pinned' }, deps);
    assert.deepEqual([...new Uint8Array(await explicitStream.response.arrayBuffer())], [1, 2, 3]);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.hostname, public4.address); assert.equal(request.family, 4); assert.equal(request.port, 443);
      assert.equal(request.headers.host, url.host); assert.equal(request.servername, url.hostname); assert.equal(request.path, url.pathname + url.search);
      assert.equal(request.rejectUnauthorized, true); assert.equal(request.agent.options.rejectUnauthorized, true);
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
      request.lookup('unexpected-system-lookup', {}, error => assert.equal(error.message, 'PINNED_DNS_LOOKUP_FORBIDDEN'));
    }
  });
  await test('mixed public plus private or fake-IP DNS answers are rejected before any connect despite legacy hostname trust', async () => {
    let connections = 0;
    const blocked = [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }, { address: '198.18.0.167', family: 4 }, { address: 'fdfe:dcba:9876::90', family: 6 }, { address: '::ffff:198.18.0.167', family: 6 }];
    for (const privateAddress of blocked) {
      for (const run of [safeFetch, safeFetchStream]) {
        await assertCode(() => run('https://fixture.example.invalid/media', { trustedHostnames: ['fixture.example.invalid'] }, {
          lookup: async () => [public4, public6, privateAddress], pinnedFetch: async () => { connections++; return payload(); }, fetch: async () => { connections++; return payload(); },
        }), 'IP_FORBIDDEN');
      }
    }
    assert.equal(connections, 0); report.mixedUnsafeCasesChecked = blocked.length * 2;
  });
  await test('local production redirect rechecks destination DNS before connecting', async () => {
    let connections = 0;
    await assertCode(() => safeFetch('https://first.example.invalid/media', {}, {
      lookup: async host => host.startsWith('first.') ? [public4] : [public4, { address: '127.0.0.1', family: 4 }],
      pinnedFetch: async () => { connections++; return new Response(null, { status: 302, headers: { location: 'https://second.example.invalid/media' } }); },
    }), 'IP_FORBIDDEN');
    assert.equal(connections, 1);
  });
  await test('fixed public resolver still targets Cloudflare through its pinned IP and validates DNS questions', async () => {
    const dnsCalls = [];
    const addresses = await lookupFixedPublicDns('fixture.example.invalid', { fetchPinned: async (url, address, init) => {
      dnsCalls.push(url.searchParams.get('type')); assert.equal(url.origin, 'https://cloudflare-dns.com'); assert.deepEqual(address, public4); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      const type = url.searchParams.get('type') === 'A' ? 1 : 28;
      return Response.json({ Status: 0, TC: false, CD: false, Question: [{ name: 'fixture.example.invalid.', type }], Answer: [{ type, data: type === 1 ? public4.address : public6.address }] });
    } });
    assert.deepEqual(dnsCalls, ['A', 'AAAA']); assert.deepEqual(addresses, [public4, public6]);
  });
} finally {
  setEnv(previous); globalThis.fetch = previousFetch;
}
report.passed = report.cases.every(item => item.passed); report.passedCount = report.cases.filter(item => item.passed).length; report.failedCount = report.cases.length - report.passedCount;
const output = process.argv[2];
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
console.log(JSON.stringify({ passed: report.passed, passedCount: report.passedCount, failedCount: report.failedCount, realNetworkRequests: 0, databaseWrites: 0 }));
if (!report.passed) process.exitCode = 1;
