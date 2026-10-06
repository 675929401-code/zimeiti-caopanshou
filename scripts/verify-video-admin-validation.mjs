import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const state = { role: 'admin', active: true, status: 'active', userId: 'fixture-admin', databaseUrl: 'http://127.0.0.1:54321', queryError: false, missingModel: false, model: null, health: null, reads: [], writes: 0, resolvedSecret: 'arbitrary-provider-secret-value', secretReady: true };
const baseModel = { id: 'hidden-fixture-video', name: 'Fixture video', provider: 'fixture-provider', protocol_type: 'autodl_comfyui_workflow', model_name: 'fixture_workflow', api_endpoint: 'https://provider.example/v1?auth=PRIVATE_QUERY', api_key: 'secret://fixture-reference', price_per_use: 0.02, cost_price: 0.01, duration_seconds: 5, max_duration: 15, supports_image_input: true, requires_image: true, is_active: false, is_hidden: true,
  admin_notes: '新协议隔离记录；arbitrary-provider-secret-value；https://private.example/file?token=PRIVATE_URL',
  api_protocol_config: { workflow_id: 'fixture_workflow', workflow_input_mode: 'first_last_frame', requires_first_frame: true, requires_last_frame: true, min_reference_images: 2, max_reference_images: 2, supports_duration: true, min_duration: 1, max_duration: 15, resolution_options: ['480p', '768p'], resolution_prices: { '480p': 0.02, '768p': 0.03 }, __model_activation_gate: { schema: 'media_model_activation_gate.v1', state: 'pending' }, nested_secret: 'PRIVATE_NESTED' } };
