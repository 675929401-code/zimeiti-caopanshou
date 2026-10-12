import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

assert.equal(process.version, 'v24.19.0');
const { NextRequest, NextResponse } = createRequire(import.meta.url)('next/server');
const source = readFileSync(new URL('../src/app/api/user/transactions/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const at = day => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const owned = (id, fields, userId = OWNER) => ({ id, user_id: userId, ...fields });
const rows = {
  credit_transactions: [
    owned('credit-recharge', { type: 'recharge', transaction_type: 'recharge', amount: 500, created_at: at(10) }),
    owned('credit-consume', { type: 'consume', transaction_type: 'consumption', amount: -7, created_at: at(9) }),
    owned('other-credit', { type: 'recharge', amount: 9000, created_at: at(11) }, OTHER),
  ],
  cash_transactions: [
    owned('cash-topup', { type: 'topup', amount: 20, reference_id: 'payment:fixture', created_at: at(10) }),
    owned('cash-consume', { type: 'consume', amount: -2, reference_id: 'other:fixture', created_at: at(9) }),
    owned('cash-video', { type: 'consume', amount: -0.85, reference_id: 'video:video-completed', created_at: at(8) }),
    owned('other-cash', { type: 'topup', amount: 900, reference_id: 'payment:other', created_at: at(11) }, OTHER),
  ],
  video_tasks: [
    owned('video-completed', { model_id: 'pm_fixture', status: 'completed', price_charged: 0.85, created_at: at(8) }),
    owned('video-pending', { model_id: 'pm_fixture', status: 'processing', price_charged: 0.4, created_at: at(7) }),
    owned('other-video', { model_id: 'pm_fixture', status: 'completed', price_charged: 9, created_at: at(11) }, OTHER),
  ],
  payment_orders: [
    owned('payment-cash', { type: 'cash', amount: '20.50', credits_amount: null, status: 'paid', created_at: at(10), unexpected_field: 'fixture-unselected' }),
    owned('payment-credits', { type: 'credits', amount: '8.00', credits_amount: 800, status: 'paid', created_at: at(9) }),
    owned('payment-old', { type: 'cash', amount: '1.00', credits_amount: null, status: 'pending', created_at: at(1) }),
    owned('other-payment', { type: 'cash', amount: '900.00', credits_amount: null, status: 'paid', created_at: at(11) }, OTHER),
  ],
  video_models: [{ id: 'pm_fixture', name: 'Fixture video' }],
  users: [{ id: OWNER, credits: 350, cash_balance: 10.25 }, { id: OTHER, credits: 9000, cash_balance: 900 }],
};
const paymentColumns = new Set(['id', 'type', 'amount', 'status', 'payment_method', 'credits_amount', 'trade_order_id', 'paid_at', 'created_at']);
let networkCalls = 0;

function fixture({ actorId = OWNER, paymentError = null, paymentThrows = false, token = 'fixture-valid' } = {}) {
  const queries = [], errors = [];
  let clientCalls = 0;
  class Query {
    constructor(table) { assert.ok(table in rows, `Unexpected table: ${table}`); this.table = table; this.filters = []; queries.push(this); }
    select(columns, options) { this.columns = columns.split(',').map(value => value.trim()); this.exactCount = options?.count === 'exact'; return this; }
    eq(column, value) { this.filters.push({ kind: 'eq', column, value }); return this; }
    in(column, value) { this.filters.push({ kind: 'in', column, value }); return this; }
    not(column, operator, value) { assert.equal(operator, 'like'); this.filters.push({ kind: 'not-like', column, value }); return this; }
    gte(column, value) { this.filters.push({ kind: 'gte', column, value }); return this; }
    lte(column, value) { this.filters.push({ kind: 'lte', column, value }); return this; }
    order(column, options) { this.ordering = { column, ascending: options.ascending }; return this; }
    range(from, to) { this.rangeBounds = [from, to]; return this.execute(); }
    single() { return this.execute(true); }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute(single = false) {
      this.executed = true;
      if (this.table !== 'video_models') {
        const ownerColumn = this.table === 'users' ? 'id' : 'user_id';
        assert.ok(this.filters.some(filter => filter.kind === 'eq' && filter.column === ownerColumn && filter.value === actorId), `Missing authenticated owner constraint: ${this.table}`);
      }
      if (this.table === 'payment_orders') {
        assert.ok(this.columns.every(column => paymentColumns.has(column)), 'Unknown payment-order projection column');
        if (paymentThrows) throw new Error('PAYMENT_FIXTURE_QUERY_THROW');
        if (paymentError) return { data: null, error: paymentError, count: null };
      }
      let data = rows[this.table].filter(row => this.filters.every(({ kind, column, value }) => {
        if (kind === 'eq') return row[column] === value;
        if (kind === 'in') return value.includes(row[column]);
        if (kind === 'gte') return row[column] >= value;
        if (kind === 'lte') return row[column] <= value;
        assert.equal(kind, 'not-like'); assert.ok(value.endsWith('%'));
        return row[column] != null && !String(row[column]).startsWith(value.slice(0, -1));
      }));
      if (this.ordering) {
        const { column, ascending } = this.ordering;
        data = [...data].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
      }
      const count = this.exactCount ? data.length : null;
      if (this.rangeBounds) data = data.slice(this.rangeBounds[0], this.rangeBounds[1] + 1);
      const projected = data.map(row => Object.fromEntries(this.columns.map(column => [column, row[column]])));
      return { data: single ? projected[0] || null : projected, error: null, count };
    }
  }
  const dependencies = {
    'next/server': { NextResponse },
    '@/lib/auth': { getTokenFromHeaders: headers => headers.get('authorization')?.replace(/^Bearer /u, '') || null, verifyToken: async value => value === 'fixture-valid' ? { userId: actorId } : null },
    '@/storage/database/supabase-client': { getSupabaseAdminClient: () => { clientCalls++; return { from: table => new Query(table) }; } },
  };
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports, URL,
    console: { error: (...values) => errors.push(values.map(String).join(' ')) },
    fetch: () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); },
    require: name => { assert.ok(name in dependencies, `Unmocked route dependency: ${name}`); return dependencies[name]; },
  }, { filename: 'user-transactions-route.ram.cjs' });
  return {
    queries, errors,
    clientCalls: () => clientCalls,
    run: async query => {
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      const response = await module.exports.GET(new NextRequest(`http://fixture.invalid/api/user/transactions?${query}`, { headers }));
      return { status: response.status, body: await response.json() };
    },
  };
}

