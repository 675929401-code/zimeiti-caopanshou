import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Zero network/DB. Optional SQL output is a PLAN for a separately approved
// disposable PostgreSQL fixture; this runner never executes it.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), ts = require('typescript');
const sourcePath = 'src/lib/server/image-model-addition-publication.ts';
const migrationPath = 'supabase/migrations/20261107180000_image_model_addition_only_publication.sql';
const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
const sql = fs.readFileSync(path.join(root, migrationPath), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const actor = '11111111-1111-4111-8111-111111111111';
const currentId = '22222222-2222-4222-8222-222222222222';
const candidateId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const targetId = 'pending-cover-model-google-addition-fixture';
const env = { LOCAL_RUNTIME_PROFILE: 'local-acceptance', LOCAL_ACCEPTANCE_PREVIEW: 'true',
  SHARED_CONFIGURATION_ENABLED: '1', SHARED_CONFIGURATION_ID: 'local-acceptance',
  COZE_SUPABASE_URL: 'http://127.0.0.1:54321', SHARED_CONFIGURATION_SUPABASE_URL: 'http://127.0.0.1:54321',
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:54322/zimeiti_local' };
let db, bootError = false, clientError = false;
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} }; modules.set(file, module.exports);
  const allowed = new Set([sourcePath, 'src/lib/platform-configuration-contract.ts', 'src/lib/image-provider-contract.ts', 'src/lib/image-model-capabilities.ts']);
  assert.ok(allowed.has(file), 'UNEXPECTED_REAL_MODULE:' + file);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, URL, AbortSignal, process: { env }, require(name) {
    if (name === 'server-only') return {};
    if (name === 'node:crypto') return { createHash };
    if (name === '@/lib/server-runtime-env') return { ensureServerRuntimeEnvLoaded() { if (bootError) throw Error('PRIVATE_BOOT_DETAIL'); } };
    if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient() { if (clientError) throw Error('PRIVATE_CLIENT_DETAIL'); return db; } };
    if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice('@/lib/'.length) + '.ts');
    throw Error('UNEXPECTED_DEPENDENCY:' + name);
  } }, { filename: file });
  modules.set(file, module.exports); return module.exports;
}
const api = load(sourcePath), contract = load('src/lib/platform-configuration-contract.ts');
function entry(id, kind = 'image') {
  const p = { protocol: 'images_generations', reference_transport: 'generations_url_array',
    resolution_options: ['2K'], default_resolution: '2K', resolution_prices: { '2K': 0.29 }, resolution_cost_prices: { '2K': 0.24 } };
  return { id, kind, name: id, modelName: id === targetId ? 'gemini-nano-banana-2.1-2k' : id,
    provider: 'lconai', protocol: 'images_generations', endpoint: 'https://n.lconai.com',
    credentialRef: `secret://platform-model/${kind === 'agent' ? 'llm_models' : kind === 'video' ? 'video_models' : 'cover_models'}/${id}`, catalogState: 'enabled', sortOrder: 1,
    capabilities: { supportsImageInput: true, protocol: p }, pricing: { cost: 0.24, selling: 0.29, currency: 'CNY' },
    configuration: { legacyId: id, legacyTable: kind === 'agent' ? 'llm_models' : kind === 'video' ? 'video_models' : 'cover_models', protocolConfig: p } };
}
const beforeSnapshot = contract.normalizeModelPoolSnapshot({ schema: 'model-pool-config/v1', models: [entry('old-image'), entry('old-video', 'video'),
  ...Array.from({ length: 6 }, (_, index) => entry('old-llm-' + index, 'agent'))] });
const nextSnapshot = contract.normalizeModelPoolSnapshot({ ...beforeSnapshot, models: [...beforeSnapshot.models, entry(targetId)] });
const current = { id: currentId, release_version: 1, schema_version: 'model-pool-config/v1', status: 'published', is_current: true,
  snapshot: beforeSnapshot, snapshot_sha256: contract.configurationSha256(beforeSnapshot), parent_release_id: null };
