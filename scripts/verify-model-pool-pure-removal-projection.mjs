import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Zero network by design: this verifier has no DB client, provider transport,
// environment/credential loader, or child-process execution. PostgreSQL tests
// are emitted for an independently authorized isolated fixture, never applied.
const root = fileURLToPath(new URL('../', import.meta.url));
const oldPath = 'supabase/migrations/20261019010000_model_pool_delta_projection.sql';
const newPath = 'supabase/migrations/20261027070000_model_pool_pure_removal_projection.sql';
const oldSource = readFileSync(root + oldPath, 'utf8').replace(/\r\n/gu, '\n');
const source = readFileSync(root + newPath, 'utf8').replace(/\r\n/gu, '\n');
const sha = text => createHash('sha256').update(text).digest('hex');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const contractSource = readFileSync(root + 'src/lib/platform-configuration-contract.ts', 'utf8');
const contractModule = { exports: {} };
runInNewContext(ts.transpileModule(contractSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module: contractModule, exports: contractModule.exports,
  require: name => { assert.equal(name, 'node:crypto', 'UNEXPECTED_CONTRACT_DEPENDENCY'); return { createHash }; },
});
const emptyPoolValidation = contractModule.exports.validateModelPoolSnapshot({ schema: 'model-pool-config/v1', models: [] });
assert.equal(emptyPoolValidation.ok, false, 'REAL_PUBLISH_VALIDATOR_MUST_REJECT_EMPTY_POOL');
for (const kind of ['agent', 'image', 'video']) assert.ok(emptyPoolValidation.issues.includes(`模型池缺少 ${kind} 模型`) && emptyPoolValidation.issues.includes(`模型池没有启用的 ${kind} 模型`));
assert.equal(contractModule.exports.validateModelPoolSnapshot({ schema: 'model-pool-config/v1', models: ['agent', 'image', 'video'].map(kind => ({ kind, id: kind, catalogState: 'enabled', credentialRef: 'fixture:' + kind, pricing: { selling: 1 } })) }).ok, true, 'VALIDATOR_POSITIVE_CONTROL');
const oldBody = oldSource.match(/AS \$delta\$\n([\s\S]*?)\n\$delta\$;/u)?.[1];
const oldDefinition = oldSource.match(/CREATE OR REPLACE FUNCTION public\.model_pool_projection_delta[\s\S]*?\$delta\$;/u)?.[0];
const definition = source.match(/CREATE OR REPLACE FUNCTION public\.model_pool_projection_delta[\s\S]*?\$delta\$;/u)?.[0];
assert.ok(oldBody && oldDefinition && definition, 'EXACT_FUNCTION_SOURCE_REQUIRED');
const preservedBody = source.match(/  RETURN QUERY\n(WITH old_entries[\s\S]*?);\nEND;\n\$delta\$;/u)?.[1];
assert.equal(preservedBody + ';', oldBody, 'ORIGINAL_NON_REMOVAL_SQL_MUST_BE_BYTE_PRESERVED');
assert.equal((source.match(/CREATE OR REPLACE FUNCTION/gu) || []).length, 1);
assert.match(source, /^BEGIN;[\s\S]*COMMIT;\s*$/u);
assert.match(definition, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public/u);
assert.doesNotMatch(source, /ALTER\s+FUNCTION|OWNER\s+TO|\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO|FROM|public\.)/iu);
const acl = source.slice(source.indexOf('REVOKE ALL ON FUNCTION'));
const originalAcl = oldSource.slice(oldSource.indexOf('REVOKE ALL ON FUNCTION public.model_pool_projection_delta'))
  .split('\n').slice(0, 3).join('\n');
