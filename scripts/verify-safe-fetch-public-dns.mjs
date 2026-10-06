import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { isBlockedIpAddress, safeFetch, SafeFetchError, validateSafeUrl } from '../src/lib/safe-fetch.ts';
import { fetchPinnedPublicAddress, lookupFixedPublicDns, usesDevelopmentPublicDns } from '../src/lib/safe-fetch-public-dns.ts';

const public4 = { address: '209.145.63.211', family: 4 };
const public6 = { address: '2606:4700:10::6814:179a', family: 6 };
const bytes = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const oldMode = process.env.NODE_ENV;
const oldFlag = process.env.SAFE_FETCH_PUBLIC_DNS;
const assertCode = (operation, code) => assert.rejects(operation, (error) => error instanceof SafeFetchError && error.code === code);
try {
  assert.equal(usesDevelopmentPublicDns({ NODE_ENV: 'production', SAFE_FETCH_PUBLIC_DNS: 'cloudflare-doh-v1' }), false);
  assert.equal(usesDevelopmentPublicDns({ NODE_ENV: 'development' }), false);
  assert.equal(usesDevelopmentPublicDns({ NODE_ENV: 'development', SAFE_FETCH_PUBLIC_DNS: 'other' }), false);
  process.env.NODE_ENV = 'development'; process.env.SAFE_FETCH_PUBLIC_DNS = 'cloudflare-doh-v1';
  let calls = 0;
  const result = await safeFetch('https://fixture.example.invalid/image.png', { headers: { authorization: 'synthetic-secret', cookie: 'synthetic-cookie' } }, {
    lookup: async () => [public4, public6],
    fetch: async () => { throw new Error('public mode must not use unpinned global fetch'); },
    pinnedFetch: async (url, address, init) => {
      calls++; assert.equal(url.hostname, 'fixture.example.invalid'); assert.deepEqual(address, public4);
      assert.equal(new Headers(init.headers).has('authorization'), false); assert.equal(new Headers(init.headers).has('cookie'), false);
      assert.equal(init.redirect, 'manual'); return bytes();
    },
  });
  assert.equal(calls, 1); assert.deepEqual([...result.buffer], [1, 2, 3]);

  for (const blocked of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '198.18.0.167', 'fdfe:dcba:9876::90', '::ffff:198.18.0.167']) {
    assert.equal(isBlockedIpAddress(blocked), true);
    const address = { address: blocked, family: blocked.includes(':') ? 6 : 4 };
    await assertCode(() => safeFetch('https://fixture.example.invalid/image.png', { trustedHostnames: ['fixture.example.invalid'] }, {
      lookup: async () => [public4, address], pinnedFetch: async () => { throw new Error('mixed unsafe answers must stop before connect'); },
    }), 'IP_FORBIDDEN');
  }
  await assertCode(() => safeFetch('http://198.18.0.167/image.png'), 'IP_FORBIDDEN');
  await assertCode(() => validateSafeUrl('https://fixture.example.invalid/image', {}, { lookup: async () => [{ address: '198.18.0.167', family: 4 }] }), 'IP_FORBIDDEN');
  const hopHosts = []; const pins = [];
  const redirects = await safeFetch('https://first.example.invalid/start', {}, {
    lookup: async (host) => { hopHosts.push(host); return [host.startsWith('first') ? public4 : public6]; },
    pinnedFetch: async (url, address) => { pins.push(address.address); return url.hostname.startsWith('first') ? new Response(null, { status: 302, headers: { location: 'https://second.example.invalid/image.png' } }) : bytes(); },
  });
  assert.deepEqual(hopHosts, ['first.example.invalid', 'second.example.invalid']);
  assert.deepEqual(pins, [public4.address, public6.address]); assert.equal(redirects.url, 'https://second.example.invalid/image.png');
  let firstHopCalls = 0;
  await assertCode(() => safeFetch('https://first.example.invalid/start', {}, {
    lookup: async (host) => host.startsWith('first') ? [public4] : [{ address: '127.0.0.1', family: 4 }],
    pinnedFetch: async () => { firstHopCalls++; return new Response(null, { status: 302, headers: { location: 'https://second.example.invalid/private' } }); },
  }), 'IP_FORBIDDEN');
  assert.equal(firstHopCalls, 1);
  await assertCode(() => safeFetch('https://fixture.example.invalid/large', { maxBytes: 1 }, { lookup: async () => [public4], pinnedFetch: async () => bytes() }), 'RESPONSE_TOO_LARGE');
  const controller = new AbortController(); controller.abort();
  await assertCode(() => safeFetch('https://fixture.example.invalid/image', { signal: controller.signal }, { lookup: async () => { throw new Error('aborted request must not resolve'); } }), 'FETCH_ABORTED');

  // Exercise actual native transport construction with a fake socket only.
  let requestOptions;
  const incoming = new PassThrough(); incoming.rawHeaders = ['content-type', 'image/png']; incoming.statusCode = 200;
  const response = await fetchPinnedPublicAddress(new URL('https://fixture.example.invalid/a?x=1'), public4, {}, {
    request: (options, callback) => {
      requestOptions = options;
      const request = new EventEmitter();
      request.end = () => { callback(incoming); incoming.end(Buffer.from([8, 9])); };
      return request;
    },
  });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [8, 9]);
  assert.equal(requestOptions.hostname, public4.address); assert.equal(requestOptions.family, 4);
  assert.equal(requestOptions.headers.host, 'fixture.example.invalid'); assert.equal(requestOptions.servername, 'fixture.example.invalid');
  assert.equal(requestOptions.rejectUnauthorized, true); assert.equal(requestOptions.agent.options.rejectUnauthorized, true);
  assert.equal(requestOptions.path, '/a?x=1'); assert.equal(requestOptions.method, 'GET');
  requestOptions.lookup('unexpected', {}, (error) => assert.match(error.message, /PINNED_DNS_LOOKUP_FORBIDDEN/u));

  const queries = [];
  const dnsBody = (url, patch = {}) => ({ Status: 0, TC: false, CD: false, Question: [{ name: `${url.searchParams.get('name')}.`, type: url.searchParams.get('type') === 'A' ? 1 : 28 }], Answer: [{ type: url.searchParams.get('type') === 'A' ? 1 : 28, data: url.searchParams.get('type') === 'A' ? public4.address : public6.address }], ...patch });
  const resolved = await lookupFixedPublicDns('fixture.example.invalid', {
    fetchPinned: async (url, address, init) => {
      queries.push(url.searchParams.get('type'));
      assert.equal(url.origin, 'https://cloudflare-dns.com'); assert.deepEqual(address, { address: '1.1.1.1', family: 4 });
      assert.equal(init.redirect, 'manual'); assert.equal(new Headers(init.headers).get('accept'), 'application/dns-json');
      return Response.json(dnsBody(url));
    },
  });
  assert.deepEqual(queries, ['A', 'AAAA']); assert.deepEqual(resolved, [public4, public6]);
  for (const patch of [{ Status: 2 }, { TC: true }, { CD: true }, { Question: [] }, { Answer: [{ type: 1, data: 'not-an-ip' }] }]) {
    await assert.rejects(() => lookupFixedPublicDns('fixture.example.invalid', { fetchPinned: async (url) => Response.json(dnsBody(url, patch)) }));
  }
  await assert.rejects(() => lookupFixedPublicDns('fixture.example.invalid', { fetchPinned: async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/dns-json' } }) }), /PUBLIC_DNS_RESPONSE_TOO_LARGE/u);
  await assertCode(() => safeFetch('https://fixture.example.invalid/image', {}, { lookup: async () => { throw new Error('resolver offline'); }, pinnedFetch: async () => { throw new Error('never fall back to transport'); } }), 'DNS_LOOKUP_FAILED');

  // An enabled-looking flag has no effect in production, including legacy trust.
  process.env.NODE_ENV = 'production';
  let normalFetchCalls = 0;
  await safeFetch('https://trusted.example.invalid/image', { trustedHostnames: ['trusted.example.invalid'] }, {
    lookup: async () => { throw new Error('legacy trusted production mode remains unchanged'); },
    fetch: async () => { normalFetchCalls++; return bytes(); }, pinnedFetch: async () => { throw new Error('production cannot enter local mode'); },
  });
  assert.equal(normalFetchCalls, 1);
  const explicitHosts = []; const explicitPins = [];
  await safeFetch('https://temporary-video.example.invalid/video.mp4', { networkPolicy: 'fixed-public-dns-pinned', allowedContentTypes: ['image/png'] }, {
    lookup: async host => { explicitHosts.push(host); return host.startsWith('temporary-video.') ? [public4] : [public6]; },
    fetch: async () => { throw new Error('explicit pinned policy must not use global fetch'); },
    pinnedFetch: async (url, address) => {
      explicitPins.push(address.address);
      return url.hostname.startsWith('temporary-video.')
        ? new Response(null, { status: 302, headers: { location: 'https://temporary-cdn.example.invalid/video.mp4' } })
        : bytes();
    },
  });
  assert.deepEqual(explicitHosts, ['temporary-video.example.invalid', 'temporary-cdn.example.invalid']);
  assert.deepEqual(explicitPins, [public4.address, public6.address]);
  const report = { passed: true, dynamicGroups: 10, privateAndSyntheticAddressesBlocked: 6, publicAddressesPinned: true, originalHostAndSniPreserved: true, redirectDnsRechecked: true, productionFlagIgnored: true, explicitProductionCallPinned: true, realProviderRequests: 0 };
  const reportPath = process.argv.find(value => value.startsWith('--report='))?.slice(9);
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(report));
} finally {
  if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode;
  if (oldFlag === undefined) delete process.env.SAFE_FETCH_PUBLIC_DNS; else process.env.SAFE_FETCH_PUBLIC_DNS = oldFlag;
}
