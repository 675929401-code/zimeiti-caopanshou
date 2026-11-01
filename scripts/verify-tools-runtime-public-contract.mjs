import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, console, TextDecoder, URL, require(id) {
    assert.ok(id in dependencies, `Unapproved dependency: ${id}`);
    return dependencies[id];
  } });
  return module.exports;
}

const pricing = load('src/lib/extract-pricing.ts');
const display = load('src/lib/display-normalization.ts');
let rows = [], databaseError = null, databaseReads = 0;
const db = { from(table) {
  databaseReads++;
  assert.equal(table, 'plugins');
  const filters = new Map();
  const query = {
    select: () => query, in: () => query,
    eq: (key, value) => { filters.set(key, value); return query; },
    then: resolve => Promise.resolve({
      data: rows.filter(row => [...filters].every(([key, value]) => row[key] === value)),
      error: databaseError,
    }).then(resolve),
  };
  return query;
} };
const route = load('src/app/api/tools/runtime-catalog/route.ts', {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/api-middleware': { withAuth: async (request, callback) => {
    const role = request.headers.get('x-fixture-role');
    return role ? callback({ id: 'owner', role }, db) : Response.json({ error: 'Unauthorized' }, { status: 401 });
  } },
  '@/lib/display-normalization': display,
  '@/lib/extract-pricing': pricing,
  '@/lib/server/admin-governance-authority': { authorizeAdminCapability: async () => ({ ok: true }) },
});
const call = role => route.GET(new Request('http://fixture.invalid/api/tools/runtime-catalog', { headers: role ? { 'x-fixture-role': role } : {} }));
const textFixture = { role: 'coze_multifunction_extract', is_active: true, name: 'Private text provider label', price_per_use: '0.02', cost_price: '0.01', config: { api_base_url: 'https://text-provider.invalid', api_token: 'fixture-text-secret', workflow_id: 'private-workflow' } };
const videoFixture = { role: 'extract_video', is_active: true, name: 'Private video provider label', price_per_use: '0.03', cost_price: '0.015', config: { api_base_url: 'https://video-provider.invalid/parse', provider: 'ppt6', response_format: 'ppt6', client_id: 'fixture-client', client_secret_key: 'fixture-video-secret' } };
const checks = [];
let response = await call();
assert.equal(response.status, 401); assert.equal(databaseReads, 0); checks.push('anonymous authentication gate precedes configuration read');
rows = [textFixture, videoFixture];
response = await call('student'); let body = await response.json();
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'private, no-store');
assert.doesNotMatch(JSON.stringify(body), /provider|model|adminExempt|semantic|Token|fixture-(?:text|video)-secret|private-workflow|Private (?:text|video) provider/iu);
assert.equal(body.items.video.available, true); assert.equal(body.items.video.unitPrice, 0.02);
for (const name of ['text','batch','search']) { assert.equal(body.items[name].available, true); assert.equal(body.items[name].unitPrice, 0.02); assert.ok(body.items[name].service); }
checks.push('student video, text, batch and search quotes all come from the shared three-in-one plugin');
for (const name of ['formatter','segmenter']) {
  assert.equal(body.items[name].unitPrice, 0); assert.equal(body.items[name].processingMode, 'local_rules'); assert.equal(body.items[name].available, true);
}
checks.push('formatter and segmenter are free local rules; semantic model absent');
body = await (await call('admin')).json();
assert.equal(body.items.video.provider.toLowerCase(), 'coze'); assert.equal(body.items.video.model, textFixture.name);
assert.equal(body.items.semantic, undefined); assert.doesNotMatch(JSON.stringify(body), /api_token|client_secret_key|fixture-(?:text|video)-secret|private-workflow|(?:text|video)-provider\.invalid/u);
checks.push('administrator keeps safe shared-plugin diagnostics without credentials or endpoint details');
for (const [name, change] of [
  ['missing shared price', { price_per_use: null }],
  ['missing shared cost', { cost_price: null }],
  ['missing shared token', { config: { ...textFixture.config, api_token: '' } }],
  ['insecure shared endpoint', { config: { ...textFixture.config, api_base_url: 'http://text-provider.invalid/run' } }],
]) {
  rows = [{ ...textFixture, ...change }, videoFixture]; body = await (await call('student')).json();
  for (const tool of ['video','text','batch','search']) assert.equal(body.items[tool].available, false);
  checks.push(`${name} fails every provider-backed three-in-one tool closed`);
}
rows = [{ ...textFixture, price_per_use: 0, cost_price: 0 }, videoFixture]; body = await (await call('student')).json();
assert.equal(body.items.video.available, true); assert.equal(body.items.video.unitPrice, 0); assert.equal(body.items.text.unitPrice, 0); checks.push('explicitly configured zero shared price remains valid');
rows = [videoFixture]; body = await (await call('student')).json(); for (const tool of ['video','text','batch','search']) { assert.equal(body.items[tool].available, false); assert.equal(body.items[tool].unitPrice, null); } checks.push('legacy PPT6 row cannot silently replace the shared plugin');
databaseError = { code: 'fixture-error' }; response = await call('student'); assert.equal(response.status, 503); checks.push('database read failure returns unavailable');
const report = { passed: true, checks, providerRequests: 0, networkRequests: 0, databaseWrites: 0, realDatabaseReads: 0 };
const target = process.argv.find(value => value.startsWith('--report='))?.slice(9);
if (target) fs.writeFileSync(target, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
