import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const clone = value => structuredClone(value);
const state = {};
let billing;
const db = {
  from(table) {
    const filters = []; let patch;
    const query = {
      select() { return query; }, eq(key, value) { filters.push(row => row[key] === value); return query; },
      is(key, value) { filters.push(row => row[key] === value); return query; },
      not(key, operator, value) { if (operator === 'in') { const values = value.slice(1, -1).split(','); filters.push(row => !values.includes(String(row[key]))); } return query; },
      update(value) { patch = value; return query; }, abortSignal() { return query; },
      order() { return query; }, limit() { return query; },
      async result(single = false) {
        const row = table === 'video_tasks' ? state.task : table === 'video_models' ? state.model : null;
        if (!row || !filters.every(filter => filter(row))) return { data: null, error: null };
        if (patch) { state.writes.push(clone(patch)); Object.assign(row, clone(patch)); }
        return { data: single ? clone(row) : [clone(row)], error: null };
      }, maybeSingle() { return query.result(true); }, then(resolve, reject) { return query.result().then(resolve, reject); },
    };
    return query;
  },
  async rpc(name, input) {
    state.rpcs.push({ name, input: clone(input) });
    assert.equal(input.p_task_id, state.task.id); assert.equal(input.p_user_id, state.task.user_id);
    assert.equal(input.p_provider_task_id, state.task.task_id_external);
    if (name === 'record_video_token_usage_v1_atomic') {
      const usage = { totalTokens: input.p_total_tokens, completionTokens: input.p_completion_tokens };
      const actual = billing.calculateVideoTokenCharge(state.task.billing_token_quote, usage);
      if (state.task.billing_token_usage) {
        assert.equal(state.task.billing_token_usage.providerTaskId, state.task.task_id_external);
        assert.equal(state.task.billing_token_usage.totalTokens, usage.totalTokens);
      } else state.task.billing_token_usage = { schema: 'video_token_usage.v1', ...usage,
        providerTaskId: state.task.task_id_external, ...actual, recordedAt: '2026-10-18T12:00:00Z' };
      Object.assign(state.task, { billing_price_yuan: actual.saleAmountYuan, billing_cost_price_yuan: actual.costAmountYuan,
        billing_state: actual.saleAmountYuan > state.task.billing_reserved_yuan ? 'quote_exceeded' : 'billing_pending' });
      return { data: { billing_state: state.task.billing_state, billing_token_usage: clone(state.task.billing_token_usage),
        price_yuan: actual.saleAmountYuan, cost_price_yuan: actual.costAmountYuan }, error: null };
    }
    if (name === 'settle_video_token_task_v1_atomic') {
      assert.ok(state.task.billing_token_usage);
      assert.ok(state.task.billing_price_yuan <= state.task.billing_reserved_yuan);
      if (!state.operation) { state.operation = 'token-operation'; state.charges++; }
      Object.assign(state.task, { billing_state: 'settled', billing_operation_id: state.operation, price_charged: state.task.billing_price_yuan });
      return { data: { success: true, operation_id: state.operation }, error: null };
    }
    if (name === 'finalize_video_generation_task_atomic') {
      if (state.failFinalizeOnce) { state.failFinalizeOnce = false; return { data: null, error: { message: 'fixture-response-loss' } }; }
      const alreadyCompleted = state.task.status === 'completed';
      Object.assign(state.task, { status: 'completed', billing_state: 'settled', billing_operation_id: input.p_billing_operation_id,
        price_charged: state.task.billing_price_yuan, provider_result_url: input.p_stable_storage_url,
        video_url: input.p_stable_storage_url });
      return { data: { status: 'completed', already_completed: alreadyCompleted,
        price_charged: state.task.price_charged, billing_state: 'settled' }, error: null };
    }
    throw Error(`Unexpected RPC ${name}`);
  },
};
function modules() {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017,
    } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, console, URL, URLSearchParams, Response, AbortSignal, Buffer,
      fetch() { throw Error('REAL_NETWORK_FORBIDDEN'); },
      require(name) {
        if (name === 'server-only') return {};
        if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
        if (name.startsWith('node:')) return nativeRequire(name);
        if (name === '@/lib/video-token-billing') return load('src/lib/video-token-billing.ts');
        if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => db, getSupabaseClient: () => db };
        if (name === '@/lib/billing-executor') return { executeCashDeduction: async input => {
          state.fixedDeductions.push(clone(input)); if (!state.operation) { state.operation = 'fixed-operation'; state.charges++; }
          return { success: true, operationId: state.operation };
        } };
        if (name === '@/lib/public-model-dto') return { toPublicModelId: () => 'pm_fixture' };
        if (name === '@/lib/revenue') return { recordRevenue: async input => { state.revenue.push(clone(input)); } };
        if (name === '@/lib/video-access-ticket') return { createVideoAccessUrl: async () => '/api/video/access/fixture' };
        if (name === '@/lib/video-provider-result-url') return { trustedVideoProviderResultHostname: () => 'example.com' };
        if (name === '@/lib/video-terminal-accounting') return { recordVideoTerminalOutcome: async () => {} };
        if (name === '@/lib/video-model-capabilities') return { resolveVideoCharge: () => ({ publicPrice: 1, costPrice: 0.5, billingUnit: 'per_use', billingQuantity: 1, resolution: '720p' }) };
        if (name === '@/lib/video-terminal-finalizer') return load('src/lib/video-terminal-finalizer.ts');
        if (name === '@/lib/video-submission-reconciliation') return { reconcileStaleVideoSubmissionsForUser: async () => {} };
        if (name === '@/lib/video-adapter') return { pollVideoTask: async () => { state.polls++; throw Error('PROVIDER_POLL_FORBIDDEN'); } };
        if (name === '@/lib/video-error-policy') return { classifyVideoProviderError: () => ({ code: 'FIXTURE_ERROR', publicMessage: 'Fixture error' }) };
        if (name.startsWith('@/lib/')) return {};
        throw Error(`Unexpected module ${name}`);
      },
    }, { filename: file });
    return module.exports;
  }
  return { billing: load('src/lib/video-token-billing.ts'), finalizer: load('src/lib/video-terminal-finalizer.ts'),
    status: load('src/lib/video-task-status.ts') };
}
function setup(token = true) {
  const loaded = modules(); billing = loaded.billing;
  const model = { id: 'fixture-model', name: 'Fixture model', api_protocol_config: { provider_billing_unit: 'token',
    token_sale_prices_per_million: { '720p:no_reference_video': 34.914, '720p:reference_video': 21.252 },
    token_cost_prices_per_million: { '720p:no_reference_video': 31.74, '720p:reference_video': 19.32 } } };
  const quote = billing.createVideoTokenQuote(model, { resolution: '720p', hasReferenceVideo: false, maxChargeYuan: 50,
    priceVersion: billing.getVideoTokenPublicPricing(model).priceVersion });
  Object.assign(state, { model, task: { id: 'fixture-internal-task', user_id: 'fixture-user', model_id: model.id,
    task_id_external: 'fixture-provider-task', status: 'processing', billing_unit: token ? 'token' : 'per_use',
    billing_state: 'provider_submitted', billing_price_yuan: token ? 50 : 1, billing_cost_price_yuan: token ? 0 : 0.5,
    billing_reserved_yuan: 50, billing_token_quote: quote, billing_token_usage: null,
    billing_idempotency_key: 'video-terminal:fixture-internal-task', request_fingerprint: 'a'.repeat(64),
    duration_seconds: 6, resolution: '720p', billing_exempt: false, explicitly_free: false, price_charged: 0 },
    rpcs: [], writes: [], charges: 0, operation: null, failFinalizeOnce: false, fixedDeductions: [], revenue: [], polls: 0 });
  return loaded.finalizer;
}
const input = () => ({ taskIdInternal: state.task.id, userId: state.task.user_id, userRole: 'student',
  providerTaskId: state.task.task_id_external, providerVideoUrl: 'https://example.com/video.mp4' });
