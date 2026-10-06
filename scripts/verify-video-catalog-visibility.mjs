import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

const requireNative = createRequire(import.meta.url);
const state = { models: [], health: [], healthError: null, modelError: null, admin: true, calls: [], responder: async () => Response.json({ data: [] }) };
const cache = new Map();
function query(table) {
  const predicates = [];
  const value = () => {
    const explicit = Object.fromEntries(state.models.map((row) => [row.id, true]));
    const rows = table === 'video_models'
      ? state.models
      : table === 'platform_settings'
        ? [{ setting_key: 'workspace_model_assignment_overrides_v1', setting_value: JSON.stringify({ version: 1, surfaces: { 'video-page': explicit, 'storyboard-video': explicit } }) }]
        : state.health;
    return { data: rows.filter((row) => predicates.every((predicate) => predicate(row))), error: table === 'video_models' ? state.modelError : table === 'platform_settings' ? null : state.healthError };
  };
  return {
    select() { return this; }, order() { return this; },
    eq(key, expected) { predicates.push((row) => row[key] === expected); return this; },
    in(key, values) { predicates.push((row) => values.includes(row[key])); return this; },
    maybeSingle() { const result = value(); return Promise.resolve({ ...result, data: result.data[0] || null }); },
    then(resolve, reject) { return Promise.resolve(value()).then(resolve, reject); },
    update() { throw new Error('UNEXPECTED_DATABASE_WRITE'); }, insert() { throw new Error('UNEXPECTED_DATABASE_WRITE'); },
  };
}
const mocks = {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/storage/database/supabase-client': { getSupabaseClient: () => ({ from: query }), getSupabaseAdminClient: () => ({ from: query }) },
  '@/lib/auth': { getTokenFromHeaders: (headers) => headers.get('authorization') },
  '@/lib/admin-auth': { verifyAdminToken: async () => state.admin ? { role: 'admin' } : null },
  '@/lib/provider-secret': { resolveProviderSecret: (key) => { if (key === 'missing-reference') throw new Error('PRIVATE_REFERENCE_DETAILS'); return key; } },
  '@/lib/video-autodl-comfyui-workflow': { AUTODL_COMFYUI_WORKFLOW_PROTOCOL: 'autodl_comfyui_workflow' },
  '@/lib/autodl-h3-selfhost': { AUTODL_H3_SELFHOST_PROTOCOL: 'autodl_h3_selfhost' },
  '@/lib/video-model-capabilities': { getVideoDurationCapabilities: () => ({ mode: 'fixed', minDuration: 5, maxDuration: 5, defaultDuration: 5, nativeDurations: [5] }), getVideoResolutionCapabilities: () => ({ options: ['720p'], defaultResolution: '720p', publicPrices: {}, labels: {} }) },
  '@/lib/video-input-contract': { getVideoInputContract: (row) => {
    const config = row?.api_protocol_config && typeof row.api_protocol_config === 'object'
      ? row.api_protocol_config : {};
    const supportsImage = row?.supports_image_input === true;
    const requiresImage = row?.requires_image === true;
    const maxReferenceImages = Number.isFinite(Number(config.max_reference_images))
      ? Math.max(0, Number(config.max_reference_images)) : supportsImage ? 1 : 0;
    const minReferenceImages = Number.isFinite(Number(config.min_reference_images))
      ? Math.max(0, Number(config.min_reference_images)) : requiresImage ? 1 : 0;
    const maxReferenceAudios = Math.max(0, Number(config.max_reference_audios) || 0);
    const minReferenceAudios = Math.max(0, Number(config.min_reference_audios) || 0);
    return {
      supportsPrompt: config.supports_prompt !== false,
      requiresSourceVideo: config.requires_source_video === true,
      maxReferenceImages,
      minReferenceImages,
      maxReferenceAudios,
      minReferenceAudios,
      showAudioInputs: config.supports_audio_input === true || maxReferenceAudios > 0,
      mode: supportsImage ? 'optional-image' : 'text-only',
      requiresFirstFrame: config.requires_first_frame === true,
      requiresLastFrame: config.requires_last_frame === true,
    };
  } },
  '@/lib/video-cancellation': { supportsConfirmedVideoCancellation: () => false },
  '@/lib/video-terminal-finalizer': { requireVideoPriceSnapshot: (row) => {
    const config = row?.api_protocol_config && typeof row.api_protocol_config === 'object' ? row.api_protocol_config : {};
    const explicitlyFree = config.explicitly_free === true || String(config.billing_mode || '').trim().toLowerCase() === 'free';
    const parseMoney = (value) => value === null || value === undefined || value === '' ? Number.NaN : Number(value);
    const price = parseMoney(row?.price_per_use);
    const cost = parseMoney(row?.cost_price);
    if ((!explicitlyFree && (!Number.isFinite(price) || price <= 0)) || !Number.isFinite(cost) || cost < 0) throw new Error('VIDEO_PRICE_NOT_READY');
    return { priceYuan: explicitlyFree ? 0 : price, costPriceYuan: cost };
  } },
};
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, {
    exports: loaded.exports, module: loaded,
    require: (name) => mocks[name] || (name.startsWith('@/') ? load('src/' + name.slice(2) + '.ts') : requireNative(name)),
    fetch: async (url, options) => { state.calls.push({ url, options }); return state.responder(url, options); },
    Request, Response, Headers, URL, AbortSignal, Date, Number, Object, Set, Map, Error, Buffer,
    console: { log() {}, warn() {}, error() {} }, process: { env: { NODE_ENV: 'test', PUBLIC_MODEL_ID_SECRET: 'fixture-public-model-id-secret' } },
  });
  return loaded.exports;
}
const gate = load('src/lib/model-activation-gate.ts');
const publicRoute = load('src/app/api/video/models/route.ts');
const testRoute = load('src/app/api/admin/video-models/test/route.ts');
const base = (id) => ({ id, name: 'Fixture ' + id, model_name: 'fixture-video', provider: 'fixture', protocol_type: 'openai_compatible', api_endpoint: 'https://provider.example/v1', api_key: 'fixture-private-key', price_per_use: 0.2, cost_price: 0.1, is_active: true, is_hidden: false, supports_image_input: true, api_protocol_config: { workspace_surfaces: ['ai-video', 'storyboard'] }, sort_order: 1, total_requests: 1, success_count: 1 });
const healthy = (channel_id) => ({ channel_id, is_healthy: true, consecutive_failures: 0, last_success_at: '2026-09-02T12:00:00Z' });
const getResponse = (surface) => publicRoute.GET(new Request('http://127.0.0.1:5000/api/video/models' + (surface === undefined ? '' : '?surface=' + encodeURIComponent(surface))));
const getModels = async (surface) => (await getResponse(surface)).json();
const post = (body, raw = false) => testRoute.POST(new Request('http://127.0.0.1:5000/api/admin/video-models/test', { method: 'POST', headers: { authorization: 'fixture-normal-session', 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) }));
let passed = 0;
async function test(name, run) { state.calls = []; state.admin = true; state.healthError = null; state.modelError = null; await run(); passed++; console.log('PASS ' + name); }