const checks = [];
const expectedTotals = {
  'all/all': [2, 2, 2, 3], 'cash/all': [0, 2, 2, 3], 'credits/all': [2, 0, 0, 3],
  'all/recharge': [1, 1, 0, 3], 'cash/recharge': [0, 1, 0, 3], 'credits/recharge': [1, 0, 0, 3],
  'all/consume': [1, 1, 1, 0], 'cash/consume': [0, 1, 1, 0], 'credits/consume': [1, 0, 0, 0],
};
for (const [scenario, totals] of Object.entries(expectedTotals)) {
  const [type, transactionType] = scenario.split('/');
  const test = fixture();
  const { status, body } = await test.run(`type=${type}&transactionType=${transactionType}&user_id=${OTHER}`);
  assert.equal(status, 200); assert.equal(body.success, true);
  const { transactions, pagination, summary } = body.data;
  assert.deepEqual([pagination.creditTotal, pagination.cashTotal, pagination.videoTotal, pagination.paymentTotal], totals);
  assert.equal(pagination.total, totals.reduce((sum, count) => sum + count, 0));
  assert.equal(transactions.length, pagination.total);
  assert.equal(new Set(transactions.map(row => row.id)).size, transactions.length);
  assert.equal(transactions.some(row => row.id.startsWith('other-')), false);
  assert.equal(transactions.some(row => row.id === 'cash-video'), false);
  const times = transactions.map(row => row.createdAt);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.deepEqual(summary, { totalCreditsRecharged: 500, totalCreditsConsumed: 7, creditBalance: 350, totalCashRecharged: 20, totalCashConsumed: 2.85, cashBalance: 10.25 });
  const paymentQueries = test.queries.filter(query => query.table === 'payment_orders');
  assert.equal(paymentQueries.length, transactionType === 'consume' ? 0 : 1);
  if (transactionType !== 'consume') {
    const cash = transactions.find(row => row.id === 'payment-cash');
    const credits = transactions.find(row => row.id === 'payment-credits');
    assert.equal(cash.amount, 20.5); assert.equal(cash.cashAmount, 20.5); assert.equal(cash.creditsAmount, null);
    assert.equal(credits.amount, 8); assert.equal(credits.creditsAmount, 800); assert.equal(credits.cashAmount, null);
    assert.equal(paymentQueries[0].columns.includes('cash_amount'), false);
    assert.equal(JSON.stringify(transactions).includes('unexpected_field'), false);
    assert.equal(JSON.stringify(transactions).includes('fixture-unselected'), false);
  }
  checks.push(`actual-route-${scenario}-owner-sort-count-wallet-semantics`);
}

