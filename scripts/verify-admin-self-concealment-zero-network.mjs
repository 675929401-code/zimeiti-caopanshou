#!/usr/bin/env node
// Actual users GET + actual pure domain helpers; identity and database rows are RAM fixtures.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routePath = 'src/app/api/admin/users/route.ts';
const pureModules = new Set([
  'src/lib/account-governance.ts', 'src/lib/display-normalization.ts',
  'src/lib/agent-category-access.ts', 'src/lib/business-ip/catalog.ts',
  'src/lib/admin-member-data-boundary.ts',
]);
const unusedModules = new Set([
  '@/lib/admin-password-policy', '@/lib/admin-user-identity', '@/lib/admin-user-verification',
  '@/lib/email-code-store', '@/lib/qq-email', '@/lib/admin-user-delete-reauth',
]);

export function createEvidenceDirectory(kind) {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.resolve(projectRoot, '.codex-evidence/admin-self-concealment', kind, runId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function sourceIdentity() {
  return Object.fromEntries([routePath, ...pureModules].map(relative => [relative,
    createHash('sha256').update(readFileSync(path.join(projectRoot, relative))).digest('hex')]));
}

export function createSyntheticAccounts() {
  const definitions = [
    ['00000000-0000-4000-8000-000000000001', 'owner', '苏总管', 'admin'],
    ['00000000-0000-4000-8000-000000000002', 'operator', '陈运营', 'admin'],
    ['00000000-0000-4000-8000-000000000003', 'other-admin', '许运营', 'admin'],
    ['00000000-0000-4000-8000-000000000004', 'student', '陈学员', 'student'],
    ['00000000-0000-4000-8000-000000000005', 'other-student', '周学员', 'student'],
  ];
  return definitions.map(([id, key, display_name, role], index) => ({
    id, key, username: `account_${index + 1}`, display_name, role,
    phone: `1380000000${index + 1}`, email: `${10000001 + index}@qq.com`,
    is_active: true, status: 'active', member_status: 'active',
    created_at: `2026-10-0${index + 1}T00:00:00.000Z`, last_sign_in_at: '2026-10-20T00:00:00.000Z',
    allowed_categories: ['task:文案创作'], credits: 200 + index, cash_balance: 10 + index,
  }));
}

function ilike(value, pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/%/gu, '.*').replace(/_/gu, '.');
  return new RegExp(`^${escaped}$`, 'iu').test(String(value ?? ''));
}

function evaluateOrTerm(row, term) {
  const parsed = /^([a-z_]+)\.(eq|neq|ilike)\.(.*)$/u.exec(term);
  assert.ok(parsed, `UNSUPPORTED_POSTGREST_OR_TERM:${term}`);
  const [, field, operator, value] = parsed;
  if (operator === 'eq') return row[field] !== null && row[field] !== undefined && String(row[field]) === value;
  if (operator === 'neq') return row[field] !== null && row[field] !== undefined && String(row[field]) !== value;
  return ilike(row[field], value);
}

/** Each .or() is one OR group; separate filters/groups are combined with AND. */
function memoryQuery(table, fixture, state) {
  const filters = [];
  const trace = { table, columns: '', filters: [], range: null, order: null };
  state.queryTraces.push(trace);
  let range = null;
  let ordering = null;
  const query = {
    select(columns) { trace.columns = columns; return query; },
    eq(field, value) { filters.push(row => row[field] === value); trace.filters.push({ op: 'eq', field, value }); return query; },
    in(field, values) { filters.push(row => values.includes(row[field])); trace.filters.push({ op: 'in', field, values }); return query; },
    is(field, value) { filters.push(row => (row[field] ?? null) === value); trace.filters.push({ op: 'is', field, value }); return query; },
    or(expression) {
      const terms = expression.split(',');
      filters.push(row => terms.some(term => evaluateOrTerm(row, term)));
      trace.filters.push({ op: 'or', expression });
      return query;
    },
    order(field, options) { ordering = { field, ascending: options?.ascending !== false }; trace.order = ordering; return query; },
    range(from, to) { range = { from, to }; trace.range = range; return query; },
    insert() { state.writeAttempts += 1; throw Error('DATABASE_WRITE_FORBIDDEN'); },
    update() { state.writeAttempts += 1; throw Error('DATABASE_WRITE_FORBIDDEN'); },
    delete() { state.writeAttempts += 1; throw Error('DATABASE_WRITE_FORBIDDEN'); },
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        assert.ok(Object.hasOwn(fixture, table), `UNCONFIGURED_TABLE:${table}`);
        if (table === 'users' && state.missingLastSignIn && trace.columns.includes('last_sign_in_at')) {
          state.missingLastSignIn = false;
          return { data: null, count: null, error: { message: 'column users.last_sign_in_at does not exist' } };
        }
        let rows = fixture[table].filter(row => filters.every(filter => filter(row)));
        const count = rows.length;
        if (ordering) rows = [...rows].sort((left, right) => String(left[ordering.field]).localeCompare(String(right[ordering.field])) * (ordering.ascending ? 1 : -1));
        if (range) rows = rows.slice(range.from, range.to + 1);
        const columns = trace.columns.split(',').map(column => column.trim());
        const data = rows.map(row => Object.fromEntries(columns.filter(column => Object.hasOwn(row, column)).map(column => [column, row[column]])));
        trace.returnedIds = data.map(row => row.id || row.user_id).filter(Boolean);
        trace.count = count;
        return { data, count, error: null };
      }).then(resolve, reject);
    },
  };
  return query;
}

