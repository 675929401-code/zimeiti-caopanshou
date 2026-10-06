#!/usr/bin/env node
// Local artifact builder only. No environment loading, network, SQL execution,
// credentials or production data. Applying the output is a separate operation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  '20260825121000_atomic_wallet_payment_fulfillment.sql',
  '20260825174500_image_generation_exactly_once.sql',
  '20260825180000_video_terminal_billing_p0.sql',
  '20260825202000_payment_provider_evidence_atomic_fulfillment.sql',
  '20260828193000_release_baseline_audit_and_debt.sql',
  '20260901093000_extraction_attempts_exactly_once.sql',
  '20260901170000_llm_request_attempts_exactly_once.sql',
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

// Split only top-level semicolons. SQL strings, quoted identifiers, nested block
// comments, line comments and dollar-quoted PL/pgSQL bodies retain their bytes.
function splitStatements(sql) {
  const output = [];
  let start = 0;
  let quote = null;
  let dollar = null;
  let lineComment = false;
  let blockDepth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockDepth) {
      if (char === '/' && next === '*') { blockDepth += 1; i += 1; }
      else if (char === '*' && next === '/') { blockDepth -= 1; i += 1; }
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; }
      continue;
    }
    if (quote) {
      if (char === quote) { if (next === quote) i += 1; else quote = null; }
      continue;
    }
    if (char === '-' && next === '-') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockDepth = 1; i += 1; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '$') {
      const match = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u.exec(sql.slice(i));
      if (match) { dollar = match[0]; i += dollar.length - 1; continue; }
    }
    if (char === ';') { output.push(sql.slice(start, i + 1)); start = i + 1; }
  }
  if (quote || dollar || blockDepth) throw new Error('UNTERMINATED_SQL_LEXICAL_BLOCK');
  if (sql.slice(start).trim()) output.push(sql.slice(start));
  return output;
}

function withoutLeadingComments(statement) {
  let value = statement.trim();
  while (true) {
    if (value.startsWith('--')) { const end = value.indexOf('\n'); value = end < 0 ? '' : value.slice(end + 1).trim(); }
    else if (value.startsWith('/*')) { const end = value.indexOf('*/'); if (end < 0) throw new Error('UNTERMINATED_COMMENT'); value = value.slice(end + 2).trim(); }
    else return value;
  }
}

const entries = files.map(name => {
  const relativePath = `supabase/migrations/${name}`;
  const original = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const statements = splitStatements(original);
  const meaningful = statements.filter(statement => withoutLeadingComments(statement));
  const boundaries = meaningful.filter(statement => /^(?:BEGIN|COMMIT)\s*;$/iu.test(withoutLeadingComments(statement)));
  if (boundaries.length) {
    assert.equal(boundaries.length, 2, `Mixed transaction: ${name}`);
    assert.match(withoutLeadingComments(meaningful[0]), /^BEGIN\s*;$/iu);
    assert.match(withoutLeadingComments(meaningful.at(-1)), /^COMMIT\s*;$/iu);
  }
  const inner = meaningful.filter(statement => !/^(?:BEGIN|COMMIT)\s*;$/iu.test(withoutLeadingComments(statement)) && !/^NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;$/iu.test(withoutLeadingComments(statement)));
  for (const statement of inner) {
    const head = withoutLeadingComments(statement);
    assert.doesNotMatch(head, /^(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END|INSERT|UPDATE|DELETE|TRUNCATE|CALL|SELECT|DROP\s+(?:TABLE|SCHEMA|DATABASE))\b/iu, `Unexpected top-level effect: ${name}`);
  }
  return { name, relativePath, version: name.slice(0, 14), slug: name.slice(15, -4), sha256: sha256(original), bytes: Buffer.byteLength(original), transactionMode: boundaries.length ? 'self-contained-outer-boundaries-removed' : 'outer-transaction-added', statements: inner, statementCount: inner.length };
});