assert.equal(acl.trim(), (originalAcl + '\n\nCOMMIT;').trim(), 'ACL_MUST_MATCH_ORIGINAL');
for (const fragment of [
  "v_current_count = 1", "jsonb_array_length(p_snapshot->'models') < jsonb_array_length(v_current_models)",
  'WHERE old.model = next.model', "GROUP BY model->>'id' HAVING count(*) > 1",
  "GROUP BY model #>> '{configuration,legacyTable}', model #>> '{configuration,legacyId}'",
  'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS', 'MODEL_POOL_LEGACY_IDENTITY_INVALID',
  'MODEL_POOL_CURRENT_IDENTITY_AMBIGUOUS',
]) assert.ok(definition.includes(fragment), 'STRICT_GUARD_FRAGMENT_MISSING:' + fragment);

const entry = (id, table, legacyId = id) => ({ id, name: id, credentialRef: 'fixture:' + id,
  configuration: { legacyTable: table, legacyId }, pricing: { selling: 1 }, capabilities: { fixture: true } });
const videos = Array.from({ length: 6 }, (_, index) => entry('video-' + index, 'video_models'));
const llms = Array.from({ length: 6 }, (_, index) => entry('llm-' + index, 'llm_models'));
const survivors = [...llms, entry('video-keep', 'video_models'), entry('cover-keep', 'cover_models', 'shared'), entry('chat-keep', 'chat_models', 'shared')];
const current = { schema: 'model-pool-config/v1', models: [...videos, ...survivors] };
const next = { schema: current.schema, models: survivors };
const changed = structuredClone(next); changed.models.at(-2).name += '-changed';
const added = structuredClone(next); added.models.push(entry('video-added', 'video_models'));
const changedCredential = structuredClone(next); changedCredential.models.at(-1).credentialRef = 'fixture:changed';
const clone = value => structuredClone(value);
const duplicateId = clone(next); duplicateId.models[1].id = duplicateId.models[0].id;
const duplicateLegacy = clone(next); duplicateLegacy.models[1].configuration = clone(duplicateLegacy.models[0].configuration);
const invalidIdentity = clone(next); delete invalidIdentity.models[0].id;
const invalidLegacyType = clone(next); invalidLegacyType.models[0].configuration.legacyId = 42;
const badCurrentId = clone(current); badCurrentId.models[1].id = badCurrentId.models[0].id;
const badCurrentLegacy = clone(current); badCurrentLegacy.models[1].configuration = clone(badCurrentLegacy.models[0].configuration);
const fixtures = [
  { name: 'pure-removal-original-12-to-6', current, next, mode: 'removed', expected: 6, oldExpected: 12 },
  { name: 'no-op-retains-six-unrelated-drift', current, next: current, mode: 'legacy', expected: 6 },
  { name: 'changed-survivor-retains-drift', current, next: changed, mode: 'legacy', expected: 13 },
  { name: 'added-entry-retains-drift', current, next: added, mode: 'legacy', expected: 13 },
  { name: 'changed-credential-ref-retains-drift', current, next: changedCredential, mode: 'legacy', expected: 13 },
  { name: 'reordered-jsonb-equal-survivors', current, next: { schema: current.schema, models: [...survivors].reverse() }, mode: 'removed', expected: 6 },
  { name: 'remove-entire-pool', current, next: { schema: current.schema, models: [] }, mode: 'removed', expected: current.models.length },
  { name: 'no-current-falls-back', current: null, next, mode: 'legacy', expected: survivors.length },
  { name: 'duplicate-next-id-rejected', current, next: duplicateId, error: 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS' },
  { name: 'duplicate-next-legacy-pair-rejected', current, next: duplicateLegacy, error: 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS' },
  { name: 'missing-id-rejected', current, next: invalidIdentity, error: 'MODEL_POOL_LEGACY_IDENTITY_INVALID' },
  { name: 'non-string-legacy-id-rejected', current, next: invalidLegacyType, error: 'MODEL_POOL_LEGACY_IDENTITY_INVALID' },
  { name: 'duplicate-current-id-rejected', current: badCurrentId, next, error: 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS' },
  { name: 'duplicate-current-legacy-pair-rejected', current: badCurrentLegacy, next, error: 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS' },
  { name: 'json-null-next-model-rejected', current, next: { ...next, models: [null, ...survivors] }, error: 'MODEL_POOL_LEGACY_IDENTITY_INVALID' },
  { name: 'scalar-next-model-rejected', current, next: { ...next, models: [42, ...survivors] }, error: 'MODEL_POOL_LEGACY_IDENTITY_INVALID' },
  { name: 'json-null-current-model-rejected', current: { ...current, models: [...current.models, null] }, next, error: 'MODEL_POOL_LEGACY_IDENTITY_INVALID' },
  { name: 'scalar-current-model-rejected', current: { ...current, models: [...current.models, 'scalar'] }, next, error: 'MODEL_POOL_LEGACY_IDENTITY_INVALID' },
  { name: 'multiple-published-current-rejected', current, currentCopies: 2, next, error: 'MODEL_POOL_CURRENT_IDENTITY_AMBIGUOUS' },
];

// Reference fixtures clarify expectations only; they do not execute SQL. The
// emitted suite below executes the actual migration's function, not this model.
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const identity = model => JSON.stringify([model.configuration.legacyTable, model.configuration.legacyId]);
function reference(fixture) {
  assert.ok((fixture.currentCopies || 1) <= 1, 'MODEL_POOL_CURRENT_IDENTITY_AMBIGUOUS');
  for (const snapshot of [fixture.current, fixture.next].filter(Boolean)) {
    for (const model of snapshot.models) assert.ok(typeof model?.id === 'string' && model.id && typeof model.configuration?.legacyId === 'string' && model.configuration.legacyId && ['video_models', 'cover_models', 'llm_models', 'chat_models'].includes(model.configuration.legacyTable), 'MODEL_POOL_LEGACY_IDENTITY_INVALID');
    assert.equal(new Set(snapshot.models.map(model => model.id)).size, snapshot.models.length, 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS');
    assert.equal(new Set(snapshot.models.map(identity)).size, snapshot.models.length, 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS');
  }
  const before = fixture.current?.models || [], after = fixture.next.models;
  const pure = fixture.current && after.length < before.length && after.every(model => before.some(old => json(old) === json(model)));
  const removed = before.filter(old => !after.some(model => identity(old) === identity(model)));
  const updates = after.filter(model => !before.some(old => json(old) === json(model)) || llms.some(llm => llm.id === model.id));
  return { mode: pure ? 'removed' : 'legacy', count: pure ? removed.length : updates.length + removed.length };
}
for (const fixture of fixtures) {
  if (fixture.error) assert.throws(() => reference(fixture), error => error.message.includes(fixture.error), fixture.name);
  else assert.deepEqual(reference(fixture), { mode: fixture.mode, count: fixture.expected }, fixture.name);
}

const schema = 'model_pool_removal_fixture';
const sqlString = value => "'" + String(value).replaceAll("'", "''") + "'";
const sqlJson = value => sqlString(JSON.stringify(value)) + '::jsonb';
const isolated = text => text.replaceAll('public.', schema + '.').replace('search_path = pg_catalog, public', 'search_path = pg_catalog, ' + schema);
const oldFixtureDefinition = isolated(oldDefinition).replace('FUNCTION ' + schema + '.model_pool_projection_delta', 'FUNCTION ' + schema + '.legacy_model_pool_projection_delta');
const protectedExpression = `jsonb_build_object(${['cover_models', 'video_models', 'llm_models', 'chat_models', 'platform_model_credential_bindings', 'fixture_billing', 'fixture_workspace'].map(table => `${sqlString(table)},(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${schema}.${table} t)`).join(',')})`;
const lines = [
  '\\set ON_ERROR_STOP on', '-- Execute only on an explicitly authorized disposable PostgreSQL instance.',
  '-- Uses a newly created isolated schema; all fixture DDL/data and function replacements ROLLBACK.',
  '-- This is not a target-database migration or an authorization to apply one.',
  'BEGIN;', 'SET LOCAL statement_timeout = \'30s\';', `CREATE SCHEMA ${schema};`,
  `CREATE TABLE ${schema}.model_pool_config_releases(snapshot jsonb,is_current boolean,status text);`,
  ...['cover_models', 'video_models', 'llm_models', 'chat_models'].map(table => `CREATE TABLE ${schema}.${table}(id text PRIMARY KEY,api_key text,is_active boolean DEFAULT true,is_hidden boolean DEFAULT false);`),
  `CREATE TABLE ${schema}.platform_model_credential_bindings(credential_ref text PRIMARY KEY,secret_value text);`,
  `CREATE TABLE ${schema}.fixture_billing(id text,amount numeric); INSERT INTO ${schema}.fixture_billing VALUES('immutable-charge',4.61);`,
  `CREATE TABLE ${schema}.fixture_workspace(id text,preferences jsonb); INSERT INTO ${schema}.fixture_workspace VALUES('immutable-preferences','{"fixture":true}');`,
  ...current.models.filter(model => !['llm-0', 'llm-1'].includes(model.id)).map(model => `INSERT INTO ${schema}.${model.configuration.legacyTable}(id,api_key) VALUES(${sqlString(model.configuration.legacyId)},${sqlString(model.id.startsWith('llm-') ? 'fixture-physical-different' : 'fixture-same')});`),
  ...current.models.map(model => `INSERT INTO ${schema}.platform_model_credential_bindings VALUES(${sqlString(model.credentialRef)},${sqlString(model.id.startsWith('llm-') ? 'fixture-binding-different' : 'fixture-same')});`),
  oldFixtureDefinition,
  // Capture the owner of the pre-existing function before CREATE OR REPLACE.
  isolated(oldDefinition),
  `CREATE TEMP TABLE fixture_owner AS SELECT proowner FROM pg_proc WHERE oid='${schema}.model_pool_projection_delta(jsonb)'::regprocedure;`,
  isolated(definition),
  `DO $security$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='${schema}.model_pool_projection_delta(jsonb)'::regprocedure AND p.proowner=(SELECT proowner FROM fixture_owner) AND p.prosecdef AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=pg_catalog, ${schema}']) THEN RAISE EXCEPTION 'FUNCTION_SECURITY_CONTRACT_CHANGED'; END IF; END $security$;`,
  `CREATE TEMP TABLE fixture_protected AS SELECT ${protectedExpression} AS value;`,
];
for (const fixture of fixtures) {
  lines.push(`DELETE FROM ${schema}.model_pool_config_releases;`);
  if (fixture.current) for (let copy = 0; copy < (fixture.currentCopies || 1); copy++) lines.push(`INSERT INTO ${schema}.model_pool_config_releases VALUES(${sqlJson(fixture.current)},true,'published');`);
  const invoke = `${schema}.model_pool_projection_delta(${sqlJson(fixture.next)})`;
  const legacyInvoke = `${schema}.legacy_model_pool_projection_delta(${sqlJson(fixture.next)})`;
  lines.push(`-- ${fixture.name}`);
  if (fixture.error) lines.push(`DO $case$ BEGIN BEGIN PERFORM * FROM ${invoke}; RAISE EXCEPTION 'EXPECTED_IDENTITY_REJECTION'; EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM <> ${sqlString(fixture.error)} THEN RAISE; END IF; END; END $case$;`);
  else {
    lines.push(`DO $case$ DECLARE result jsonb; legacy_result jsonb; BEGIN SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY legacy_table,legacy_id,removed),'[]'::jsonb) INTO result FROM ${invoke} d; IF jsonb_array_length(result) <> ${fixture.expected} THEN RAISE EXCEPTION 'COUNT_MISMATCH ${fixture.name}: %',result; END IF;`);
    if (fixture.mode === 'legacy') lines.push(`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY legacy_table,legacy_id,removed),'[]'::jsonb) INTO legacy_result FROM ${legacyInvoke} d; IF result IS DISTINCT FROM legacy_result THEN RAISE EXCEPTION 'LEGACY_SEMANTICS_CHANGED ${fixture.name}'; END IF;`);
    else lines.push(`IF EXISTS(SELECT 1 FROM jsonb_array_elements(result) item WHERE item->>'removed' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'NON_REMOVAL_LEAKED ${fixture.name}'; END IF; IF EXISTS((SELECT legacy_table,legacy_id FROM ${invoke}) EXCEPT (SELECT old.model #>> '{configuration,legacyTable}',old.model #>> '{configuration,legacyId}' FROM jsonb_array_elements(${sqlJson(fixture.current)}->'models') old(model) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${sqlJson(fixture.next)}->'models') next(model) WHERE next.model=old.model))) THEN RAISE EXCEPTION 'WRONG_REMOVAL_IDENTITY'; END IF;`);
    if (fixture.oldExpected) lines.push(`IF (SELECT count(*) FROM ${legacyInvoke}) <> ${fixture.oldExpected} THEN RAISE EXCEPTION 'BASELINE_12_DRIFT_NOT_REPRODUCED'; END IF;`);
    lines.push('END $case$;');
  }
  lines.push(`DO $protected$ BEGIN IF ${protectedExpression} IS DISTINCT FROM (SELECT value FROM fixture_protected) THEN RAISE EXCEPTION 'PROTECTED_ROWS_CHANGED'; END IF; END $protected$;`);
}
lines.push("SELECT 'PASS: actual PostgreSQL pure-removal fixture suite; protected rows unchanged; transaction rolls back' AS result;", 'ROLLBACK;');
const emitArg = process.argv.find(arg => arg.startsWith('--emit-isolated-sql='));
const replaceEmittedSql = process.argv.includes('--replace-emitted-sql');
assert.ok(process.argv.slice(2).every(arg => arg.startsWith('--emit-isolated-sql=') || arg === '--replace-emitted-sql'), 'UNKNOWN_ARGUMENT');
assert.ok(!replaceEmittedSql || emitArg, 'REPLACE_REQUIRES_EXPLICIT_SQL_OUTPUT');
if (emitArg) {
  const target = emitArg.slice('--emit-isolated-sql='.length); assert.ok(target, 'SQL_OUTPUT_PATH_REQUIRED');
  writeFileSync(target, lines.join('\n') + '\n', { flag: replaceEmittedSql ? 'w' : 'wx' });
}
console.log(JSON.stringify({ status: '✅完成', mode: 'zero-network-static-and-reference-fixtures', staticContractsPassed: true,
  referenceFixturesPassed: fixtures.length, actualPostgresExecuted: false, actualPostgresStatus: '❌未完成：须由授权执行人在隔离 PostgreSQL 执行生成的事务回滚 fixture SQL',
  realPublishValidatorEmptyPoolRejected: true, emptyPoolIssues: [...emptyPoolValidation.issues],
  emptyPoolBoundary: 'The delta allows removal of all entries; the real publish validator rejects the resulting empty pool. No claim that delta rejects an empty pool.',
  validatorSourceSha256: sha(contractSource),
  emittedIsolatedSql: emitArg?.slice('--emit-isolated-sql='.length) || null,
  migrationSha256: sha(source), originalMigrationSha256: sha(oldSource), isolatedSqlSha256: sha(lines.join('\n') + '\n'),
  databaseConnections: 0, providerRequests: 0, modelDataWrites: 0,
  boundaries: 'Reference results are specification fixtures only. Actual old/new migration function source is embedded in emitted SQL; no copied SQL algorithm. ACL equality checked statically; owner/definer/search_path/volatility checked by the PG fixture. No publish/CAS integration is claimed.' }, null, 2));
