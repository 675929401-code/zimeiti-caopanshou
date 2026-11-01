import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = { network: 0, writes: 0, principalReads: [], accessReads: [], memberReads: [], attempts: 0, providerCalls: 0, charges: 0, users: {}, access: {}, grants: {}, revoked: false, userReadThrows: false, accessReadThrows: false, signatureThrows: false };
const grants = ['自用', 'task:文案创作', 'task:影像编导'];
const validAccess = () => ({ authorityStatus: 'ready', integrityValid: true, profileActive: true, adminLevel: 'super_admin', revision: 12, checksum: 'fixture-current-checksum', permissionKeys: ['agents.view', 'internal_tools.manage'] });
const agent = (id, name, category, extra = {}) => ({ id, name, category, source: 'llm', is_active: true, user_access: 'available', deleted_at: null, system_prompt: 'FIXTURE_PRIVATE_PROMPT_MUST_NOT_ESCAPE', coze_coding_api_token: 'FIXTURE_PRIVATE_TOKEN_MUST_NOT_ESCAPE', ...extra });
const fixtureAgents = [
  ...Array.from({ length: 14 }, (_, index) => agent('internal-' + index, '内部工具' + index, '自用')),
  agent('deleted-internal', '已删除内部历史', '自用', { is_active: false, user_access: 'hidden', deleted_at: '2026-01-01T00:00:00Z' }),
  agent('public-copy', '公开文案助手', '公开'),
  agent('public-director', '3D影像编导', '公开'),
];
const fixtureCategories = [
  { id: 'category-internal', name: '自用', icon: null, visibility: 'normal', is_active: true, sort_order: 1 },
  { id: 'category-public', name: '公开', icon: null, visibility: 'normal', is_active: true, sort_order: 0 },
];
function identity(token) {
  if (!token || !['owner', 'admin', 'learner', 'other-owner'].includes(token)) return null;
  return { userId: token, role: token === 'learner' ? 'student' : 'admin', sessionId: 'fixture-session-' + token };
}
function reset() {
  state.principalReads = [];
  state.accessReads = [];
  state.memberReads = [];
  state.attempts = 0;
  state.providerCalls = 0;
  state.charges = 0;
  state.users = {};
  state.access = {};
  state.grants = {};
  state.revoked = false;
  state.userReadThrows = false;
  state.accessReadThrows = false;
  state.signatureThrows = false;
  for (const id of ['owner', 'admin', 'learner', 'other-owner']) {
    state.users[id] = { id, role: id === 'learner' ? 'student' : 'admin', status: 'active', is_active: true, session_id: 'fixture-session-' + id };
    state.access[id] = { ...validAccess(), adminLevel: id === 'admin' ? 'admin' : 'super_admin' };
    state.grants[id] = [...grants];
  }
}
function query(table) {
  const predicates = [];
  const finish = single => {
    if (table === 'users' && state.userReadThrows) throw new Error('FIXTURE_CURRENT_PRINCIPAL_UNAVAILABLE');
    const rows = table === 'agents' ? fixtureAgents : table === 'categories' ? fixtureCategories : table === 'users' ? Object.values(state.users) : null;
    assert.ok(rows, 'Unexpected mock table: ' + table);
    const filtered = rows.filter(row => predicates.every(predicate => predicate(row)));
    if (table === 'users') state.principalReads.push(filtered[0]?.id || null);
    return { data: single ? filtered[0] || null : filtered, error: null };
  };
  return {
    select() { return this; }, order() { return this; }, abortSignal() { return this; },
    eq(key, value) { predicates.push(row => row[key] === value); return this; },
    is(key, value) { predicates.push(row => row[key] === value); return this; },
    maybeSingle() { return Promise.resolve().then(() => finish(true)); },
    then(resolve, reject) { return Promise.resolve().then(() => finish(false)).then(resolve, reject); },
    insert() { state.writes++; throw new Error('REAL_WRITES_FORBIDDEN'); },
    update() { state.writes++; throw new Error('REAL_WRITES_FORBIDDEN'); },
    delete() { state.writes++; throw new Error('REAL_WRITES_FORBIDDEN'); },
    rpc() { state.writes++; throw new Error('UNEXPECTED_RPC'); },
  };
}
const client = { from: query };
async function readFixtureMemberPermissionSnapshot(userId) {
  state.memberReads.push(userId);
  return { authorityStatus: 'ready', integrityValid: true, agentNavigationKeys: [...state.grants[userId]] };
}
const moduleCache = new Map();
function load(relative) {
  if (moduleCache.has(relative)) return moduleCache.get(relative);
  const loaded = { exports: {} };
  moduleCache.set(relative, loaded.exports);
  const source = ts.transpileModule(fs.readFileSync(path.join(projectRoot, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, {
    module: loaded, exports: loaded.exports, URL, Date, Number, Object, Array, Set, Map, Error, Math, AbortSignal,
    process: { env: { NODE_ENV: 'production' } },
    console: { log() {}, warn() {}, error() {} },
    fetch() { state.network++; throw new Error('REAL_NETWORK_FORBIDDEN'); },
    require(name) {
      if (name === 'server-only') return {};
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/lib/auth') return {
        getTokenFromHeaders: headers => headers.get('Authorization')?.replace(/^Bearer /u, '') || null,
        verifyToken: async token => identity(token),
        verifyTokenSignature: async token => { if (state.signatureThrows) throw new Error('FIXTURE_AUTH_UNAVAILABLE'); return identity(token); },
      };
      if (name === '@/storage/database/supabase-client') return { getSupabaseClient: () => client, getSupabaseAdminClient: () => client };
      if (name === '@/lib/auth-session-store') return { isUserAuthSessionActive: async (_client, userId, sessionId) => ({ ok: !state.revoked && sessionId === state.users[userId]?.session_id }) };
      if (name === '@/lib/server/admin-governance-authority') return { readAdminAccessSnapshot: async userId => {
        state.accessReads.push(userId);
        if (state.accessReadThrows) throw new Error('FIXTURE_AUTHORITY_UNAVAILABLE');
        return structuredClone(state.access[userId]);
      } };
      if (name === '@/lib/server/member-permission-authority') return { readMemberPermissionSnapshot: readFixtureMemberPermissionSnapshot };
      if (name === '@/lib/bots-cache') return { getBotsCache: () => null, setBotsCache: () => {} };
      if (name === '@/lib/agent-preset-schema') return { normalizeAgentPresetFields: value => value };
      if (name === '@/lib/public-model-dto') return { toPublicModelId: () => 'fixture-public-model' };
      if (name === '@/lib/storyboard-director-public-output-style') return { publicStoryboardDirectorOutputStyle: () => undefined };
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts');
      throw new Error('UNEXPECTED_DEPENDENCY:' + name);
    },
  }, { filename: relative });
  return loaded.exports;
}
const helper = load('src/lib/server/internal-agent-catalog-access.ts');
const bots = load('src/app/api/bots/route.ts');
const categories = load('src/app/api/categories/route.ts');
const request = (pathname, token = 'owner', method = 'GET', steppedUp = false) => new Request('http://fixture.invalid' + pathname, {
  method,
  headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(steppedUp ? { 'x-admin-step-up': 'fixture-step-up' } : {}) },
});