const candidate = { id: candidateId, release_version: 2, schema_version: 'model-pool-config/v1', status: 'validated', is_current: false,
  snapshot: nextSnapshot, snapshot_sha256: contract.configurationSha256(nextSnapshot), parent_release_id: currentId, rollback_target_id: null,
  validated_at: '2026-11-07T00:00:00Z', validation_result: { ok: true, checkedBy: actor, schema: 'platform-configuration-validation/v1', mode: 'deterministic-contract' } };
const input = { actorId: actor, currentReleaseId: currentId, currentSnapshotSha256: current.snapshot_sha256,
  candidateReleaseId: candidateId, candidateSnapshotSha256: candidate.snapshot_sha256, targetModelId: targetId };
const digest = { llm_models: { count: 6, sha256: 'a'.repeat(64) }, platform_model_credential_bindings: { count: 6, sha256: 'b'.repeat(64) } };
let calls, reads, dbOptions;
function setup(options = {}) {
  calls = []; reads = 0; dbOptions = options; bootError = false; clientError = false;
  db = { from(table) {
    assert.equal(table, 'model_pool_config_releases'); if (options.constructThrow) throw Error('PRIVATE_READ_DETAIL');
    return { select(columns) { assert.equal(columns, '*'); return { in(key, ids) {
      assert.equal(key, 'id'); assert.deepEqual(Array.from(ids), [currentId, candidateId]); return { async abortSignal() {
        reads++; if (options.readThrow) throw Error('PRIVATE_READ_DETAIL');
        return { data: options.rows || [clone(current), clone(candidate)], error: options.readError || null };
      } }; } }; } };
  }, async rpc(name, params) {
    calls.push({ name, params }); if (options.rpcThrow) throw Error('PRIVATE_TRANSPORT_DETAIL');
    if (options.rpcError) return { error: options.rpcError, data: null };
    const dry = params.p_dry_run, release = { ...clone(candidate), status: dry ? 'validated' : 'published', is_current: !dry };
    return { error: null, data: options.reply || { release, dryRun: dry, outcome: dry ? 'rolled_back' : 'committed',
      evidence: { targetModelId: targetId, verificationState: 'pending', protectedUnchanged: true, rollbackVerified: dry,
        before: digest, after: digest, PRIVATE_CREDENTIAL: 'DO_NOT_RETURN' }, PRIVATE_CREDENTIAL: 'DO_NOT_RETURN' } };
  } };
}
const passed = [];
async function test(name, work) { setup(); await work(); passed.push(name); }
const rejects = async (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes('PRIVATE'));
await test('real contract recognizes N+1 with six untouched drifted LLM entries', () => assert.equal(api.inspectImageModelAddition(beforeSnapshot, nextSnapshot).targetId, targetId));
await test('old row edit rejected', () => { const changed = clone(nextSnapshot); changed.models[0].name = 'unauthorized'; assert.equal(api.inspectImageModelAddition(beforeSnapshot, changed), null); });
await test('old order changed rejected', () => { const changed = clone(nextSnapshot); changed.models.push(changed.models.shift()); assert.equal(api.inspectImageModelAddition(beforeSnapshot, changed), null); });
await test('non-image addition rejected', () => { const changed = clone(nextSnapshot); changed.models.find(model => model.id === targetId).kind = 'video'; assert.equal(api.inspectImageModelAddition(beforeSnapshot, changed), null); });
await test('credential reuse rejected', () => { const changed = clone(nextSnapshot); changed.models.find(model => model.id === targetId).credentialRef = beforeSnapshot.models[0].credentialRef; assert.equal(api.inspectImageModelAddition(beforeSnapshot, changed), null); });
await test('single RPC exact nine server-bound arguments and no private response fields', async () => {
  const result = await api.publishImageModelAdditionRelease(input); assert.equal(result.outcome, 'committed'); assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'publish_image_model_addition_only_atomic'); assert.equal(Object.keys(calls[0].params).length, 9);
  assert.equal(calls[0].params.p_actor_id, actor); assert.equal(calls[0].params.p_target_model_id, targetId);
  assert.deepEqual(clone(calls[0].params.p_expected_current_snapshot), clone(dbOptions.rows?.[0]?.snapshot || current.snapshot));
  assert.deepEqual(clone(calls[0].params.p_expected_candidate_snapshot), clone(candidate.snapshot));
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'), false);
});
await test('dry run only explicit true with rollback evidence', async () => { const result = await api.publishImageModelAdditionRelease({ ...input, dryRun: true }); assert.equal(result.outcome, 'rolled_back'); assert.equal(result.evidence.rollbackVerified, true); assert.equal(calls[0].params.p_dry_run, true); });
await test('stale identity zero write RPC', async () => { await rejects(api.publishImageModelAdditionRelease({ ...input, candidateSnapshotSha256: 'd'.repeat(64) }), 'IMAGE_ADDITION_BASE_CHANGED'); assert.equal(calls.length, 0); });
await test('snapshot bytes/hash mismatch zero write RPC', async () => { const changed = clone(candidate); changed.snapshot.models[0].name = 'tampered'; setup({ rows: [clone(current), changed] }); await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_CANDIDATE_INVALID'); assert.equal(calls.length, 0); });
await test('wrong runtime zero read/write', async () => { env.SHARED_CONFIGURATION_SUPABASE_URL = 'https://wrong.invalid'; try { await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_DATABASE_UNAVAILABLE'); assert.equal(reads, 0); assert.equal(calls.length, 0); } finally { env.SHARED_CONFIGURATION_SUPABASE_URL = 'http://127.0.0.1:54321'; } });
for (const [name, options] of [['construct', { constructThrow: true }], ['read throw', { readThrow: true }], ['read error', { readError: { message: 'PRIVATE' } }]]) {
  await test(name + ' before dispatch known unavailable', async () => { setup(options); await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_DATABASE_UNAVAILABLE'); assert.equal(calls.length, 0); });
}
await test('boot exception before dispatch known unavailable', async () => { bootError = true; await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_DATABASE_UNAVAILABLE'); assert.equal(calls.length, 0); });
await test('client exception before dispatch known unavailable', async () => { clientError = true; await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_DATABASE_UNAVAILABLE'); assert.equal(calls.length, 0); });
for (const code of ['PGRST202', '42883', '42501']) await test('known DB rejection ' + code, async () => { setup({ rpcError: { code, message: 'PRIVATE' } }); await rejects(api.publishImageModelAdditionRelease(input), code === '42501' ? 'IMAGE_ADDITION_ROLE_UNAVAILABLE' : 'IMAGE_ADDITION_DATABASE_UNAVAILABLE'); assert.equal(calls.length, 1); });
await test('transport unknown once with no retry', async () => { setup({ rpcThrow: true }); await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_OUTCOME_UNKNOWN'); assert.equal(calls.length, 1); });
await test('SQL protected-row failure stays known safe rejection', async () => { setup({ rpcError: { code: 'P0001', message: 'IMAGE_ADDITION_PROTECTED_ROWS_CHANGED', details: 'PRIVATE' } }); await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_PROTECTED_ROWS_CHANGED'); assert.equal(calls.length, 1); });
await test('incomplete successful receipt unknown once', async () => { setup({ reply: { release: candidate } }); await rejects(api.publishImageModelAdditionRelease(input), 'IMAGE_ADDITION_OUTCOME_UNKNOWN'); assert.equal(calls.length, 1); });

const definition = sql.match(/CREATE FUNCTION public\.publish_image_model_addition_only_atomic\([\s\S]*?\$function\$;/)?.[0];
assert.ok(definition, 'ACTUAL_SQL_FUNCTION_REQUIRED');
assert.equal((sql.match(/CREATE FUNCTION public\./g) || []).length, 1);
assert.equal(/CREATE OR REPLACE|ALTER TABLE|DISABLE TRIGGER|SET ROLE|project_model_pool_configuration_atomic\s*\(|publish_platform_configuration_release_atomic\s*\(/i.test(sql), false);
assert.equal(/UPDATE public\.(llm_models|video_models|chat_models)|INSERT INTO public\.(llm_models|video_models|chat_models)/i.test(sql), false);
assert.match(sql, /p_expected_current_snapshot jsonb[\s\S]*p_expected_candidate_snapshot jsonb/);
assert.match(sql, /ON COMMIT DROP/); assert.match(sql, /false,true,coalesce/);
assert.match(sql, /EXCEPTION WHEN SQLSTATE 'P0I01'/); assert.match(sql, /IMAGE_ADDITION_DRY_RUN_RESTORE_FAILED/);
assert.match(sql, /v_binding_exists OR v_pending\.expected_exists IS DISTINCT FROM false/);
assert.equal(/UPDATE public\.platform_model_credential_bindings/.test(sql), false);
assert.match(sql, /OWNER TO zimeiti_owner/); assert.match(sql, /TO service_role;/);
assert.match(definition, /SET search_path = pg_catalog, public, pg_temp/);
assert.doesNotMatch(definition, /\b(?:FROM|JOIN)\s+(?:pg_class|pg_namespace|pg_roles|pg_type|pg_proc|pg_attribute)\b/);
assert.match(definition, /pg_catalog\.pg_class WHERE relnamespace=pg_catalog\.pg_my_temp_schema\(\)/);
assert.match(definition, /pg_catalog\.pg_type WHERE typnamespace=pg_catalog\.pg_my_temp_schema\(\)/);
assert.match(definition, /pg_catalog\.pg_proc WHERE pronamespace=pg_catalog\.pg_my_temp_schema\(\)/);
assert.ok(definition.indexOf('IMAGE_ADDITION_TEMP_CONTEXT_UNTRUSTED') < definition.indexOf('v_access := public.read_admin_access_snapshot'));
assert.equal((definition.match(/DROP TABLE pg_temp\.model_pool_canonical_visibility_permit;/g) || []).length, 2);
assert.match(definition, /IF v_replayed THEN RAISE EXCEPTION 'IMAGE_ADDITION_ALREADY_PUBLISHED'; END IF;/);
assert.equal(definition.includes("'outcome','already_published'"), false);
assert.doesNotMatch(definition, /IS DISTINCT FROM CASE WHEN/);
passed.push('actual SQL additive-only/security/CAS/isolation/dryrun target scope static contracts');

const emit = process.argv.find(arg => arg.startsWith('--emit-isolated-sql='));
assert.ok(process.argv.slice(2).every(arg => arg.startsWith('--emit-isolated-sql=')), 'UNKNOWN_ARGUMENT');
if (emit) {
  const target = path.resolve(root, emit.slice('--emit-isolated-sql='.length));
  fs.writeFileSync(target, fixtureSql(definition), { flag: 'wx' });
}
console.log(JSON.stringify({ passed: true, groups: passed.length, cases: passed, databaseConnections: 0, httpCalls: 0, providerCalls: 0,
  sourceSha256: sha(source), migrationSha256: sha(sql), actualPostgresExecuted: false,
  actualPostgresStatus: 'Requires a separately approved disposable PostgreSQL transaction; no migration is applied by this test.',
  emittedSql: emit?.slice('--emit-isolated-sql='.length) || null }));

function fixtureSql(actualDefinition) {
  const schema = 'image_addition_publication_fixture';
  const str = value => "'" + String(value).replaceAll("'", "''") + "'";
  const j = value => str(JSON.stringify(value)) + '::jsonb';
  const adapted = actualDefinition.replaceAll('public.', schema + '.').replace("n.nspname='public'", `n.nspname='${schema}'`).replace('SET search_path = pg_catalog, public, pg_temp', 'SET search_path = pg_catalog, ' + schema + ', pg_temp');
  const call = (dry, actorValue = actor, candidateSHA = candidate.snapshot_sha256) => `${schema}.publish_image_model_addition_only_atomic(${str(actorValue)}::uuid,${str(candidateId)}::uuid,${str(candidateSHA)},${str(currentId)}::uuid,${str(current.snapshot_sha256)},${str(targetId)},${dry},(SELECT snapshot FROM ${schema}.model_pool_config_releases WHERE id=${str(currentId)}::uuid),(SELECT snapshot FROM ${schema}.model_pool_config_releases WHERE id=${str(candidateId)}::uuid))`;
  const lines = ['\\set ON_ERROR_STOP on', '-- PLAN ONLY. Execute solely on an explicitly approved disposable PostgreSQL.',
    '-- The real RPC body is namespace-adapted only. Actual public business tables/functions remain unchanged.',
    '-- Fixture authority is a controlled SQL stub; live authority/permissions and migration apply remain separate gates.',
    'BEGIN;', "SET LOCAL statement_timeout='120s';", `CREATE SCHEMA ${schema} AUTHORIZATION zimeiti_owner;`,
    `CREATE TABLE ${schema}.cover_models(id text PRIMARY KEY,name text NOT NULL,model_name text,provider text,api_endpoint text,api_key text,cost_price numeric,selling_price numeric,is_active boolean,is_hidden boolean,supports_image_input boolean,sort_order integer,api_protocol_config jsonb,updated_at timestamptz);`,
    `CREATE TABLE ${schema}.llm_models(id text PRIMARY KEY,api_key text,temperature numeric,user_access text,image_parsing text);`,
    ...['video_models', 'chat_models'].map(table => `CREATE TABLE ${schema}.${table}(id text PRIMARY KEY,api_key text,metadata jsonb);`),
    `CREATE TABLE ${schema}.users(id text PRIMARY KEY,role text,is_active boolean,credits numeric,cash_balance numeric);`,
    ...['workspace_model_config_releases', 'platform_settings', 'wallet_operations', 'wallet_ledger_entries', 'revenue_records'].map(table => `CREATE TABLE ${schema}.${table}(id text PRIMARY KEY,payload jsonb); INSERT INTO ${schema}.${table} VALUES('protected','{"immutable":true}');`),
    ...['image_model_validations', 'image_model_legacy_baselines'].map(table => `CREATE TABLE ${schema}.${table}(model_id text PRIMARY KEY,state text);`),
    `CREATE TABLE ${schema}.model_pool_config_releases(LIKE public.model_pool_config_releases INCLUDING ALL);`,
    `CREATE TABLE ${schema}.platform_model_credential_bindings(LIKE public.platform_model_credential_bindings INCLUDING ALL);`,
    `CREATE TABLE ${schema}.platform_model_pending_credentials(LIKE public.platform_model_pending_credentials INCLUDING ALL);`,
    `CREATE TABLE ${schema}.platform_model_mutation_receipts(LIKE public.platform_model_mutation_receipts INCLUDING ALL);`,
    `CREATE FUNCTION ${schema}.read_admin_access_snapshot(actor text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('authority_status',CASE WHEN actor=${str(actor)} THEN 'ready' ELSE 'disabled' END,'integrity_valid',actor=${str(actor)},'profile_active',actor=${str(actor)},'permission_keys',CASE WHEN actor=${str(actor)} THEN '["models.manage"]'::jsonb ELSE '[]'::jsonb END) $$;`,
    // Copy the deployed guard definitions into the fixture namespace. Only the
    // schema assertion is adapted; no public function is replaced or called for DML.
    `DO $copy$ DECLARE definition text; function_name text; BEGIN FOREACH function_name IN ARRAY ARRAY['enforce_model_resource_visibility_invariant','platform_model_credential_revision_guard','platform_model_pending_credential_immutable_guard'] LOOP SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=function_name; definition:=replace(definition,'public.','${schema}.'); definition:=replace(definition,'TG_TABLE_SCHEMA = ''public''','TG_TABLE_SCHEMA = ''${schema}'''); EXECUTE definition; EXECUTE format('ALTER FUNCTION ${schema}.%I() OWNER TO zimeiti_owner',function_name); END LOOP; END $copy$;`,
    `CREATE TRIGGER cover_visibility BEFORE INSERT OR UPDATE ON ${schema}.cover_models FOR EACH ROW EXECUTE FUNCTION ${schema}.enforce_model_resource_visibility_invariant();`,
    `CREATE TRIGGER credential_revision BEFORE INSERT OR UPDATE ON ${schema}.platform_model_credential_bindings FOR EACH ROW EXECUTE FUNCTION ${schema}.platform_model_credential_revision_guard();`,
    `CREATE TRIGGER pending_immutable BEFORE UPDATE OR DELETE ON ${schema}.platform_model_pending_credentials FOR EACH ROW EXECUTE FUNCTION ${schema}.platform_model_pending_credential_immutable_guard();`,
    adapted,
    `ALTER FUNCTION ${schema}.publish_image_model_addition_only_atomic(uuid,uuid,text,uuid,text,text,boolean,jsonb,jsonb) OWNER TO zimeiti_owner;`,
    `DO $owners$ DECLARE r record; BEGIN FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND c.relkind='r' LOOP EXECUTE format('ALTER TABLE ${schema}.%I OWNER TO zimeiti_owner',r.relname); END LOOP; END $owners$;`,
    `GRANT USAGE ON SCHEMA ${schema} TO service_role; REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM service_role,anon,authenticated;`,
    `GRANT SELECT ON ${schema}.model_pool_config_releases TO service_role;`,
    `REVOKE ALL ON FUNCTION ${schema}.publish_image_model_addition_only_atomic(uuid,uuid,text,uuid,text,text,boolean,jsonb,jsonb) FROM PUBLIC,anon,authenticated;`,
    `GRANT EXECUTE ON FUNCTION ${schema}.publish_image_model_addition_only_atomic(uuid,uuid,text,uuid,text,text,boolean,jsonb,jsonb) TO service_role;`,
    `INSERT INTO ${schema}.users VALUES(${str(actor)},'admin',true,99,88);`,
    `INSERT INTO ${schema}.model_pool_config_releases(id,release_version,status,is_current,snapshot,snapshot_sha256,created_by) VALUES(${str(currentId)},1,'published',true,${j(beforeSnapshot)},${str(current.snapshot_sha256)},${str(actor)});`,
    `INSERT INTO ${schema}.model_pool_config_releases(id,release_version,status,is_current,snapshot,snapshot_sha256,created_by,parent_release_id,validation_result,validated_at) VALUES(${str(candidateId)},2,'validated',false,${j(nextSnapshot)},${str(candidate.snapshot_sha256)},${str(actor)},${str(currentId)},${j(candidate.validation_result)},now());`,
    `INSERT INTO ${schema}.platform_model_pending_credentials(release_id,model_key,credential_ref,expected_exists,expected_revision,secret_value) VALUES(${str(candidateId)},${str('cover_models:' + targetId)},${str('secret://platform-model/cover_models/' + targetId)},false,NULL,'fixture-credential-only');`,
    `INSERT INTO ${schema}.platform_model_mutation_receipts(actor_id,request_id,candidate_id,request_fingerprint,payload_fingerprint) VALUES(${str(actor)},${str(requestId)},${str(candidateId)},'fixture-request','fixture-payload');`,
    ...Array.from({ length: 6 }, (_, index) => `INSERT INTO ${schema}.llm_models VALUES('old-llm-${index}','fixture-physical-different-${index}',0.7,'available','gpt_vision'); INSERT INTO ${schema}.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by) VALUES('secret://platform-model/llm_models/old-llm-${index}','llm_models:old-llm-${index}','fixture-binding-different-${index}',${str(actor)});`),
    `CREATE TABLE ${schema}.original_llms AS SELECT jsonb_agg(to_jsonb(t) ORDER BY id) AS value FROM ${schema}.llm_models t;`];
  function testCase(name, statements) { lines.push(`-- ${name}`, `SAVEPOINT fixture_case;`, ...statements, 'ROLLBACK TO SAVEPOINT fixture_case;', 'RELEASE SAVEPOINT fixture_case;'); }
  const expect = (expression, code) => `DO $case$ BEGIN BEGIN PERFORM ${expression}; RAISE EXCEPTION 'EXPECTED_FAILURE'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>${str(code)} THEN RAISE; END IF; END; END $case$;`;
  testCase('real dry run restores candidate, pending and target and leaves all six LLMs unchanged', [`SET LOCAL ROLE service_role;`, `DO $case$ DECLARE r jsonb; BEGIN r:=${call(true)}; IF r->>'outcome'<>'rolled_back' OR r #>> '{evidence,rollbackVerified}'<>'true' THEN RAISE EXCEPTION 'DRY_RUN_FAILED'; END IF; END $case$;`, 'RESET ROLE;', `DO $case$ BEGIN IF EXISTS(SELECT 1 FROM ${schema}.cover_models WHERE id=${str(targetId)}) OR (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ${schema}.llm_models t) IS DISTINCT FROM (SELECT value FROM ${schema}.original_llms) THEN RAISE EXCEPTION 'RESTORE_OR_LLM_PROTECTION_FAILED'; END IF; END $case$;`]);
  testCase('stale candidate hash rejects before DML', [expect(call(false, actor, 'f'.repeat(64)), 'IMAGE_ADDITION_BASE_CHANGED')]);
  testCase('disabled actor rejects', [expect(call(false, '99999999-9999-4999-8999-999999999999'), 'IMAGE_ADDITION_ADMIN_REQUIRED')]);
  testCase('old logical entry edit rejects', [`UPDATE ${schema}.model_pool_config_releases SET snapshot=jsonb_set(snapshot,'{models,0,name}','"unauthorized"') WHERE id=${str(candidateId)};`, expect(call(false), 'IMAGE_ADDITION_TARGET_INVALID')]);
  testCase('missing pending rejects', [`ALTER TABLE ${schema}.platform_model_pending_credentials DISABLE TRIGGER pending_immutable; DELETE FROM ${schema}.platform_model_pending_credentials WHERE release_id=${str(candidateId)};`, expect(call(false), 'IMAGE_ADDITION_CREDENTIAL_CONFLICT')]);
  testCase('new target cannot reuse existing credential binding', [`INSERT INTO ${schema}.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by) VALUES(${str('secret://platform-model/cover_models/' + targetId)},${str('cover_models:' + targetId)},'fixture-orphan',${str(actor)});`, expect(call(false), 'IMAGE_ADDITION_CREDENTIAL_CONFLICT')]);
  testCase('untrusted temp context rejects without reuse', ['CREATE TEMP TABLE pg_temp.model_pool_canonical_visibility_permit(untrusted text) ON COMMIT DROP;', expect(call(false), 'IMAGE_ADDITION_TEMP_CONTEXT_UNTRUSTED')]);
  testCase('catalog shadow is rejected before old trigger can execute', ['CREATE TEMP TABLE pg_temp.pg_class(untrusted text) ON COMMIT DROP;', expect(call(false), 'IMAGE_ADDITION_TEMP_CONTEXT_UNTRUSTED')]);
  testCase('unexpected non-target LLM trigger side effect rolls back', [`CREATE FUNCTION ${schema}.fixture_illegal_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE ${schema}.llm_models SET temperature=0.9 WHERE id='old-llm-0'; RETURN NEW; END $$; CREATE TRIGGER fixture_illegal_effect AFTER INSERT ON ${schema}.cover_models FOR EACH ROW EXECUTE FUNCTION ${schema}.fixture_illegal_effect();`, expect(call(false), 'IMAGE_ADDITION_PROTECTED_ROWS_CHANGED')]);
  testCase('visibility isolation postcondition failure rolls back', [`CREATE FUNCTION ${schema}.fixture_break_isolation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.is_active:=true; NEW.is_hidden:=false; RETURN NEW; END $$; CREATE TRIGGER zz_fixture_break_isolation BEFORE INSERT ON ${schema}.cover_models FOR EACH ROW EXECUTE FUNCTION ${schema}.fixture_break_isolation();`, expect(call(false), 'IMAGE_ADDITION_ISOLATION_POSTCONDITION_FAILED')]);
  testCase('anon cannot execute RPC', [`SET LOCAL ROLE anon; DO $case$ BEGIN BEGIN PERFORM ${call(false)}; RAISE EXCEPTION 'ANON_ALLOWED'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $case$; RESET ROLE;`]);
  testCase('single successful scoped publication remains isolated and replay requests readback', [`SET LOCAL ROLE service_role; DO $case$ DECLARE r jsonb; BEGIN r:=${call(false)}; IF r->>'outcome'<>'committed' THEN RAISE EXCEPTION 'PUBLICATION_FAILED'; END IF; END $case$;`, expect(call(false), 'IMAGE_ADDITION_ALREADY_PUBLISHED'), `RESET ROLE;`, `DO $case$ BEGIN IF NOT EXISTS(SELECT 1 FROM ${schema}.cover_models WHERE id=${str(targetId)} AND is_active=false AND is_hidden=true) OR (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ${schema}.llm_models t) IS DISTINCT FROM (SELECT value FROM ${schema}.original_llms) THEN RAISE EXCEPTION 'ISOLATION_OR_LLM_PROTECTION_FAILED'; END IF; END $case$;`]);
  lines.push("SELECT 'PASS: namespace-adapted actual image addition RPC; final transaction rollback' AS result;", 'ROLLBACK;');
  return lines.join('\n') + '\n';
}
