import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

// Execute the actual handlers with isolated transport/auth/database boundaries.
// No environment file, browser session, database or supplier is contacted.
const root = process.cwd();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const audio = Buffer.from([0x49, 0x44, 0x33, 0xff, 0x00, 0xa5]);
const encoded = (buffer) => buffer.toString('base64');
const stream = (...events) => new Response(events.map((event) => JSON.stringify(event)).join('\r\n'));
let passed = 0;

function loadRoute(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  const context = vm.createContext({
    exports, module: { exports }, Buffer, URL, Response, Request, AbortSignal,
    crypto: webcrypto, process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (value, init) => Response.json(value, init) } };
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ...globals,
  });
  vm.runInContext(outputText, context, { filename: relative });
  return exports;
}

function previewHarness(responses, { configured = true, downloadError = false } = {}) {
  const calls = [];
  let downloads = 0;
  const synthesis = loadRoute('src/lib/server/voice-preview-synthesis.ts', {
    '@/lib/api-middleware': { withAuth: (_request, callback) => callback({ id: 'fixture-user' }) },
    '@/lib/security-edge': { getClientIP: () => '192.0.2.1' },
    '@/lib/server/voice-provider-config': { loadVolcanoVoiceProviderConfig: async () => configured ? { apiKey: 'fixture-never-sent' } : null },
    '@/lib/vs/voices-data': { findVoiceBySpeakerId: () => ({ resourceId: 'seed-tts-2.0' }) },
    '@/lib/safe-fetch': { safeFetch: async () => {
      downloads++;
      if (downloadError) throw new Error('fixture download failure');
      return { buffer: audio, contentType: 'audio/mpeg' };
    } },
  }, {
    fetch: async (_url, init) => {
      assert.equal(init.method, 'POST');
      calls.push(JSON.parse(init.body));
      const value = responses[calls.length - 1];
      assert.ok(value, 'No unplanned supplier fallback is allowed');
      if (value instanceof Error) throw value;
      return value.clone();
    },
  });
  const previewTexts = loadRoute('src/lib/vs/preview-texts.ts', {});
  const route = loadRoute('src/app/api/voice/preview/route.ts', {
    '@/lib/voice-studio/catalog': { readVoiceCatalog: () => [{ speakerId: 'fixture_voice', resourceId: 'seed-tts-2.0', isActive: true }] },
    '@/lib/api-middleware': { withAuth: (_request, callback) => callback({ id: 'fixture-user' }) },
    '@/lib/security-edge': { getClientIP: () => '192.0.2.1' },
    '@/storage/database/supabase-client': {},
    '@/lib/vs/voices-data': { findVoiceBySpeakerId: () => ({ resourceId: 'seed-tts-2.0' }) },
    '@/lib/server/voice-preview-synthesis': synthesis,
    '@/lib/server/voice-preview-cache': { cachedVoicePreview: async (_input, produce) => ({ audio: await produce(), cacheHit: false }), voicePreviewProviderIdentity: () => 'fixture-provider' },
    '@/lib/vs/preview-texts': previewTexts,
  });
  return {
    calls, get downloads() { return downloads; },
    async post(body = { speakerId: 'fixture_voice', category: '热门推荐' }) {
      const result = await route.POST(new Request('http://127.0.0.1/api/voice/preview', { method: 'POST', body: JSON.stringify(body) }));
      return { status: result.status, body: await result.json() };
    },
  };
}

async function check(name, callback) {
  await callback();
  passed++;
  console.log(`PASS ${name}`);
}