function containsCall(node, name) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) return true;
  return ts.forEachChild(node, child => containsCall(child, name)) || false;
}
function containsCode(node, code) {
  if (ts.isStringLiteral(node) && node.text === code) return true;
  return ts.forEachChild(node, child => containsCode(child, code)) || false;
}
function compileActualAdmission(relative, rowName) {
  const text = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const post = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
  assert.ok(post?.body, relative + ': actual POST handler exists');
  const tryBlock = post.body.statements.find(ts.isTryStatement)?.tryBlock;
  assert.ok(tryBlock, relative + ': POST try block exists');
  const statements = [...tryBlock.statements];
  const guardIndex = statements.findIndex(node => ts.isIfStatement(node) && containsCall(node.expression, 'canUseOwnerInternalAgent'));
  assert.ok(guardIndex >= 0, relative + ': actual owner guard must exist');
  const guard = statements[guardIndex];
  assert.ok(containsCode(guard, 'OWNER_INTERNAL_AGENT_REQUIRED'));
  const memberStatements = [];
  for (let index = guardIndex + 1; index < statements.length; index++) {
    memberStatements.push(statements[index]);
    if (containsCode(statements[index], 'CATEGORY_ACCESS_DENIED')) break;
  }
  assert.ok(memberStatements.some(statement => containsCall(statement, 'readMemberPermissionSnapshot')), relative + ': original member admission must follow owner guard');
  assert.ok(memberStatements.some(statement => containsCode(statement, 'CATEGORY_ACCESS_DENIED')));
  const sideEffects = [];
  const sideEffectNames = new Set(['claim', 'markProviderCallStarted', 'reserveLlmStreamCredits', 'streamChat', 'handleStreamResponse', 'handleNonStreamResponse']);
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
      if (sideEffectNames.has(name)) {
        assert.ok(node.getStart(source) > guard.end, relative + ': ' + name + ' must stay after the actual admission guard');
        sideEffects.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(post.body);
  assert.ok(sideEffects.includes('claim'), relative + ': durable attempt claim order is checked');
  assert.ok(sideEffects.includes('markProviderCallStarted'), relative + ': provider dispatch marker order is checked');
  const loaded = { exports: {} };
  const harness = `export async function admission(request, trustedAgent, body) {
    const ${rowName} = trustedAgent;
    const agentId = trustedAgent.id;
    const verifiedUserId = identity(request.headers.get('Authorization')?.replace(/^Bearer /, ''))?.userId;
    const userRole = identity(request.headers.get('Authorization')?.replace(/^Bearer /, ''))?.role;
    ${guard.getText(source)}
    ${memberStatements.map(statement => statement.getText(source)).join('\n')}
    // Only fixture sentinels run after the actual owner and member blocks.
    state.attempts++; state.charges++; state.providerCalls++;
    return Response.json({ code: 'ORIGINAL_ADMISSION_CONTINUED' });
  }`;
  const compiled = ts.transpileModule(harness, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Response, String, identity, state,
    canUseOwnerInternalAgent: helper.canUseOwnerInternalAgent,
    readMemberPermissionSnapshot: readFixtureMemberPermissionSnapshot,
    getAgentNavigationKey: load('src/lib/agent-category-access.ts').getAgentNavigationKey,
  }, { filename: relative + ':actual-admission-blocks' });
  return loaded.exports.admission;
}
const actualAdmissions = [
  { pathname: '/api/llm', run: compileActualAdmission('src/app/api/llm/route.ts', 'agentRow') },
  { pathname: '/api/chat', run: compileActualAdmission('src/app/api/chat/route.ts', 'serverAgent') },
];
const results = [];
async function test(name, run) {
  reset();
  await run();
  assert.equal(state.network, 0);
  assert.equal(state.writes, 0);
  results.push({ name, passed: true });
  console.log('PASS ' + name);
}
async function assertCatalog(token, internalCount, steppedUp = false) {
  const response = await bots.GET(request('/api/bots?shape=agents', token, 'GET', steppedUp));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agents.filter(agent => agent.category === '自用').length, internalCount);
  assert.equal(body.agents.filter(agent => agent.category === '公开').length, 2, 'Existing public cards remain readable');
  assert.equal(body.agents.some(agent => agent.id === 'deleted-internal'), false, 'Deleted internal history must stay deleted');
  assert.doesNotMatch(JSON.stringify(body), /system_prompt|coze_coding_api_token|FIXTURE_PRIVATE/u);
  const categoryResponse = await categories.GET(request('/api/categories', token, 'GET', steppedUp));
  assert.equal(categoryResponse.status, 200);
  const categoryBody = await categoryResponse.json();
  assert.equal(categoryBody.categories.filter(category => category.name === '自用').length, internalCount > 0 ? 1 : 0);
  assert.equal(categoryBody.categories.filter(category => category.name === '公开').length, 1);
  return body;
}