await test('health history does not hide configured active models from public creation workspaces', async () => {
  state.models = [base('healthy'), base('paused'), base('unverified'), base('null-health')];
  state.health = [healthy('healthy'), { ...healthy('paused'), is_healthy: false, consecutive_failures: 3, last_fail_at: new Date().toISOString() }, { ...healthy('null-health'), is_healthy: null }];
  for (const surface of [undefined, '', 'video-page', 'storyboard-workbench', 'film-studio']) {
    const body = await getModels(surface);
    const expectedCount = surface === 'film-studio' ? 0 : 4;
    assert.equal(body.models.length, expectedCount, `surface=${String(surface)}`);
    assert.equal(body.models.filter(m => m.capabilities.available).length, surface === 'film-studio' ? 0 : 4);
    assert.doesNotMatch(JSON.stringify(body), /fixture-private-key|provider\.example|api_endpoint|api_key/u);
  }
});
await test('health lookup errors do not block configured active models', async () => {
  state.models = [base('healthy')]; state.healthError = { message: 'fixture schema failure' };
  for (const surface of [undefined, 'video-page', 'storyboard-workbench', 'unknown-surface']) {
    const response = await getResponse(surface); assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.models.length, 1);
    assert.equal(body.models.filter(m => m.capabilities.available).length, 1);
    assert.doesNotMatch(JSON.stringify(body), /fixture schema failure/u);
  }
});
await test('stale gate evidence stays diagnostic while current configured binding remains usable', async () => {
  const accepted = base('accepted'); accepted.api_protocol_config = gate.makePendingVideoProtocolConfig(accepted.api_protocol_config);
  const check = { evidenceRef: 'fixture-evidence' };
  const evidence = gate.issueVideoModelAcceptanceEvidence(accepted, { secretResolution: check, endpointConnectivity: check, protocolFixture: check, canary: check, resultPersistence: check }, { issuedBy: 'fixture-issuer' });
  accepted.api_protocol_config = gate.persistVideoModelAcceptanceEvidence(accepted.api_protocol_config, evidence);
  state.models = [accepted]; state.health = [healthy('accepted')];
  for (const surface of [undefined, 'video-page', 'storyboard-workbench', 'unknown-surface']) assert.equal((await getModels(surface)).models.length, 1);
  state.models = [{ ...accepted, api_endpoint: 'https://changed.example/v1' }];
  assert.equal((await getModels()).models[0].capabilities.available, true);
  assert.equal((await getModels('video-page')).models.length, 1);
  assert.equal((await getModels('unknown-surface')).models[0].capabilities.available, true);
  state.models = [{ ...accepted, model_name: 'other-video' }]; assert.equal((await getModels('video-page')).models.length, 1);
});
await test('missing sale price or supplier cost stays visible but disabled in the public video creation catalog', async () => {
  state.models = [{ ...base('missing-sale'), price_per_use: null }, { ...base('missing-cost'), cost_price: null }];
  state.health = state.models.map((row) => healthy(row.id));
  const body = await getModels('video-page');
  assert.equal(body.models.length, 2);
  assert.ok(body.models.every((model) => model.capabilities.available === false));
  assert.ok(body.models.every((model) => model.capabilities.priceReady === false));
  assert.doesNotMatch(JSON.stringify(body), /成本价|销售价|管理员|canary|上游/u);
});
await test('quota remains selectable, pending remains visible but blocked, manual hiding remains respected', async () => {
  state.models = [base('quota'), { ...base('pending'), is_active: false }, { ...base('manual-hidden'), is_hidden: true }];
  state.health = [{ ...healthy('quota'), is_healthy: false, last_error: 'user quota is not enough', consecutive_failures: 1, last_fail_at: new Date().toISOString() }, healthy('pending')];
  const body = await getModels('video-page'); assert.equal(body.models.length, 2);
  const quota = body.models.find(m => m.capabilities.available === true);
  assert.ok(quota);
  assert.equal(quota.capabilities.available, true);
  assert.equal(quota.capabilities.availabilityMessage, '');
  const pending = body.models.find(m => m.id !== quota.id);
  assert.equal(pending.capabilities.available, false);
  assert.equal(pending.capabilities.generationReady, false);
  assert.doesNotMatch(JSON.stringify(body), /待充值|余额|额度|管理员|canary|渠道连续失败|配置保留/u);
});
await test('provider token billing stays visible and cannot be presented as flat per-use pricing', async () => {
  state.models = [{ ...base('provider-token'), api_protocol_config: {
    workspace_surfaces: ['ai-video', 'storyboard'],
    provider_billing_unit: 'token',
    billing_unit: 'per_use',
    public_billing_pending: true,
  } }];
  state.health = [healthy('provider-token')];
  for (const surface of ['video-page', 'storyboard-workbench']) {
    const body = await getModels(surface);
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].capabilities.available, false);
    assert.equal(body.models[0].capabilities.priceReady, false);
    assert.equal(body.models[0].capabilities.generationReady, false);
    assert.match(body.models[0].capabilities.availabilityMessage, /Token.*精确结算/u);
  }
});
await test('surface capability filtering remains narrower than the generic healthy catalog', async () => {
  state.models = [base('image-capable'), { ...base('text-only'), supports_image_input: false }, { ...base('digital-human'), name: 'Fixture talking-head', api_protocol_config: { workspace_surfaces: ['digital-human'] } }, { ...base('legacy-retalk'), protocol_type: 'dashscope_video_retalk', name: 'Legacy Retalk', api_protocol_config: {} }]; state.health = state.models.map(row => healthy(row.id));
  assert.equal((await getModels()).models.length, 4); assert.equal((await getModels('video-page')).models.length, 2); assert.equal((await getModels('storyboard-workbench')).models.length, 1); assert.equal((await getModels('digital-human')).models.length, 2);
});
await test('an empty capability selection stays empty and model lookup failure returns a friendly 503', async () => {
  state.models = []; state.health = []; assert.equal((await getModels()).models.length, 0); state.modelError = { message: 'PRIVATE_DATABASE_ERROR' }; const response = await getResponse(); assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.code, 'VIDEO_MODEL_CATALOG_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(body), /PRIVATE/u);
});
await test('unauthorized connection checks issue no upstream requests', async () => { state.admin = false; assert.equal((await post({})).status, 403); assert.equal(state.calls.length, 0); });
await test('invalid JSON and unknown stored models never use supplied fallback credentials', async () => {
  assert.equal((await post('{', true)).status, 400); state.models = [];
  assert.equal((await post({ model_id: 'missing', api_endpoint: 'https://other.example', api_key: 'fixture-key' })).status, 404); assert.equal(state.calls.length, 0);
});
await test('a recognized model directory is connection evidence only', async () => {
  state.models = [base('stored')]; state.responder = async () => Response.json({ data: [{ id: 'fixture-video' }] });
  const body = await (await post({ model_id: 'stored' })).json(); assert.equal(body.success, true); assert.equal(body.modelListed, true);
  assert.equal(body.checkKind, 'connection'); assert.equal(body.generationVerified, false); assert.equal(body.healthUpdated, false); assert.equal(body.activationChanged, false);
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].options.method, 'GET');
});
await test('a reachable directory missing the target does not confirm model usability', async () => {
  state.responder = async () => Response.json({ data: [{ id: 'different-model' }] });
  const body = await (await post({ model_id: 'stored' })).json(); assert.equal(body.success, false); assert.equal(body.connectionOk, true); assert.equal(body.modelListed, false);
});
await test('HTTP errors and credential resolution never expose raw provider details', async () => {
  state.responder = async () => new Response('PRIVATE_UPSTREAM_BODY_AND_TOKEN', { status: 403 });
  const rejected = await (await post({ model_id: 'stored' })).json(); assert.equal(rejected.success, false); assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE|fixture-private-key/u);
  state.models = [{ ...base('stored'), api_key: 'missing-reference' }];
  const missing = await (await post({ model_id: 'stored' })).json(); assert.equal(missing.code, 'PROVIDER_SECRET_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(missing), /PRIVATE_REFERENCE/u);
});
await test('HTTP 403 account arrears remain a funding diagnostic and never disable the model', async () => {
  state.models = [base('stored')];
  state.responder = async () => new Response(JSON.stringify({ error: { message: 'Arrearage: insufficient balance' } }), { status: 403 });
  const body = await (await post({ model_id: 'stored' })).json();
  assert.equal(body.success, true);
  assert.equal(body.connectionOk, true);
  assert.equal(body.diagnosticCode, 'UPSTREAM_BALANCE');
  assert.equal(body.fundingRequired, true);
  assert.equal(body.healthUpdated, false);
  assert.equal(body.activationChanged, false);
  assert.doesNotMatch(JSON.stringify(body), /Arrearage|insufficient balance/u);
});
await test('malformed response and timeout remain non-mutating failures', async () => {
  state.models = [base('stored')]; state.responder = async () => new Response('<html>not a directory</html>');
  assert.equal((await (await post({ model_id: 'stored' })).json()).success, false);
  state.responder = async () => { const error = new Error('PRIVATE_TIMEOUT_DETAIL'); error.name = 'TimeoutError'; throw error; };
  const body = await (await post({ model_id: 'stored' })).json(); assert.equal(body.code, 'CONNECTION_TIMEOUT'); assert.doesNotMatch(JSON.stringify(body), /PRIVATE_TIMEOUT/u);
});
await test('AutoDL metadata success cannot mask an auth service failure', async () => {
  state.models = [{ ...base('stored'), protocol_type: 'autodl_comfyui_workflow' }]; let calls = 0;
  state.responder = async () => ++calls === 1 ? Response.json({ ok: true }) : new Response('PRIVATE_FAILURE', { status: 503 });
  const body = await (await post({ model_id: 'stored' })).json(); assert.equal(body.success, false); assert.equal(body.status, 503); assert.equal(body.generationVerified, false);
  assert.ok(state.calls.every((call) => call.options.method === 'GET'));
});
console.log(JSON.stringify({ passed, failed: 0, realUpstreamRequests: 0, databaseWrites: 0 }));
