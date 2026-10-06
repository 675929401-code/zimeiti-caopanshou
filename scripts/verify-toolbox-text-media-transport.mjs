import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { lookupFixedPublicDns, fetchPinnedPublicAddress } from '../src/lib/safe-fetch-public-dns.ts';
import { safeFetch, safeFetchStream } from '../src/lib/safe-fetch.ts';

if (!process.argv.includes('--execute-readonly')) { console.log(JSON.stringify({ networkRequests: 0, mode: 'plan', purpose: 'Read the existing fresh PPT6 media; never re-extract or generate' })); process.exit(0); }
process.env.NODE_ENV = 'development'; process.env.SAFE_FETCH_PUBLIC_DNS = 'cloudflare-doh-v1';
const cfg = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(new URL(cfg.supabaseUrl).hostname, '127.0.0.1'); assert.equal(new URL(cfg.supabaseUrl).port, '54321');
const recordId = '8ea0993da619e02b4c2117c9b0b27d54e4a1ff149f05aab623233547c58cd493';
const lookup = await fetch(`${cfg.supabaseUrl.replace(/\/$/, '')}/rest/v1/extraction_attempts?record_id=eq.${recordId}&select=state,response`, { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } });
const [row] = await lookup.json(); assert.equal(row?.state, 'succeeded');
const rawUrl = row.response?.videos?.[0]?.download_url || row.response?.videos?.[0]?.url;
const url = new URL(rawUrl); assert.ok(/(^|\.)douyinvod\.com$/.test(url.hostname));
const report = { at: new Date().toISOString(), recordId, host: url.host, urlSha256: createHash('sha256').update(rawUrl).digest('hex'), credentialPersistence: false, newProviderSubmissions: 0, probes: [] };
const addresses = await lookupFixedPublicDns(url.hostname);
report.addresses = addresses;
if (process.argv.includes('--recovery')) {
  // Replay only this immutable media GET, arranging the real DNS answer so
  // the previously observed unavailable edge is attempted before alternatives.
  const unavailable = addresses.find(address => address.address === '36.158.229.101');
  const ordered = unavailable ? [unavailable, ...addresses.filter(address => address !== unavailable)] : addresses;
  const started = Date.now();
  const media = await safeFetch(url, { timeoutMs: 30000, maxBytes: 50 * 1024 * 1024,
    allowedContentTypes: ['video/mp4'], headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.douyin.com/' } }, {
    lookup: async () => ordered,
    pinnedFetch: (target, selectedAddress, init) => {
      const probe = { address: selectedAddress, errors: [] }; report.probes.push(probe);
      const request = (options, callback) => {
        const req = (options.protocol === 'https:' ? httpsRequest : httpRequest)(options, incoming => { probe.headersReceived = true; probe.http = incoming.statusCode; callback(incoming); });
        req.once('error', error => probe.errors.push({ name: error.name, code: error.code || null })); return req;
      };
      return fetchPinnedPublicAddress(target, selectedAddress, init, { request });
    },
  });
  report.result = { passed: true, unavailableEdgeStillInCurrentDns: !!unavailable, status: media.status, bytes: media.buffer.length,
    contentType: media.contentType, mediaSha256: createHash('sha256').update(media.buffer).digest('hex'), elapsedMs: Date.now() - started };
  await fs.writeFile('.codex-evidence/toolbox-real-e2e-20260902/media-transport-recovery.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report.result, probes: report.probes })); process.exit(0);
}
const baseline = process.argv.includes('--baseline');
for (const address of baseline ? [null, null] : addresses.slice(0, 6)) {
  const probe = { address, errors: [], headersReceived: false };
  const request = (options, callback) => {
    const req = (options.protocol === 'https:' ? httpsRequest : httpRequest)(options, response => { probe.headersReceived = true; probe.upstreamHttp = response.statusCode; callback(response); });
    req.once('error', error => probe.errors.push({ name: error.name, code: error.code || null, syscall: error.syscall || null, reason: typeof error.reason === 'string' ? error.reason.slice(0, 200) : null }));
    return req;
  };
  try {
    const { response } = await safeFetchStream(url, { timeoutMs: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Referer: 'https://www.douyin.com/', ...(!baseline || report.probes.length === 1 ? { Range: 'bytes=0-65535' } : {}) } }, {
      pinnedFetch: (target, selectedAddress, init) => { probe.address = address || selectedAddress; return fetchPinnedPublicAddress(target, address || selectedAddress, init, { request }); },
    });
    probe.status = response.status; probe.contentType = response.headers.get('content-type');
    if (response.status >= 200 && response.status < 300) {
      const reader = response.body.getReader(); let bytes = 0;
      while (bytes < 65536) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; }
      await reader.cancel(); probe.bytes = bytes;
    } else await response.body?.cancel();
  } catch (error) { probe.failure = { name: error.name, code: error.code || null, message: error.message }; }
  report.probes.push(probe);
  console.log(JSON.stringify(probe));
  await fs.writeFile(`.codex-evidence/toolbox-real-e2e-20260902/media-transport-${baseline ? 'baseline' : 'diagnostic'}.json`, JSON.stringify(report, null, 2));
}
