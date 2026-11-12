import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { Blob, File } from 'node:buffer';
import ts from 'typescript';
import { z } from 'zod';

// Runs the real migrated upload implementation with RAM browser/transport
// dependencies. No credential, database, build, server or provider access.
const sourcePath = path.resolve('src/features/publishing/studio/native-assets.ts');
const source = await fs.readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const checks = [];
const check = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); assert.ok(passed, name); };
const output = path.resolve('.codex-evidence/publishing-studio-f76f3d79/qa');
await fs.mkdir(output, { recursive: true });
const assetId = '00000000-0000-4000-8000-000000000201';
const actorA = '00000000-0000-4000-8000-000000000202';
const actorB = '00000000-0000-4000-8000-000000000203';
const canonicalUrl = `/api/native-operations/assets/${assetId}/content`;
const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const file = () => new File([bytes], 'explicit-ram-fixture.png', { type: 'image/png' });
let forbiddenNetwork = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { forbiddenNetwork++; throw new Error('NETWORK_FORBIDDEN_IN_STUDIO_CONTRACT'); };

function harness(options = {}) {
  let owner = actorA, revision = 1, signed = 0, puts = 0, confirms = 0, reads = 0;
  const storage = new Map(), listeners = new Set(), controllers = new Set();
  const session = () => ({ user: { id: owner } });
  const assertOwner = (expected, expectedRevision) => { if (!owner || expected && expected !== owner || expectedRevision !== undefined && expectedRevision !== revision) throw new Error('SESSION_CHANGED_FIXTURE'); return session(); };
  const host = { assertHostSession: assertOwner, getHostSession: session, getHostSessionRevision: () => revision, hostStorageKey: key => owner ? `fixture:${owner}:${key}` : null,
    subscribeHostSession: fn => { listeners.add(fn); return () => listeners.delete(fn); }, trackHostRequest: controller => { controllers.add(controller); return () => controllers.delete(controller); } };
  const ownerChange = () => { owner = actorB; revision++; for (const controller of controllers) controller.abort(); for (const listener of listeners) listener(); };
  let signKey, signMediaId;
  const transport = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url === 'assets/upload-sign' && method === 'POST') {
      signed++; const value = JSON.parse(init.body); signKey = value.requestKey; signMediaId = value.mediaId;
      if (options.signUnknown) throw new Error('SIGN_RESPONSE_LOST_FIXTURE');
      if (options.ownerDuringSign) ownerChange();
      return { json: async () => ({ code: 0, data: { id: assetId, url: canonicalUrl, uploadUrl: 'https://upload.fixture.invalid/never-network' }, message: '' }) };
    }
    if (url.startsWith('assets/upload-sign?requestKey=') && method === 'GET') {
      reads++; assert.equal(new URL(url, 'http://fixture.invalid').searchParams.get('requestKey'), signKey);
      const asset = options.remoteReady ? { id: assetId, mediaId: signMediaId, fileName: 'explicit-ram-fixture.png', mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), state: 'ready', metadata: {} } : null;
      return { json: async () => ({ code: 0, data: { operation: { kind: 'asset_sign', requestKey: signKey }, asset, uploadUrlRecoverable: false }, message: '' }) };
    }
    if (url === `assets/${assetId}/confirm` && method === 'POST') {
      confirms++; if (options.confirmUnknown) throw new Error('CONFIRM_RESPONSE_LOST_FIXTURE');
      return { json: async () => ({ code: 0, data: { url: canonicalUrl }, message: '' }) };
    }
    if (url === `assets/${assetId}` && method === 'GET') {
      reads++; const phaseReady = options.remoteReady || !options.putUnknown && !options.confirmUnknown;
      return { json: async () => ({ code: 0, data: { id: assetId, mediaId: signMediaId, fileName: 'explicit-ram-fixture.png', mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), state: phaseReady ? 'ready' : 'signed', metadata: {} }, message: '' }) };
    }
    if (url === `assets/${assetId}/content` && method === 'GET') return { ok: true, blob: async () => new Blob([bytes], { type: 'image/png' }) };
    throw new Error(`UNEXPECTED_RAM_TRANSPORT_${method}_${url}`);
  };
  class XHR {
    constructor() { this.upload = {}; this.status = 200; }
    open(method, url) { assert.equal(method, 'PUT'); assert.equal(new URL(url).hostname, 'upload.fixture.invalid'); }
    setRequestHeader(name, value) { assert.equal(name, 'Content-Type'); assert.equal(value, 'image/png'); }
    send() { puts++; queueMicrotask(() => { if (options.putUnknown) this.onerror?.(); else this.onload?.(); }); }
    abort() { this.onabort?.(); }
  }
  const exports = {}, context = vm.createContext({ exports, Blob, File, URL, Map, WeakMap, Set, Uint8Array, AbortController, crypto: webcrypto, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    navigator: { locks: { request: async (_key, _options, callback) => callback(options.lockUnavailable ? null : {}) } },
    window: { location: { origin: 'http://127.0.0.1:5000' } }, XMLHttpRequest: XHR,
    require: name => {
      if (name === './host-session') return host;
      if (name === './host-transport') return { nativeBffFetch: transport };
      if (name === 'zod') return { z };
      // Provider DTO schema details are not under test here. Marker parsing
      // still uses real zod; state/hash/owner checks run in production code.
      if (name === '@/lib/publishing-v3-contract') return { PublishingV3AssetSchema: z.any(), PublishingV3OperationSchema: z.any() };
      throw new Error(`UNEXPECTED_IMPORT_${name}`);
    },
  });
  new vm.Script(compiled, { filename: sourcePath }).runInContext(context);
  return { implementation: exports, storage, ownerChange, counts: () => ({ signed, puts, confirms, reads, signKey }) };
}

