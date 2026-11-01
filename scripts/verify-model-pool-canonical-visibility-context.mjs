import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = 'supabase/migrations/20261027071000_model_pool_canonical_visibility_context.sql';
const source = readFileSync(root + file, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
assert.equal(sha(readFileSync(root + 'supabase/migrations/20261027070000_model_pool_pure_removal_projection.sql')), 'f5766451e54458b01049047871358d6419924bf22d816377b9d039c2780473ae', 'REVIEWED_DELTA_MIGRATION_CHANGED');
assert.match(source, /^BEGIN;[\s\S]*COMMIT;\s*$/u);
assert.doesNotMatch(source, /DISABLE\s+TRIGGER|set_config|current_setting|ALTER\s+TABLE/iu);
for (const name of source.matchAll(/(?:FUNCTION|TO) public\.([a-z0-9_]+)/gu)) assert.ok(Buffer.byteLength(name[1]) <= 63, 'IDENTIFIER_TRUNCATION');
for (const guard of [
  'v_owner := pg_get_userbyid(v_original.proowner)', '__EXPECTED_OWNER_LITERAL__',
  "relation.relpersistence = 't'", "relation.relkind = 'r'", 'relation.relnamespace = pg_my_temp_schema()',
  'attribute.attnotnull', 'attribute.attnum', 'relation.relowner = v_owner', 'SECURITY INVOKER',
  'current_user = pg_get_userbyid(v_owner)', 'permit.transaction_id = txid_current()', 'permit.backend_pid = pg_backend_pid()',
  'permit.legacy_table = TG_TABLE_NAME', 'permit.legacy_id = NEW.id::text', 'NEW.is_active IS FALSE AND NEW.is_hidden IS TRUE',
  "to_jsonb(NEW) - ARRAY['is_active','is_hidden','updated_at']", 'MODEL_POOL_REMOVAL_CONTENT_CHANGED',
  'ON COMMIT DROP', 'MODEL_POOL_VISIBILITY_CONTEXT_REENTRY', 'MODEL_POOL_VISIBILITY_CONTEXT_UNTRUSTED',
  'MODEL_POOL_CANONICAL_RETIREMENT_NOT_APPLIED', 'MODEL_POOL_REMOVED_ABSENT_ROW_REINSERTED',
  'DROP TABLE pg_temp.model_pool_canonical_visibility_permit', 'FROM PUBLIC, anon, authenticated, service_role',
  'coalesce(v_original.proacl, acldefault', 'WITH GRANT OPTION', 'OLD.is_active IS FALSE AND OLD.is_hidden IS TRUE',
  "GRANT EXECUTE ON FUNCTION public.project_model_pool_before_visibility(jsonb) TO %I', v_owner",
]) assert.ok(source.includes(guard), 'MISSING_GUARD:' + guard);

// Specification cases only. Actual SQL below uses the migration verbatim,
// with only schema qualification isolated. It does not simulate PostgreSQL.
const cases = [
  ['ordinary-hide', {}, false], ['GUC-only', { guc: true }, false],
  ['exact-retirement', { trusted: true, owner: true, row: true, tx: true, pid: true, flags: true }, true],
  ...['trusted', 'owner', 'row', 'tx', 'pid', 'flags'].map(key => ['wrong-' + key, { trusted: true, owner: true, row: true, tx: true, pid: true, flags: true, [key]: false }, false]),
];
for (const [name, value, expected] of cases) assert.equal(Boolean(value.trusted && value.owner && value.row && value.tx && value.pid && value.flags), expected, name);
const schema = 'model_pool_visibility_fixture';
const owner = 'zimeiti_owner';
const emit = process.argv.find(arg => arg.startsWith('--emit-isolated-sql='))?.slice('--emit-isolated-sql='.length);
const database = process.argv.find(arg => arg.startsWith('--fixture-database='))?.slice('--fixture-database='.length);
const replace = process.argv.includes('--replace-emitted-sql');
assert.ok(process.argv.slice(2).every(arg => ['--emit-isolated-sql=', '--fixture-database='].some(prefix => arg.startsWith(prefix)) || arg === '--replace-emitted-sql'), 'UNKNOWN_ARGUMENT');
if (emit) assert.match(database || '', /^zimeiti_restore_[a-zA-Z0-9_]+$/u, 'EXPLICIT_RESTORE_DATABASE_REQUIRED');
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const json = value => literal(JSON.stringify(value)) + '::jsonb';
const table = 'pg_temp.model_pool_canonical_visibility_permit';
const permitDdl = `CREATE TEMP TABLE ${table}(legacy_table text NOT NULL,legacy_id text NOT NULL,transaction_id bigint NOT NULL,backend_pid integer NOT NULL,expected_present boolean NOT NULL,removed boolean NOT NULL,original_hash text NOT NULL,PRIMARY KEY(legacy_table,legacy_id)) ON COMMIT DROP; REVOKE ALL ON TABLE ${table} FROM PUBLIC,anon,authenticated,service_role;`;
const delta = Array.from({ length: 6 }, (_, index) => ({ legacy_table: 'video_models', legacy_id: 'video-' + index, removed: true }));
const snapshot = { models: [], fixtureDelta: delta };
const call = value => `SELECT ${schema}.project_model_pool_configuration_atomic(${json(value)});`;
const expectError = (value, pattern) => `DO $test$ BEGIN BEGIN PERFORM ${schema}.project_model_pool_configuration_atomic(${json(value)}); RAISE EXCEPTION 'EXPECTED_FAILURE_NOT_RAISED'; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE ${literal(pattern)} THEN RAISE; END IF; END; IF to_regclass('${table}') IS NOT NULL THEN RAISE EXCEPTION 'PERMIT_LEAKED_AFTER_EXCEPTION'; END IF; END $test$;`;
const noLeak = `DO $test$ BEGIN IF to_regclass('${table}') IS NOT NULL THEN RAISE EXCEPTION 'PERMIT_LEAKED'; END IF; END $test$;`;
const ordinaryCheck = `DO $test$ BEGIN IF NOT EXISTS(SELECT 1 FROM ${schema}.video_models WHERE id='video-keep' AND is_active AND NOT is_hidden) THEN RAISE EXCEPTION 'ORDINARY_HIDE_BYPASSED'; END IF; END $test$;`;
const sql = [
  '\\set ON_ERROR_STOP on', 'BEGIN;', `DO $identity$ BEGIN IF current_database() <> ${literal(database || 'EXPLICIT_RESTORE_DATABASE_REQUIRED')} THEN RAISE EXCEPTION 'WRONG_FIXTURE_DATABASE'; END IF; END $identity$;`,
  "SET LOCAL statement_timeout='30s';", `CREATE SCHEMA ${schema}; GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${owner}; GRANT USAGE ON SCHEMA ${schema} TO service_role;`,
  ...['video_models', 'cover_models', 'llm_models'].map(name => `CREATE TABLE ${schema}.${name}(id text PRIMARY KEY,provider text DEFAULT 'fixture-provider',name text DEFAULT 'fixture-name',api_key text DEFAULT 'fixture-key',api_endpoint text DEFAULT 'https://fixture.invalid',is_active boolean DEFAULT true,is_hidden boolean DEFAULT false,updated_at timestamptz DEFAULT now()); GRANT ALL ON ${schema}.${name} TO ${owner};`),
  `INSERT INTO ${schema}.video_models(id) SELECT 'video-'||n FROM generate_series(0,5) n; INSERT INTO ${schema}.video_models(id) VALUES('video-keep'); INSERT INTO ${schema}.cover_models(id) VALUES('cover-retire'); INSERT INTO ${schema}.llm_models(id) VALUES('llm-retire');`,
  `CREATE FUNCTION ${schema}.model_pool_projection_delta(p jsonb) RETURNS TABLE(legacy_table text,legacy_id text,removed boolean) LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ SELECT * FROM jsonb_to_recordset(p->'fixtureDelta') d(legacy_table text,legacy_id text,removed boolean) $fn$; ALTER FUNCTION ${schema}.model_pool_projection_delta(jsonb) OWNER TO ${owner};`,
  `CREATE FUNCTION ${schema}.project_model_pool_configuration_atomic(p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,${schema} AS $fn$ DECLARE d record; BEGIN IF has_table_privilege('service_role','${table}','INSERT') OR has_table_privilege('anon','${table}','INSERT') OR has_table_privilege('authenticated','${table}','INSERT') THEN RAISE EXCEPTION 'PERMIT_WRITABLE_BY_API'; END IF; IF p ? 'reenter' THEN PERFORM ${schema}.project_model_pool_configuration_atomic(p-'reenter'); END IF; FOR d IN SELECT * FROM ${schema}.model_pool_projection_delta(p) LOOP EXECUTE format('UPDATE ${schema}.%I SET is_active=false,is_hidden=true WHERE id=$1',d.legacy_table) USING d.legacy_id; END LOOP; IF p ? 'tamper' THEN UPDATE ${schema}.video_models SET name='tampered' WHERE id='video-0'; END IF; IF p ? 'delete' THEN DELETE FROM ${schema}.video_models WHERE id='video-0'; END IF; IF p ? 'insertAbsent' THEN INSERT INTO ${schema}.video_models(id,provider,is_active,is_hidden) VALUES('absent','retired_configuration',false,true); END IF; END $fn$; ALTER FUNCTION ${schema}.project_model_pool_configuration_atomic(jsonb) OWNER TO ${owner}; REVOKE ALL ON FUNCTION ${schema}.project_model_pool_configuration_atomic(jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION ${schema}.project_model_pool_configuration_atomic(jsonb) TO service_role;`,
  `CREATE TEMP TABLE expected_projector_acl AS SELECT proowner,proacl FROM pg_proc WHERE oid='${schema}.project_model_pool_configuration_atomic(jsonb)'::regprocedure;`,
  source.replace(/^BEGIN;\s*/u, '').replace(/COMMIT;\s*$/u, '').replaceAll('public.', schema + '.').replaceAll("TG_TABLE_SCHEMA = 'public'", `TG_TABLE_SCHEMA = '${schema}'`).replaceAll('search_path = pg_catalog, public', `search_path = pg_catalog, ${schema}`),
  ...['video_models', 'cover_models', 'llm_models'].map(name => `CREATE TRIGGER fixture_visibility BEFORE INSERT OR UPDATE ON ${schema}.${name} FOR EACH ROW EXECUTE FUNCTION ${schema}.enforce_model_resource_visibility_invariant();`),
  `DO $acl$ BEGIN IF EXISTS(SELECT 1 FROM pg_proc p,expected_projector_acl e WHERE p.oid='${schema}.project_model_pool_configuration_atomic(jsonb)'::regprocedure AND (p.proowner<>e.proowner OR (SELECT jsonb_agg(jsonb_build_array(grantee,privilege_type,is_grantable) ORDER BY grantee,privilege_type,is_grantable) FROM aclexplode(p.proacl)) IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(grantee,privilege_type,is_grantable) ORDER BY grantee,privilege_type,is_grantable) FROM aclexplode(e.proacl)))) THEN RAISE EXCEPTION 'PROJECTOR_OWNER_ACL_CHANGED'; END IF; IF NOT has_function_privilege('${owner}','${schema}.project_model_pool_before_visibility(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'INTERNAL_PROJECTOR_OWNER_CANNOT_EXECUTE'; END IF; IF has_function_privilege('service_role','${schema}.project_model_pool_before_visibility(jsonb)','EXECUTE') OR has_function_privilege('anon','${schema}.project_model_pool_before_visibility(jsonb)','EXECUTE') OR has_function_privilege('authenticated','${schema}.project_model_pool_before_visibility(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'INTERNAL_PROJECTOR_API_WRITABLE'; END IF; END $acl$;`,
  `UPDATE ${schema}.video_models SET is_active=false,is_hidden=true WHERE id='video-keep';`, ordinaryCheck,
  "SELECT set_config('app.model_pool_retirement','on',true);", `UPDATE ${schema}.video_models SET is_active=false,is_hidden=true WHERE id='video-keep';`, ordinaryCheck,
  'SET LOCAL ROLE service_role;', call(snapshot), call(snapshot), 'RESET ROLE;', noLeak,
  `DO $six$ BEGIN IF (SELECT count(*) FROM ${schema}.video_models WHERE id<>'video-keep' AND is_active=false AND is_hidden=true)<>6 THEN RAISE EXCEPTION 'EXACT_SIX_NOT_RETIRED'; END IF; END $six$;`,
  `UPDATE ${schema}.video_models SET name=name||'-metadata' WHERE id<>'video-keep';`,
  `DO $metadata$ BEGIN IF (SELECT count(*) FROM ${schema}.video_models WHERE id<>'video-keep' AND NOT is_active AND is_hidden)<>6 THEN RAISE EXCEPTION 'METADATA_UPDATE_RESURRECTED'; END IF; END $metadata$;`,
  expectError({ ...snapshot, delete: true }, 'MODEL_POOL_CANONICAL_RETIREMENT_NOT_APPLIED:%'),
  expectError({ ...snapshot, tamper: true }, 'MODEL_POOL_REMOVAL_CONTENT_CHANGED'),
  expectError({ ...snapshot, reenter: true }, 'MODEL_POOL_VISIBILITY_CONTEXT_REENTRY'),
  call({ models: [], fixtureDelta: [{ legacy_table: 'video_models', legacy_id: 'absent', removed: true }] }), noLeak,
  expectError({ models: [], fixtureDelta: [{ legacy_table: 'video_models', legacy_id: 'absent', removed: true }], insertAbsent: true }, 'MODEL_POOL_REMOVED_ABSENT_ROW_REINSERTED'),
];
for (const field of ['id', 'tx', 'pid', 'caller']) {
  sql.push(`SET LOCAL ROLE ${owner};`, permitDdl,
    `INSERT INTO ${table} VALUES('video_models',${literal(field === 'id' ? 'wrong-id' : 'video-keep')},txid_current()${field === 'tx' ? '+1' : ''},pg_backend_pid()${field === 'pid' ? '+1' : ''},true,true,'fixture-hash');`);
  if (field === 'caller') sql.push('RESET ROLE;');
  sql.push(`UPDATE ${schema}.video_models SET is_active=false,is_hidden=true WHERE id='video-keep';`, ordinaryCheck);
  if (field === 'caller') sql.push(`SET LOCAL ROLE ${owner};`);
  sql.push(`DROP TABLE ${table}; RESET ROLE;`);
}
sql.push(permitDdl, `DO $spoof$ BEGIN BEGIN PERFORM ${schema}.project_model_pool_configuration_atomic(${json(snapshot)}); RAISE EXCEPTION 'SPOOF_NOT_REJECTED'; EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'MODEL_POOL_VISIBILITY_CONTEXT_UNTRUSTED' THEN RAISE; END IF; END; END $spoof$;`, `DROP TABLE ${table};`,
  `SET LOCAL ROLE ${owner}; CREATE TEMP TABLE ${table}(bad_structure text);`,
  `DO $shape$ BEGIN BEGIN UPDATE ${schema}.video_models SET is_active=false,is_hidden=true WHERE id='video-keep'; RAISE EXCEPTION 'BAD_STRUCTURE_NOT_REJECTED'; EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'MODEL_POOL_VISIBILITY_CONTEXT_UNTRUSTED' THEN RAISE; END IF; END; END $shape$;`, `DROP TABLE ${table}; RESET ROLE;`,
  ...['cover_models', 'llm_models'].map(name => call({ models: [{ configuration: { legacyTable: name, legacyId: name === 'cover_models' ? 'cover-retire' : 'llm-retire' }, catalogState: 'retired' }], fixtureDelta: [{ legacy_table: name, legacy_id: name === 'cover_models' ? 'cover-retire' : 'llm-retire', removed: false }] })), noLeak,
  "SELECT 'PASS actual visibility migration fixture; mocked legacy projector transport; ROLLBACK follows' AS result;", 'ROLLBACK;');
if (emit) writeFileSync(emit, sql.join('\n') + '\n', { flag: replace ? 'w' : 'wx' });
console.log(JSON.stringify({ status: '✅完成', staticContractsPassed: true, referenceCases: cases.length, migrationSha256: sha(source), verifierSha256: sha(readFileSync(fileURLToPath(import.meta.url))), emittedSql: emit || null, fixtureSqlSha256: sha(sql.join('\n') + '\n'), actualPostgresExecuted: false, actualPostgresStatus: '❌未完成：由协调者在明确恢复库执行隔离fixture与真实publish/CAS回归', databaseConnections: 0, providerRequests: 0, scope: 'Actual trigger/wrapper migration source emitted; legacy projector and delta are isolated fixtures. Does not claim real publish integration, target apply, or provider success.' }, null, 2));
