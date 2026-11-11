#!/usr/bin/env node
// Fixed local 145 only. No dependency expansion, provider request or business RPC.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TARGET, DEFERRED, stable, digest, controlledConnection, capture, safeSnapshot, verifyCanonicalBackup } from './native-agent-local-migration.mjs';
import { bytes, parseArguments, sourceManifest as originalManifest } from './publishing-studio-local-migration.mjs';

export { ROOT, TARGET, parseArguments };
export const CANDIDATE = Object.freeze({ version: '20261110144500', name: '20261110144500_publish_cash_admission.sql', slug: 'publish_cash_admission', sha256: 'fb27f5ee2a12a18834050ca56395ed072e181e9cd05a501e2e826857163cc31d' });
const SELF = fileURLToPath(import.meta.url);
const REVIEW = path.join(ROOT, 'scripts/manifests/publishing-cash-145-reviewed.json');
export const REVIEW_SHA = '37cac88c16a059c09a10e3f4c3b0558b8659d0507877f00f79032a2657bb824c';
const RUNTIME = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const FINGERPRINT = 'f182534099e8496efcf791f5ff09470500b0d3d320ad801992056f183a32ca35';
const REMAIN = [...DEFERRED, '20261110150000'].sort();
const SHA = /^[a-f0-9]{64}$/u;
const fail = code => { throw Object.assign(new Error(code), { localMigrationCode: code }); };
const BEFORE = ['20261110143000', '20261110143100'];
const OLD = new Set(['pub2_assert_input_shape', 'mutate_publish_v2_atomic', 'pub3_assert_input', 'mutate_publish_v3_media_v1_atomic', 'mutate_native_official_atomic', 'pub5_history_guard', 'native_release_unissued_quota_on_blocked']);
const identity = fn => { const { definition_hash, body_hash, ...rest } = fn; void definition_hash; void body_hash; return rest; };
export async function moneyFingerprint(db) {
  const result = await db.query("SELECT encode(sha256(convert_to(jsonb_build_object('users',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'cash',cash_balance,'credits',credits) ORDER BY id),'[]') FROM public.users),'wallet',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') FROM public.wallet_operations w),'cash',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.cash_transactions c))::text,'UTF8')),'hex') AS sha256");
  if (!SHA.test(result.rows[0]?.sha256 ?? '')) fail('CASH_SNAPSHOT_UNAVAILABLE');
  return result.rows[0].sha256;
}
export function sourceManifest(io = fs) {
  if (!SHA.test(CANDIDATE.sha256) || !SHA.test(REVIEW_SHA)) fail('CASH_REVIEW_NOT_PINNED');
  const original = originalManifest(io), sql = bytes(path.join(ROOT, 'supabase/migrations', CANDIDATE.name), io), reviewed = bytes(REVIEW, io);
  if (digest(sql) !== CANDIDATE.sha256 || digest(reviewed) !== REVIEW_SHA) fail('CASH_SOURCE_CHANGED');
  const review = JSON.parse(reviewed);
  if (review.kind !== 'publishing-cash-145-review.v1' || review.candidateSha256 !== CANDIDATE.sha256 || !SHA.test(review.beforeSemanticSha256) || !SHA.test(review.afterSemanticSha256) || review.targetFingerprint !== FINGERPRINT) fail('CASH_REVIEW_INVALID');
  const rollback = 'supabase/rollbacks/20261110144500_publish_cash_admission.rollback.sql';
  const value = { kind: 'publishing-cash-145-manifest.v1', candidate: CANDIDATE, target: TARGET, targetFingerprint: FINGERPRINT, toolSha256: digest(bytes(SELF, io)), reviewSha256: REVIEW_SHA, review, originalManifestSha256: original.manifestSha256, helpers: original.helpers, migrations: original.migrations, rollback: { file: rollback, sha256: digest(bytes(path.join(ROOT, rollback), io)) }, remainPending: REMAIN, executeCount: 1 };
  return { ...value, manifestSha256: digest(stable(value)) };
}
export function reviewedSql(io = fs) {
  const sql = bytes(path.join(ROOT, 'supabase/migrations', CANDIDATE.name), io);
  if (digest(sql) !== CANDIDATE.sha256) fail('CASH_CANDIDATE_CHANGED');
  const text = sql.toString('utf8');
  if (text.includes('PUBLISH_CASH_CANDIDATE_INCOMPLETE_DO_NOT_APPLY') || !/^(?:--[^\n]*\r?\n)*BEGIN;\r?\n/u.test(text) || !/\r?\nCOMMIT;\s*$/u.test(text)) fail('CASH_CANDIDATE_NOT_EXECUTABLE');
  return text.replace(/^((?:--[^\n]*\r?\n)*)BEGIN;\r?\n/u, '$1').replace(/\r?\nCOMMIT;\s*$/u, '\n');
}
export function validateBefore(observed, manifest) {
  if (observed.target.fingerprint !== FINGERPRINT || observed.semantic.sha256 !== manifest.review.beforeSemanticSha256) fail('CASH_BASELINE_CHANGED');
  if (new Set(observed.ledger.map(row => row.version)).size !== observed.ledger.length || BEFORE.some(v => observed.ledger.filter(row => row.version === v).length !== 1)) fail('CASH_PREREQUISITE_LEDGER_INVALID');
  for (const row of observed.ledger) if (manifest.migrations.find(item => item.version === row.version)?.sha256 !== row.hash) fail('CASH_APPLIED_SOURCE_CHANGED');
  const pending = manifest.migrations.filter(item => !observed.ledger.some(row => row.version === item.version)).map(item => item.version).sort();
  if (stable(pending) !== stable([...REMAIN, CANDIDATE.version].sort())) fail('CASH_PENDING_SCOPE_CHANGED');
  for (const name of OLD) if (observed.functions.filter(fn => fn.name === name && fn.owner === 'zimeiti_owner').length !== 1) fail('CASH_FORWARD_FUNCTION_INVALID');
  return { pending };
}
export function validateAfter(before, after, manifest) {
  if (after.target.fingerprint !== FINGERPRINT || after.semantic.sha256 !== manifest.review.afterSemanticSha256) fail('CASH_POST_CATALOG_MISMATCH');
  const entries = after.ledger.filter(row => row.version === CANDIDATE.version);
  if (entries.length !== 1 || entries[0].hash !== CANDIDATE.sha256 || entries[0].name !== CANDIDATE.slug || stable(after.ledger.filter(row => row.version !== CANDIDATE.version)) !== stable(before.ledger)) fail('CASH_POST_LEDGER_MISMATCH');
  for (const old of before.functions) {
    const next = after.functions.find(fn => fn.name === old.name && fn.arguments === old.arguments);
    if (!next || stable(OLD.has(old.name) ? identity(old) : old) !== stable(OLD.has(old.name) ? identity(next) : next)) fail('CASH_EXISTING_FUNCTION_SECURITY_CHANGED');
  }
  return { executeCount: 1, ledgerInsertedCount: 1, catalogSha256: after.semantic.sha256, pendingUnchanged: REMAIN };
}
async function connect(readOnly, dependencies = {}) {
  if (dependencies.connect) return dependencies.connect(readOnly);
  if (Object.keys(process.env).some(key => /^PG/iu.test(key))) fail('AMBIENT_PG_ENVIRONMENT_FORBIDDEN');
  const configuration = controlledConnection(JSON.parse(bytes(RUNTIME).toString('utf8').replace(/^\uFEFF/u, '')));
  const { default: pg } = await import('pg');
  const db = new pg.Client({ ...configuration, ssl: false, application_name: 'publishing-fixed-145-local', connectionTimeoutMillis: 10000, query_timeout: 120000, statement_timeout: 120000, options: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c lock_timeout=10000` });
  await db.connect(); return db;
}
export async function plan(dependencies = {}) {
  const manifest = sourceManifest(dependencies.fs ?? fs), db = await connect(true, dependencies); let open = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const observed = await capture(db), facts = validateBefore(observed, manifest), before = safeSnapshot(observed);
    return { kind: 'publishing-cash-145-plan.v1', createdAt: new Date().toISOString(), manifest, beforeSnapshot: before, beforeSnapshotSha256: digest(stable(before)), moneySha256: await moneyFingerprint(db), facts, databaseWrites: 0, migrationApplied: false, approvalReady: false };
  } finally { if (open) await db.query('ROLLBACK').catch(() => {}); await db.end(); }
}
export function validateConfirmations(options, reviewed, planBytes, manifest) {
  if (!['apply', 'reconcile'].includes(options.mode) || options.mode === 'apply' && options.execute !== true) fail('EXPLICIT_CASH_APPLY_REQUIRED');
  if (digest(planBytes) !== options['confirm-plan-sha256'] || reviewed.kind !== 'publishing-cash-145-plan.v1' || reviewed.databaseWrites !== 0 || reviewed.migrationApplied !== false) fail('EXACT_CASH_PLAN_REQUIRED');
  if (stable(reviewed.manifest) !== stable(manifest) || options['confirm-manifest-sha256'] !== manifest.manifestSha256 || options['confirm-tool-sha256'] !== manifest.toolSha256 || options['confirm-candidate-sha256'] !== CANDIDATE.sha256) fail('CASH_SOURCE_CONFIRMATION_MISMATCH');
  if (digest(stable(reviewed.beforeSnapshot)) !== reviewed.beforeSnapshotSha256 || options['confirm-target-fingerprint'] !== FINGERPRINT || !SHA.test(reviewed.moneySha256)) fail('CASH_TARGET_OR_SNAPSHOT_MISMATCH');
  validateBefore(reviewed.beforeSnapshot, manifest);
  const age = Date.now() - Date.parse(reviewed.createdAt);
  if (!Number.isFinite(age) || age < 0 || options.mode === 'apply' && age > 3600000) fail('CASH_PLAN_EXPIRED');
  if (options.mode === 'apply' && !/^[A-Za-z0-9_.:-]{1,120}$/u.test(options.actor ?? '')) fail('ACTOR_REQUIRED');
}
export function verifyBackup(options, reviewed, io = fs) {
  const verified = verifyCanonicalBackup(options, FINGERPRINT, io), receipt = JSON.parse(bytes(options['confirm-backup'], io));
  const applied = Math.max(...reviewed.beforeSnapshot.ledger.filter(row => BEFORE.includes(row.version)).map(row => Date.parse(row.applied_at)));
  if (!(Date.parse(receipt.createdAt) > applied)) fail('POST_143100_BACKUP_REQUIRED');
  return verified;
}
export async function apply(options, dependencies = {}) {
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), planBytes = bytes(options.plan, io), reviewed = JSON.parse(planBytes);
  validateConfirmations(options, reviewed, planBytes, manifest); verifyBackup(options, reviewed, io);
  const db = await connect(false, dependencies); let open = false, commitAttempted = false, committed = false, stage = 'begin';
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); open = true;
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', ['260830500011']);
    await db.query('LOCK TABLE supabase_migrations.schema_migrations,public.users,public.wallet_operations,public.cash_transactions IN SHARE ROW EXCLUSIVE MODE');
    stage = 'revalidate'; const before = await capture(db); validateBefore(before, manifest);
    if (digest(stable(safeSnapshot(before))) !== reviewed.beforeSnapshotSha256 || await moneyFingerprint(db) !== reviewed.moneySha256) fail('CASH_LIVE_BASELINE_CHANGED');
    if (sourceManifest(io).manifestSha256 !== manifest.manifestSha256) fail('CASH_SOURCE_CHANGED');
    verifyBackup(options, reviewed, io);
    stage = 'single-145'; await db.query(reviewedSql(io));
    stage = 'atomic-ledger'; const inserted = await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(version) DO NOTHING RETURNING version', [CANDIDATE.version, CANDIDATE.slug, [CANDIDATE.name], CANDIDATE.sha256, `${options.actor}:publishing-cash-145`]);
    if (inserted.rowCount !== 1) fail('CASH_LEDGER_CONFLICT');
    stage = 'postcheck'; const after = await capture(db), checked = validateAfter(before, after, manifest);
    if (await moneyFingerprint(db) !== reviewed.moneySha256) fail('CASH_BALANCE_OR_LEDGER_MUTATED');
    stage = 'schema-cache-notify'; await db.query("NOTIFY pgrst, 'reload schema'");
    stage = 'commit'; commitAttempted = true; await db.query('COMMIT'); open = false; committed = true;
    stage = 'readback'; const persisted = await capture(db); validateAfter(before, persisted, manifest);
    return { kind: 'publishing-cash-145-apply.v1', migrationApplied: true, commitConfirmed: true, manifestSha256: manifest.manifestSha256, planSha256: digest(planBytes), targetFingerprint: FINGERPRINT, ...checked, notifyCount: 1, cashMutations: 0, externalCalls: 0, automaticRetry: false };
  } catch (error) {
    let rolledBack = false; if (open && !commitAttempted) try { await db.query('ROLLBACK'); rolledBack = true; } catch {}
    throw Object.assign(new Error(error.localMigrationCode ?? 'CASH_OPERATION_UNCONFIRMED'), { localMigrationCode: error.localMigrationCode ?? 'CASH_OPERATION_UNCONFIRMED', stage, commitState: committed ? 'committed-readback-unconfirmed' : commitAttempted || open && !rolledBack ? 'unknown-do-not-retry' : 'not-committed', automaticRetry: false });
  } finally { await db.end().catch(() => {}); }
}
export async function reconcile(options, dependencies = {}) {
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), planBytes = bytes(options.plan, io), reviewed = JSON.parse(planBytes);
  validateConfirmations(options, reviewed, planBytes, manifest);
  const db = await connect(true, dependencies); let open = false; const result = { kind: 'publishing-cash-145-readback.v1', databaseWrites: 0, automaticRetry: false };
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const observed = await capture(db);
    if (digest(stable(safeSnapshot(observed))) === reviewed.beforeSnapshotSha256) return { ...result, classification: 'not-applied', migrationApplied: false };
    return { ...result, ...validateAfter(reviewed.beforeSnapshot, observed, manifest), classification: 'installed-reviewed-catalog-and-ledger', migrationApplied: true, notifyCount: 1 };
  } catch (error) { return { ...result, classification: 'indeterminate', migrationApplied: null, code: error.localMigrationCode ?? 'CASH_READBACK_UNCONFIRMED' }; }
  finally { if (open) await db.query('ROLLBACK').catch(() => {}); await db.end().catch(() => {}); }
}
export async function main(argv = process.argv.slice(2)) { const options = parseArguments(argv); return ['catalog', 'plan'].includes(options.mode) ? plan() : options.mode === 'apply' ? apply(options) : reconcile(options); }
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error.localMigrationCode ?? 'CASH_UNCONFIRMED', stage: error.stage ?? 'preflight', commitState: error.commitState ?? 'not-started', automaticRetry: false })); process.exitCode = 1; }
}