const report = { passed: false, scope: 'Actual migrated native-assets implementation; RAM transport/XHR, lock and asset-schema dependencies; no real provider/database/browser publication', sourceSha256: createHash('sha256').update(source).digest('hex'), checks, actualNetworkCalls: 0 };
try {
  {
    const h = harness({ signUnknown: true }), blob = file();
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /SIGN_RESPONSE_LOST/);
    const markerBefore = [...h.storage.values()][0];
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /尚未查明/);
    check('unknown signing retains original request key and cannot sign or PUT twice', h.counts().signed === 1 && h.counts().puts === 0 && [...h.storage.values()][0] === markerBefore && JSON.parse(markerBefore).requestKey === h.counts().signKey);
  }
  {
    const h = harness({ signUnknown: true, remoteReady: true }), blob = file();
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /SIGN_RESPONSE_LOST/);
    const recovered = await h.implementation.uploadNativeAsset(blob);
    check('lost signing can recover the exact ready asset through GET-only readback', recovered === canonicalUrl && h.counts().signed === 1 && h.counts().puts === 0 && h.counts().confirms === 0 && h.counts().reads === 2);
  }
  {
    const h = harness({ putUnknown: true }), blob = file();
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /传输已中断/);
    const markerBefore = [...h.storage.values()][0];
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /尚未确认或已失效/);
    check('unknown PUT retry reads original asset and never repeats PUT', h.counts().signed === 1 && h.counts().puts === 1 && h.counts().confirms === 0 && h.counts().reads === 1 && [...h.storage.values()][0] === markerBefore);
  }
  {
    const h = harness({ confirmUnknown: true }), blob = file();
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /CONFIRM_RESPONSE_LOST/);
    const markerBefore = [...h.storage.values()][0];
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /尚未确认或已失效/);
    check('unknown confirmation preserves marker and never repeats signing PUT or confirmation', h.counts().signed === 1 && h.counts().puts === 1 && h.counts().confirms === 1 && h.counts().reads === 1 && [...h.storage.values()][0] === markerBefore);
  }
  {
    const h = harness({ confirmUnknown: true, remoteReady: true }), blob = file();
    await assert.rejects(h.implementation.uploadNativeAsset(blob), /CONFIRM_RESPONSE_LOST/);
    const recovered = await h.implementation.uploadNativeAsset(blob);
    check('lost confirmation can reuse exact ready asset through GET-only readback', recovered === canonicalUrl && h.counts().signed === 1 && h.counts().puts === 1 && h.counts().confirms === 1 && h.counts().reads === 1);
  }
  {
    const h = harness(), blob = file();
    assert.equal(await h.implementation.uploadNativeAsset(blob), canonicalUrl);
    assert.equal(await h.implementation.uploadNativeAsset(file()), canonicalUrl);
    check('same bytes from a reselected File reuse owner-scoped ready asset', h.counts().signed === 1 && h.counts().puts === 1 && h.counts().confirms === 1 && h.counts().reads === 1);
  }
  {
    const h = harness({ ownerDuringSign: true });
    await assert.rejects(h.implementation.uploadNativeAsset(file()), /SESSION_CHANGED_FIXTURE/);
    check('owner switch after signing prevents transfer to returned upload URL', h.counts().signed === 1 && h.counts().puts === 0 && h.counts().confirms === 0 && [...h.storage.keys()].every(key => key.includes(actorA)));
  }
  {
    const h = harness({ lockUnavailable: true });
    await assert.rejects(h.implementation.uploadNativeAsset(file()), /另一个页面/);
    check('cross-page lock contention has no request or marker side effect', h.counts().signed === 0 && h.counts().puts === 0 && h.storage.size === 0);
  }
  check('zero actual network calls', forbiddenNetwork === 0);
  report.passed = checks.every(item => item.passed);
} catch (error) {
  report.error = String(error.message).slice(0, 1500); process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch; report.actualNetworkCalls = forbiddenNetwork;
  await fs.writeFile(path.join(output, 'zero-network-upload-boundaries.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, actualNetworkCalls: forbiddenNetwork, output: path.join(output, 'zero-network-upload-boundaries.json'), ...(report.error ? { error: report.error } : {}) }));
}
