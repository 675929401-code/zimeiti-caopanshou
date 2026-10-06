import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const state = { models: [], health: [], writes: 0, authStatus: 200, lookupError: false, commitThenThrow: false };
function query(table) {
  const predicates = [];
  let inserted;
  const resolve = () => {
    if (state.lookupError) return { data: null, error: { code: 'FIXTURE_LOOKUP_ERROR', message: 'PRIVATE_DETAIL' } };
    return { data: (table === 'video_models' ? state.models : state.health).filter((row) => predicates.every((test) => test(row))), error: null };
  };
  return {
    select() { return this; }, order() { return this; },
    eq(key, value) { predicates.push((row) => row[key] === value); return this; },
    maybeSingle() { const result = resolve(); return Promise.resolve({ ...result, data: result.data?.[0] || null }); },
    then(yes, no) { return Promise.resolve(resolve()).then(yes, no); },
    insert(value) { assert.equal(table, 'video_channel_health'); inserted = structuredClone(value); return this; },
    single() {
      assert.ok(inserted); state.writes++;
      if (state.health.some((row) => row.channel_id === inserted.channel_id)) return Promise.resolve({ data: null, error: { code: '23505' } });
      state.health.push(inserted);
      if (state.commitThenThrow) return Promise.reject(new Error('PRIVATE_CONNECTION_DETAILS'));
      return Promise.resolve({ data: inserted, error: null });
    },
    update() { throw new Error('UNEXPECTED_UPDATE'); }, upsert() { throw new Error('UNEXPECTED_UPSERT'); },
  };
}
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, {
    exports: loaded.exports, module: loaded,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/lib/auth') return { getTokenFromHeaders: (headers) => headers.get('authorization') };
      if (name === '@/lib/admin-auth') return { authorizeAdminToken: async () => state.authStatus === 200 ? { ok: true, actor: { role: 'admin' } } : { ok: false, status: state.authStatus, code: 'ADMIN_DENIED', error: '无权限' } };
      if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => ({ from: query }) };
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts');
      return nativeRequire(name);
    },
    Date, Map, Set, URL, Number, Object, Math, Error,
    fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); },
  });
  return loaded.exports;
}
const route = load('src/app/api/video/channel-health/route.ts');
const circuit = load('src/lib/video-channel-health-circuit.ts');
const model = { id: 'fixture-channel', name: 'Fixture', model_name: 'fixture-video', api_endpoint: ['https://', 'user:PRIVATE_URL_PASSWORD@provider.example/v1?key=PRIVATE_URL_QUERY'].join(''), is_active: true };
const baseHealth = () => ({ channel_id: model.id, is_healthy: false, total_requests: 0, success_count: 0, fail_count: 0, timeout_count: 0, avg_response_ms: 0, consecutive_failures: 0, last_success_at: null, last_fail_at: null, last_error: null, updated_at: new Date().toISOString() });
const get = () => route.GET(new Request('http://127.0.0.1:5000/api/video/channel-health'));
const post = (body = { action: 'prepare_validation', channelId: model.id }) => route.POST(new Request('http://127.0.0.1:5000/api/video/channel-health', { method: 'POST', body: JSON.stringify(body) }));
let passed = 0;
async function test(name, run) {
  Object.assign(state, { models: [structuredClone(model)], health: [], writes: 0, authStatus: 200, lookupError: false, commitThenThrow: false });
  await run(); passed++; console.log('PASS ' + name);
}