export function createUsersRouteHarness({ routeSource, missingLastSignIn = false } = {}) {
  const accounts = createSyntheticAccounts();
  const byKey = Object.fromEntries(accounts.map(account => [account.key, account]));
  const state = { actorKey: 'operator', queryTraces: [], writeAttempts: 0, networkAttempts: 0, missingLastSignIn, warnings: [] };
  const fixture = { users: accounts, categories: [], agents: [], member_permission_assignments: [], credit_transactions: [], cash_transactions: [] };
  const cache = new Map();
  const forbidden = name => () => { throw Error(`UNEXPECTED_NON_GET_DEPENDENCY:${name}`); };
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth': { getTokenFromHeaders: headers => headers.get('authorization')?.replace(/^Bearer\s+/u, '') || null },
    '@/lib/admin-auth': { verifyAdminToken: async token => {
      const actor = byKey[token.replace(/^synthetic-session:/u, '')];
      return actor && token === `synthetic-session:${actor.key}` ? { userId: actor.id, role: actor.role, displayName: actor.display_name } : null;
    } },
    '@/storage/database/supabase-client': { getSupabaseAdminClient: () => ({ from: table => memoryQuery(table, fixture, state) }) },
    '@/lib/server/admin-governance-authority': {
      readAdminAccessSnapshot: async userId => ({
        authorityStatus: 'ready', integrityValid: true, permissionKeys: ['members.view', 'billing.view', 'wallet.adjust'],
        adminLevel: userId === byKey.owner.id ? 'super_admin' : 'admin',
      }),
      authorizeAdminCapability: forbidden('authorizeAdminCapability'),
    },
  };
  function load(relative, sourceOverride) {
    if (cache.has(relative)) return cache.get(relative);
    const module = { exports: {} };
    cache.set(relative, module.exports);
    const source = sourceOverride ?? readFileSync(path.join(projectRoot, relative), 'utf8');
    const code = ts.transpileModule(source, { fileName: relative, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, URL, URLSearchParams, Request, Response, Headers, TextDecoder, TextEncoder, Buffer,
      console: { error: (...args) => state.warnings.push(args.map(String).join(' ')), warn: (...args) => state.warnings.push(args.map(String).join(' ')) },
      fetch: async () => { state.networkAttempts += 1; throw Error('NETWORK_FORBIDDEN'); },
      require(specifier) {
        if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
        if (unusedModules.has(specifier)) return new Proxy({}, { get: (_, key) => forbidden(`${specifier}:${String(key)}`) });
        const dependency = specifier.startsWith('@/') ? `src/${specifier.slice(2)}.ts` : '';
        assert.ok(pureModules.has(dependency), `UNMOCKED_DEPENDENCY:${specifier}`);
        return load(dependency);
      },
    }, { filename: relative, timeout: 5000 });
    cache.set(relative, module.exports);
    return module.exports;
  }
  const route = load(routePath, routeSource);
  return {
    accounts, byKey, state,
    async get(actorKey, query = '') {
      const before = state.queryTraces.length;
      state.actorKey = actorKey;
      const headers = actorKey ? { Authorization: `Bearer synthetic-session:${actorKey}` } : {};
      const response = await route.GET(new Request(`http://127.0.0.1:5000/api/admin/users${query ? `?${query}` : ''}`, { headers }));
      return { status: response.status, body: await response.json(), queries: state.queryTraces.slice(before) };
    },
  };
}

