import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { safeFetchStream, SafeFetchError } from '../src/lib/safe-fetch.ts';
import { safeMediaFetch } from '../src/lib/safe-media-fetch.ts';

const publicIp = { address: '209.145.63.211', family: 4 };
const asset = 'https://v5-coldm.douyinvod.com/synthetic-fixture.mp4';
const media = (contentType = 'video/mp4') => new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { 'content-type': contentType, 'content-range': 'bytes 0-3/8', 'accept-ranges': 'bytes', 'content-length': '4' } });
const redirect = (target) => new Response(null, { status: 302, headers: { location: target } });
const originalMode = process.env.NODE_ENV;
const originalDns = process.env.SAFE_FETCH_PUBLIC_DNS;
const filename = 'src/app/api/extract/download/route.ts';
const tree = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const actualSource = tree.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(tree)).join('\n');
const code = ts.transpileModule(actualSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function downloadHandler({ signed = false, lookup = async () => [publicIp], upstream = async () => media() } = {}) {
  const requests = []; const lookups = [];
  const context = { exports: {}, URL, Headers, AbortSignal, SafeFetchError, console: { error() {} },
    NextResponse: class extends Response { static json = Response.json; },
    getTokenFromHeaders: (headers) => headers.get('authorization'),
    verifyToken: async (token) => token === 'synthetic-session' ? { userId: 'synthetic-user' } : null,
    verifyExtractDownloadSignature: () => signed,
    safeFetchStream: (url, options) => safeFetchStream(url, options, {
      lookup: async (host) => { lookups.push(host); return lookup(host); },
      pinnedFetch: async (url, pin, init) => { requests.push({ hostname: url.hostname, range: new Headers(init.headers).get('range'), auth: new Headers(init.headers).get('authorization'), method: init.method, pin }); return upstream(url, init); },
      fetch: async () => { throw new Error('public mode must pin the real connection'); },
    }),
  };
  runInNewContext(code, context);
  return { get: context.exports.GET, requests, lookups };
}
function request({ url = asset, auth = true, range = 'bytes=0-3', mode = 'play', signal } = {}) {
  const target = new URL('http://fixture.invalid/api/extract/download');
  target.searchParams.set('url', url); target.searchParams.set('mode', mode);
  return new Request(target, { headers: { ...(auth ? { authorization: 'synthetic-session' } : {}), ...(range ? { range } : {}) }, signal });
}

try {
  process.env.NODE_ENV = 'development'; process.env.SAFE_FETCH_PUBLIC_DNS = 'cloudflare-doh-v1';
  const normal = downloadHandler();
  const response = await normal.get(request());
  assert.equal(response.status, 206); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/8'); assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-disposition'), 'inline'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(normal.requests.length, 1); assert.equal(normal.requests[0].range, 'bytes=0-3'); assert.equal(normal.requests[0].auth, null); assert.equal(normal.requests[0].method, 'GET');
  assert.deepEqual(normal.requests[0].pin, publicIp);
  const anonymous = downloadHandler(); assert.equal((await anonymous.get(request({ auth: false }))).status, 401); assert.equal(anonymous.lookups.length, 0);
  const signed = downloadHandler({ signed: true }); assert.equal((await signed.get(request({ auth: false }))).status, 206); assert.equal(signed.requests.length, 1);
  const badDomain = downloadHandler(); assert.equal((await badDomain.get(request({ url: 'https://douyinvod.com.evil.invalid/file.mp4' }))).status, 403); assert.equal(badDomain.lookups.length, 0);
  const badPort = downloadHandler(); assert.equal((await badPort.get(request({ url: 'https://v5-coldm.douyinvod.com:8443/file.mp4' }))).status, 400); assert.equal(badPort.requests.length, 0);
  const badContent = downloadHandler({ upstream: async () => media('text/html') }); assert.equal((await badContent.get(request())).status, 415);
  const badMode = downloadHandler(); assert.equal((await badMode.get(request({ mode: 'other' }))).status, 400); assert.equal(badMode.requests.length, 0);

  const second = 'https://v6-coldm.douyinvod.com/synthetic-fixture.mp4';
  const hops = downloadHandler({ upstream: async (url) => url.hostname.startsWith('v5') ? redirect(second) : media() });
  assert.equal((await hops.get(request())).status, 206); assert.equal(hops.requests.length, 2); assert.equal(hops.lookups.length, 2);
  assert.ok(hops.requests.every((entry) => entry.range === 'bytes=0-3' && entry.pin.address === publicIp.address));
  const outside = downloadHandler({ upstream: async () => redirect('https://untrusted.example.invalid/file.mp4') });
  assert.equal((await outside.get(request())).status, 403); assert.equal(outside.requests.length, 1); assert.equal(outside.lookups.length, 1);
  const privateHop = downloadHandler({ lookup: async (host) => host.startsWith('v5') ? [publicIp] : [{ address: '198.18.0.167', family: 4 }], upstream: async () => redirect(second) });
  assert.equal((await privateHop.get(request())).status, 400); assert.equal(privateHop.requests.length, 1);
  const cancelled = new AbortController(); cancelled.abort(); const stopped = downloadHandler();
  assert.equal((await stopped.get(request({ signal: cancelled.signal }))).status, 504); assert.equal(stopped.lookups.length, 0);

  for (const sameOrigin of [true, false]) {
    const observed = []; const hosts = [];
    const result = await safeMediaFetch('https://first.example.invalid/start', { headers: { range: 'bytes=0-3', authorization: 'stale-fixture', cookie: 'stale-cookie', 'x-api-key': 'stale-key' }, authorization: { origin: 'https://first.example.invalid', value: 'Bearer synthetic-provider-key' } }, {
      lookup: async (host) => { hosts.push(host); return [publicIp]; },
      pinnedFetch: async (url, pin, init) => {
        const headers = new Headers(init.headers);
        observed.push({ origin: url.origin, authorization: headers.get('authorization') });
        assert.equal(headers.get('range'), 'bytes=0-3'); assert.equal(headers.has('cookie'), false); assert.equal(headers.has('x-api-key'), false); assert.deepEqual(pin, publicIp);
        return observed.length === 1 ? redirect(sameOrigin ? '/media' : 'https://second.example.invalid/media') : media();
      },
    });
    assert.equal(result.response.status, 206); assert.equal(hosts.length, 2);
    assert.equal(observed[0].authorization, 'Bearer synthetic-provider-key');
    assert.equal(observed[1].authorization, sameOrigin ? 'Bearer synthetic-provider-key' : null);
  }
  let failedHops = 0;
  await assert.rejects(() => safeMediaFetch('https://first.example.invalid/start', {}, { lookup: async (host) => host.startsWith('first') ? [publicIp] : [{ address: 'fdfe:dcba:9876::90', family: 6 }], pinnedFetch: async () => { failedHops++; return redirect('https://second.example.invalid/media'); } }), (error) => error instanceof SafeFetchError && error.code === 'IP_FORBIDDEN');
  assert.equal(failedHops, 1);
  const report = { passed: true, dynamicGroups: 12, actualExtractGetHandler: true, actualSafeMediaFetch: true, rangeStreamsPinned: true, perHopHostAndDnsChecked: true, originCredentialsEnforced: true, realProviderRequests: 0, realDatabaseWrites: 0 };
  mkdirSync('.codex-evidence/safe-media-stream-20260902', { recursive: true });
  writeFileSync('.codex-evidence/safe-media-stream-20260902/fixture.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  if (originalDns === undefined) delete process.env.SAFE_FETCH_PUBLIC_DNS; else process.env.SAFE_FETCH_PUBLIC_DNS = originalDns;
}