const page = fixture();
const paginated = await page.run('type=credits&transactionType=recharge&page=2&pageSize=1');
assert.equal(paginated.status, 200);
assert.deepEqual(paginated.body.data.pagination, { page: 2, pageSize: 1, creditTotal: 1, cashTotal: 0, videoTotal: 0, paymentTotal: 3, total: 4 });
assert.equal(paginated.body.data.transactions.length, 1);
assert.equal(paginated.body.data.transactions[0].id, 'payment-credits');
checks.push('exact-total-remains-full-filtered-count-after-pagination');

const dated = fixture();
const datedResult = await dated.run('type=cash&transactionType=recharge&dateFrom=2026-10-09&dateTo=2026-10-10');
assert.equal(datedResult.status, 200); assert.equal(datedResult.body.data.pagination.paymentTotal, 2);
assert.equal(datedResult.body.data.transactions.some(row => row.id === 'payment-old'), false);
const paymentDateFilters = dated.queries.find(query => query.table === 'payment_orders').filters;
assert.ok(paymentDateFilters.some(filter => filter.kind === 'gte' && filter.column === 'created_at' && filter.value === '2026-10-09'));
assert.ok(paymentDateFilters.some(filter => filter.kind === 'lte' && filter.value === '2026-10-10T23:59:59'));
checks.push('payment-order-date-window-kept');

for (const options of [{ paymentError: { code: '42703', message: 'fixture-private-db-detail' } }, { paymentThrows: true }]) {
  const test = fixture(options), result = await test.run('type=all&transactionType=recharge');
  assert.equal(result.status, 500); assert.deepEqual(result.body, { error: '查询交易记录失败' });
  assert.equal('success' in result.body, false); assert.equal('data' in result.body, false);
  assert.equal(JSON.stringify(result.body).includes('fixture-private-db-detail'), false);
  assert.equal(test.errors.length, 1); assert.equal(test.errors.join().includes('fixture-private-db-detail'), false);
  checks.push(options.paymentThrows ? 'thrown-payment-read-fails-with-generic-500' : 'payment-error-fails-with-generic-500-and-safe-log');
}

const consume = fixture({ paymentError: { code: '42703' } });
assert.equal((await consume.run('type=cash&transactionType=consume')).status, 200);
assert.equal(consume.queries.some(query => query.table === 'payment_orders'), false);
checks.push('consume-does-not-touch-failing-payment-source');

const other = fixture({ actorId: OTHER }), otherResult = await other.run(`type=all&user_id=${OWNER}`);
assert.equal(otherResult.status, 200);
assert.deepEqual(otherResult.body.data.transactions.map(row => row.id).sort(), ['other-cash', 'other-credit', 'other-payment', 'other-video']);
assert.equal(otherResult.body.data.summary.creditBalance, 9000); assert.equal(otherResult.body.data.summary.cashBalance, 900);
checks.push('second-authenticated-owner-isolated-from-requested-user-id');

for (const token of [null, 'fixture-invalid']) {
  const test = fixture({ token }), result = await test.run('type=all');
  assert.equal(result.status, 401); assert.equal(test.clientCalls(), 0); assert.equal(test.queries.length, 0);
  checks.push(token ? 'invalid-token-no-database-access' : 'missing-token-no-database-access');
}
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ kind: 'actual-user-transactions-payment-orders-route-zero-network', status: 'PASS', checks: checks.length, scenarios: checks, networkCalls, dbConnections: 0, browserRuns: 0, paidPosts: 0 }));