await test('current administrator authorization blocks reads and preparation before queries', async () => {
  for (const status of [401, 403, 503]) { state.authStatus = status; assert.equal((await get()).status, status); assert.equal((await post()).status, status); }
  assert.equal(state.writes, 0);
});
await test('unrecorded active models remain visible and ordinary submission stays available', async () => {
  state.models.push({ ...model, id: 'inactive', is_active: false });
  const body = await (await get()).json(); assert.equal(body.channels.length, 1);
  const channel = body.channels[0]; assert.equal(channel.validationPreparationRequired, true); assert.equal(channel.healthRecorded, false); assert.equal(channel.productionBlocked, false); assert.equal(channel.recoveryCanaryEligible, false); assert.equal(channel.recoveryKey, null);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_URL/u); assert.equal(state.writes, 0);
});
await test('preparation persists only a zero-outcome record and gives one stable epoch key', async () => {
  const response = await post(); assert.equal(response.status, 201); const body = await response.json();
  assert.equal(body.generationSubmitted, false); assert.equal(body.generationVerified, false); assert.equal(state.writes, 1);
  const record = state.health[0]; assert.equal(record.is_healthy, false);
  for (const key of ['total_requests', 'success_count', 'fail_count', 'timeout_count', 'consecutive_failures']) assert.equal(record[key], 0);
  for (const key of ['last_success_at', 'last_fail_at', 'last_error']) assert.equal(record[key], null);
  assert.ok(Date.parse(record.updated_at)); assert.equal(body.channel.circuitState, 'unverified'); assert.equal(body.channel.productionBlocked, false); assert.equal(body.channel.recoveryCanaryEligible, true);
  const readback = await (await get()).json(); assert.equal(readback.channels[0].recoveryKey, body.channel.recoveryKey);
  const authorization = { decision: circuit.evaluateVideoChannelCircuit(record), userRole: 'admin', requested: true, recoveryKey: body.channel.recoveryKey, clientRequestId: body.channel.recoveryKey, confirmation: circuit.VIDEO_CHANNEL_RECOVERY_CONFIRMATION };
  assert.equal(circuit.authorizeVideoChannelRecoveryCanary(authorization).ok, true);
  for (const patch of [{ userRole: 'student' }, { requested: false }, { confirmation: 'no' }, { clientRequestId: 'different-key' }, { recoveryKey: 'old-epoch' }]) assert.equal(circuit.authorizeVideoChannelRecoveryCanary({ ...authorization, ...patch }).ok, false);
});
await test('repeated preparation never resets successful or failed history', async () => {
  for (const health of [baseHealth(), { ...baseHealth(), is_healthy: true, total_requests: 1, success_count: 1, last_success_at: new Date().toISOString() }, { ...baseHealth(), total_requests: 1, fail_count: 1, consecutive_failures: 1, last_fail_at: new Date().toISOString() }]) {
    state.health = [structuredClone(health)]; const before = JSON.stringify(state.health);
    assert.equal((await post()).status, 409); assert.equal(JSON.stringify(state.health), before);
  }
  assert.equal(state.writes, 0);
});
await test('two concurrent preparations use insert uniqueness and retain the winning key', async () => {
  const results = await Promise.all([post(), post()]); assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.equal(state.health.length, 1); assert.equal(state.writes, 2);
  const success = await results.find((response) => response.status === 201).json(); const readback = await (await get()).json();
  assert.equal(readback.channels[0].recoveryKey, success.channel.recoveryKey);
});
await test('lost preparation response remains unknown and readback does not rotate the committed epoch', async () => {
  state.commitThenThrow = true; const response = await post(); assert.equal(response.status, 503); const body = await response.json();
  assert.equal(body.code, 'CHANNEL_PREPARATION_UNKNOWN'); assert.doesNotMatch(JSON.stringify(body), /PRIVATE/u); assert.equal(state.health.length, 1);
  const key = circuit.buildVideoChannelRecoveryKey(state.health[0]); state.commitThenThrow = false;
  assert.equal((await post()).status, 409); assert.equal(circuit.buildVideoChannelRecoveryKey(state.health[0]), key); assert.equal(state.writes, 1);
});
await test('invalid input, inactive models, missing models, and schema failures cannot prepare', async () => {
  assert.equal((await post({ action: 'enable', channelId: model.id })).status, 400);
  state.models[0].is_active = false; assert.equal((await post()).status, 409);
  state.models = []; assert.equal((await post()).status, 404);
  state.lookupError = true; assert.equal((await post()).status, 503); assert.equal((await get()).status, 503); assert.equal(state.writes, 0);
});
await test('partial legacy records and nonzero evidence cannot impersonate preparation', async () => {
  const record = baseHealth();
  for (const patch of [{ total_requests: undefined }, { total_requests: 1 }, { success_count: 1 }, { fail_count: 1 }, { timeout_count: 1 }, { last_error: 'provider failed' }, { last_success_at: '' }, { updated_at: null }]) {
    assert.equal(circuit.evaluateVideoChannelCircuit({ ...record, ...patch }).canaryEligible, false);
  }
  assert.equal(circuit.evaluateVideoChannelCircuit(null).canaryEligible, false);
});
await test('actual failure uses cooldown and actual success closes the circuit', async () => {
  const failed = { ...baseHealth(), total_requests: 1, fail_count: 1, consecutive_failures: 1, last_fail_at: new Date().toISOString() };
  assert.equal(circuit.evaluateVideoChannelCircuit(failed).canaryEligible, false);
  const expired = circuit.evaluateVideoChannelCircuit(failed, Date.now() + circuit.VIDEO_CHANNEL_RECOVERY_COOLDOWN_MS + 1000);
  assert.equal(expired.canaryEligible, true); assert.equal(expired.blocksProduction, true);
  const completed = circuit.evaluateVideoChannelCircuit({ ...failed, is_healthy: true, consecutive_failures: 0, success_count: 1, last_success_at: new Date().toISOString() });
  assert.equal(completed.blocksProduction, false); assert.equal(completed.canaryEligible, false);
});
console.log(JSON.stringify({ passed, failed: 0, realUpstreamRequests: 0, realDatabaseWrites: 0 }));