await test('current super admin reads 14 active internal agents and their category without step-up', async () => {
  await assertCatalog('owner', 14);
  assert.ok(state.principalReads.every(id => id === 'owner'));
  assert.ok(state.accessReads.every(id => id === 'owner'));
});
await test('ordinary admin cannot read internals even with step-up and internal grants', () => assertCatalog('admin', 0, true));
await test('learner cannot read internals even with the self-use grant', () => assertCatalog('learner', 0, true));
await test('anonymous catalog excludes all internal agents', () => assertCatalog(null, 0));
await test('owner identity alone cannot substitute for the self-use product grant', async () => {
  state.grants.owner = grants.filter(key => key !== '自用');
  await assertCatalog('owner', 0);
});
for (const permission of ['internal_tools.manage', 'agents.view']) {
  await test('missing owner capability blocks internals: ' + permission, async () => {
    state.access.owner.permissionKeys = state.access.owner.permissionKeys.filter(key => key !== permission);
    await assertCatalog('owner', 0);
  });
}
for (const [name, patch] of [
  ['legacy revision zero', { revision: 0 }],
  ['legacy checksum', { checksum: 'legacy-schema-absent' }],
  ['missing checksum', { checksum: '' }],
  ['invalid authority', { authorityStatus: 'invalid' }],
  ['unavailable authority', { authorityStatus: 'unavailable' }],
  ['invalid integrity', { integrityValid: false }],
  ['disabled profile', { profileActive: false }],
  ['disabled authority', { authorityStatus: 'disabled' }],
]) {
  await test(name + ' cannot prove current owner access', async () => {
    Object.assign(state.access.owner, patch);
    await assertCatalog('owner', 0);
  });
}
await test('current principal role revocation overrides a stale owner JWT', async () => {
  state.users.owner.role = 'student';
  await assertCatalog('owner', 0);
  assert.equal(state.accessReads.length, 0);
});
await test('current account disablement denies internals despite valid owner authority', async () => {
  state.users.owner.is_active = false;
  await assertCatalog('owner', 0);
});
await test('revoked live session denies internals despite a valid owner JWT', async () => {
  state.revoked = true;
  await assertCatalog('owner', 0);
});
await test('authentication signature read failure does not expose internals', async () => {
  state.signatureThrows = true;
  await assertCatalog('owner', 0);
});
await test('current principal database read failure does not expose internals', async () => {
  state.userReadThrows = true;
  await assertCatalog('owner', 0);
});
await test('authority database read failure does not expose internals', async () => {
  state.accessReadThrows = true;
  await assertCatalog('owner', 0);
});
await test('the helper permits only the exact two GET routes', async () => {
  for (const pathname of ['/api/bots', '/api/categories']) {
    assert.equal(await helper.canReadOwnerInternalAgentCatalog(request(pathname)), true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const reads = state.principalReads.length;
      assert.equal(await helper.canReadOwnerInternalAgentCatalog(request(pathname, 'owner', method, true)), false);
      assert.equal(state.principalReads.length, reads, 'Rejected methods must not read authority');
    }
  }
  for (const pathname of ['/api/admin/agents', '/api/admin/categories', '/api/bots/', '/api/categories/private', '/api/llm', '/api/storyboard/agent', '/api/bots-extra']) {
    const reads = state.principalReads.length;
    assert.equal(await helper.canReadOwnerInternalAgentCatalog(request(pathname)), false);
    assert.equal(state.principalReads.length, reads, 'Out-of-scope paths must not read authority');
  }
});
await test('successive identities and revocation cannot inherit the previous owner snapshot', async () => {
  await assertCatalog('owner', 14);
  await assertCatalog('admin', 0, true);
  await assertCatalog('learner', 0);
  await assertCatalog(null, 0);
  state.access['other-owner'].profileActive = false;
  await assertCatalog('other-owner', 0);
  state.users.owner.role = 'student';
  await assertCatalog('owner', 0);
  assert.ok(state.accessReads.includes('owner'));
  assert.ok(state.accessReads.includes('admin'));
  assert.ok(state.accessReads.includes('other-owner'));
});

