import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const root = process.cwd();
const require = createRequire(import.meta.url);
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
function compile(source, dependencies = {}, globals = {}) {
  const exports = {};
  const context = vm.createContext({
    exports, module: { exports }, Buffer, URL, Response, AbortSignal, crypto: webcrypto,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'node:crypto') return require(name);
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency ${name}`);
    }, ...globals,
  });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}
const validation = compile(read('src/lib/file-upload-security.ts'));
const routeSource = read('src/app/api/voice/tts/route.ts');
const ast = ts.createSourceFile('route.ts', routeSource, ts.ScriptTarget.Latest, true);
const functionSources = ['toAudioObjectUri', 'persistGeneratedAudio'].map((name) => {
  const node = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `Actual ${name} function exists`);
  return `export ${node.getText(ast)}`;
}).join('\n');

function persistenceHarness({ download, missingOwnership = false } = {}) {
  const uploads = [];
  let signs = 0;
  const route = compile(functionSources, {}, {
    ...validation,
    safeFetch: async () => {
      assert.ok(download, 'Unplanned network access');
      return download;
    },
    storageManager: {
      async upload(buffer, filename, contentType, options) {
        uploads.push({ buffer, filename, contentType, options });
        return { key: 'fixture-object', provider: 'local', contentType, size: buffer.length };
      },
      async getSignedUrl() { signs++; return 'http://127.0.0.1:5000/fixture-audio'; },
      async listUserFiles(userId) {
        assert.equal(userId, 'fixture-user');
        return missingOwnership ? [] : [{ id: 'fixture-owned-asset', storage_key: 'fixture-object' }];
      },
    },
  });
  return { uploads, get signs() { return signs; }, persist: (url) => route.persistGeneratedAudio(url, 'fixture-task', 'fixture-user') };
}

const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12), Buffer.from([0xff, 0xfb, 0x90, 0x64])]);
const wav = Buffer.alloc(48);
wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('original shared validator rejects the engine legacy MP3 alias', async () => {
  assert.throws(() => validation.validateUploadBuffer(mp3, 'audio/mp3'), { code: 'UNSUPPORTED_FILE_TYPE' });
  assert.equal(validation.validateUploadBuffer(mp3, 'audio/mpeg').extension, '.mp3');
});
for (const [format, mime, bytes, extension] of [['mp3', 'audio/mpeg', mp3, '.mp3'], ['wav', 'audio/wav', wav, '.wav'], ['ogg_opus', 'audio/ogg', ogg, '.ogg']]) {
  await test(`actual ${format} engine output passes actual persistence and shared validation`, async () => {
    let providerCalls = 0;
    const engine = compile(read('src/lib/vs/volcengine.ts'), {
      '@/lib/server/voice-provider-config': { loadVolcanoVoiceProviderConfig: async () => ({ apiKey: 'fixture-key-never-sent' }) },
    }, {
      fetch: async (_url, init) => {
        providerCalls++;
        assert.equal(JSON.parse(init.body).req_params.audio_params.format, format);
        return Response.json({ code: 20000000, data: bytes.toString('base64'), duration: 1 });
      },
    });
    const generated = await engine.synthesizeSpeech({ text: 'fixture', speaker: 'fixture_voice', audioParams: { format } });
    assert.ok(generated.audioUrl.startsWith(`data:${mime};base64,`));
    const h = persistenceHarness();
    const stored = await h.persist(generated.audioUrl);
    assert.equal(providerCalls, 1);
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.uploads[0].buffer, bytes);
    assert.equal(h.uploads[0].contentType, mime);
    assert.ok(h.uploads[0].filename.endsWith(extension));
    assert.equal(h.uploads[0].options.requireOwnershipRecord, true);
    assert.equal(h.uploads[0].options.userId, 'fixture-user');
    assert.equal(stored.assetId, 'fixture-owned-asset');
    assert.equal(stored.contentType, mime);
  });
}
await test('MP3 and WAV aliases normalize locally without changing shared policy', async () => {
  for (const [alias, bytes, mime] of [['audio/mp3', mp3, 'audio/mpeg'], ['audio/x-wav', wav, 'audio/wav']]) {
    const h = persistenceHarness();
    assert.equal((await h.persist(dataUrl(alias, bytes))).contentType, mime);
    assert.equal(h.uploads.length, 1);
  }
});
await test('downloaded legacy MIME declaration uses the same signature check', async () => {
  const h = persistenceHarness({ download: { contentType: 'audio/mp3; charset=binary', buffer: mp3 } });
  assert.equal((await h.persist('https://fixture.invalid/output')).contentType, 'audio/mpeg');
  assert.equal(h.uploads.length, 1);
});
for (const [name, mime, bytes] of [
  ['active markup disguised as audio', 'audio/mp3', Buffer.from('<html><script>alert(1)</script>')],
  ['WAV bytes falsely declared MP3', 'audio/mp3', wav],
  ['opaque octet stream', 'application/octet-stream', mp3],
  ['raw PCM without a supported container', 'audio/pcm', Buffer.alloc(100)],
  ['image output cannot be an audio asset', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])],
]) {
  await test(`${name} is still rejected before upload`, async () => {
    const h = persistenceHarness();
    await assert.rejects(h.persist(dataUrl(mime, bytes)));
    assert.equal(h.uploads.length, 0);
    assert.equal(h.signs, 0);
  });
}
await test('an upload without an owned record is never accepted as delivered', async () => {
  const h = persistenceHarness({ missingOwnership: true });
  await assert.rejects(h.persist(dataUrl('audio/mpeg', mp3)), /VOICE_ASSET_RECORD_MISSING/u);
});

function actualSingleHandlerHarness() {
  const calls = { quotes: [], begin: [], provider: [], finalize: [], uploads: 0 };
  const voices = compile(read('src/lib/vs/voices-data.ts'));
  const route = compile(read('src/app/api/voice/tts/route.ts'), {
    crypto: require('node:crypto'),
    'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
    '@/lib/tts/router': { routeTTS() { throw new Error('Unexpected alternative engine'); } },
    '@/lib/voice-store': { getAllVoices: () => [], getAllEngineConfigs: () => [], addGeneration: () => ({ id: 'fixture-history' }) },
    '@/lib/api-middleware': { withAuth: (request, handler) => handler({ id: 'fixture-user', role: 'admin', credits: 0 }, { from() { throw new Error('Unexpected direct business write'); } }, request) },
    '@/lib/vs/pricing': {
      inferModelId() { throw new Error('Frozen target should control pricing'); },
      calculateVoiceCost(_characters, modelId) {
        calls.quotes.push(modelId);
        if (!['seed-tts-2.0', 'seed-icl-2.0'].includes(modelId)) return null;
        return { creditsToCharge: 1, costPriceRmb: 0.01, sellPriceRmb: 0.02, profitRmb: 0.01, pricing: { name: modelId, unit: '千字符', profitMargin: 10, costPrice: 0.3 } };
      },
    },
    '@/lib/vs/voices-data': voices,
    '@/storage/object': { storageManager: {
      async upload(bytes, _filename, contentType) { calls.uploads++; return { key: 'fixture-object', provider: 'local', contentType, size: bytes.length }; },
      async getSignedUrl() { return 'http://127.0.0.1:5000/fixture-audio'; },
      async listUserFiles() { return [{ id: 'fixture-asset', storage_key: 'fixture-object' }]; },
    } },
    '@/lib/file-upload-security': validation,
    '@/lib/safe-fetch': { safeFetch() { throw new Error('Unexpected remote download'); } },
    '@/lib/billing': { getBillingConfig: async () => ({ creditsPerYuan: 100 }) },
    '@/lib/voice-generation-lifecycle': {
      VoiceGenerationLifecycleError: class extends Error {},
      async beginVoiceGenerationAtomic(input) {
        calls.begin.push(input);
        return { success: true, alreadyFulfilled: false, record: { requestId: input.requestId, quotedCredits: input.quotedCredits, chargeCredits: input.chargeCredits, refundedCredits: 0, billingExempt: input.billingExempt } };
      },
      async finalizeVoiceGenerationAtomic(input) { calls.finalize.push(input); return { response: input.response }; },
      async refundVoiceGenerationAtomic() { throw new Error('Successful fixture must not refund'); },
    },
    '@/lib/vs/volcengine': {
      getActiveApiKey: async () => 'fixture-never-sent',
      async synthesizeSpeech(input) { calls.provider.push(input); return { audioUrl: dataUrl('audio/mpeg', mp3), duration: 1, logId: 'fixture-provider-log' }; },
    },
    '@/lib/tts/markers': { translateForEngine: (text) => ({ text }) },
  });
  return { calls, async post(extra) {
    const key = 'fixture-single-model-key';
    const response = await route.POST(new Request('http://127.0.0.1/api/voice/tts', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ text: 'fixture text', speaker: 'zh_female_vv_uranus_bigtts', format: 'mp3', client_request_id: key, ...extra }) }));
    return { status: response.status, body: await response.json() };
  } };
}
for (const [model, expectedModel, billingModel, resource] of [
  ['seed-tts-2.0-expressive', 'seed-tts-2.0-expressive', 'seed-tts-2.0', 'seed-tts-2.0'],
  ['seed-tts-2.0-standard', 'seed-tts-2.0-standard', 'seed-tts-2.0', 'seed-tts-2.0'],
  ['seed-icl-2.0', 'seed-icl-2.0', 'seed-icl-2.0', 'seed-icl-2.0'],
  [undefined, 'seed-tts-2.0-expressive', 'seed-tts-2.0', 'seed-tts-2.0'],
]) {
  await test(`actual single POST freezes ${model || 'speaker default'} for provider and billing`, async () => {
    const h = actualSingleHandlerHarness();
    const result = await h.post({ model });
    assert.equal(result.status, 200);
    assert.equal(h.calls.provider.length, 1);
    assert.equal(h.calls.provider[0].model, expectedModel);
    assert.equal(h.calls.provider[0].resourceId, resource);
    assert.equal(h.calls.quotes[0], billingModel);
    assert.equal(h.calls.begin[0].modelId, billingModel);
    assert.deepEqual([...h.calls.begin[0].metadata.provider_candidates], [expectedModel]);
    assert.equal(h.calls.begin[0].billingExempt, true);
    assert.equal(h.calls.begin[0].chargeCredits, 0);
    assert.equal(h.calls.finalize[0].metadata.provider_model, expectedModel);
    assert.equal(result.body.data.billing.modelId, billingModel);
    assert.equal(result.body.data.persisted, true);
    assert.equal(h.calls.uploads, 1);
  });
}
await test('conflicting resource cannot replace selected model or call provider', async () => {
  const h = actualSingleHandlerHarness();
  const result = await h.post({ model: 'seed-tts-2.0-expressive', resourceId: 'seed-icl-2.0' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'VOICE_MODEL_RESOURCE_CONFLICT');
  assert.equal(h.calls.begin.length, 0);
  assert.equal(h.calls.provider.length, 0);
});
await test('unpublished model fails pricing before any task or supplier call', async () => {
  const h = actualSingleHandlerHarness();
  const result = await h.post({ model: 'unknown-unpublished-model' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'VOICE_PRICE_NOT_CONFIGURED');
  assert.equal(h.calls.begin.length, 0);
  assert.equal(h.calls.provider.length, 0);
});
console.log(`PASS ${passed} actual voice engine/persistence/validator scenarios; no real supplier, storage or database calls`);
