#!/usr/bin/env node
// Executes the actual before/current handlers, shared wallet wrapper, mutation
// helper and audit writer against an isolated deterministic RPC contract store.
// This proves handler behavior, not execution of the candidate SQL migration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const beforeArg = process.argv.find(value => value.startsWith('--before='));
assert.ok(beforeArg, 'Provide the actual pre-edit snapshot directory');
const beforeRoot = path.resolve(root, beforeArg.slice('--before='.length));
assert.ok(beforeRoot.startsWith(path.join(root, '.codex-backups') + path.sep));
const cases = [];
const actor = { id: '11111111-1111-4111-8111-111111111111', userId: '11111111-1111-4111-8111-111111111111', role: 'admin', username: 'fixture' };
const userId = '22222222-2222-4222-8222-222222222222';

function harness(before = false, options = {}) {
  const state = {
    balances: { credits: 100, cash: 100 }, audit: [], operations: new Map(), adjustments: new Map(),
    rpcCalls: [], mutations: 0, updates: 0, warnings: [], queries: [], sequence: 0,
    lostResponse: false, interleaved: false, legacyCreditTransactions: [],
  };
  function atomicWallet(parameters) {
    const key = JSON.stringify([parameters.p_user_id, parameters.p_operation_kind, parameters.p_idempotency_key]);
    const previous = state.operations.get(key);
    if (previous) {
      if (previous.amount !== Number(parameters.p_amount)) return { data: null, error: { code: '22023', message: 'WALLET_IDEMPOTENCY_CONFLICT' } };
      return { data: { ...previous, already_fulfilled: true }, error: null };
    }
    const wallet = parameters.p_operation_kind.startsWith('cash_') ? 'cash' : 'credits';
    const amount = Number(parameters.p_amount);
    const delta = parameters.p_operation_kind.endsWith('_charge') ? -amount : amount;
    const beforeBalance = state.balances[wallet];
    const result = {
      success: true, already_fulfilled: false, operation_id: String(++state.sequence),
      wallet, operation_kind: parameters.p_operation_kind, amount, delta,
      balance_before: beforeBalance, balance_after: beforeBalance + delta,
      metadata: parameters.p_metadata,
    };
    state.balances[wallet] = result.balance_after;
    state.mutations += 1;
    state.operations.set(key, result);
    if (options.interleave && !state.interleaved) {
      state.interleaved = true;
      state.balances[wallet] += 7; // An unrelated committed mutation before audit projection.
    }
    if (options.loseResponse && !state.lostResponse) {
      state.lostResponse = true;
      return { data: null, error: { code: 'NETWORK_ERROR', message: 'fixture response was lost' } };
    }
    if (options.invalidReceipt) return { data: { ...result, balance_before: null }, error: null };
    if (options.wrongAmountReceipt) return { data: { ...result, amount: 3, delta: 3, balance_after: beforeBalance + 3 }, error: null };
    return { data: result, error: null };
  }
  const client = {
    from(table) {
      let operation = 'select';
      let fields = '*';
      let payload;
      const filters = [];
      let limit;
      async function execute() {
        state.queries.push({ table, operation, fields });
        if (table === 'wallet_operations' || table === 'wallet_ledger_entries') {
          assert.equal(operation, 'select'); assert.equal(limit, 0, 'Only zero-row prerequisites are allowed');
          return options.missingSchema ? { data: null, error: { code: 'PGRST205', message: 'fixture absent table' } } : { data: [], error: null };
        }
        if (table === 'balance_audit_log') {
          if (operation === 'insert') {
            if (options.auditReject) throw new Error('PRIVATE_FIXTURE_ERROR');
            if (options.auditError) return { data: null, error: { message: 'PRIVATE_FIXTURE_ERROR' } };
            state.audit.push(structuredClone(payload)); return { error: null };
          }
          const record = state.audit.find(row => filters.every(([key, value]) => row[key] === value));
          return { data: record || null, error: null };
        }
        if (table === 'credit_transactions') {
          assert.equal(operation, 'insert'); state.legacyCreditTransactions.push(payload); return { error: null };
        }
        assert.equal(table, 'users');
        if (operation === 'update') {
          state.updates += 1;
          if ('credits' in payload) state.balances.credits = payload.credits;
          return { error: null };
        }
        return { data: {
          id: userId, username: 'ordinary-fixture-user', display_name: 'fixture',
          credits: state.balances.credits, cash_balance: state.balances.cash, total_credits_consumed: 0,
        }, error: null };
      }
      const query = {
        select(value) { fields = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        limit(value) { limit = value; return query; },
        order() { return query; },
        update(value) { operation = 'update'; payload = value; return query; },
        insert(value) { operation = 'insert'; payload = value; return query; },
        single: execute, maybeSingle: execute,
        then(fulfilled, rejected) { return execute().then(fulfilled, rejected); },
      };
      return query;
    },
    async rpc(name, parameters) {
      state.rpcCalls.push({ name, parameters: structuredClone(parameters) });
      await Promise.resolve(); // Let both handlers reach an unsafe legacy pre-read before committing.
      if (name === 'apply_wallet_operation_atomic') return atomicWallet(parameters);
      if (name === 'recharge_credits_atomic') {
        state.balances.credits += Number(parameters.p_amount); state.mutations += 1;
        return { data: { success: true, credits: state.balances.credits }, error: null };
      }
      assert.equal(name, 'set_admin_credit_balance_atomic');
      if (options.missingSetRpc) return { data: null, error: { code: 'PGRST202', message: 'fixture absent function' } };
      const key = JSON.stringify([parameters.p_admin_id, parameters.p_idempotency_key]);
      const previous = state.adjustments.get(key);
      if (previous) {
        if (previous.target_credits !== parameters.p_target_credits || previous.user_id !== parameters.p_user_id) {
          return { data: null, error: { code: '22023', message: 'ADMIN_CREDIT_ADJUSTMENT_CONFLICT' } };
        }
        return { data: { ...previous, already_fulfilled: true }, error: null };
      }
      const target = parameters.p_target_credits;
      const beforeBalance = state.balances.credits;
      const delta = target - beforeBalance;
      const adjustmentId = String(++state.sequence);
      const walletResult = delta ? atomicWallet({
        p_user_id: parameters.p_user_id, p_operation_kind: delta > 0 ? 'credit_topup' : 'credit_charge',
        p_idempotency_key: `admin-credit-set:${adjustmentId}`, p_amount: Math.abs(delta),
        p_metadata: { admin_user_id: parameters.p_admin_id, source: 'admin_manual', source_id: parameters.p_idempotency_key },
      }) : null;
      if (walletResult?.error) return walletResult;
      const result = {
        success: true, already_fulfilled: false, adjustment_id: adjustmentId,
        operation_id: walletResult?.data?.operation_id ?? null, wallet: 'credits',
        operation_kind: delta === 0 ? 'credit_set_noop' : delta > 0 ? 'credit_topup' : 'credit_charge',
        target_credits: target, no_change: delta === 0, user_id: parameters.p_user_id,
        balance_before: beforeBalance, balance_after: target, delta,
      };
      state.adjustments.set(key, result);
      return { data: result, error: null };
    },
  };
  const cache = new Map();
  function load(relativePath) {
    if (cache.has(relativePath)) return cache.get(relativePath);
    const snapshotFile = path.join(beforeRoot, relativePath);
    const filename = before && fs.existsSync(snapshotFile) ? snapshotFile : path.join(root, relativePath);
    const compiledModule = { exports: {} };
    cache.set(relativePath, compiledModule.exports);
    const sandbox = {
      module: compiledModule, exports: compiledModule.exports, Date, Number, Math, Map, Set, URL,
      console: { warn: (...values) => state.warnings.push(values), error() {} },
      fetch() { throw new Error('Real network is forbidden'); },
      require(name) {
        if (name === 'next/server') return { NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } };
        if (name === '@/storage/database/supabase-client') return { getSupabaseClient: () => client, getSupabaseAdminClient: () => client };
        if (name === '@/lib/auth') return { getTokenFromHeaders: () => 'fixture-placeholder' };
        if (name === '@/lib/admin-auth') return { verifyAdminToken: async () => options.unauthorized ? null : actor };
        if (name === '@/lib/api-middleware') return { withAdminAuth: async (_request, handler) => options.unauthorized ? { status: 403 } : handler(actor, client) };
        if (name === '@/lib/account-governance') return { getAccountGovernanceInfo: () => ({ isFixture: Boolean(options.fixtureAccount) }) };
        if (name === './db') return { getDb() { throw new Error('Unused database dependency called'); } };
        if (name.startsWith('@/lib/')) return load(`src/lib/${name.slice('@/lib/'.length)}.ts`);
        throw new Error(`Unexpected dependency ${name}`);
      },
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, sandbox, { filename: relativePath });
    return compiledModule.exports;
  }
  async function call(kind, body = {}, key = 'same-request') {
    const route = load(`src/app/api/admin/${kind === 'cash' ? 'cash' : 'credits'}/route.ts`);
    const handler = kind === 'set' ? route.PUT : route.POST;
    return handler({
      headers: new Headers({ 'idempotency-key': key }),
      json: async () => ({ userId, ...(kind === 'set' ? { credits: 80 } : { amount: 20 }), ...body }),
    });
  }
  return { state, call, load };
}

