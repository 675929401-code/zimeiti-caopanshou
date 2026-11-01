import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

assert.equal(process.versions.node, '24.19.0', 'Use the project-controlled Node runtime');
const { NextRequest, NextResponse } = createRequire(import.meta.url)('next/server');
let networkCalls = 0;
function noNetwork() { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); }
function loadActual(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const vmModule = { exports: {} };
  runInNewContext(compiled, {
    module: vmModule, exports: vmModule.exports, URL, TextDecoder, Uint8Array, fetch: noNetwork,
    require(name) { assert.ok(name in dependencies, `UNMOCKED_DEPENDENCY:${name}`); return dependencies[name]; },
  }, { filename: relativePath });
  return vmModule.exports;
}
const pricing = loadActual('../src/lib/text-model-pricing.ts');
const publicBilling = loadActual('../src/lib/public-billing-explanation.ts', { '@/lib/text-model-pricing': pricing });
const display = loadActual('../src/lib/display-normalization.ts');
const { buildSelectedModelBillingSnapshot } = loadActual('../src/lib/llm-billing.ts', {
  '@/lib/billing': {}, '@/lib/revenue': {}, '@/lib/llm-credit-reservation': {},
  '@/lib/llm-request-idempotency': {}, '@/lib/text-model-pricing': pricing,
});
const publicModelId = `pm_${'a'.repeat(24)}`;
const selected = buildSelectedModelBillingSnapshot(publicModelId, {
  id: 'fixture-private-model', name: 'Fixture model', model_name: 'fixture-private-provider-model',
  token_billing_enabled: true, input_cost_per_million: 10, output_cost_per_million: 20,
  cached_cost_per_million: 2, profit_margin: 50, token_rounding_unit: 0,
}, {
  inputCostPerMillion: 9001, outputCostPerMillion: 9002, cachedCostPerMillion: 9003,
  profitMargin: 90, creditsPerYuan: 50, tokenRoundingEnabled: true, tokenRoundingUnit: 1000,
  tokenRoundingMin: 100, tokenRoundingMax: 10000,
});
assert.ok(selected);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const date = day => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const privateMetadata = {
  agent_name: '公开智能体', public_model_id: publicModelId,
  prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 200, total_tokens: 1500,
  credits_charged: 4.64, sell_price_rmb: 0.0928, selling_price: 0.0928,
  actual_cost_rmb: 9876, profit_rmb: 9876, profit_margin: 50, internalModelId: 'fixture-private-model',
  model: 'fixture-private-provider-model', model_name: 'fixture-private-provider-model',
  api_key: 'fixture-secret-marker', api_endpoint: 'https://fixture-private.invalid',
  provider_config: { token: 'fixture-secret-marker' }, arbitrary: [{ secret: 'fixture-secret-marker' }],
  wallet_operation_id: '101', price_snapshot: { ...selected.priceSnapshot, baseFeeCredits: 3 },
};
const rows = [
  { id: 'snapshot', user_id: OWNER, type: 'consume', transaction_type: 'consumption', amount: -4.64, balance_after: 0, description: '  通用   描述  ', created_at: date(25), metadata: privateMetadata },
  { id: 'legacy', user_id: OWNER, type: 'consumption', transaction_type: 'consumption', amount: -2, balance_after: '0', description: '', created_at: date(24), metadata: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, actual_cost_rmb: 9876 } },
  { id: 'invalid', user_id: OWNER, type: 'deduction', amount: -3, balance_after: 2, created_at: date(23), metadata: { price_snapshot: { schemaVersion: 'unknown.v99' }, wallet_operation_id: '0', nested: { secret: 'fixture-secret-marker' } } },
  { id: 'recharge', user_id: OWNER, type: 'recharge', amount: 100, balance_after: 100, created_at: date(22), metadata: { arbitrary: { secret: 'fixture-secret-marker' } } },
  { id: 'other-snapshot', user_id: OTHER, type: 'consume', amount: -4.64, balance_after: 0, description: 'Other owner', created_at: date(26), metadata: privateMetadata },
  { id: 'admin-snapshot', user_id: ADMIN, type: 'consume', amount: -4.64, balance_after: 0, description: 'Admin own', created_at: date(27), metadata: privateMetadata },
];
const allowedColumns = new Set(['id', 'type', 'transaction_type', 'amount', 'balance_after', 'description', 'metadata', 'created_at']);
const source = readFileSync(new URL('../src/app/api/credits/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function fixture({ actorId = OWNER, role = 'student', token = 'fixture-valid', denyCapability = null,
  userError = false, noUser = false, transactionsError = false, recoveryError = false,
  userBalance = { credits: '20', credits_reserved: '5', cash_balance: '2.50', member_status: 'active' },
  transactionRows = rows } = {}) {
  const queries = [], authorizations = [], recovery = [], errors = [];
  let clientCalls = 0;
  let target = null;
  class Query {
    constructor(table) { assert.ok(['users', 'credit_transactions'].includes(table)); this.table = table; this.filters = []; queries.push(this); }
    select(value) { this.columns = value.split(',').map(value => value.trim()); if (this.table === 'credit_transactions') assert.ok(this.columns.every(column => allowedColumns.has(column)), 'Unknown/private or star transaction column'); return this; }
    eq(column, value) { this.filters.push({ column, value }); return this; }
    order(column, options) { this.ordering = { column, ascending: options.ascending }; return this; }
    single() { assert.equal(this.table, 'users'); return this.execute(); }
    limit(value) { assert.equal(value, 100); this.bound = value; return this.execute(); }
    async execute() {
      const ownerColumn = this.table === 'users' ? 'id' : 'user_id';
      assert.deepEqual(this.filters, [{ column: ownerColumn, value: target }], 'Every query must retain the authorized target constraint');
      if (this.table === 'users') return { data: noUser ? null : { ...userBalance }, error: userError ? { message: 'fixture-private-db-detail' } : null };
      assert.deepEqual(this.ordering, { column: 'created_at', ascending: false });
      if (transactionsError) return { data: null, error: { message: 'fixture-private-db-detail' } };
      const data = transactionRows.filter(row => row.user_id === target).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, this.bound);
      // Include a DB canary despite the explicit select to prove the response also projects fields.
      return { data: data.map(row => ({ ...Object.fromEntries(this.columns.map(column => [column, row[column]])), unexpected_field: 'fixture-private-extra', internalModelId: 'fixture-private-extra' })), error: null };
    }
  }
  const dependencies = {
    'next/server': { NextResponse },
    '@/lib/auth': { getTokenFromHeaders: headers => headers.get('authorization')?.replace(/^Bearer /u, '') || null,
      verifyToken: async value => value === 'fixture-valid' ? { userId: actorId, role } : null },
    '@/storage/database/supabase-client': { getSupabaseClient() { clientCalls++; return { from: table => new Query(table) }; } },
    '@/lib/display-normalization': display,
    '@/lib/public-billing-explanation': publicBilling,
    '@/lib/llm-credit-reservation': { recoverLlmCreditReservations: async userId => { recovery.push(userId); if (recoveryError) throw new Error('fixture-private-recovery-error'); } },
    '@/lib/server/admin-governance-authority': { authorizeAdminCapability: async (_request, capability, options) => {
      authorizations.push({ capability, operation: options.operation });
      return role === 'admin' && capability !== denyCapability ? { ok: true } : { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    } },
  };
  const vmModule = { exports: {} };
  runInNewContext(compiled, { module: vmModule, exports: vmModule.exports, URL, fetch: noNetwork,
    console: { error: (...values) => errors.push(values.map(String).join(' ')) },
    require(name) { assert.ok(name in dependencies, `UNMOCKED_ROUTE_DEPENDENCY:${name}`); return dependencies[name]; },
  }, { filename: 'actual-credits-route.ram.cjs' });
  return { queries, authorizations, recovery, errors, clientCalls: () => clientCalls,
    async run(query = `user_id=${OWNER}`) {
      target = new URLSearchParams(query).get('user_id');
      const response = await vmModule.exports.GET(new NextRequest(`http://fixture.invalid/api/credits?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
      return { status: response.status, body: await response.json() };
    } };
}
function assertPublic(rows) {
  for (const row of rows) {
    assert.equal('user_id' in row, false);
    for (const marker of ['fixture-private', 'fixture-secret', 'actual_cost', 'profit', 'internalModel', 'provider_config', 'price_snapshot', 'api_key', 'api_endpoint', 'unexpected_field', 'wallet_operation_id']) {
      assert.equal(JSON.stringify(row).includes(marker), false, `Private field/value leaked: ${marker}`);
    }
  }
}
const checks = [];
const own = fixture();
const result = await own.run();
assert.equal(result.status, 200);
assert.equal(result.body.credits, 15); assert.equal(result.body.reservedCredits, 5); assert.equal(result.body.cashBalance, 2.5); assert.equal(result.body.memberStatus, 'active');
assert.deepEqual(result.body.transactions.map(row => row.id), ['snapshot', 'legacy', 'invalid', 'recharge']);
assertPublic(result.body.transactions);
assert.deepEqual(own.recovery, [OWNER]); assert.deepEqual(own.authorizations, []);
assert.equal(own.queries.length, 2);
checks.push('student-own-ledger-isolated-public-projection-extra-field-canary-and-balances');

const snapshot = result.body.transactions[0];
assert.equal(snapshot.balance_after, 0); assert.equal(snapshot.amount, -4.64); assert.equal(snapshot.description, '通用 描述');
assert.deepEqual(snapshot.metadata, { agent_name: '公开智能体', prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 200,
  total_tokens: 1500, credits_charged: 4.64, sell_price_rmb: 0.0928, selling_price: 0.0928, public_model_id: publicModelId });
assert.equal(snapshot.billingExplanation.status, 'snapshot'); assert.equal(snapshot.billingExplanation.walletLink.status, 'linked');
assert.deepEqual([snapshot.billingExplanation.price.inputCreditsPerMillion, snapshot.billingExplanation.price.outputCreditsPerMillion, snapshot.billingExplanation.price.cachedCreditsPerMillion], [1000, 2000, 200]);
assert.equal(snapshot.billingExplanation.price.tokenRoundingUnit, 0); assert.equal(snapshot.billingExplanation.price.creditsPerYuan, 50);
assert.equal(snapshot.billingExplanation.baseFeeCredits, 3);
checks.push('actual-selected-model-snapshot-cache-rates-explicit-zero-rounding-and-zero-balance');

const legacy = result.body.transactions[1], invalid = result.body.transactions[2], recharge = result.body.transactions[3];
assert.equal(legacy.balance_after, '0'); assert.equal(legacy.metadata.prompt_tokens, 0); assert.equal(legacy.description, '积分消耗');
assert.equal(legacy.billingExplanation.status, 'missing_snapshot'); assert.equal(legacy.billingExplanation.walletLink.status, 'unlinked');
assert.equal(invalid.billingExplanation.status, 'invalid_snapshot'); assert.equal(invalid.billingExplanation.walletLink.status, 'unlinked');
for (const row of [legacy, invalid]) assert.equal('price' in row.billingExplanation, false);
assert.equal(recharge.description, '积分充值'); assert.equal(recharge.metadata, null); assert.equal('billingExplanation' in recharge, false);
checks.push('missing-invalid-snapshots-no-current-price-fallback-and-no-fabricated-wallet-links');

const noTransactions = fixture();
const noTransactionsResult = await noTransactions.run(`user_id=${OWNER}&include_transactions=0`);
assert.equal(noTransactionsResult.status, 200); assert.deepEqual(noTransactionsResult.body.transactions, []);
assert.deepEqual(noTransactions.queries.map(query => query.table), ['users']);
assert.deepEqual(noTransactions.recovery, [OWNER], 'Existing recovery boundary also applies to balance-only GET');
checks.push('balance-only-skips-transaction-query-but-preserves-recovery-spy-boundary');

for (const userBalance of [{ credits: 0, credits_reserved: 0, cash_balance: 0, member_status: null }, { credits: 3, credits_reserved: 5, cash_balance: 0, member_status: null }]) {
  const test = fixture({ userBalance }); const response = await test.run(`user_id=${OWNER}&include_transactions=0`);
  assert.equal(response.body.credits, 0); assert.equal(response.body.cashBalance, 0); assert.equal(response.body.memberStatus, 'inactive');
}
checks.push('zero-and-overreserved-balances-stay-zero-with-member-fallback');

const otherOwn = fixture({ actorId: OTHER }); const otherResult = await otherOwn.run(`user_id=${OTHER}`);
assert.deepEqual(otherResult.body.transactions.map(row => row.id), ['other-snapshot']); assert.deepEqual(otherOwn.recovery, [OTHER]); assertPublic(otherResult.body.transactions);
checks.push('second-student-only-reads-own-ledger');

const forbidden = fixture(); const forbiddenResult = await forbidden.run(`user_id=${OTHER}&role=admin`);
assert.equal(forbiddenResult.status, 403); assert.equal(forbidden.clientCalls(), 0); assert.deepEqual(forbidden.recovery, []);
assert.deepEqual(forbidden.authorizations.map(row => row.capability), ['members.view']);
checks.push('student-cross-account-and-query-role-spoof-denied-before-database-or-recovery');

const admin = fixture({ actorId: ADMIN, role: 'admin' }); const adminResult = await admin.run(`user_id=${OTHER}`);
assert.equal(adminResult.status, 200); assert.deepEqual(adminResult.body.transactions.map(row => row.id), ['other-snapshot']); assertPublic(adminResult.body.transactions);
assert.deepEqual(admin.authorizations, [{ capability: 'members.view', operation: 'member_balance_view' }, { capability: 'billing.view', operation: 'member_transactions_view' }]);
assert.deepEqual(admin.recovery, [], 'An authorized cross-user read must not recover the target wallet');
checks.push('admin-cross-account-requires-both-capabilities-and-keeps-public-dto-no-recovery');

const adminOwn = fixture({ actorId: ADMIN, role: 'admin' }); const adminOwnResult = await adminOwn.run(`user_id=${ADMIN}`);
assert.deepEqual(adminOwn.authorizations, []); assert.deepEqual(adminOwn.recovery, [ADMIN]); assertPublic(adminOwnResult.body.transactions);
checks.push('admin-own-response-does-not-implicitly-expose-private-metadata');

for (const denyCapability of ['members.view', 'billing.view']) {
  const test = fixture({ actorId: ADMIN, role: 'admin', denyCapability }); const response = await test.run(`user_id=${OTHER}`);
  assert.equal(response.status, 403); assert.equal(test.clientCalls(), 0); assert.deepEqual(test.recovery, []);
  assert.deepEqual(test.authorizations.map(row => row.capability), denyCapability === 'members.view' ? ['members.view'] : ['members.view', 'billing.view']);
  checks.push(`admin-${denyCapability}-denied-before-data-and-recovery`);
}

for (const token of [null, 'fixture-invalid']) {
  const test = fixture({ token }); const response = await test.run();
  assert.equal(response.status, 401); assert.equal(test.clientCalls(), 0); assert.deepEqual(test.recovery, []); assert.deepEqual(test.authorizations, []);
  checks.push(token ? 'expired-or-invalid-token-no-data-or-recovery' : 'missing-token-no-data-or-recovery');
}
const missingUser = fixture(); assert.equal((await missingUser.run('include_transactions=1')).status, 400);
assert.equal(missingUser.clientCalls(), 0); assert.deepEqual(missingUser.recovery, []);
checks.push('missing-target-no-database-or-recovery');

for (const options of [{ userError: true }, { noUser: true }, { transactionsError: true }, { recoveryError: true }]) {
  const test = fixture(options); const response = await test.run();
  assert.equal(response.status, 503); assert.equal('transactions' in response.body, false); assert.equal(JSON.stringify(response.body).includes('fixture-private'), false);
  if (options.recoveryError) assert.equal(test.queries.length, 0);
  checks.push(`safe-failure-${Object.keys(options)[0]}-no-private-response`);
}

const manyRows = Array.from({ length: 105 }, (_, index) => ({ ...rows[3], id: `bounded-${index}`, created_at: new Date(Date.UTC(2026, 9, 25, 12, index)).toISOString() }));
const bounded = fixture({ transactionRows: manyRows }); const boundedResult = await bounded.run();
assert.equal(boundedResult.body.transactions.length, 100); assert.equal(boundedResult.body.transactions[0].id, 'bounded-104'); assert.equal(boundedResult.body.transactions.at(-1).id, 'bounded-5');
checks.push('latest-one-hundred-transactions-order-and-limit-preserved');

assert.equal(networkCalls, 0);
console.log(JSON.stringify({ kind: 'actual-credits-public-transactions-route-zero-network', status: 'PASS', checks: checks.length,
  scenarios: checks, actualPublicHelpers: true, actualSelectedModelSnapshotBuilder: true,
  networkCalls, dbConnections: 0, liveRecoveryRpcCalls: 0, databaseWrites: 0, paidPosts: 0, browserRuns: 0 }));
