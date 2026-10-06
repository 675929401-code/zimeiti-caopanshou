import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';

const routeFile = 'src/app/api/image/generate/route.ts';
const previousFile = '任务快照/image-current-account-20260903-010931/src/app/api/image/generate/route.ts';
const state = {};
const source = fs.readFileSync(routeFile, 'utf8');
const report = { at: new Date().toISOString(), sourceSha256: createHash('sha256').update(source).digest('hex'), actualRouteAst: true, actualAdminAuthorizer: true, realJwtCreated: 0, realNetwork: 0, realDatabaseWrites: 0, cases: [] };
function reset() {
  Object.assign(state, {
    user: { id: 'fixture-user', role: 'admin', is_active: true, status: 'active' }, jwtRole: 'admin', signatureValid: true, authError: false,
    rows: [{ id: 'fixture-hidden-model', name: 'Fixture model', is_active: true, is_hidden: true, provider: 'fixture-provider', model_name: 'fixture-image', cost_price: 0.1, selling_price: 0.2 }],
    modelError: false, modelThrow: false, remoteModel: null, authReads: 0, modelReads: 0, productionReads: 0, traces: [],
  });
}
const payload = () => state.signatureValid ? { userId: 'fixture-user', role: state.jwtRole } : null;
const db = { from(table) {
  assert.equal(table, 'cover_models');
  const filters = [];
  const result = async single => {
    state.modelReads++;
    if (state.modelThrow) throw new Error('FIXTURE_MODEL_DB_THROW');
    if (state.modelError) return { data: null, error: { code: 'FIXTURE_MODEL_DB_ERROR' } };
    const rows = state.rows.filter(row => filters.every(([key, value]) => row[key] === value));
    return { data: single ? rows[0] || null : rows, error: null };
  };
  const query = { select() { return query; }, eq(key, value) { filters.push([key, value]); return query; }, order() { return query; }, limit() { return query; }, single() { return result(true); }, maybeSingle() { return result(true); }, then(resolve, reject) { return result(false).then(resolve, reject); } };
  return query;
} };
const globals = {
  Request, Response, Headers, URL, Date, Error, Promise, Buffer, Set, AbortSignal, crypto: { randomUUID }, createHash,
  console: { log() {}, warn() {}, error() {} },
  NextResponse: { json: (value, init) => Response.json(value, init) },
  verifyToken: async () => payload(),
  getSupabaseClient: () => db,
  getProductionCoverModelById: async () => { state.productionReads++; return state.remoteModel; },
  writeImageTrace: async value => { state.traces.push(value); },
  filterAvailableCoverModels: rows => rows || [],
  findModelByPublicId: (_kind, rows, id) => id === 'pm_fixture' ? rows[0] || null : null,
  orderEquivalentImageModelCandidates: selected => [selected],
  publicModelDisplayName: model => model.name,
  isRetiredCoverModel: () => false,
};
function evaluate(code, extra = {}) {
  const compiledModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { ...globals, ...extra, module: compiledModule, exports: compiledModule.exports });
  return compiledModule.exports;
}
const adminSource = fs.readFileSync('src/lib/admin-auth.ts', 'utf8');
const adminAst = ts.createSourceFile('admin-auth.ts', adminSource, ts.ScriptTarget.Latest, true);
const adminFunction = adminAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createAdminTokenAuthorizer');
assert.ok(adminFunction);
const authorizeAdminToken = evaluate(adminFunction.getText(adminAst)).createAdminTokenAuthorizer({
  verifySignature: async () => payload(),
  findCurrentUser: async () => { state.authReads++; if (state.authError) throw new Error('FIXTURE_AUTH_DB_ERROR'); return state.user; },
});
function loadPrefix(text) {
  const ast = ts.createSourceFile(routeFile, text, ts.ScriptTarget.Latest, true);
  const post = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
  const tryNode = post.body.statements.find(ts.isTryStatement);
  const statements = [...tryNode.tryBlock.statements];
  const end = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === 'imageCapabilities'));
  assert.ok(end > 0);
  const declarations = post.body.statements.slice(0, post.body.statements.indexOf(tryNode)).map(node => node.getText(ast)).join('\n');
  const prefix = statements.slice(0, end).map(node => node.getText(ast)).join('\n');
  return evaluate(`export async function run(request: Request) { ${declarations} ${prefix}\nreturn { effectiveRole: userRole, selectedModelId: modelConfig?.id, key: generationIdempotencyKey, trace: traceId }; }`, { authorizeAdminToken }).run;
}
const current = loadPrefix(source), previous = loadPrefix(fs.readFileSync(previousFile, 'utf8'));
const input = (overrides = {}, authorized = true) => new Request('http://127.0.0.1:5000/api/image/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer fixture-decoded-input' } : {}) },
  body: JSON.stringify({ modelId: 'fixture-hidden-model', prompt: 'Fixture cup', mode: 'local', clientTraceId: 'fixture-original-trace', clientIdempotencyKey: 'fixture-original-key', ...overrides }),
});
async function expectRejection(response, status, code, beforeTrace = false) {
  assert.equal(response.status, status); const body = await response.json();
  if (code) assert.equal(body.code, code);
  assert.equal(state.productionReads, 0);
  if (beforeTrace) { assert.equal(state.traces.length, 0); assert.equal(state.modelReads, 0); }
}
async function test(name, run) {
  reset(); await run(); report.cases.push({ name, passed: true }); console.log('PASS ' + name);
}
await test('previous route treated demoted current account as admin from stale JWT', async () => {
  state.user.role = 'student'; const result = await previous(input()); assert.equal(result.effectiveRole, 'admin'); assert.equal(result.selectedModelId, 'fixture-hidden-model'); assert.equal(state.authReads, 0);
});
await test('previous route used production fallback when local admin model read failed', async () => {
  state.modelError = true; state.remoteModel = { ...state.rows[0], id: 'fixture-remote-only' };
  const result = await previous(input()); assert.equal(result.selectedModelId, 'fixture-remote-only'); assert.equal(state.productionReads, 1);
});
await test('current DB demotion enforces ordinary stable-key requirements before trace', async () => {
  state.user.role = 'student'; await expectRejection(await current(input({ clientIdempotencyKey: '' })), 400, 'IMAGE_IDEMPOTENCY_KEY_REQUIRED', true);
});
await test('current DB demotion forbids privileged internal hidden-model lookup', async () => {
  state.user.role = 'student'; await expectRejection(await current(input()), 404, 'MODEL_NOT_AVAILABLE'); assert.equal(state.modelReads, 0);
});
await test('ordinary current account retains published model access with original keys', async () => {
  state.user.role = 'student'; state.rows[0].is_hidden = false;
  const result = await current(input({ modelId: 'pm_fixture' })); assert.equal(result.effectiveRole, 'student'); assert.equal(result.selectedModelId, 'fixture-hidden-model'); assert.equal(result.key, 'fixture-original-key'); assert.equal(result.trace, 'fixture-original-trace');
});
await test('current DB admin elevation supersedes old student JWT without changing keys', async () => {
  state.jwtRole = 'student'; const result = await current(input()); assert.equal(result.effectiveRole, 'admin'); assert.equal(result.key, 'fixture-original-key'); assert.equal(result.trace, 'fixture-original-trace'); assert.equal(state.authReads, 1);
});
for (const [name, user] of [
  ['inactive account', { id: 'fixture-user', role: 'admin', is_active: false, status: 'active' }],
  ['suspended account', { id: 'fixture-user', role: 'admin', is_active: true, status: 'suspended' }],
  ['blocked account', { id: 'fixture-user', role: 'student', is_active: true, status: 'blocked' }],
]) await test(name + ' cannot reach trace model lookup or generation', async () => { state.user = user; await expectRejection(await current(input()), 403, 'ACCOUNT_DISABLED', true); });
await test('missing current account is rejected before any side effect', async () => { state.user = null; await expectRejection(await current(input()), 401, 'UNAUTHENTICATED', true); });
await test('current account DB error fails closed with 503 before any side effect', async () => { state.authError = true; await expectRejection(await current(input()), 503, 'ADMIN_AUTH_UNAVAILABLE', true); });
await test('missing and invalid JWTs never read current account or model', async () => {
  await expectRejection(await current(input({}, false)), 401, undefined, true); state.signatureValid = false; await expectRejection(await current(input()), 401, undefined, true); assert.equal(state.authReads, 0);
});
await test('legacy active admin with null status remains eligible', async () => { state.user.status = null; const result = await current(input()); assert.equal(result.effectiveRole, 'admin'); });
await test('inactive and missing local model do not fall back to production', async () => {
  state.rows[0].is_active = false; state.remoteModel = { ...state.rows[0], is_active: true }; await expectRejection(await current(input()), 404, 'MODEL_NOT_AVAILABLE');
  state.rows = []; await expectRejection(await current(input()), 404, 'MODEL_NOT_AVAILABLE');
});
await test('local admin model query error returns 503 without remote fallback', async () => { state.modelError = true; state.remoteModel = { ...state.rows[0] }; await expectRejection(await current(input()), 503, 'IMAGE_MODEL_LOOKUP_UNAVAILABLE'); });
await test('thrown local model transport never falls back or creates a task', async () => { state.modelThrow = true; await assert.rejects(() => current(input()), /FIXTURE_MODEL_DB_THROW/u); assert.equal(state.productionReads, 0); });
report.passed = report.cases.length;
const out = '.codex-evidence/image-model-governance-20260903/current-account-fixture.json';
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, actualRouteAst: true, actualAdminAuthorizer: true, realJwtCreated: 0, realNetwork: 0, realDatabaseWrites: 0 }));