const newTables = [...new Set(entries.flatMap(entry => entry.statements.flatMap(statement => {
  const match = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.([a-z_]+)/iu.exec(withoutLeadingComments(statement));
  return match ? [match[1]] : [];
})))];
const functions = [...new Set(entries.flatMap(entry => entry.statements.flatMap(statement => {
  const match = /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_]+)/iu.exec(withoutLeadingComments(statement));
  return match ? [match[1]] : [];
})))];
assert.equal(entries.length, 7);
assert.equal(newTables.length, 9);
assert.equal(functions.length, 18);
const core = {
  format: 'core-repair-single-transaction-v1',
  mode: 'fresh-only-no-replay-no-existing-function-overwrite',
  generatorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  files: entries.map(({ statements, ...entry }) => entry),
  newTables,
  functions,
  existingTablesAltered: ['public.video_tasks', 'public.payment_orders'],
  migrationLedger: 'supabase_migrations.schema_migrations',
  sourceBusinessDmlAtApply: false,
  balanceUpdatesAtApply: false,
};
const manifestSha256 = sha256(JSON.stringify(core));
const versions = entries.map(entry => sqlLiteral(entry.version)).join(', ');
const newTablesArray = `ARRAY[${newTables.map(sqlLiteral).join(', ')}]`;
const functionsArray = `ARRAY[${functions.map(sqlLiteral).join(', ')}]`;
const prelude = `-- Generated by scripts/prepare-core-repair-migration-bundle.mjs.
-- All seven migrations and their source-hash ledger rows commit together.
-- Review manifest.json and read-only-preflight.sql before any execution.
-- Required session settings (set in this same connection before this file):
-- app.core_migration_manifest_sha256, app.core_migration_target_database,
-- app.core_migration_backup_ref, app.core_migration_actor.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(260830500011);
DO $core_preflight$
DECLARE
  target_name text;
BEGIN
  IF current_setting('app.core_migration_manifest_sha256', true) IS DISTINCT FROM ${sqlLiteral(manifestSha256)} THEN
    RAISE EXCEPTION 'CORE_MIGRATION_MANIFEST_CONFIRMATION_REQUIRED';
  END IF;
  IF current_setting('app.core_migration_target_database', true) IS DISTINCT FROM current_database() THEN
    RAISE EXCEPTION 'CORE_MIGRATION_DATABASE_CONFIRMATION_REQUIRED';
  END IF;
  IF length(trim(coalesce(current_setting('app.core_migration_backup_ref', true), ''))) < 12
     OR length(trim(coalesce(current_setting('app.core_migration_actor', true), ''))) < 3 THEN
    RAISE EXCEPTION 'CORE_MIGRATION_BACKUP_AND_ACTOR_REQUIRED';
  END IF;
  -- Check the privileges this DDL actually needs. Hosted database owners need
  -- not be superusers or have CREATEROLE; no role is created by this bundle.
  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_PUBLIC_SCHEMA_CREATE_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='supabase_migrations')
     AND NOT has_database_privilege(current_user, current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_LEDGER_SCHEMA_CREATE_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='supabase_migrations')
     AND NOT has_schema_privilege(current_user, 'supabase_migrations', 'CREATE') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_LEDGER_TABLE_CREATE_REQUIRED';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('supabase_migrations.schema_migrations')
                     AND pg_has_role(current_user, relowner, 'USAGE')) THEN
    RAISE EXCEPTION 'CORE_MIGRATION_LEDGER_TABLE_OWNER_REQUIRED';
  END IF;
  FOREACH target_name IN ARRAY ARRAY['video_tasks','payment_orders'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.' || target_name)
                   AND pg_has_role(current_user, relowner, 'USAGE')) THEN
      RAISE EXCEPTION 'CORE_MIGRATION_ALTER_TABLE_OWNER_REQUIRED:%', target_name;
    END IF;
  END LOOP;
  FOREACH target_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_name) THEN
      RAISE EXCEPTION 'CORE_MIGRATION_REQUIRED_ROLE_MISSING:%', target_name;
    END IF;
  END LOOP;
  FOREACH target_name IN ARRAY ARRAY['users', 'credit_transactions', 'cash_transactions', 'payment_orders', 'user_files', 'video_tasks', 'autodl_h3_settlements'] LOOP
    IF to_regclass('public.' || target_name) IS NULL THEN
      RAISE EXCEPTION 'CORE_MIGRATION_BASELINE_TABLE_MISSING:%', target_name;
    END IF;
  END LOOP;
  -- CREATE IF NOT EXISTS must not conceal partially deployed/drifted schemas.
  FOREACH target_name IN ARRAY ${newTablesArray} LOOP
    IF to_regclass('public.' || target_name) IS NOT NULL THEN
      RAISE EXCEPTION 'CORE_MIGRATION_EXISTING_TABLE_REQUIRES_RECONCILIATION:%', target_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = ANY(${functionsArray})) THEN
    RAISE EXCEPTION 'CORE_MIGRATION_EXISTING_FUNCTION_REQUIRES_RECONCILIATION';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text IN (${entries.map(entry => "''" + entry.version + "''").join(', ')})' INTO target_name;
    IF target_name::bigint <> 0 THEN RAISE EXCEPTION 'CORE_MIGRATION_ALREADY_RECORDED_REQUIRES_RECONCILIATION'; END IF;
  END IF;
  -- Explicitly checked against current remote metadata; no existing ID coercion.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='id' AND data_type IN ('text','character varying'))
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user_files' AND column_name='user_id' AND udt_name='uuid')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='video_tasks' AND column_name='user_id' AND udt_name='uuid') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_BASELINE_ID_TYPE_MISMATCH';
  END IF;
  FOREACH target_name IN ARRAY ARRAY['credits','cash_balance','total_credits_recharged','total_credits_consumed','total_cash_recharged','total_cash_consumed'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name=target_name AND data_type='numeric') THEN
      RAISE EXCEPTION 'CORE_MIGRATION_BASELINE_BALANCE_TYPE_MISMATCH:%', target_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND
      ((table_name='video_tasks' AND column_name IN ('client_request_id','request_fingerprint','billing_price_yuan','billing_cost_price_yuan','billing_unit','billing_quantity','billing_state','billing_operation_id','billing_idempotency_key','provider_result_url','explicitly_free','billing_exempt','submission_error_code'))
       OR (table_name='payment_orders' AND column_name IN ('provider_trade_order_id','provider_transaction_id','provider_paid_amount','provider_confirmed_at')))) THEN
    RAISE EXCEPTION 'CORE_MIGRATION_PARTIAL_EXISTING_COLUMNS_REQUIRES_RECONCILIATION';
  END IF;
END;
$core_preflight$;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY, name text, statements text[], hash text,
  applied_by text, applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS hash text;
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS applied_by text;
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS applied_at timestamptz NOT NULL DEFAULT now();
`;