const usage = { totalTokens: 100_000, completionTokens: 100_000 };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
await test('missing usage preserves supplier URL and never charges or completes', async () => {
  const f = setup(); const result = await f.finalizeVideoGenerationSuccess(input());
  assert.equal(result.code, 'VIDEO_TOKEN_USAGE_PENDING'); assert.equal(state.task.billing_state, 'usage_pending');
  assert.equal(state.task.provider_result_url, input().providerVideoUrl); assert.equal(state.charges, 0);
  assert.equal(state.task.status, 'finalizing'); assert.equal(state.rpcs.length, 0);
});
await test('over-cap usage preserves URL and stops before any wallet settlement', async () => {
  const f = setup(); const result = await f.finalizeVideoGenerationSuccess({ ...input(), usage: { totalTokens: 2_000_000, completionTokens: 2_000_000 } });
  assert.equal(result.code, 'VIDEO_TOKEN_BILLING_REVIEW'); assert.equal(state.task.billing_state, 'quote_exceeded');
  assert.equal(state.task.provider_result_url, input().providerVideoUrl); assert.equal(state.charges, 0);
  assert.equal(state.rpcs.filter(r => r.name === 'settle_video_token_task_v1_atomic').length, 0);
});
await test('actual token bill uses atomic RPC once and completed replay adds no charge', async () => {
  const f = setup(); const first = f.finalizeVideoGenerationSuccess({ ...input(), usage });
  const concurrent = f.finalizeVideoGenerationSuccess({ ...input(), usage });
  assert.equal(first, concurrent); const result = await first;
  assert.equal(result.state, 'completed'); assert.equal(result.priceCharged, 3.49); assert.equal(state.charges, 1);
  assert.equal(state.fixedDeductions.length, 0); assert.equal(state.rpcs.filter(r => r.name === 'settle_video_token_task_v1_atomic').length, 1);
  const replay = await modules().finalizer.finalizeVideoGenerationSuccess(input());
  assert.equal(replay.state, 'completed'); assert.equal(state.charges, 1);
});
await test('restart after settlement response/finalization interruption reuses one wallet operation', async () => {
  const f = setup(); state.failFinalizeOnce = true;
  const pending = await f.finalizeVideoGenerationSuccess({ ...input(), usage }); assert.equal(pending.state, 'billing_pending');
  const resumed = await modules().finalizer.finalizeVideoGenerationSuccess(input());
  assert.equal(resumed.state, 'completed'); assert.equal(state.charges, 1); assert.equal(state.task.billing_operation_id, 'token-operation');
});
await test('mismatched caller provider task is rejected before usage writes or charging', async () => {
  const f = setup(); await assert.rejects(() => f.finalizeVideoGenerationSuccess({ ...input(), providerTaskId: 'different-provider', usage }));
  assert.equal(state.rpcs.length, 0); assert.equal(state.writes.length, 0); assert.equal(state.charges, 0);
});
await test('stored usage from another provider cannot be reused or charged', async () => {
  const f = setup(); state.task.billing_token_usage = { schema: 'video_token_usage.v1', ...usage, providerTaskId: 'different-provider' };
  let result; try { result = await f.finalizeVideoGenerationSuccess(input()); } catch { /* A strict binding rejection is also safe. */ }
  assert.notEqual(result?.state, 'completed'); assert.equal(state.rpcs.length, 0); assert.equal(state.charges, 0);
});
await test('ordinary per-use billing still calls existing cash deduction', async () => {
  const f = setup(false); const result = await f.finalizeVideoGenerationSuccess(input());
  assert.equal(result.state, 'completed'); assert.equal(result.priceCharged, 1);
  assert.equal(state.fixedDeductions.length, 1); assert.equal(state.fixedDeductions[0].amount, 1);
  assert.equal(state.rpcs.some(r => r.name.includes('token')), false); assert.equal(state.charges, 1);
});
await test('read-only owned snapshot explains token pending/review without provider polling or billing', async () => {
  for (const billingState of ['usage_pending', 'quote_exceeded', 'billing_review']) {
    setup(); Object.assign(state.task, { status: 'finalizing', billing_state: billingState,
      provider_result_url: 'https://example.com/video.mp4', error_message: 'INTERNAL_TOKEN_DIAGNOSTIC' });
    const response = await modules().status.readOwnedVideoTaskStatus({ userId: state.task.user_id, role: 'student' },
      new URLSearchParams({ taskId: state.task.task_id_external, modelId: state.task.model_id }));
    assert.equal(response.status, 200); const dto = await response.json();
    assert.equal(dto.status, 'billing_pending');
    assert.equal(dto.processingStage, billingState === 'usage_pending' ? 'billing' : 'billing_review');
    assert.equal(dto.errorCode, billingState === 'usage_pending' ? 'VIDEO_TOKEN_USAGE_PENDING' : 'VIDEO_TOKEN_BILLING_REVIEW');
    assert.equal(dto.videoUrl, ''); assert.equal(dto.priceCharged, 0); assert.equal(dto.providerCompleted, true);
    assert.equal(dto.billingState, billingState); assert.equal(dto.retryable, false);
    assert.ok(dto.message.includes(billingState === 'usage_pending' ? '尚未扣费' : billingState === 'quote_exceeded' ? '扣款上限' : '需要核对'));
    assert.equal(JSON.stringify(dto).includes('INTERNAL_TOKEN_DIAGNOSTIC'), false);
    assert.equal(state.polls, 0); assert.equal(state.charges, 0); assert.equal(state.rpcs.length, 0); assert.equal(state.writes.length, 0);
  }
});
console.log(JSON.stringify({ passed, actualFinalizerModule: true, realNetwork: 0, realDatabaseWrites: 0 }));