{
  const old = harness(true);
  await Promise.all([old.call('credits'), old.call('credits')]);
  assert.equal(old.state.balances.credits, 140); assert.equal(old.state.mutations, 2);
  const current = harness();
  const replies = await Promise.all([current.call('credits'), current.call('credits')]);
  assert.equal(current.state.balances.credits, 120); assert.equal(current.state.mutations, 1);
  assert.equal(replies.filter(reply => reply.body.alreadyFulfilled).length, 1);
  assert.equal(current.state.audit.length, 1);
  assert.equal(current.state.rpcCalls.every(call => call.name === 'apply_wallet_operation_atomic'), true);
  cases.push('actual legacy concurrent credit POST duplicates topup; current same-key handlers mutate once');
}
{
  const old = harness(true, { interleave: true });
  await old.call('cash');
  assert.equal(old.state.audit[0].old_value, 107); assert.equal(old.state.audit[0].new_value, 127);
  const current = harness(false, { interleave: true });
  const result = await current.call('cash');
  assert.equal(result.body.balance, 120); assert.equal(current.state.balances.cash, 127);
  assert.deepEqual([current.state.audit[0].old_value, current.state.audit[0].new_value], [100, 120]);
  assert.equal(current.state.audit[0].source_id, `wallet:${result.body.operationId}`);
  assert.equal(current.state.queries.some(query => query.table === 'users' && query.fields === 'credits, cash_balance'), false);
  cases.push('actual old audit borrows concurrent balance; current audit keeps atomic before/after and operation ID');
}
for (const kind of ['cash', 'credits']) {
  const current = harness();
  const replies = await Promise.all([current.call(kind), current.call(kind)]);
  assert.equal(current.state.mutations, 1); assert.ok(replies.every(reply => reply.status === 200));
  const original = replies.find(reply => !reply.body.alreadyFulfilled).body;
  assert.equal(original.balanceBefore, 100); assert.equal(original.balanceAfter, 120);
  const operation = [...current.state.operations.values()][0];
  assert.equal(operation.metadata.admin_user_id, actor.id); assert.equal(operation.metadata.source, 'admin_manual');
  cases.push(`${kind}: same-key concurrency returns one original receipt and stores trusted admin/source metadata`);
}
for (const options of [{ auditError: true }, { auditReject: true }]) {
  const current = harness(false, options);
  const first = await current.call('cash');
  const replay = await current.call('cash');
  assert.equal(first.status, 200); assert.equal(first.body.success, true);
  assert.equal(first.body.auditProjection, 'wallet_ledger_only'); assert.equal(replay.status, 200);
  assert.equal(current.state.mutations, 1); assert.equal(current.state.audit.length, 0);
  assert.equal(JSON.stringify(current.state.warnings).includes('PRIVATE_FIXTURE_ERROR'), false);
  cases.push(`${options.auditError ? 'returned' : 'thrown'} audit projection failure preserves confirmed wallet success and never repeats mutation`);
}
{
  const current = harness(false, { loseResponse: true });
  const first = await current.call('credits');
  assert.equal(first.status, 503); assert.equal(first.body.outcome, 'unknown');
  assert.equal(first.body.canRetryWithSameKey, true); assert.equal(first.body.balanceAfter, undefined);
  assert.equal(first.body.idempotencyKey, 'same-request');
  const replay = await current.call('credits');
  assert.equal(replay.status, 200); assert.equal(replay.body.alreadyFulfilled, true);
  assert.equal(replay.body.balanceBefore, 100); assert.equal(current.state.mutations, 1);
  cases.push('committed RPC with lost response stays unknown and same-key replay returns original receipt without second topup');
}
for (const options of [{ invalidReceipt: true }, { wrongAmountReceipt: true }]) {
  const current = harness(false, options);
  const reply = await current.call('cash');
  assert.equal(reply.status, 503); assert.equal(reply.body.outcome, 'unknown');
  assert.equal(current.state.audit.length, 0); assert.equal(reply.body.balance, undefined);
  cases.push(`${options.invalidReceipt ? 'incomplete' : 'wrong-amount'} atomic receipt never fabricates audit values or releases retry key`);
}
{
  const current = harness(false, { missingSchema: true });
  for (const kind of ['cash', 'credits', 'set']) {
    const reply = await current.call(kind);
    assert.equal(reply.status, 503); assert.equal(reply.body.code, 'ADMIN_WALLET_MIGRATION_NOT_READY');
    assert.equal(reply.body.outcome, 'not_applied');
  }
  assert.equal(current.state.rpcCalls.length, 0); assert.equal(current.state.updates, 0);
  cases.push('missing wallet schema blocks every admin mutation before any RPC or legacy write');
}
{
  const current = harness(false, { missingSetRpc: true });
  const reply = await current.call('set');
  assert.equal(reply.status, 503); assert.equal(reply.body.code, 'ADMIN_CREDIT_ADJUSTMENT_MIGRATION_NOT_READY');
  assert.equal(reply.body.outcome, 'not_applied');
  assert.equal(current.state.mutations, 0); assert.equal(current.state.updates, 0);
  assert.ok(current.state.rpcCalls.every(call => call.name === 'set_admin_credit_balance_atomic'));
  cases.push('missing target-adjustment RPC never falls back to old recharge or direct balance UPDATE');
}
{
  const current = harness();
  const first = await current.call('set');
  assert.deepEqual([first.body.balanceBefore, first.body.balanceAfter, first.body.delta], [100, 80, -20]);
  stateAdvance(current, 50);
  const replay = await current.call('set');
  assert.equal(replay.body.balanceAfter, 80); assert.equal(replay.body.alreadyFulfilled, true);
  assert.equal(current.state.balances.credits, 50); assert.equal(current.state.mutations, 1);
  const conflict = await current.call('set', { credits: 110 });
  assert.equal(conflict.status, 409); assert.equal(current.state.balances.credits, 50);
  const otherUserConflict = await current.call('set', { userId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(otherUserConflict.status, 409);
  cases.push('target set uses atomic receipt; replay after unrelated spend never sets again; changed target/user conflicts');
}
{
  const current = harness();
  const noChange = await current.call('set', { credits: 100 });
  assert.equal(noChange.status, 200); assert.equal(noChange.body.noChange, true);
  assert.ok(noChange.body.adjustmentId); assert.equal(noChange.body.operationId, undefined);
  assert.equal(current.state.mutations, 0); assert.equal(current.state.adjustments.size, 1);
  stateAdvance(current, 60);
  const replay = await current.call('set', { credits: 100 });
  assert.equal(replay.body.alreadyFulfilled, true); assert.equal(current.state.balances.credits, 60);
  const zero = await current.call('set', { credits: 0 }, 'zero-target');
  assert.equal(zero.status, 200); assert.equal(zero.body.balanceAfter, 0);
  assert.equal(zero.body.delta, -60); assert.equal(current.state.updates, 0);
  cases.push('zero target is valid; no-op has durable request identity and replay does not restore a changed balance');
}
{
  const current = harness();
  const results = await Promise.all([current.call('set'), current.call('set')]);
  assert.equal(current.state.mutations, 1); assert.equal(current.state.adjustments.size, 1);
  assert.equal(results.filter(result => result.body.alreadyFulfilled).length, 1);
  assert.equal(current.state.audit.length, 1);
  cases.push('concurrent target-set handler requests use one durable adjustment and one audit projection');
}
{
  const current = harness();
  for (const value of [null, '', false, {}, -1, 'NaN', 'Infinity', 0.0000001, 1e-13]) {
    const reply = await current.call('set', { credits: value }); assert.equal(reply.status, 400);
  }
  for (const value of [null, false, {}, '', 0, -1, 0.001, 1e-9, 1.0000000001]) {
    const reply = await current.call('cash', { amount: value }); assert.equal(reply.status, 400);
  }
  assert.equal(current.state.rpcCalls.length, 0);
  const denied = harness(false, { unauthorized: true }); assert.equal((await denied.call('credits')).status, 403);
  const fixture = harness(false, { fixtureAccount: true }); assert.equal((await fixture.call('cash')).status, 400);
  assert.equal(denied.state.rpcCalls.length + fixture.state.rpcCalls.length, 0);
  cases.push('invalid finite/precision values, unauthorized admins and fixture accounts never reach a wallet RPC');
}
{
  const current = harness();
  await current.call('cash');
  const conflicting = await current.call('cash', { amount: 30 });
  assert.equal(conflicting.status, 503); assert.equal(current.state.mutations, 1);
  assert.equal(conflicting.body.outcome, 'unknown');
  assert.equal(conflicting.body.balance, undefined);
  cases.push('same-key changed topup amount is rejected by the actual wallet wrapper without a second mutation');
}
{
  const current = harness();
  const replies = await Promise.all([current.call('set', {}, 'set-request'), current.call('credits', {}, 'topup-request')]);
  assert.ok(replies.every(reply => reply.status === 200));
  const operations = [...current.state.operations.values()];
  assert.equal(operations.length, 2);
  assert.equal(operations[1].balance_before, operations[0].balance_after);
  assert.equal(current.state.balances.credits, operations[1].balance_after);
  assert.equal(current.state.updates, 0);
  assert.equal(current.state.audit.length, 2);
  cases.push('concurrent set and topup preserve each RPC receipt and never emit application balance UPDATEs');
}
function stateAdvance(current, balance) { current.state.balances.credits = balance; }

const result = {
  passed: true, caseCount: cases.length, cases, beforeSnapshot: path.relative(root, beforeRoot),
  actualHandlerExecution: true, actualBillingWrapperExecution: true, databaseIsContractFixture: true,
  realDatabaseWrites: 0, realNetworkCalls: 0, realCredentialsRead: 0, candidateSqlExecuted: false,
};
const outputDir = path.join(root, '.codex-evidence/admin-wallet-audit-20260902');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