await check('independently padded fragments preserve all binary bytes', async () => {
  const h = previewHarness([stream({ code: 0, data: encoded(audio.subarray(0, 1)) }, { code: 0, data: encoded(audio.subarray(1, 3)) }, { code: 20000000, data: encoded(audio.subarray(3)), duration: 1.5 })]);
  const r = await h.post();
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(r.body.data.audioUrl.split(',')[1], 'base64'), audio);
  assert.equal(r.body.data.duration, 1.5);
  assert.equal(h.calls.length, 1);
});
await check('unpadded fragments decode separately', async () => {
  const h = previewHarness([stream(...[audio.subarray(0, 1), audio.subarray(1)].map((part) => ({ code: 0, data: encoded(part).replace(/=+$/u, '') })))]);
  const r = await h.post();
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(r.body.data.audioUrl.split(',')[1], 'base64'), audio);
});
await check('provider error after audio is terminal for this preview and cannot fallback', async () => {
  const h = previewHarness([stream({ code: 0, data: encoded(audio) }, { code: 45000030, message: 'model not support' })]);
  assert.equal((await h.post()).status, 502);
  assert.equal(h.calls.length, 1);
});
await check('explicit model rejection before audio permits one compatible fallback', async () => {
  const h = previewHarness([json({ code: 45000030, message: 'model not support' }), json({ code: 0, data: encoded(audio) })]);
  assert.equal((await h.post()).status, 200);
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.calls[0].req_params.model, h.calls[1].req_params.model);
});
await check('explicit HTTP incompatibility permits fallback', async () => {
  const h = previewHarness([new Response('model mismatch', { status: 400 }), json({ code: 0, data: encoded(audio) })]);
  assert.equal((await h.post()).status, 200);
  assert.equal(h.calls.length, 2);
});
for (const [name, response, status] of [
  ['HTTP 500 with compatibility words remains unknown', new Response('invalid model', { status: 500 }), 502],
  ['network timeout remains unknown', new Error('fixture timeout'), 502],
  ['rate limit never falls back', new Response('rate limit', { status: 429 }), 429],
  ['unclassified provider failure never falls back', json({ code: 45009999, message: 'internal failure' }), 502],
  ['malformed base64 is rejected', json({ code: 0, data: 'AB==' }), 502],
  ['empty response is not successful', new Response(''), 502],
]) {
  await check(name, async () => {
    const h = previewHarness([response]);
    assert.equal((await h.post()).status, status);
    assert.equal(h.calls.length, 1);
  });
}
await check('failed download after provider output cannot start another synthesis', async () => {
  const h = previewHarness([json({ code: 0, url: 'https://fixture.invalid/result.mp3' })], { downloadError: true });
  assert.equal((await h.post()).status, 502);
  assert.equal(h.downloads, 1);
  assert.equal(h.calls.length, 1);
});
await check('single JSON audio and safe URL downloads remain supported', async () => {
  for (const response of [json({ code: 0, data: encoded(Buffer.concat(Array(30).fill(audio))) }), json({ code: 0, data: { url: 'https://fixture.invalid/result.mp3' } })]) {
    const h = previewHarness([response]);
    assert.equal((await h.post()).status, 200);
    assert.equal(h.calls.length, 1);
  }
});
await check('oversized decoded audio is rejected without fallback', async () => {
  const h = previewHarness([json({ code: 0, data: encoded(Buffer.alloc(5 * 1024 * 1024 + 1)) })]);
  assert.equal((await h.post()).status, 502);
  assert.equal(h.calls.length, 1);
});
await check('unconfigured provider and invalid input make zero supplier calls', async () => {
  const h = previewHarness([], { configured: false });
  assert.equal((await h.post()).status, 503);
  assert.equal((await h.post({ speakerId: '../invalid' })).status, 400);
  assert.equal(h.calls.length, 0);
});
await check('fixed preview text and rate limit remain enforced', async () => {
  const h = previewHarness(Array.from({ length: 6 }, () => json({ code: 0, data: encoded(audio) })));
  for (let i = 0; i < 6; i++) assert.equal((await h.post({ speakerId: 'fixture_voice', text: 'client override' })).status, 200);
  assert.equal((await h.post()).status, 429);
  assert.equal(h.calls.length, 6);
  assert.ok(h.calls.every((body) => body.req_params.text !== 'client override'));
});

