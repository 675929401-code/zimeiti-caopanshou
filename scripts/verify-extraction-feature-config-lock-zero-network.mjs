import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protectedRoles = [
  'coze_multifunction_extract', 'extract_workflow', 'extract_text_third_party',
  'extract_batch_third_party', 'extract_video',
];
const state = { admin: true, plugins: [], writes: [], readError: null, network: 0 };
const fixture = (role = 'coze_multifunction_extract', id = 'fixture-original') => ({
  id, name: '测试插件', type: 'coze', subtype: 'workflow', role,
  description: '测试说明', icon: '', is_active: true, price_per_use: 0.02,
  cost_price: 0.01, price_unit: '条', sort_order: 0,
  config: { api_base_url: 'https://fixture.invalid/run', api_token: 'FIXTURE_PRIVATE_TOKEN', extra: true },
});

function query(table) {
  assert.equal(table, 'plugins');
  const filters = [];
  let operation = 'read';
  let payload;
  const finish = (single = false) => {
    if (state.readError && operation === 'read') return { data: null, error: state.readError };
    let rows = state.plugins.filter(row => filters.every(test => test(row)));
    if (operation === 'insert') {
      const row = { id: 'fixture-created', ...payload };
      state.plugins.push(row);
      rows = [row];
    } else if (operation === 'update') {
      rows.forEach(row => Object.assign(row, payload));
    } else if (operation === 'delete') {
      state.plugins = state.plugins.filter(row => !rows.includes(row));
    }
    return { data: single ? rows[0] || null : rows, error: null };
  };
  return {
    select() { return this; }, order() { return this; },
    eq(key, value) { filters.push(row => row[key] === value); return this; },
    neq(key, value) { filters.push(row => row[key] !== value); return this; },
    in(key, values) { filters.push(row => values.includes(row[key])); return this; },
    insert(value) { operation = 'insert'; payload = value; state.writes.push({ operation, payload }); return this; },
    update(value) { operation = 'update'; payload = value; state.writes.push({ operation, payload }); return this; },
    delete() { operation = 'delete'; state.writes.push({ operation }); return this; },
    single() { return Promise.resolve(finish(true)); },
    maybeSingle() { return Promise.resolve(finish(true)); },
    then(resolve, reject) { return Promise.resolve(finish()).then(resolve, reject); },
  };
}

const moduleCache = new Map();
function load(relativeFile) {
  if (moduleCache.has(relativeFile)) return moduleCache.get(relativeFile);
  const loaded = { exports: {} };
  moduleCache.set(relativeFile, loaded.exports);
  const source = fs.readFileSync(path.join(projectRoot, relativeFile), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, URL, Date, Number, Object, Array, Set, Error, Math,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/lib/admin-auth') return { verifyAdminToken: async () => state.admin ? { userId: 'fixture-admin', role: 'admin' } : null };
      if (name === '@/storage/database/supabase-client') return { getSupabaseClient: () => ({ from: query }) };
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts');
      throw new Error('UNEXPECTED_DEPENDENCY:' + name);
    },
    console: { log() {}, warn() {}, error() {} },
    fetch() { state.network++; throw new Error('REAL_NETWORK_FORBIDDEN'); },
  }, { filename: relativeFile });
  return loaded.exports;
}