const body = entries.map(entry => `\n-- SOURCE ${entry.name}\n-- SHA256 ${entry.sha256}\n${entry.statements.map(statement => statement.trim()).join('\n\n')}\n`).join('');
const ledgerValues = entries.map(entry => `(${sqlLiteral(entry.version)}, ${sqlLiteral(entry.slug)}, ARRAY[${sqlLiteral(entry.name)}], ${sqlLiteral(entry.sha256)}, current_setting('app.core_migration_actor'), now())`).join(',\n');
const epilogue = `
-- This is the only top-level INSERT: migration bookkeeping, never business rows.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements, hash, applied_by, applied_at)
VALUES ${ledgerValues};
DO $core_postflight$
BEGIN
  IF has_function_privilege('service_role', 'public.fulfill_payment_order_atomic(text,text,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_LEGACY_PAYMENT_RPC_STILL_EXECUTABLE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.apply_wallet_operation_atomic(text,text,text,numeric,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fulfill_payment_order_with_evidence_atomic(text,text,text,text,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_REQUIRED_PAYMENT_RPC_NOT_EXECUTABLE';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.wallet_operations', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.wallet_ledger_entries', 'SELECT') THEN
    RAISE EXCEPTION 'CORE_MIGRATION_WALLET_READINESS_PRIVILEGE_MISSING';
  END IF;
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text IN (${versions})) <> 7 THEN
    RAISE EXCEPTION 'CORE_MIGRATION_LEDGER_COUNT_MISMATCH';
  END IF;
END;
$core_postflight$;
NOTIFY pgrst, 'reload schema';
COMMIT;
`;
const bundle = prelude + body + epilogue;
const bundleStatements = splitStatements(bundle).map(withoutLeadingComments).filter(Boolean);
assert.equal(bundleStatements.filter(statement => /^BEGIN\s*;$/iu.test(statement)).length, 1);
assert.equal(bundleStatements.filter(statement => /^COMMIT\s*;$/iu.test(statement)).length, 1);
assert.equal(bundleStatements.filter(statement => /^INSERT\b/iu.test(statement)).length, 1);
assert.equal(bundleStatements.filter(statement => /^UPDATE\b/iu.test(statement)).length, 0);
assert.ok(bundle.indexOf('REVOKE EXECUTE ON FUNCTION public.fulfill_payment_order_atomic(text, text, numeric)\n  FROM PUBLIC, anon, authenticated, service_role') > bundle.indexOf('GRANT EXECUTE ON FUNCTION public.fulfill_payment_order_atomic'));

