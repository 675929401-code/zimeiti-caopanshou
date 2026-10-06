import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { z } from 'zod';
import { waitForSecondaryDestination, navigationReportDirectory } from './verify-local-navigation-experience.mjs';

const filename = 'src/app/api/canvas/route.ts';
const source = fs.readFileSync(filename, 'utf8');
const state = { ranges: [], filters: [], error: null, dbReads: 0 };
const allRows = Array.from({ length: 60 }, (_, index) => ({ id: `canvas:fixture-${index}`, owner_id: 'fixture-owner', deleted: false, name: 'Fixture canvas', revision: 1, created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z' }));
allRows.push({ ...allRows[0], owner_id: 'other-owner' }, { ...allRows[0], deleted: true });
const db = { from(table) {
  assert.equal(table, 'canvas_documents'); state.dbReads++;
  const filters = [];
  const chain = {
    select(columns) { assert.ok(!columns.includes('document')); return chain; },
    eq(key, value) { filters.push([key, value]); return chain; },
    order(key, options) { assert.equal(key, 'updated_at'); assert.equal(options.ascending, false); return chain; },
    async range(start, end) {
      state.ranges.push([start, end]); state.filters.push(filters);
      const rows = allRows.filter(row => filters.every(([key, value]) => row[key] === value));
      return { data: rows.slice(start, end + 1), count: rows.length, error: state.error };
    },
  };
  return chain;
} };
const exports = {};
const dependencies = {
  'node:crypto': crypto, zod: { z },
  '@/lib/auth': { getTokenFromHeaders: headers => headers.get('Authorization'), verifyToken: async value => value === 'fixture-session' ? { userId: 'fixture-owner' } : null },
  '@/lib/workflow-schema': { WorkflowEdgeSchema: z.unknown(), WorkflowNodeSchema: z.unknown() },
  '@/storage/object': { storageManager: {} },
  '@/storage/database/supabase-client': { getSupabaseClient: () => db },
};
const environment = { COZE_SUPABASE_SERVICE_ROLE_KEY: 'fixture-local-only' };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, require: name => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected import ${name}`); return dependencies[name]; },
  Response, Request, Headers, URL, Buffer, process: { env: environment }, console: { error() {}, warn() {}, log() {} },
}, { filename });
const cases = [];
async function check(name, work) { await work(); cases.push({ name, passed: true }); }
async function get(query = '', authenticated = true) {
  const response = await exports.GET(new Request(`http://127.0.0.1:5000/api/canvas${query}`, { headers: authenticated ? { Authorization: 'fixture-session' } : {} }));
  return { response, body: await response.json() };
}
await check('missing limit reads fifty owned nondeleted canvases', async () => {
  assert.equal(Number(null), 0, 'Old default bug reproduced');
  const { response, body } = await get(); assert.equal(response.status, 200); assert.equal(body.pagination.limit, 50); assert.equal(body.canvases.length, 50);
  assert.equal(body.pagination.total, 60); assert.equal(body.pagination.nextOffset, 50); assert.deepEqual(state.ranges.at(-1), [0, 49]);
  assert.deepEqual(state.filters.at(-1), [['owner_id', 'fixture-owner'], ['deleted', false]]); assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
for (const value of ['', '%20%20', 'not-a-number', '1.5', 'Infinity']) await check(`invalid or empty limit falls back: ${value || 'empty'}`, async () => {
  const { body } = await get(`?limit=${value}`); assert.equal(body.pagination.limit, 50); assert.equal(body.canvases.length, 50);
});
await check('explicit page size and offset preserve final page and count', async () => {
  const { body } = await get('?limit=5&offset=55'); assert.equal(body.canvases.length, 5); assert.equal(body.pagination.total, 60); assert.equal(body.pagination.nextOffset, null); assert.deepEqual(state.ranges.at(-1), [55, 59]);
});
await check('explicit zero clamps to one and upper limit clamps to one hundred', async () => {
  assert.equal((await get('?limit=0')).body.pagination.limit, 1); assert.equal((await get('?limit=1000')).body.pagination.limit, 100);
});
await check('anonymous read does not reach database', async () => {
  const before = state.dbReads; assert.equal((await get('', false)).response.status, 401); assert.equal(state.dbReads, before);
});
await check('missing table remains truthful migration not ready', async () => {
  state.error = { code: 'PGRST205', message: 'Missing relation' };
  const { response, body } = await get(); assert.equal(response.status, 503); assert.equal(body.code, 'MIGRATION_NOT_READY'); state.error = null;
});
await check('missing local service role does not query database', async () => {
  const before = state.dbReads; delete environment.COZE_SUPABASE_SERVICE_ROLE_KEY;
  assert.equal((await get()).response.status, 503); assert.equal(state.dbReads, before); environment.COZE_SUPABASE_SERVICE_ROLE_KEY = 'fixture-local-only';
});
await check('four voice redirects await only their source-declared final page', async () => {
  const redirects = [
    ['/voice-studio', '/voice-studio/workspace'], ['/voice-studio/nest', '/voice-studio/imitate'],
    ['/youcai/voice-studio', '/youcai/voice-studio/workspace'], ['/youcai/voice-studio/nest', '/voice-studio/imitate'],
  ];
  for (const [from, to] of redirects) {
    const pageSource = fs.readFileSync(`src/app${from}/page.tsx`, 'utf8'); assert.ok(pageSource.includes(`'${to}'`) || pageSource.includes(`"${to}"`));
    let finalDocument = false;
    const fakePage = { async waitForURL(predicate, options) {
      assert.equal(predicate(new URL(`http://127.0.0.1:5000${from}`)), false); assert.equal(predicate(new URL(`https://external.invalid${to}`)), false);
      assert.equal(options.waitUntil, 'domcontentloaded'); await Promise.resolve();
      assert.equal(predicate(new URL(`http://127.0.0.1:5000${to}`)), true); finalDocument = true;
    } };
    assert.equal(await waitForSecondaryDestination(fakePage, from, 'http://127.0.0.1:5000'), to); assert.equal(finalDocument, true);
  }
});
await check('documented secondary redirect waits for its final local path', async () => {
  const fakePage = { async waitForURL(predicate) { assert.equal(predicate(new URL('http://127.0.0.1:5000/youcai/tools/image/image-chat')), true); assert.equal(predicate(new URL('http://127.0.0.1:5000/other')), false); } };
  assert.equal(await waitForSecondaryDestination(fakePage, '/youcai/image-workbench', 'http://127.0.0.1:5000'), '/youcai/tools/image/image-chat');
});
await check('new evidence directory is separate and rejects traversal', async () => {
  assert.notEqual(navigationReportDirectory('voice-canvas-1'), navigationReportDirectory());
  for (const bad of ['../old', 'path/nested', 'x\\y', 'http://bad']) assert.throws(() => navigationReportDirectory(bad));
});
const output = '.codex-evidence/navigation-experience-20260903/voice-canvas-source-fixes-1.json';
fs.mkdirSync(navigationReportDirectory(), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), actualCanvasGet: true, actualNavigationWaitHelper: true, realNetworkRequests: 0, databaseWrites: 0, cases, passed: cases.length, failed: 0 }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, passed: cases.length, failed: 0, realNetworkRequests: 0, databaseWrites: 0 }));
