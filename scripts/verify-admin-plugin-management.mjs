import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';
const nativeRequire = createRequire(import.meta.url);
const state = { admin: true, plugins: [], writes: [] };
function query() {
  const filters = []; let operation = 'read'; let payload;
  const finish = (single = false) => {
    let rows = state.plugins.filter((row) => filters.every((test) => test(row)));
    if (operation === 'insert') { const row = { id: 'fixture-created', ...payload }; state.plugins.push(row); rows = [row]; state.writes.push({ operation, payload }); }
    if (operation === 'update') { rows.forEach((row) => Object.assign(row, payload)); state.writes.push({ operation, count: rows.length, payload }); }
    return { data: single ? rows[0] || null : rows, error: null };
  };
  return {
    select() { return this; }, order() { return this; },
    eq(key, value) { filters.push((row) => row[key] === value); return this; },
    neq(key, value) { filters.push((row) => row[key] !== value); return this; },
    in(key, values) { filters.push((row) => values.includes(row[key])); return this; },
    insert(value) { operation = 'insert'; payload = value; return this; }, update(value) { operation = 'update'; payload = value; return this; },
    single() { return Promise.resolve(finish(true)); }, maybeSingle() { return Promise.resolve(finish(true)); },
    then(yes, no) { return Promise.resolve(finish()).then(yes, no); },
  };
}
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const loaded = { exports: {} }; cache.set(file, loaded.exports);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, URL, Date, Number, Object, Array, Set, Error, Math,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/lib/admin-auth') return { verifyAdminToken: async () => state.admin ? { userId: 'fixture-admin', role: 'admin' } : null };
      if (name === '@/storage/database/supabase-client') return { getSupabaseClient: () => ({ from: query }) };
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts');
      return nativeRequire(name);
    },
    console: { log() {}, warn() {}, error() {} },
    fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); },
  });
  return loaded.exports;
}
const metadata = load('src/lib/plugin-metadata.ts');
const formHelpers = load('src/lib/admin-plugin-form.ts');
const route = load('src/app/api/admin/plugins/route.ts');
const stored = () => ({ id: 'fixture-original', name: '原插件', type: 'coze', subtype: 'workflow', role: 'cover_workflow', description: '原说明', is_active: true, price_per_use: 0, cost_price: 0, price_unit: '次', sort_order: 3, config: { api_base_url: 'https://provider.example/run', api_token: 'FIXTURE_PRIVATE_TOKEN', api_key: 'FIXTURE_PRIVATE_KEY', workflow_id: 'workflow-fixture', nested: { authorization: 'FIXTURE_NESTED_SECRET', keep: 42 }, extra: true } });
const request = (body, method = 'PUT') => new Request('http://127.0.0.1:5000/api/admin/plugins', { method, headers: { Authorization: 'Bearer fixture-test-session', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let passed = 0;
async function test(name, run) { state.admin = true; state.plugins = [stored()]; state.writes = []; await run(); passed++; console.log('PASS ' + name); }
await test('new form creates an inactive zero-price plugin', async () => {
  const form = formHelpers.createAdminPluginForm(); form.name = '新插件'; form.apiBaseUrl = 'https://provider.example/run';
  const payload = formHelpers.buildAdminPluginPayload(form); assert.equal(payload.is_active, false); assert.equal(payload.price_per_use, 0); assert.equal(payload.cost_price, 0);
  const response = await route.POST(request(payload, 'POST')); assert.equal(response.status, 201); assert.equal(state.plugins[0].is_active, true); assert.equal(state.writes.length, 1);
});
await test('masked records open with blank credential controls and preserve extra configuration', async () => {
  const masked = metadata.sanitizePluginForAdmin(stored()); const form = formHelpers.createAdminPluginForm(masked);
  assert.equal(form.secretValues.api_token, ''); assert.equal(form.secretValues.api_key, ''); assert.equal(form.price, '0');
  assert.doesNotMatch(JSON.stringify(form), /FIXTURE_PRIVATE|FIXTURE_NESTED/u);
  const extra = JSON.parse(form.advancedConfig); assert.equal(extra.nested.authorization, '********'); assert.equal(extra.nested.keep, 42); assert.equal(extra.extra, true);
});
await test('metadata edit keeps credentials and does not toggle or deactivate other plugins', async () => {
  const masked = metadata.sanitizePluginForAdmin(stored()); const form = formHelpers.createAdminPluginForm(masked); form.name = '已编辑';
  const payload = formHelpers.buildAdminPluginPayload(form, masked); assert.equal(Object.hasOwn(payload, 'is_active'), false); assert.equal(Object.hasOwn(payload, 'role'), false);
  const response = await route.PUT(request(payload)); assert.equal(response.status, 200); const body = await response.json();
  assert.equal(state.writes.length, 1); assert.equal(state.plugins[0].config.api_token, 'FIXTURE_PRIVATE_TOKEN'); assert.equal(state.plugins[0].config.nested.authorization, 'FIXTURE_NESTED_SECRET');
  assert.equal(body.plugin.config.api_token, '********'); assert.doesNotMatch(JSON.stringify(body), /FIXTURE_PRIVATE|FIXTURE_NESTED/u);
});
await test('empty whitespace masked and omitted credentials all preserve stored values', async () => {
  for (const value of ['', '   ', '********', undefined, null]) {
    const result = metadata.mergePluginConfigSecrets({ api_token: value }, stored().config); assert.equal(result.api_token, 'FIXTURE_PRIVATE_TOKEN');
  }
});
await test('explicit credential replacement remains masked in the response', async () => {
  const masked = metadata.sanitizePluginForAdmin(stored()); const form = formHelpers.createAdminPluginForm(masked); form.secretValues.api_token = 'FIXTURE_REPLACEMENT';
  const response = await route.PUT(request(formHelpers.buildAdminPluginPayload(form, masked))); assert.equal(response.status, 200); assert.equal(state.plugins[0].config.api_token, 'FIXTURE_REPLACEMENT');
  assert.doesNotMatch(JSON.stringify(await response.json()), /FIXTURE_REPLACEMENT/u);
});
await test('explicit clear removes only the selected existing credential', async () => {
  const masked = metadata.sanitizePluginForAdmin(stored()); const form = formHelpers.createAdminPluginForm(masked); form.clearSecretFields = ['api_token'];
  const response = await route.PUT(request(formHelpers.buildAdminPluginPayload(form, masked))); assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(state.plugins[0].config, 'api_token'), false); assert.equal(state.plugins[0].config.api_key, 'FIXTURE_PRIVATE_KEY'); assert.equal(state.plugins[0].config.nested.authorization, 'FIXTURE_NESTED_SECRET');
});
await test('clear-only requests preserve all nonselected configuration', async () => {
  const response = await route.PUT(request({ id: 'fixture-original', clear_secret_fields: ['api_key'] })); assert.equal(response.status, 200);
  assert.equal(state.plugins[0].config.extra, true); assert.equal(state.plugins[0].config.api_token, 'FIXTURE_PRIVATE_TOKEN'); assert.equal(Object.hasOwn(state.plugins[0].config, 'api_key'), false);
});
await test('invalid or unconfigured clear fields cannot mutate the plugin', async () => {
  for (const fields of [['api_base_url'], ['missing_token'], ['nested.authorization'], ['__proto__'], 'api_token', null]) {
    const response = await route.PUT(request({ id: 'fixture-original', clear_secret_fields: fields })); assert.equal(response.status, 400);
  }
  assert.equal(state.writes.length, 0);
});
await test('negative blank nonnumeric prices and malformed configuration are rejected before dispatch', async () => {
  const base = formHelpers.createAdminPluginForm(); base.name = '测试'; base.apiBaseUrl = 'https://provider.example';
  for (const value of ['', '-1', 'NaN', 'Infinity']) assert.throws(() => formHelpers.buildAdminPluginPayload({ ...base, price: value }));
  for (const value of ['[]', 'null', '{']) assert.throws(() => formHelpers.buildAdminPluginPayload({ ...base, advancedConfig: value }));
  assert.throws(() => formHelpers.buildAdminPluginPayload({ ...base, apiBaseUrl: 'javascript:alert(1)' }));
  assert.equal(state.writes.length, 0);
});
await test('current admin authorization is required for saving and clearing', async () => {
  state.admin = false; assert.equal((await route.PUT(request({ id: 'fixture-original', clear_secret_fields: ['api_token'] }))).status, 401); assert.equal(state.writes.length, 0);
});
console.log(JSON.stringify({ passed, failed: 0, realUpstreamRequests: 0, realDatabaseWrites: 0 }));
