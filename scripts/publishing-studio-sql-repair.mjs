#!/usr/bin/env node
// Applies only the reviewed single-function alias repair, after migration 143.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TARGET, DEFERRED, stable, digest, controlledConnection, capture, safeSnapshot, verifyCanonicalBackup } from './native-agent-local-migration.mjs';
import { bytes, parseArguments, sourceManifest as originalManifest } from './publishing-studio-local-migration.mjs';
import { compareSemanticSnapshots } from './lib/database-semantic-catalog.mjs';

export { ROOT, TARGET, stable, digest, parseArguments };
export const CANDIDATE = Object.freeze({ version: '20261110143100', name: '20261110143100_native_generic_sql_alias_fix.sql', slug: 'native_generic_sql_alias_fix', sha256: '37965f6b1c3c652417b43c5122a729784b4595da4987fcb539ef732fe4e715d9' });
export const BODY = Object.freeze({ before: '0b3138dee10ac03d0722792fe39a78dffe40aeb456d00f7b476f524e457e97fb', after: '9e806de0296954e9d0ec9328c823c58a922e8a6bfc913630adef55b0b160b459' });
const SELF = fileURLToPath(import.meta.url), FUNCTION = 'mutate_native_official_atomic', KEY = 'public|mutate_native_official_atomic|p_user_id text, p_input jsonb';
const ORIGINAL = { version: '20261110143000', sha256: '1fd025437403f71763878a0ba17109fa2c35bb3d341a0ba8a99b98dcc986e544' };
const RUNTIME = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const REMAIN = [...DEFERRED, '20261110150000'].sort(), SHA = /^[a-f0-9]{64}$/u;
const fail = code => { throw Object.assign(new Error(code), { localMigrationCode: code }); };
const identity = fn => { const { definition_hash, body_hash, ...rest } = fn; void definition_hash; void body_hash; return rest; };
const one = values => { const found = values.filter(x => x.name === FUNCTION); if (found.length !== 1) fail('REPAIR_FUNCTION_MISSING_OR_OVERLOADED'); return found[0]; };