const route = load('src/app/api/admin/plugins/route.ts');
const request = (method, body, suffix = '') => new Request('http://127.0.0.1:5000/api/admin/plugins' + suffix, {
  method,
  headers: { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
let passed = 0;
async function test(name, run) {
  state.admin = true;
  state.plugins = [fixture(), fixture('cover_workflow', 'fixture-unrelated')];
  state.writes = [];
  state.readError = null;
  await run();
  assert.equal(state.network, 0);
  passed++;
  console.log('PASS ' + name);
}
async function assertLocked(response, before) {
  assert.equal(response.status, 423);
  const body = await response.json();
  assert.equal(body.error_code, 'EXTRACTION_FEATURE_LOCKED');
  assert.equal(body.featureLock.locked, true);
  assert.match(body.error, /用户本人明确授权/u);
  assert.deepEqual(body.featureLock.protectedRoles, protectedRoles);
  assert.equal(state.writes.length, 0, 'No insert/update/delete method may be reached, including sibling deactivation');
  assert.deepEqual(state.plugins, before);
  assert.doesNotMatch(JSON.stringify(body), /FIXTURE_PRIVATE_TOKEN/u);
}

for (const role of protectedRoles) {
  for (const is_active of [true, false]) {
    await test(`POST ${role} active=${is_active} blocks creation before sibling deactivation`, async () => {
      const before = structuredClone(state.plugins);
      await assertLocked(await route.POST(request('POST', { ...fixture(role), is_active })), before);
    });
  }
  for (const [kind, change] of Object.entries({
    name: { name: '修改名称' }, type: { type: 'workflow' }, subtype: { subtype: 'other' },
    description: { description: '修改说明' }, icon: { icon: 'x' }, sort: { sort_order: 9 },
    activate: { is_active: true }, deactivate: { is_active: false },
    price: { price_per_use: 0.03 }, cost: { cost_price: 0.02 }, priceUnit: { price_unit: '次' },
    endpoint: { config: { api_base_url: 'https://replacement.invalid/run' } },
    credential: { config: { api_token: 'FIXTURE_REPLACEMENT' } },
    clearCredential: { clear_secret_fields: ['api_token'] },
    roleExit: { role: 'cover_workflow' }, roleSame: { role },
    emptyPatch: {}, fakeUnlock: { featureLock: { locked: false }, unlock: true, owner_authorized: true },
  })) {
    await test(`PUT ${role} ${kind} is frozen`, async () => {
      state.plugins[0].role = role;
      const before = structuredClone(state.plugins);
      await assertLocked(await route.PUT(request('PUT', { id: 'fixture-original', ...change })), before);
    });
  }
  await test(`PUT normal role into ${role} cannot deactivate extraction siblings`, async () => {
    const before = structuredClone(state.plugins);
    await assertLocked(await route.PUT(request('PUT', { id: 'fixture-unrelated', role, is_active: true })), before);
  });
  await test(`DELETE ${role} is frozen`, async () => {
    state.plugins[0].role = role;
    const before = structuredClone(state.plugins);
    await assertLocked(await route.DELETE(request('DELETE', undefined, '?id=fixture-original')), before);
  });
}

await test('GET list preserves masked configuration and exposes nonsecret lock metadata', async () => {
  const response = await route.GET(request('GET'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plugins.length, 2);
  assert.equal(body.plugins[0].config.api_token, '********');
  assert.equal(body.featureLock.locked, true);
  assert.deepEqual(body.featureLock.protectedRoles, protectedRoles);
  assert.doesNotMatch(JSON.stringify(body), /FIXTURE_PRIVATE_TOKEN/u);
  assert.equal(state.writes.length, 0);
});
await test('GET single preserves the original readable configuration', async () => {
  const response = await route.GET(request('GET', undefined, '?id=fixture-original'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plugin.id, 'fixture-original');
  assert.equal(body.plugin.config.api_base_url, 'https://fixture.invalid/run');
  assert.equal(body.plugin.config.api_token, '********');
  assert.equal(body.featureLock.locked, true);
  assert.equal(state.writes.length, 0);
});
await test('ordinary plugin POST remains available and does not deactivate protected roles', async () => {
  const protectedBefore = structuredClone(state.plugins[0]);
  const response = await route.POST(request('POST', { ...fixture('cover_workflow'), id: undefined }));
  assert.equal(response.status, 201);
  assert.deepEqual(state.plugins[0], protectedBefore);
  assert.equal(state.writes.filter(write => write.operation === 'insert').length, 1);
});
await test('ordinary plugin PUT can save metadata and preserve a masked credential', async () => {
  const protectedBefore = structuredClone(state.plugins[0]);
  const response = await route.PUT(request('PUT', { id: 'fixture-unrelated', name: '普通插件更新', config: { api_base_url: 'https://fixture.invalid/run', api_token: '********' } }));
  assert.equal(response.status, 200);
  assert.equal(state.plugins[1].name, '普通插件更新');
  assert.equal(state.plugins[1].config.api_token, 'FIXTURE_PRIVATE_TOKEN');
  assert.deepEqual(state.plugins[0], protectedBefore);
});
await test('ordinary plugin DELETE remains available without touching extraction', async () => {
  const protectedBefore = structuredClone(state.plugins[0]);
  const response = await route.DELETE(request('DELETE', undefined, '?id=fixture-unrelated'));
  assert.equal(response.status, 200);
  assert.equal(state.plugins.length, 1);
  assert.deepEqual(state.plugins[0], protectedBefore);
});
await test('failed original-role reads close PUT and DELETE without writes', async () => {
  state.readError = { message: 'fixture read unavailable' };
  assert.equal((await route.PUT(request('PUT', { id: 'fixture-original', role: 'cover_workflow' }))).status, 500);
  assert.equal((await route.DELETE(request('DELETE', undefined, '?id=fixture-original'))).status, 500);
  assert.equal(state.writes.length, 0);
});
await test('missing records do not permit update or delete writes', async () => {
  assert.equal((await route.PUT(request('PUT', { id: 'missing', name: 'x' }))).status, 404);
  assert.equal((await route.DELETE(request('DELETE', undefined, '?id=missing'))).status, 404);
  assert.equal(state.writes.length, 0);
});
await test('admin authorization remains mandatory for every method', async () => {
  state.admin = false;
  assert.equal((await route.GET(request('GET'))).status, 401);
  assert.equal((await route.POST(request('POST', fixture()))).status, 401);
  assert.equal((await route.PUT(request('PUT', { id: 'fixture-original', name: 'x' }))).status, 401);
  assert.equal((await route.DELETE(request('DELETE', undefined, '?id=fixture-original'))).status, 401);
  assert.equal(state.writes.length, 0);
});

console.log(JSON.stringify({ passed, failed: 0, realNetworkRequests: state.network, realDatabaseWrites: 0 }));
