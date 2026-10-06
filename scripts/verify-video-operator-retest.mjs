import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire = createRequire(import.meta.url);
const sourceRoot = process.env.VIDEO_RETEST_SOURCE_ROOT || '.';
const cache = new Map();
const state = { admin: true, writes: 0, health: [] };
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    module: loaded, exports: loaded.exports, Date, Number, Object, Math, Set, Map, URL, Error, RegExp,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/lib/auth') return { getTokenFromHeaders: () => 'fixture-session' };
      if (name === '@/lib/admin-auth') return { authorizeAdminToken: async () => state.admin ? { ok: true } : { ok: false, error: '无权限', code: 'ADMIN_REQUIRED', status: 403 } };
      if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => ({ from(table) { return { select() { return this; }, order() { return this; }, then(yes, no) { return Promise.resolve({ data: table === 'video_channel_health' ? state.health : [{ id: 'fixture-channel', is_active: true, name: 'Fixture' }], error: null }).then(yes, no); }, insert() { state.writes++; throw new Error('WRITE_FORBIDDEN'); }, update() { state.writes++; throw new Error('WRITE_FORBIDDEN'); } }; } }) };
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts');
      return nativeRequire(name);
    },
    fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); },
  });
  return loaded.exports;
}
const circuit = load('src/lib/video-channel-health-circuit.ts');
const route = load('src/app/api/video/channel-health/route.ts');
const failed = { channel_id: 'fixture-channel', is_healthy: false, total_requests: 4, success_count: 1, fail_count: 3, timeout_count: 0, avg_response_ms: 500, consecutive_failures: 3, last_success_at: '2026-09-01T10:00:00Z', last_fail_at: new Date().toISOString(), last_error: 'Download source video failed: HTTP 403 Forbidden', updated_at: new Date().toISOString() };
const get = () => route.GET(new Request('http://127.0.0.1:5000/api/video/channel-health'));
const authorize = (decision, patch = {}) => circuit.authorizeVideoChannelRecoveryCanary({ decision, userRole: 'admin', requested: true, operatorRetest: true, operatorRetestReason: '修正输入素材授权并验证媒体可读', recoveryKey: decision.operatorRetestKey, clientRequestId: decision.operatorRetestKey, confirmation: circuit.VIDEO_CHANNEL_RECOVERY_CONFIRMATION, ...patch });
let passed = 0;
async function test(name, run) { state.admin = true; state.writes = 0; state.health = [structuredClone(failed)]; await run(); passed++; console.log('PASS ' + name); }
await test('post-repair retest leaves circuit blocked, cooldown intact, and failure history unchanged', async () => {
  const before = JSON.stringify(state.health[0]); const decision = circuit.evaluateVideoChannelCircuit(state.health[0]);
  assert.equal(decision.state, 'open'); assert.equal(decision.blocksProduction, true); assert.equal(decision.canaryEligible, false); assert.equal(decision.recoveryKey, null); assert.ok(decision.operatorRetestKey);
  assert.equal(authorize(decision).ok, true); assert.equal(JSON.stringify(state.health[0]), before); assert.equal(state.writes, 0);
});
await test('ordinary requests, nonadmins, missing confirmation, and missing reason remain denied', async () => {
  const decision = circuit.evaluateVideoChannelCircuit(failed);
  for (const patch of [{ requested: false }, { userRole: 'student' }, { confirmation: '' }, { operatorRetest: false }, { operatorRetestReason: '' }, { operatorRetestReason: '  ' }, { operatorRetestReason: 42 }, { operatorRetestReason: 'x'.repeat(501) }]) assert.equal(authorize(decision, patch).ok, false);
});
await test('wrong epoch keys and new arbitrary client keys cannot authorize', async () => {
  const decision = circuit.evaluateVideoChannelCircuit(failed);
  assert.equal(authorize(decision, { recoveryKey: 'old-key', clientRequestId: 'old-key' }).ok, false);
  assert.equal(authorize(decision, { clientRequestId: 'different-new-key' }).ok, false);
  const next = circuit.evaluateVideoChannelCircuit({ ...failed, consecutive_failures: 4, updated_at: new Date(Date.now() + 1000).toISOString() });
  assert.notEqual(next.operatorRetestKey, decision.operatorRetestKey);
  assert.equal(authorize(next, { recoveryKey: decision.operatorRetestKey, clientRequestId: decision.operatorRetestKey }).ok, false);
});
await test('explicit retest and cooldown recovery share one key for the same epoch', async () => {
  const before = circuit.evaluateVideoChannelCircuit(failed); const after = circuit.evaluateVideoChannelCircuit(failed, Date.now() + circuit.VIDEO_CHANNEL_RECOVERY_COOLDOWN_MS + 1000);
  assert.equal(before.operatorRetestKey, after.recoveryKey); assert.equal(after.operatorRetestKey, after.recoveryKey); assert.equal(after.blocksProduction, true);
});
await test('healthy, missing, prepared, and malformed histories cannot gain operator retest', async () => {
  for (const record of [null, { ...failed, is_healthy: true }, { ...failed, last_fail_at: null }, { ...failed, consecutive_failures: 0 }, { ...failed, updated_at: null }]) {
    const decision = circuit.evaluateVideoChannelCircuit(record); assert.equal(Boolean(decision.operatorRetestKey), false); assert.equal(authorize(decision).ok, false);
  }
});
await test('the admin read returns retest metadata without writing or leaking provider detail', async () => {
  const body = await (await get()).json(); assert.equal(body.channels[0].operatorRetestKey, circuit.evaluateVideoChannelCircuit(failed).operatorRetestKey);
  assert.equal(body.channels[0].productionBlocked, true); assert.equal(body.channels[0].isHealthy, false); assert.equal(body.channels[0].lastErrorCode, 'VIDEO_INPUT_INVALID'); assert.equal(state.writes, 0);
  state.admin = false; const response = await get(); assert.equal(response.status, 403); assert.equal(Object.hasOwn(await response.json(), 'channels'), false);
});
await test('explicit media download 403 is input access failure instead of channel authentication', async () => {
  for (const message of ['Download source video failed: HTTP 403 Forbidden https://asset.example/x?token=PRIVATE', '403 returned when fetching reference image', '读取视频素材失败：HTTP 403', '素材下载返回403']) {
    const result = circuit.sanitizeVideoChannelError(message); assert.equal(result.code, 'VIDEO_INPUT_INVALID'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|asset\.example/u);
  }
});
await test('generic or explicit credential 403 keeps authentication classification', async () => {
  for (const message of ['HTTP 403 Forbidden', 'invalid API key HTTP 403', 'video provider returned 403', 'download model list failed HTTP 403', 'download source video failed: invalid API key HTTP 403']) assert.equal(circuit.sanitizeVideoChannelError(message).code, 'UPSTREAM_AUTH');
  assert.notEqual(circuit.sanitizeVideoChannelError('download source video failed HTTP 404').code, 'VIDEO_INPUT_INVALID');
});
console.log(JSON.stringify({ passed, failed: 0, sourceRoot, realUpstreamRequests: 0, realDatabaseWrites: 0 }));
