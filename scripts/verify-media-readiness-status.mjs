import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(file, modules, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, URL, Date, AbortSignal,
    require(id) { assert.ok(Object.hasOwn(modules, id), `Unmocked dependency ${id}`); return modules[id]; }, ...globals });
  return module.exports;
}
const next = { NextResponse: { json: (value, init) => Response.json(value, init) } };
const request = (query = '') => ({ nextUrl: new URL('http://fixture.invalid/?' + query) });
let cases = 0;
async function test(name, fn) { await fn(); cases++; console.log('PASS ' + name); }

function extraction({ state = 'failed_unknown', evidence = {}, operations = [], owner = 'fixture-user', authenticated = true } = {}) {
  let reads = 0;
  const db = { from(table) {
    reads++;
    const filters = {};
    const q = { select: () => q, eq: (k,v) => { filters[k] = v; return q; }, in: () => q, like: () => q,
      maybeSingle: async () => ({ data: filters.user_id === owner ? { state, billing_evidence: evidence, client_request_id: 'fixture-request', request_kind: 'single' } : null }),
      then(resolve) { assert.equal(table, 'wallet_operations'); assert.equal(filters.user_id, 'fixture-user'); resolve({ data: operations }); } };
    return q;
  } };
  const modules = { 'next/server': next, '@/lib/api-middleware': { withAuth: async (_req, fn) => authenticated ? fn({ id: 'fixture-user' }, db) : Response.json({}, { status: 401 }) },
    '@/lib/extraction-status-billing': { extractionBillingPrefix: () => 'fixture-prefix' },
    '@/lib/extraction-history': {
      extractionRetryInputFromSnapshot: () => null,
      sanitizeOwnedExtractionResponse: (value) => value,
    } };
  const route = load('src/app/api/extract/status/route.ts', modules);
  return { get: (id = 'a'.repeat(64)) => route.GET(request('attempt_id=' + id)), reads: () => reads };
}
await test('unknown request distinguishes zero wallet charge from unresolved request result', async () => {
  const body = await (await extraction().get()).json();
  assert.equal(body.billingConfirmed, false); assert.equal(body.requiresReconciliation, true); assert.equal(body.canResubmit, false);
  assert.equal(body.platformChargeRecorded, false); assert.equal(body.platformWalletOperationCount, 0);
  assert.equal(body.quoteSnapshotPresent, false);
  assert.match(body.billingMessage, /用户钱包未发现扣费记录/); assert.match(body.billingMessage, /未保存报价快照/);
  assert.match(body.billingMessage, /请勿重复提交/);
});
await test('recorded no-charge evidence still prevents unknown provider replay', async () => {
  const body = await (await extraction({ evidence: { charged: false } }).get()).json();
  assert.equal(body.billingConfirmed, true); assert.equal(body.canResubmit, false); assert.equal(body.billingMessage, '本次未扣费');
  assert.equal(body.platformChargeRecorded, false);
});
await test('legacy quote snapshot is reported without replacing it with the current configured price', async () => {
  const body = await (await extraction({ evidence: { price: .02 } }).get()).json();
  assert.equal(body.quoteSnapshotPresent, true); assert.doesNotMatch(body.billingMessage, /未保存报价快照/);
  assert.match(body.billingMessage, /用户钱包未发现扣费记录/); assert.equal(body.billingConfirmed, false);
});
await test('historical charged flag without wallet operation is described as a mismatch', async () => {
  const body = await (await extraction({ evidence: { charged: true, price: .02 } }).get()).json();
  assert.equal(body.platformChargeRecorded, false); assert.equal(body.billingConfirmed, false);
  assert.match(body.billingMessage, /曾标记已扣费/); assert.match(body.billingMessage, /钱包未发现对应扣费流水/);
});
await test('completed original charge and refund reconcile to net platform amount', async () => {
  const body = await (await extraction({ state: 'succeeded', operations: [{ amount: .04, operation_kind: 'cash_charge', status: 'completed' }, { amount: .02, operation_kind: 'cash_refund', status: 'completed' }] }).get()).json();
  assert.equal(body.netCharged, .02); assert.equal(body.billingConfirmed, true); assert.equal(body.platformChargeRecorded, true); assert.equal(body.platformRefundRecorded, true);
});
await test('fully refunded charge reports zero net charge without calling it an uncharged request', async () => {
  const body = await (await extraction({ state: 'failed', operations: [{ amount: .02, operation_kind: 'cash_charge', status: 'completed' }, { amount: .02, operation_kind: 'cash_refund', status: 'completed' }] }).get()).json();
  assert.equal(body.netCharged, 0); assert.equal(body.billingMessage, '费用已退回，当前净扣费 ¥0.00');
});
await test('pending ledger does not assert confirmed settlement', async () => {
  const body = await (await extraction({ operations: [{ status: 'pending' }] }).get()).json(); assert.equal(body.billingConfirmed, false);
});
await test('authentication, owner filter, and invalid IDs prevent status disclosure', async () => {
  const anonymous = extraction({ authenticated: false }); assert.equal((await anonymous.get()).status, 401); assert.equal(anonymous.reads(), 0);
  assert.equal((await extraction({ owner: 'another-user' }).get()).status, 404);
  const invalid = extraction(); assert.equal((await invalid.get('invalid')).status, 400); assert.equal(invalid.reads(), 0);
});