export async function runZeroNetworkVerification() {
  const evidenceDirectory = createEvidenceDirectory('zero-network');
  const harness = createUsersRouteHarness();
  const { byKey } = harness;
  const id = key => byKey[key].id;
  const checks = [];
  async function check(name, actor, query, expected, status = 200, customHarness = harness) {
    const result = await customHarness.get(actor, query);
    assert.equal(result.status, status, `${name}: status`);
    if (status === 200) {
      assert.deepEqual(result.body.users.map(user => user.id).sort(), expected.map(id).sort(), `${name}: rows`);
      assert.equal(result.body.totalCount, expected.length, `${name}: count`);
      for (const user of result.body.users) {
        if (actor === 'operator' && user.role === 'admin') assert.equal(user.id, id('operator'), `${name}: foreign administrator leaked`);
      }
    } else assert.equal(result.queries.length, 0, `${name}: forbidden actor reached database`);
    checks.push({ name, actor, query, status: result.status, returnedIds: result.body.users?.map(user => user.id) || [], queries: result.queries });
    return result;
  }
  await check('super administrator sees all five accounts', 'owner', '', ['owner', 'operator', 'other-admin', 'student', 'other-student']);
  await check('ordinary administrator sees self and students', 'operator', '', ['operator', 'student', 'other-student']);
  await check('student denied before any database query', 'student', '', [], 403);
  await check('anonymous denied before any database query', null, '', [], 403);
  await check('super administrator role filter', 'owner', 'role=admin', ['owner', 'operator', 'other-admin']);
  await check('ordinary administrator role filter retains only self', 'operator', 'role=admin', ['operator']);
  await check('ordinary administrator student filter', 'operator', 'role=student', ['student', 'other-student']);
  await check('ordinary administrator direct self lookup', 'operator', `user_id=${id('operator')}`, ['operator']);
  await check('ordinary administrator direct foreign-admin lookup concealed', 'operator', `user_id=${id('other-admin')}`, []);
  await check('super administrator direct foreign-admin lookup', 'owner', `user_id=${id('other-admin')}`, ['other-admin']);
  await check('search matches own administrator and student with AND policy', 'operator', 'search=陈', ['operator', 'student']);
  await check('search cannot reveal foreign administrator', 'operator', 'search=许运营', []);
  await check('phone search is applied by query', 'operator', `search=${byKey.student.phone}`, ['student']);
  await check('email search is applied by query', 'operator', `search=${byKey.operator.email}`, ['operator']);
  await check('username search is applied by query', 'operator', `search=${byKey['other-student'].username}`, ['other-student']);
  await check('role plus search is conjunctive', 'operator', 'role=admin&search=陈', ['operator']);
  await check('role plus direct lookup cannot escape role filter', 'operator', `role=student&user_id=${id('operator')}`, []);
  await check('role plus search plus foreign id cannot escape concealment', 'operator', `role=admin&search=许运营&user_id=${id('other-admin')}`, []);
  await check('role plus search plus own id succeeds', 'operator', `role=admin&search=陈&user_id=${id('operator')}`, ['operator']);
  const paged = await harness.get('operator', 'page=2&page_size=1');
  assert.equal(paged.body.users.length, 1);
  assert.equal(paged.body.totalCount, 3, 'pagination count must follow concealment and precede range');
  assert.equal(paged.body.users[0].id, id('student'));
  checks.push({ name: 'pagination counts only visible rows', status: paged.status, queries: paged.queries });
  const fallback = createUsersRouteHarness({ missingLastSignIn: true });
  const fallbackResult = await check('missing last-sign-in fallback preserves all filters', 'operator', 'role=admin&search=许运营', [], 200, fallback);
  assert.equal(fallbackResult.queries.filter(query => query.table === 'users').length, 2);
  const source = readFileSync(path.join(projectRoot, routePath), 'utf8');
  const policyLine = /query = query\.or\(`role\.neq\.admin,id\.eq\.\$\{clean\(admin\.userId\)\}`\);/u;
  assert.match(source, policyLine, 'identity filter must be present for mutation sensitivity check');
  const mutant = createUsersRouteHarness({ routeSource: source.replace(policyLine, '/* sensitivity check: identity predicate removed */') });
  const leaked = await mutant.get('operator');
  assert.equal(leaked.status, 200);
  assert.ok(leaked.body.users.some(user => user.role === 'admin' && user.id !== id('operator')), 'fixture must expose policy removal; never hard-code expected rows');
  assert.equal(harness.state.networkAttempts + fallback.state.networkAttempts + mutant.state.networkAttempts, 0);
  assert.equal(harness.state.writeAttempts + fallback.state.writeAttempts + mutant.state.writeAttempts, 0);
  const report = {
    status: 'PASS', evidenceLayer: 'fixture-only actual-route VM', actualRoute: true, actualPureDomainHelpers: true,
    querySemantics: 'eq/in/is + AND of independent OR groups + order + selected-column projection + range',
    sourceIdentity: sourceIdentity(), checks, checksPassed: checks.length,
    mutationSensitivity: { identityFilterRemovalDetected: true, mutantForeignAdminCount: leaked.body.users.filter(user => user.role === 'admin' && user.id !== id('operator')).length },
    networkRequests: 0, databaseWrites: 0, realRoleSessionsVerified: false,
  };
  writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, checksPassed: checks.length, mutationSensitivity: report.mutationSensitivity, evidenceLayer: report.evidenceLayer, networkRequests: 0, databaseWrites: 0, evidenceDirectory }, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runZeroNetworkVerification();
}