const db = {
  get supabaseUrl() { return state.databaseUrl; },
  from(table) {
    const record = { table, filters: [], select: null }; state.reads.push(record);
    return { select(columns) { record.select = columns; return this; }, eq(column, value) { record.filters.push([column, value]); return this; }, abortSignal() { return this; },
      async maybeSingle() {
        if (state.queryError) return { data: null, error: { message: 'PRIVATE_DATABASE_DIAGNOSTIC' } };
        if (table === 'users') return { data: { id: state.userId, role: state.role, is_active: state.active, status: state.status, username: 'fixture-user', cash_balance: 0, credits: 0 }, error: null };
        if (table === 'video_tasks') return { data: null, error: null };
        assert.deepEqual(record.filters, [[table === 'video_models' ? 'id' : 'channel_id', baseModel.id]]);
        return { data: table === 'video_models' ? state.missingModel ? null : state.model : state.health, error: null };
      },
      insert() { state.writes++; throw new Error('WRITE_FORBIDDEN'); }, update() { state.writes++; throw new Error('WRITE_FORBIDDEN'); }, upsert() { state.writes++; throw new Error('WRITE_FORBIDDEN'); },
    };
  },
};
const cache = new Map();
function load(file) {
  file = path.normalize(file);
  if (cache.has(file)) return cache.get(file);
  const compiledModule = { exports: {} }; cache.set(file, compiledModule.exports);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(output, { module: compiledModule, exports: compiledModule.exports, Buffer, URL, Date, Number, Object, Math, Set, Map, String, RegExp, Error, Promise, JSON, AbortSignal, process: { env: { JWT_SECRET: 'fixture-signing-secret', NODE_ENV: 'test' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name === '@/lib/auth') return { getJwtSecretString: () => 'fixture-signing-secret', getTokenFromHeaders: headers => headers.get('Authorization')?.slice(7) || null, verifyToken: async token => token === 'normal-fixture-session' ? { userId: state.userId, role: 'admin' } : null };
      if (name === '@/lib/provider-secret') return { resolveProviderSecret: () => { if (!state.secretReady) throw new Error('PRIVATE_CREDENTIAL_DIAGNOSTIC'); return state.resolvedSecret; } };
      if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => db };
      if (name === '@/storage/object') return { storageManager: { head() { throw new Error('STORAGE_HEAD_FORBIDDEN_IN_PREFLIGHT'); } } };
      if (name.startsWith('@/')) return load(path.join('src', name.slice(2) + '.ts'));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name.endsWith('.ts') ? name : name + '.ts'));
      return nativeRequire(name);
    }, fetch() { throw new Error('REAL_NETWORK_FORBIDDEN'); }, console: { warn() {}, error() {} },
  });
  return compiledModule.exports;
}
const helper = load('src/lib/video-admin-validation.ts');
const route = load('src/app/api/admin/video-models/validation/route.ts');
const adminAuth = load('src/lib/admin-auth.ts');
const request = (token = 'normal-fixture-session', suffix = '') => new Request(`http://127.0.0.1:5000/api/admin/video-models/validation?modelId=${baseModel.id}${suffix}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const context = () => helper.buildVideoAdminValidationContext({ model: state.model, health: state.health, userId: state.userId });
const authorize = async (ctx, patch = {}) => helper.authorizeVideoAdminValidation({ context: ctx, authorization: await adminAuth.authorizeAdminToken('normal-fixture-session'), requested: true, modelId: ctx.model.id, validationKey: ctx.validationKey, confirmation: helper.VIDEO_ADMIN_VALIDATION_CONFIRMATION, clientRequestId: ctx.validationKey, ...patch });
let passed = 0;
async function test(name, callback) {
  Object.assign(state, { role: 'admin', active: true, status: 'active', userId: 'fixture-admin', databaseUrl: 'http://127.0.0.1:54321', queryError: false, missingModel: false, model: structuredClone(baseModel), health: null, reads: [], writes: 0, resolvedSecret: 'arbitrary-provider-secret-value', secretReady: true });
  await callback(); assert.equal(state.writes, 0); passed++; console.log('PASS ' + name);
}
await test('hidden/new model GET provides a stable key and real minimum inputs without mutation', async () => {
  const response = await route.GET(request()); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const dto = await response.json(); assert.equal(dto.success, true); assert.equal(dto.model.active, false); assert.equal(dto.model.hidden, true); assert.equal(dto.readiness.healthRecorded, false); assert.equal(dto.minimumInput.imageCount, 2); assert.equal(dto.minimumInput.firstFrameRequired, true); assert.equal(dto.minimumInput.lastFrameRequired, true); assert.equal(dto.confirmation, 'AUTHORIZE_ONE_REAL_VIDEO_CANARY');
  assert.equal(dto.validationKey, (await (await route.GET(request())).json()).validationKey);
});
await test('current DB nonadmin or disabled account cannot receive validation metadata even with admin JWT', async () => {
  for (const patch of [{ role: 'student' }, { active: false }, { status: 'disabled' }]) { Object.assign(state, { role: 'admin', active: true, status: 'active' }, patch); state.reads = []; const response = await route.GET(request()); assert.equal(response.status, 403); assert.equal(state.reads.some(read => read.table === 'video_models'), false); assert.equal(Object.hasOwn(await response.json(), 'validationKey'), false); }
});
await test('missing and expired normal sessions cannot read models', async () => { for (const token of ['', 'expired-fixture-session']) { const response = await route.GET(request(token)); assert.equal(response.status, 401); } assert.equal(state.reads.some(read => read.table === 'video_models'), false); });
await test('configured application database is supported while malformed base URLs never read models', async () => {
  state.databaseUrl = 'https://configured-database.example'; assert.equal((await route.GET(request())).status, 200);
  for (const url of ['ftp://wrong.example', 'http://127.0.0.1:54321/other', 'http://127.0.0.1:54321/?secret=x']) { state.databaseUrl = url; state.reads = []; const response = await route.GET(request()); assert.equal(response.status, 503); assert.equal(state.reads.some(read => read.table === 'video_models'), false); }
});
await test('DTO cannot leak configured/resolved secrets, raw URLs, nested config or free-form admin notes', async () => {
  state.model.name = `Fixture arbitrary-provider-secret-value`; const dto = await (await route.GET(request())).json(); const text = JSON.stringify(dto);
  for (const value of ['secret://fixture-reference', state.resolvedSecret, 'PRIVATE_QUERY', 'PRIVATE_URL', 'PRIVATE_NESTED', 'PRIVATE_DATABASE_DIAGNOSTIC', 'api_key', 'admin_notes']) assert.equal(text.includes(value), false, value);
  assert.equal(dto.model.endpointHost, 'provider.example'); assert.equal(Object.hasOwn(dto, 'operatorNotes'), false);
});
await test('confirmation, selected model and identical request key are all required', async () => {
  const ctx = context(); assert.equal((await authorize(ctx)).ok, true);
  for (const patch of [{ requested: false }, { confirmation: 'yes' }, { modelId: 'another-model' }, { validationKey: 'new-key' }, { clientRequestId: 'different-key' }]) assert.equal((await authorize(ctx, patch)).ok, false);
});
await test('configuration, protocol, price, visibility and actual resolved credential changes invalidate the old key', async () => {
  const before = context();
  for (const patch of [{ protocol_type: 'new-protocol' }, { price_per_use: 0.03 }, { is_hidden: false }, { api_protocol_config: { ...baseModel.api_protocol_config, resolution_options: ['1080p'] } }]) {
    state.model = { ...structuredClone(baseModel), ...patch }; const after = context(); assert.notEqual(before.configurationHash, after.configurationHash); assert.equal((await authorize(after, { validationKey: before.validationKey, clientRequestId: before.validationKey })).ok, false);
  }
  state.model = structuredClone(baseModel); state.resolvedSecret = 'rotated-resolved-value'; assert.notEqual(context().validationKey, before.validationKey);
});
await test('statistics, descriptive notes and same terminal epoch preserve the existing request identity', async () => {
  const before = context(); state.model = { ...state.model, total_requests: 12, updated_at: '2026-09-02T14:00:00Z', admin_notes: 'changed audit projection', name: 'Display correction' }; state.health = { channel_id: baseModel.id, is_healthy: false, total_requests: 0, consecutive_failures: 0, updated_at: '2026-09-02T15:00:00Z' }; assert.equal(context().validationKey, before.validationKey);
});
await test('real terminal health epoch changes invalidate old validation keys', async () => { const before = context(); state.health = { channel_id: baseModel.id, is_healthy: false, last_fail_at: '2026-09-02T15:00:00Z', consecutive_failures: 1 }; const after = context(); assert.notEqual(before.validationKey, after.validationKey); assert.equal((await authorize(after, { validationKey: before.validationKey, clientRequestId: before.validationKey })).ok, false); });
await test('keys are user-bound and current revoked admin cannot authorize an already-issued context', async () => { const before = context(); state.userId = 'different-admin'; assert.notEqual(context().validationKey, before.validationKey); assert.equal((await authorize(before)).ok, false); state.userId = 'fixture-admin'; state.role = 'student'; assert.equal((await authorize(before)).ok, false); });
await test('two administrators have distinct authorization proofs but one shared configuration claim', async () => {
  const first = context(); state.userId = 'another-current-admin'; const second = context();
  assert.notEqual(first.validationKey, second.validationKey);
  const claim = helper.buildVideoAdminValidationClaimKey(first); assert.match(claim, /^vvc_[a-f0-9]{64}$/u);
  assert.equal(helper.buildVideoAdminValidationClaimKey(second), claim);
  state.model.price_per_use = 0.03; assert.notEqual(helper.buildVideoAdminValidationClaimKey(context()), claim);
  state.model = structuredClone(baseModel); state.health = { channel_id: baseModel.id, last_fail_at: '2026-09-02T15:00:00Z', consecutive_failures: 1 };
  assert.notEqual(helper.buildVideoAdminValidationClaimKey(context()), claim);
});
await test('unresolved credentials return only readiness and cannot authorize a submission', async () => { state.secretReady = false; const ctx = context(); assert.equal(ctx.credentialReady, false); assert.equal((await authorize(ctx)).code, 'VIDEO_VALIDATION_CREDENTIAL_UNAVAILABLE'); const dto = await (await route.GET(request())).json(); assert.equal(dto.readiness.credentialReady, false); assert.equal(JSON.stringify(dto).includes('PRIVATE_CREDENTIAL_DIAGNOSTIC'), false); });
await test('local missing rows and database faults fail closed without production fallback or raw diagnostics', async () => { state.missingModel = true; assert.equal((await route.GET(request())).status, 404); state.missingModel = false; state.queryError = true; const response = await route.GET(request()); assert.equal(response.status, 503); assert.equal(JSON.stringify(await response.json()).includes('PRIVATE_DATABASE_DIAGNOSTIC'), false); });
await test('legacy source edit requirement follows the actual adapter identity', async () => { state.model.protocol_type = 'gaorui_video'; state.model.model_name = 'omni_flash_abra_edit'; state.model.api_protocol_config = {}; const dto = helper.toVideoAdminValidationDto(context()); assert.equal(dto.minimumInput.sourceVideoRequired, true); assert.equal(dto.capabilities.requiresSourceVideo, true); });
await test('same key maps to the same existing task, provider and billing identities', async () => {
  const source = fs.readFileSync('src/lib/video-terminal-finalizer.ts', 'utf8'); const tree = ts.createSourceFile('finalizer.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildVideoTaskIdentity'); assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(tree).replace(/^export /u, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const identity = vm.runInNewContext(`${code}; buildVideoTaskIdentity`, { createHash }); const first = context(); const second = context();
  assert.deepEqual(JSON.parse(JSON.stringify(identity(state.userId, first.validationKey))), JSON.parse(JSON.stringify(identity(state.userId, second.validationKey))));
  const approved = await Promise.all([authorize(first), authorize(second)]); assert.ok(approved.every(result => result.ok));
  // Authorization is read-only; the existing reservation RPC must claim this
  // one derived task identity and reject a changed payload under the same key.
});
console.log(JSON.stringify({ passed, failed: 0, realNetworkRequests: 0, realDatabaseWrites: 0, actualHelperAndGetHandler: true, reservationSqlExecution: false }));