export function sourceManifest(io = fs) {
  const original = originalManifest(io);
  if (original.toolSha256 !== 'e09903029c261efc3b551266fd0f71fa1ed56c7645c98d50c8ba232e845a2a02') fail('ORIGINAL_TOOL_CHANGED');
  const candidate = original.migrations.filter(item => item.version === CANDIDATE.version);
  if (candidate.length !== 1 || candidate[0].name !== CANDIDATE.name || candidate[0].sha256 !== CANDIDATE.sha256) fail('REPAIR_CANDIDATE_CHANGED');
  const rollback = 'supabase/rollbacks/20261110143100_native_generic_sql_alias_fix.rollback.sql';
  const value = { kind: 'publishing-studio-143100-manifest.v1', candidate: CANDIDATE, originalMigration: ORIGINAL, target: TARGET, functionBody: BODY, executeCount: 1, toolSha256: digest(bytes(SELF, io)), originalManifestSha256: original.manifestSha256, helpers: original.helpers, migrations: original.migrations, rollback: { file: rollback, sha256: digest(bytes(path.join(ROOT, rollback), io)) }, remainPending: REMAIN };
  return { ...value, manifestSha256: digest(stable(value)) };
}
export function validateBefore(observed, manifest) {
  const prerequisite = observed.ledger.filter(row => row.version === ORIGINAL.version);
  if (prerequisite.length !== 1 || prerequisite[0].hash !== ORIGINAL.sha256 || !Number.isFinite(Date.parse(prerequisite[0].applied_at))) fail('APPLIED_143_REQUIRED');
  if (observed.ledger.some(row => row.version === CANDIDATE.version)) fail('REPAIR_ALREADY_PRESENT_USE_READBACK');
  if (new Set(observed.ledger.map(row => row.version)).size !== observed.ledger.length) fail('LEDGER_DUPLICATE');
  for (const row of observed.ledger) if (manifest.migrations.find(item => item.version === row.version)?.sha256 !== row.hash) fail('APPLIED_SOURCE_HASH_DRIFT');
  const pending = manifest.migrations.filter(item => !observed.ledger.some(row => row.version === item.version)).map(item => item.version).sort();
  if (stable(pending) !== stable([...REMAIN, CANDIDATE.version].sort())) fail('REPAIR_PENDING_SCOPE_CHANGED');
  const fn = one(observed.functions);
  if (fn.body_hash !== BODY.before || fn.owner !== 'zimeiti_owner' || fn.arguments !== 'p_user_id text, p_input jsonb' || fn.security_definer !== true || fn.language !== 'plpgsql' || fn.return_type !== 'jsonb' || stable(fn.proconfig) !== stable(['search_path=public, pg_temp']) || fn.grants.some(g => g.grantee !== 'zimeiti_owner' && (g.grantee !== 'service_role' || g.privilege !== 'EXECUTE' || g.grantable))) fail('REPAIR_FUNCTION_BASELINE_INVALID');
  return { prerequisiteAppliedAt: prerequisite[0].applied_at, pending };
}
export function reviewedSql(io = fs) {
  const sql = bytes(path.join(ROOT, 'supabase/migrations', CANDIDATE.name), io);
  if (digest(sql) !== CANDIDATE.sha256) fail('REPAIR_CANDIDATE_CHANGED');
  const text = sql.toString('utf8');
  if (!/^(?:--[^\n]*\r?\n)*BEGIN;\r?\n/u.test(text) || !/\r?\nCOMMIT;\s*$/u.test(text)) fail('REPAIR_OUTER_TRANSACTION_CHANGED');
  return text.replace(/^((?:--[^\n]*\r?\n)*)BEGIN;\r?\n/u, '$1').replace(/\r?\nCOMMIT;\s*$/u, '\n');
}
async function connect(readOnly, dependencies = {}) {
  if (dependencies.connect) return dependencies.connect(readOnly);
  if (Object.keys(process.env).some(key => /^PG/iu.test(key))) fail('AMBIENT_PG_ENVIRONMENT_FORBIDDEN');
  const configuration = controlledConnection(JSON.parse(bytes(RUNTIME).toString('utf8').replace(/^\uFEFF/u, '')));
  const { default: pg } = await import('pg');
  const db = new pg.Client({ ...configuration, ssl: false, application_name: 'publishing-studio-143100-local', connectionTimeoutMillis: 10000, query_timeout: 120000, statement_timeout: 120000, options: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c lock_timeout=10000` });
  await db.connect(); return db;
}
export async function plan(dependencies = {}) {
  const manifest = sourceManifest(dependencies.fs ?? fs), db = await connect(true, dependencies); let open = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const observed = await capture(db), facts = validateBefore(observed, manifest), before = safeSnapshot(observed);
    return { kind: 'publishing-studio-143100-plan.v1', createdAt: new Date().toISOString(), manifest, beforeSnapshot: before, beforeSnapshotSha256: digest(stable(before)), facts, databaseWrites: 0, migrationApplied: false, approvalReady: false, requiresPost143BackupAndIsolatedRestore: true, businessReady: false };
  } finally { if (open) await db.query('ROLLBACK').catch(() => {}); await db.end(); }
}
export function validateConfirmations(options, reviewed, planBytes, manifest) {
  if (!['apply', 'reconcile'].includes(options.mode) || options.mode === 'apply' && options.execute !== true) fail('EXPLICIT_REPAIR_APPLY_REQUIRED');
  if (digest(planBytes) !== options['confirm-plan-sha256'] || reviewed.kind !== 'publishing-studio-143100-plan.v1' || reviewed.databaseWrites !== 0 || reviewed.migrationApplied !== false) fail('EXACT_REPAIR_PLAN_REQUIRED');
  if (stable(reviewed.manifest) !== stable(manifest) || options['confirm-manifest-sha256'] !== manifest.manifestSha256 || options['confirm-tool-sha256'] !== manifest.toolSha256 || options['confirm-candidate-sha256'] !== CANDIDATE.sha256) fail('REPAIR_SOURCE_CONFIRMATION_MISMATCH');
  if (digest(stable(reviewed.beforeSnapshot)) !== reviewed.beforeSnapshotSha256 || !SHA.test(options['confirm-target-fingerprint'] ?? '') || options['confirm-target-fingerprint'] !== reviewed.beforeSnapshot?.target?.fingerprint) fail('REPAIR_TARGET_OR_SNAPSHOT_MISMATCH');
  validateBefore(reviewed.beforeSnapshot, manifest);
  const age = Date.now() - Date.parse(reviewed.createdAt);
  if (!Number.isFinite(age) || age < 0 || options.mode === 'apply' && age > 3600000) fail('REPAIR_PLAN_EXPIRED');
  if (options.mode === 'apply' && !/^[A-Za-z0-9_.:-]{1,120}$/u.test(options.actor ?? '')) fail('ACTOR_REQUIRED');
}
export function verifyPost143Backup(options, reviewed, io = fs) {
  const verified = verifyCanonicalBackup(options, reviewed.beforeSnapshot.target.fingerprint, io);
  const receipt = JSON.parse(bytes(options['confirm-backup'], io).toString('utf8'));
  const prerequisite = reviewed.beforeSnapshot.ledger.find(row => row.version === ORIGINAL.version);
  if (!prerequisite || Date.parse(receipt.createdAt) <= Date.parse(prerequisite.applied_at)) fail('NEW_POST_143_BACKUP_REQUIRED');
  return verified;
}
export function validateAfter(before, after, manifest) {
  if (before.target.fingerprint !== after.target.fingerprint) fail('REPAIR_POST_TARGET_CHANGED');
  const inserted = after.ledger.filter(row => row.version === CANDIDATE.version);
  if (inserted.length !== 1 || inserted[0].hash !== CANDIDATE.sha256 || inserted[0].name !== CANDIDATE.slug || stable(after.ledger.filter(row => row.version !== CANDIDATE.version)) !== stable(before.ledger)) fail('REPAIR_LEDGER_SCOPE_CHANGED');
  if (stable(before.owners) !== stable(after.owners)) fail('REPAIR_TABLE_SECURITY_CHANGED');
  const original = one(before.functions), changed = one(after.functions);
  if (original.body_hash !== BODY.before || changed.body_hash !== BODY.after || stable(identity(original)) !== stable(identity(changed))) fail('REPAIR_FUNCTION_IDENTITY_OR_BODY_CHANGED');
  if (stable(before.functions.filter(fn => fn.name !== FUNCTION)) !== stable(after.functions.filter(fn => fn.name !== FUNCTION))) fail('REPAIR_UNRELATED_FUNCTION_CHANGED');
  const differences = compareSemanticSnapshots(before.semantic, after.semantic, { strictExtras: true }).differences;
  if (differences.length !== 1 || differences[0].section !== 'functions' || differences[0].key !== KEY || differences[0].kind !== 'changed') fail('REPAIR_UNRELATED_CATALOG_CHANGED');
  const pending = manifest.migrations.filter(item => !after.ledger.some(row => row.version === item.version)).map(item => item.version).sort();
  if (stable(pending) !== stable(REMAIN)) fail('REPAIR_DEFERRED_SCOPE_CHANGED');
  return { executeCount: 1, ledgerInsertedCount: 1, functionBodySha256: changed.body_hash, catalogSha256: after.semantic.sha256, catalogChangedObjects: differences, pendingUnchanged: REMAIN };
}
export async function apply(options, dependencies = {}) {
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), planBytes = bytes(options.plan, io), reviewed = JSON.parse(planBytes);
  validateConfirmations(options, reviewed, planBytes, manifest); verifyPost143Backup(options, reviewed, io);
  const db = await connect(false, dependencies); let open = false, commitAttempted = false, committed = false, stage = 'begin';
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); open = true;
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', ['260830500011']);
    await db.query('LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE');
    stage = 'revalidate'; const before = await capture(db); validateBefore(before, manifest);
    if (digest(stable(safeSnapshot(before))) !== reviewed.beforeSnapshotSha256) fail('REPAIR_LIVE_CATALOG_OR_LEDGER_DRIFT');
    if (sourceManifest(io).manifestSha256 !== manifest.manifestSha256) fail('REPAIR_SOURCE_CHANGED');
    verifyPost143Backup(options, reviewed, io);
    stage = 'single-function-repair'; await db.query(reviewedSql(io));
    stage = 'atomic-ledger'; const inserted = await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(version) DO NOTHING RETURNING version', [CANDIDATE.version, CANDIDATE.slug, [CANDIDATE.name], CANDIDATE.sha256, options.actor + ':publishing-studio-143100']);
    if (inserted.rowCount !== 1) fail('REPAIR_LEDGER_CONFLICT');
    stage = 'postcheck'; const after = await capture(db), checked = validateAfter(before, after, manifest);
    stage = 'commit'; commitAttempted = true; await db.query('COMMIT'); open = false; committed = true;
    stage = 'readback'; const persisted = await capture(db); validateAfter(before, persisted, manifest);
    if (persisted.semantic.sha256 !== after.semantic.sha256) fail('REPAIR_COMMITTED_READBACK_CHANGED');
    return { kind: 'publishing-studio-143100-apply.v1', migrationApplied: true, commitConfirmed: true, manifestSha256: manifest.manifestSha256, planSha256: digest(planBytes), targetFingerprint: before.target.fingerprint, ...checked, cashMutations: 0, externalCalls: 0, automaticRetry: false, businessReady: false };
  } catch (error) {
    let rolledBack = false; if (open && !commitAttempted) try { await db.query('ROLLBACK'); rolledBack = true; } catch {}
    throw Object.assign(new Error(error.localMigrationCode ?? 'REPAIR_OPERATION_UNCONFIRMED'), { localMigrationCode: error.localMigrationCode ?? 'REPAIR_OPERATION_UNCONFIRMED', stage, commitState: committed ? 'committed-readback-unconfirmed' : commitAttempted || open && !rolledBack ? 'unknown-do-not-retry' : 'not-committed', automaticRetry: false });
  } finally { await db.end().catch(() => {}); }
}
export async function reconcile(options, dependencies = {}) {
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), planBytes = bytes(options.plan, io), reviewed = JSON.parse(planBytes);
  validateConfirmations(options, reviewed, planBytes, manifest);
  const db = await connect(true, dependencies); let open = false;
  const result = { kind: 'publishing-studio-143100-readback.v1', databaseWrites: 0, automaticRetry: false };
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const observed = await capture(db);
    if (digest(stable(safeSnapshot(observed))) === reviewed.beforeSnapshotSha256) return { ...result, classification: 'not-applied', migrationApplied: false };
    const checked = validateAfter(reviewed.beforeSnapshot, observed, manifest);
    return { ...result, ...checked, classification: 'installed-exact-function-and-ledger', migrationApplied: true };
  } catch (error) { return { ...result, classification: 'indeterminate', migrationApplied: null, code: error.localMigrationCode ?? 'REPAIR_READBACK_UNCONFIRMED' }; }
  finally { if (open) await db.query('ROLLBACK').catch(() => {}); await db.end().catch(() => {}); }
}
export async function main(argv = process.argv.slice(2)) { const options = parseArguments(argv); return ['catalog', 'plan'].includes(options.mode) ? plan() : options.mode === 'apply' ? apply(options) : reconcile(options); }
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error.localMigrationCode ?? 'REPAIR_UNCONFIRMED', stage: error.stage ?? 'preflight', commitState: error.commitState ?? 'not-started', automaticRetry: false })); process.exitCode = 1; }
}