function voice({ configured = true, schema = 'ready' } = {}) {
  const names = ['begin_voice_generation_atomic','finalize_voice_generation_atomic','refund_voice_generation_atomic','reserve_voice_training_authorization_atomic','release_voice_training_authorization_atomic','finalize_voice_training_authorization_atomic','claim_voice_training_provider_call_atomic','mark_voice_training_provider_attempt_atomic','release_voice_training_terminal_atomic','finalize_voice_training_ready_atomic','apply_wallet_operation_atomic'];
  let reads = 0;
  const forbidden = new Proxy({}, { get: () => () => { throw new Error('Provider/lifecycle call forbidden in preflight'); } });
  const db = { from() { const q = { select: () => q, limit: () => q, abortSignal: async () => ({ error: null }) }; return q; } };
  const modules = { 'next/server': next, '@/lib/api-middleware': forbidden, '@/lib/server/voice-provider-config': { inspectVolcanoVoiceProviderConfig: async () => ({ configured, source: 'fixture' }) },
    '@/lib/server/voice-training-lifecycle': forbidden, '@/lib/voice-training-status': forbidden, '@/lib/vs/volcengine': forbidden, '@/storage/database/supabase-client': { getSupabaseClient: () => db } };
  const route = load('src/app/api/voice/status/route.ts', modules, { process: { env: { COZE_SUPABASE_URL: 'http://database.invalid/', COZE_SUPABASE_SERVICE_ROLE_KEY: 'fixture' } },
    fetch: async (url, options) => { assert.equal(new URL(url).hostname, 'database.invalid'); assert.equal(options.method, 'GET'); reads++;
      if (schema === 'unavailable') return Response.json({}, { status: 503 });
      return Response.json({ paths: Object.fromEntries((schema === 'missing' ? names.slice(1) : names).map(name => ['/rpc/' + name, { post: {} }])) }); } });
  return { get: (provider = 'volcano') => route.GET(request('provider=' + provider)), reads: () => reads };
}
await test('configured voice preflight explicitly leaves upstream permissions unverified', async () => {
  const f = voice(); const body = await (await f.get()).json();
  assert.equal(body.data.canSubmit, true); assert.equal(body.data.configurationReady, true);
  assert.equal(body.data.upstreamChecked, false); assert.equal(body.data.generationVerified, false); assert.equal(body.data.readinessScope, 'configuration'); assert.equal(f.reads(), 1);
});
for (const state of [{ configured: false }, { schema: 'missing' }, { schema: 'unavailable' }]) await test('voice blocks submission on prerequisite failure ' + JSON.stringify(state), async () => {
  const body = await (await voice(state).get()).json(); assert.equal(body.data.canSubmit, false); assert.equal(body.data.upstreamCalls, 0);
});
await test('unsupported provider is rejected before database preflight', async () => {
  const f = voice(); assert.equal((await f.get('unsupported')).status, 400); assert.equal(f.reads(), 0);
});
console.log(JSON.stringify({ passed: true, scenarios: cases, actualStatusHandlers: true, realNetworkCalls: 0, databaseWrites: 0 }));