const statusSource = fs.readFileSync(path.join(root, 'src/app/api/voice/status/route.ts'), 'utf8');
const rpcNames = [...statusSource.matchAll(/'([a-z_]+_atomic)'/gu)].map((match) => match[1]);
function statusHarness({ configured = true, missingRpc = false, tableError = null, failedMetadata = false, brokenMetadata = false } = {}) {
  const reads = [];
  let metadataGets = 0;
  const route = loadRoute('src/app/api/voice/status/route.ts', {
    '@/lib/api-middleware': { withAuth() { throw new Error('Unexpected authentication or mutation'); } },
    '@/lib/server/voice-provider-config': { inspectVolcanoVoiceProviderConfig: async () => ({ configured, source: configured ? 'plugins' : 'none' }) },
    '@/lib/server/voice-training-lifecycle': {},
    '@/lib/voice-training-status': {},
    '@/lib/vs/volcengine': {},
    '@/storage/database/supabase-client': { getSupabaseClient: () => ({ from(table) {
      const read = { table };
      reads.push(read);
      return { select(columns) { read.columns = columns; return this; }, limit(value) { assert.equal(value, 0); return this; }, abortSignal() { return Promise.resolve({ data: [], error: tableError }); } };
    } }) },
  }, {
    process: { env: { COZE_SUPABASE_URL: 'http://127.0.0.1:54321', COZE_SUPABASE_SERVICE_ROLE_KEY: 'fixture-only' } },
    fetch: async (url, init) => {
      metadataGets++;
      assert.equal(new URL(url).pathname, '/rest/v1/');
      assert.equal(init.method, 'GET');
      if (failedMetadata) return new Response('', { status: 503 });
      const names = missingRpc ? rpcNames.slice(1) : rpcNames;
      return json(brokenMetadata ? {} : { paths: Object.fromEntries(names.map((name) => [`/rpc/${name}`, { post: {} }])) });
    },
  });
  return { reads, get metadataGets() { return metadataGets; }, async get(provider = 'volcano') {
    const result = await route.GET({ nextUrl: new URL(`http://127.0.0.1/api/voice/status?provider=${provider}`) });
    return { status: result.status, body: await result.json() };
  } };
}
await check('configured credentials alone do not enable submission without lifecycle RPCs', async () => {
  const h = statusHarness({ missingRpc: true });
  const r = await h.get();
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'MIGRATION_NOT_READY');
  assert.equal(r.body.data.available, true);
  assert.equal(r.body.data.canSubmit, false);
});
for (const [name, options, expectedCode] of [
  ['missing task table', { tableError: { code: 'PGRST205' } }, 'MIGRATION_NOT_READY'],
  ['missing training lifecycle column', { tableError: { code: '42703' } }, 'MIGRATION_NOT_READY'],
  ['denied table read', { tableError: { code: '42501' } }, 'VOICE_DATABASE_STATUS_UNAVAILABLE'],
  ['metadata unavailable', { failedMetadata: true }, 'VOICE_DATABASE_STATUS_UNAVAILABLE'],
  ['malformed metadata', { brokenMetadata: true }, 'VOICE_DATABASE_STATUS_UNAVAILABLE'],
]) {
  await check(`${name} fails closed with no RPC execution`, async () => {
    const r = await statusHarness(options).get();
    assert.equal(r.status, 503);
    assert.equal(r.body.code, expectedCode);
    assert.equal(r.body.data.canSubmit, false);
    assert.equal(r.body.data.upstreamCalls, 0);
    assert.equal(r.body.data.creditsCharged, 0);
  });
}
await check('ready schema uses zero-row GETs and configured provider enables submission', async () => {
  const h = statusHarness();
  const r = await h.get();
  assert.equal(r.status, 200);
  assert.equal(r.body.data.canSubmit, true);
  assert.equal(h.metadataGets, 1);
  assert.equal(h.reads.length, 2);
  assert.ok(h.reads.every((read) => read.columns.includes('user_id')));
});
await check('ready schema cannot enable a missing provider or unsupported provider', async () => {
  const h = statusHarness({ configured: false });
  assert.equal((await h.get()).body.data.canSubmit, false);
  assert.equal((await h.get('unknown')).status, 400);
  assert.equal(h.metadataGets, 1);
});
console.log(`PASS ${passed} voice preview/readiness scenarios; no network or database access`);