const preflight = `-- Read-only metadata. Run through the selected legitimate DB management connection.
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database_name, current_user AS management_role, version() AS server_version;
SELECT rolname, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname IN (current_user,'anon','authenticated','service_role');
SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, numeric_precision, numeric_scale, column_default
FROM information_schema.columns
WHERE (table_schema='public' AND table_name IN ('users','credit_transactions','cash_transactions','payment_orders','user_files','video_tasks','autodl_h3_settlements'))
   OR (table_schema='supabase_migrations' AND table_name='schema_migrations')
ORDER BY table_schema, table_name, ordinal_position;
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments, md5(pg_get_functiondef(p.oid)) AS definition_md5, p.prosecdef, p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname=ANY(${functionsArray}) ORDER BY p.proname;
SELECT conrelid::regclass::text AS table_name, conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid IN ('public.users'::regclass,'public.credit_transactions'::regclass,'public.cash_transactions'::regclass,'public.payment_orders'::regclass,'public.user_files'::regclass,'public.video_tasks'::regclass) ORDER BY table_name, conname;
SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('payment_orders','video_tasks') ORDER BY tablename,indexname;
SELECT count(*) AS users_with_non_uuid_compatible_id FROM public.users WHERE id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
-- If schema_migrations exists, separately SELECT version,name,hash for these versions:
-- ${entries.map(entry => entry.version).join(', ')}
-- Fresh-only bundle rejects any existing target table/function/version/new column.
-- If this guard fails, inspect exact deployed hashes, duplicates and CHECK validity;
-- do not delete rows or drop objects to make the guard pass.
ROLLBACK;
`;

const outputArg = process.argv.find(argument => argument.startsWith('--output='));
const output = path.resolve(root, outputArg ? outputArg.slice('--output='.length) : `.codex-evidence/core-migration-20260902/bundle-${manifestSha256.slice(0, 12)}`);
const evidenceRoot = `${path.join(root, '.codex-evidence')}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot), 'Output must remain under .codex-evidence');
assert.ok(!fs.existsSync(output), 'Output already exists; do not overwrite a reviewed package');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(output, 'sources'));
for (const entry of entries) fs.copyFileSync(path.join(root, entry.relativePath), path.join(output, 'sources', entry.name), fs.constants.COPYFILE_EXCL);
const manifest = { ...core, manifestSha256, bundleSha256: sha256(bundle), bundleBytes: Buffer.byteLength(bundle), generatedAt: new Date().toISOString(), executionStatus: 'NOT_EXECUTED', requiredAuthorization: ['exact connection host and database identity', 'verified recoverable database backup reference', 'reviewed manifest and bundle SHA256', 'isolated PostgreSQL fixture pass', 'one connection, one request, one transaction'] };
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(output, 'apply-all.sql'), bundle, { flag: 'wx' });
fs.writeFileSync(path.join(output, 'read-only-preflight.sql'), preflight, { flag: 'wx' });
console.log(JSON.stringify({ output: path.relative(root, output).replaceAll('\\', '/'), migrationCount: entries.length, tableCount: newTables.length, functionCount: functions.length, manifestSha256, bundleSha256: manifest.bundleSha256, bundleBytes: manifest.bundleBytes, localOnly: true, sqlExecuted: false }, null, 2));