await test('execution wrapper admits the current owner only on exact LLM and Coze POST paths', async () => {
  for (const pathname of ['/api/llm', '/api/chat']) {
    assert.equal(await helper.canUseOwnerInternalAgent(request(pathname, 'owner', 'POST')), true);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(await helper.canUseOwnerInternalAgent(request(pathname, 'owner', method)), false);
    }
  }
  for (const pathname of ['/api/bots', '/api/categories', '/api/llm/', '/api/chat/start', '/api/admin/agents', '/api/storyboard/agent']) {
    assert.equal(await helper.canUseOwnerInternalAgent(request(pathname, 'owner', 'POST')), false);
  }
});
for (const [name, configure, token] of [
  ['ordinary admin with step-up', () => {}, 'admin'],
  ['learner with self-use grant', () => {}, 'learner'],
  ['anonymous identity', () => {}, null],
  ['revoked owner session', () => { state.revoked = true; }, 'owner'],
  ['revoked current admin role', () => { state.users.owner.role = 'student'; }, 'owner'],
  ['disabled current account', () => { state.users.owner.is_active = false; }, 'owner'],
  ['legacy owner revision', () => { state.access.owner.revision = 0; }, 'owner'],
  ['legacy owner checksum', () => { state.access.owner.checksum = 'legacy-schema-absent'; }, 'owner'],
  ['disabled authority profile', () => { state.access.owner.profileActive = false; }, 'owner'],
  ['invalid authority integrity', () => { state.access.owner.integrityValid = false; }, 'owner'],
  ['missing internal capability', () => { state.access.owner.permissionKeys = ['agents.view']; }, 'owner'],
  ['missing agents view capability', () => { state.access.owner.permissionKeys = ['internal_tools.manage']; }, 'owner'],
  ['signature validation failure', () => { state.signatureThrows = true; }, 'owner'],
  ['current principal read failure', () => { state.userReadThrows = true; }, 'owner'],
  ['authority read failure', () => { state.accessReadThrows = true; }, 'owner'],
]) {
  await test('both real execution admission blocks deny ' + name + ' before any attempt, dispatch or charge', async () => {
    configure();
    for (const admission of actualAdmissions) {
      const executionRequest = request(admission.pathname, token, 'POST', true);
      assert.equal(await helper.canUseOwnerInternalAgent(executionRequest), false);
      const response = await admission.run(executionRequest, fixtureAgents[0], { category: '公开', agentId: 'internal-0' });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'OWNER_INTERNAL_AGENT_REQUIRED');
    }
    assert.equal(state.memberReads.length, 0, 'Rejected callers must not enter the original member admission');
    assert.equal(state.attempts, 0);
    assert.equal(state.charges, 0);
    assert.equal(state.providerCalls, 0);
  });
}
await test('owner execution guard still delegates to the original self-use product grant', async () => {
  state.grants.owner = grants.filter(key => key !== '自用');
  for (const admission of actualAdmissions) {
    const executionRequest = request(admission.pathname, 'owner', 'POST');
    assert.equal(await helper.canUseOwnerInternalAgent(executionRequest), true);
    const response = await admission.run(executionRequest, fixtureAgents[0], { category: '公开' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CATEGORY_ACCESS_DENIED');
  }
  assert.equal(state.memberReads.length, 2);
  assert.equal(state.attempts, 0);
  assert.equal(state.charges, 0);
  assert.equal(state.providerCalls, 0);
});
await test('authorized owner proceeds through both original member admission blocks', async () => {
  for (const admission of actualAdmissions) {
    const response = await admission.run(request(admission.pathname, 'owner', 'POST'), fixtureAgents[0], { category: '公开' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).code, 'ORIGINAL_ADMISSION_CONTINUED');
  }
  assert.equal(state.memberReads.length, 2);
  assert.equal(state.attempts, 2);
  assert.equal(state.charges, 2);
  assert.equal(state.providerCalls, 2);
});
await test('client category claims cannot turn a public server record into a private record', async () => {
  for (const admission of actualAdmissions) {
    const response = await admission.run(request(admission.pathname, 'learner', 'POST'), fixtureAgents.at(-1), { category: '自用' });
    assert.equal(response.status, 200);
  }
  assert.equal(state.accessReads.length, 0, 'Only the trusted server category triggers owner authorization');
});

console.log(JSON.stringify({ passed: results.length, failed: 0, realNetworkRequests: state.network, realDatabaseWrites: state.writes, actualInternalFixtures: 14, deletedHistoricalFixture: 1, executionVerification: 'actual owner and member admission blocks; downstream effects are in-memory sentinels, not full POST execution', results }));
