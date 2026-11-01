#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { tsImport } from 'tsx/esm/api';
import { readDatabaseTargetIdentity } from './lib/database-target-identity.mjs';
import { DATABASE_SEMANTIC_PROFILE, readSemanticRows, semanticSnapshotFromRows, compareSemanticSnapshots, normalizeSemanticRow, objectKey, DATABASE_SEMANTIC_SECTIONS, stableJson, sha256 } from './lib/database-semantic-catalog.mjs';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';
import { assertPaidDatabaseReadiness, assertPaidCanonicalFunctionSources, readPaidDatabaseReadiness } from './verify-image-workbench-live-e2e.mjs';

const ROOT = process.cwd();
const FINGERPRINT = 'f182534099e8496efcf791f5ff09470500b0d3d320ad801992056f183a32ca35';
const CONSUMER = 'scripts/verify-image-workbench-live-e2e.mjs';
const DEFAULT_BASELINE = '.codex-evidence/remaining-local-20261025-c239d0c9/readiness-audit/runs/20261026T053951244Z/actual-A-semantic.json';
const fail = (condition, code) => assert.ok(condition, code);
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const fileHash = async file => sha256(await fs.readFile(file));

export function parseReadinessArgs(args) {
  const result = { finalize: false };
  const values = new Set(['output', 'baseline', 'expected-source-version', 'expected-build-id']);
  for (const arg of args) {
    if (arg === '--finalize') { fail(!result.finalize, 'DUPLICATE_FLAG'); result.finalize = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
    fail(match && values.has(match[1]) && !Object.hasOwn(result, match[1]), 'UNKNOWN_OR_DUPLICATE_ARGUMENT');
    result[match[1]] = match[2];
  }
  fail(result.output, 'UNIQUE_OUTPUT_DIRECTORY_REQUIRED');
  const output = path.resolve(result.output); const allowed = path.resolve(ROOT, '.codex-evidence') + path.sep;
  fail(output.startsWith(allowed), 'OUTPUT_MUST_BE_EVIDENCE_SUBDIRECTORY');
  if (result.finalize) fail(result['expected-source-version'] && result['expected-build-id'], 'FINAL_RUNTIME_PINS_REQUIRED');
  return { ...result, output, baseline: path.resolve(result.baseline || DEFAULT_BASELINE) };
}

export function consumerExpectations(source) {
  const functions = /const PAID_AUTHORITY_FUNCTIONS = (\[[\s\S]*?\n\]);/u.exec(source);
  const pin = /const PAID_SEMANTIC_SHA\s*=\s*['"]([a-f0-9]{64})['"]/u.exec(source);
  fail(functions && pin, 'CANONICAL_CONSUMER_EXPECTATIONS_UNAVAILABLE');
  const entries = JSON.parse(functions[1]);
  fail(entries.length === 7 && new Set(entries.map(row => row.signature)).size === 7, 'SEVEN_UNIQUE_CANONICAL_FUNCTIONS_REQUIRED');
  return { functions: entries, semanticSha256: pin[1] };
}

export async function capturePaidAuthority(client, expectations) {
  const roleUniverse = (await client.query('select oid::text, rolname, rolsuper, rolinherit, rolbypassrls from pg_roles order by oid')).rows;
  const functions = [];
  for (const expected of expectations) {
    const metadata = await client.query(`select p.oid::text, pg_get_function_identity_arguments(p.oid) identity_arguments,
      pg_get_function_result(p.oid) result, l.lanname language, p.prokind, p.provolatile, p.proparallel, p.prosecdef, p.proisstrict, p.proleakproof,
      coalesce(p.proconfig,array[]::text[]) proconfig, p.prosrc body,
      p.proowner::text owner_oid, o.rolname owner_name, o.rolsuper owner_superuser,
      t.relowner::text table_owner_oid, pg_get_userbyid(t.relowner) table_owner_name
      from pg_proc p join pg_language l on l.oid=p.prolang join pg_roles o on o.oid=p.proowner
      left join pg_class t on t.oid=to_regclass($2) where p.oid=to_regprocedure($1)`, [expected.signature, expected.ownerEqualsTableOwner]);
    fail(metadata.rows.length === 1, 'CANONICAL_AUTHORITY_FUNCTION_MISSING');
    const { body, oid, ...row } = metadata.rows[0];
    const directAcl = (await client.query(`select a.grantor::text grantor_oid, a.grantee::text grantee_oid,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee_name,
      a.privilege_type, a.is_grantable from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=$1::oid order by a.grantee,a.privilege_type`, [oid])).rows;
    const effective = (await client.query(`select r.oid::text role_oid,r.rolname role_name,
      has_function_privilege(r.oid,$1::oid,'EXECUTE') execute,has_schema_privilege(r.oid,'public','USAGE') public_schema_usage
      from pg_roles r where not r.rolsuper order by r.oid`, [oid])).rows;
    functions.push({ signature: expected.signature, protectedTable: expected.ownerEqualsTableOwner, ...row,
      bodyLfSha256: sha256(String(body).replace(/\r\n/gu, '\n')), ownerMatchesExpectedTable: row.owner_oid === row.table_owner_oid,
      directAcl, effective });
  }
  const serviceSchemaUsage = (await client.query("select has_schema_privilege('service_role','public','USAGE') value")).rows[0]?.value;
  return { roleUniverse, roleUniverseSha256: sha256(JSON.stringify(roleUniverse)), totalRoleCount: roleUniverse.length,
    nonSuperuserRoleCount: roleUniverse.filter(role => !role.rolsuper).length, selectedSignatureCount: functions.length, serviceSchemaUsage, functions };
}

export function fullSemanticReview(before, after, rowsBefore, rowsAfter) {
  const comparison = compareSemanticSnapshots(before, after, { strictExtras: true });
  // Hashes identify all changed objects; full actual rows retain exact metadata,
  // function body digests and ACL details for independent semantic review.
  return { kind: 'local-paid-canary-full-semantic-diff.v1', beforeSemanticSha256: before.sha256, afterSemanticSha256: after.sha256,
    ...comparison, beforeRowsAvailable: !!rowsBefore, afterRowsAvailable: !!rowsAfter, reviewDecision: 'PENDING_INDEPENDENT_REVIEW',
    pinUpdatePerformed: false, databaseWrites: 0, providerCalls: 0 };
}

async function recoverHistoricalFunctionRows(before, after, rows, baselineFile) {
  const baselinePlanFile = path.join(path.dirname(baselineFile), 'source-plan.json');
  const baselinePlan = await readJson(baselinePlanFile);
  fail(baselinePlan.manifestSha256 === before.migrationManifestSha256, 'HISTORICAL_SOURCE_MANIFEST_MISMATCH');
  const section = DATABASE_SEMANTIC_SECTIONS.find(entry => entry.name === 'functions');
  const differences = compareSemanticSnapshots(before.snapshot, after, { strictExtras: true }).differences.filter(entry => entry.section === 'functions');
  const results = [];
  for (const difference of differences) {
    const actual = rows.functions.find(row => objectKey(section, row) === difference.key);
    if (!difference.expectedSha256) { results.push({ ...difference, before: null, after: actual, historicalRowRecovered: true }); continue; }
    const candidates = [];
    for (const migration of baselinePlan.migrations) {
      const sqlFile = path.join(ROOT, 'supabase/migrations', migration.name);
      const bytes = await fs.readFile(sqlFile); fail(sha256(bytes) === migration.sha256, 'HISTORICAL_MIGRATION_SOURCE_CHANGED');
      const escaped = actual?.function_name?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (!escaped) continue;
      const regex = new RegExp('CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?' + escaped + '\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[A-Za-z_0-9]*\\$)([\\s\\S]*?)\\1', 'giu');
      for (const match of bytes.toString('utf8').replace(/\r\n/gu, '\n').matchAll(regex)) {
        const header = match[0].slice(0, match[0].indexOf(match[1]));
        const searchPath = /\bSET\s+search_path\s*(?:=|TO)\s+([^\n]+?)(?=\s+AS\b|\n|$)/iu.exec(header)?.[1]?.trim();
        const pathSetting = searchPath ? `search_path=${searchPath.split(',').map(part => part.trim()).join(', ')}` : null;
        const fromDefinition = { ...actual, source: match[2],
          language_name: /\bLANGUAGE\s+(\w+)/iu.exec(header)?.[1]?.toLowerCase() || actual.language_name,
          provolatile: /\bIMMUTABLE\b/iu.test(header) ? 'i' : /\bSTABLE\b/iu.test(header) ? 's' : 'v',
          proparallel: /\bPARALLEL\s+SAFE\b/iu.test(header) ? 's' : /\bPARALLEL\s+RESTRICTED\b/iu.test(header) ? 'r' : 'u',
          prosecdef: /\bSECURITY\s+DEFINER\b/iu.test(header), proisstrict: /\bSTRICT\b|\bRETURNS\s+NULL\s+ON\s+NULL\s+INPUT\b/iu.test(header),
          proleakproof: /\bLEAKPROOF\b/iu.test(header) && !/\bNOT\s+LEAKPROOF\b/iu.test(header),
          configuration: pathSetting ? `{${JSON.stringify(pathSetting)}}` : '',
        };
        for (const proposed of [{ ...actual, source: match[2] }, fromDefinition]) {
          if (sha256(stableJson(normalizeSemanticRow('functions', proposed))) === difference.expectedSha256) candidates.push({ row: proposed, migration: migration.name, sourceSha256: migration.sha256 });
        }
      }
    }
    const found = candidates.at(-1);
    results.push({ ...difference, before: found?.row || null, after: actual, historicalRowRecovered: !!found, source: found ? { migration: found.migration, sha256: found.sourceSha256 } : null,
      recoveryRule: 'historical canonical migration body and CREATE FUNCTION metadata accepted only when entire normalized row exactly hashes to historical snapshot object' });
  }
  return { baselinePlanSha256: await fileHash(baselinePlanFile), functionDifferences: results, completeForFunctionDifferences: results.every(row => row.historicalRowRecovered), fabricatedValues: false };
}

async function runtimeReadback(origin) {
  const response = await fetch(`${origin}/api/version`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  fail(response.ok, 'VERSION_READ_FAILED'); const served = await response.json();
  const [diskVersion, buildId, receipt] = await Promise.all([readJson('public/version.json'), fs.readFile('.next/BUILD_ID', 'utf8').then(value => value.trim()), readJson('.next/local-source-fingerprint.v1.json')]);
  const source = computeLocalBuildFingerprint(ROOT);
  const runningLatest = served.sourceVersion === diskVersion.sourceVersion && served.buildId === buildId && receipt.buildId === buildId && receipt.fingerprint === source.fingerprint && receipt.fileCount === source.fileCount;
  return { sourceVersion: served.sourceVersion, buildId: served.buildId, diskSourceVersion: diskVersion.sourceVersion,
    diskBuildId: buildId, sourceFingerprint: source.fingerprint, sourceFingerprintCurrent: receipt.fingerprint === source.fingerprint, runningLatest };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseReadinessArgs(args);
  fail(process.env.LOCAL_NAV_ADMIN_TOKEN && process.env.LOCAL_ACCEPTANCE_PREVIEW === 'true', 'CONTROLLED_LOCAL_ADMIN_WRAPPER_REQUIRED');
  const origin = String(process.env.LOCAL_NAV_ORIGIN || ''); fail(origin === 'http://127.0.0.1:5000', 'EXACT_LOCAL_PREVIEW_REQUIRED');
  const dbUrl = new URL(String(process.env.DATABASE_URL || ''));
  fail(dbUrl.hostname === '127.0.0.1' && dbUrl.port === '54322' && dbUrl.pathname === '/zimeiti_local' && !dbUrl.search && !dbUrl.hash, 'EXACT_LOCAL_DATABASE_REQUIRED');
  fail(new URL(String(process.env.COZE_SUPABASE_URL || '')).origin === 'http://127.0.0.1:54321', 'EXACT_LOCAL_REST_REQUIRED');
  const configPath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
  const config = await readJson(configPath); const configurationFileSha256 = await fileHash(configPath);
  fail(config.localOnly === true && config.databaseUrl === process.env.DATABASE_URL && config.supabaseUrl === process.env.COZE_SUPABASE_URL, 'WRAPPER_RUNTIME_CONFIG_MISMATCH');
  const consumerSource = await fs.readFile(CONSUMER, 'utf8'); const expected = consumerExpectations(consumerSource);
  const dependencyFiles = [CONSUMER, 'scripts/prepare-local-paid-canary-readiness.mjs', 'scripts/db-migration-release.mjs', 'scripts/lib/database-semantic-catalog.mjs',
    'scripts/lib/database-target-identity.mjs', 'scripts/verify-release-database-gates.ts', 'src/lib/production-database-readiness.ts', 'src/lib/generated/database-contract.ts',
    'deploy/policies/database-contract.v1.json', 'deploy/policies/release-policy.json'];
  const sourceDependencies = await Promise.all(dependencyFiles.map(async file => ({ path: file, sha256: await fileHash(file) })));
  const beforeSemantic = await readJson(options.baseline);
  fail(beforeSemantic.snapshot?.sha256 && beforeSemantic.contractSha256, 'REAL_HISTORICAL_SEMANTIC_BASELINE_REQUIRED');
  const beforeCore = { ...beforeSemantic }; delete beforeCore.contractSha256;
  fail(sha256(stableJson(beforeCore)) === beforeSemantic.contractSha256 && sha256(stableJson(beforeSemantic.snapshot.sections)) === beforeSemantic.snapshot.sha256, 'HISTORICAL_BASELINE_HASH_INVALID');
  const databaseContract = await readJson('deploy/policies/database-contract.v1.json');
  const releasePolicy = await readJson('deploy/policies/release-policy.json');
  const childEnv = { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' };
  for (const name of releasePolicy.database.migrationDatabaseUrlEnv) delete childEnv[name];
  childEnv[releasePolicy.database.migrationDatabaseUrlEnv[0]] = process.env.DATABASE_URL;
  childEnv.CANARY_READONLY_DATABASE_URL = process.env.DATABASE_URL;
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.mkdir(options.output); // Never overwrite or reuse a previous capture.
  const refs = {};
  const write = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); await fs.writeFile(path.join(options.output, name), bytes, { flag: 'wx' });
    return { path: name, sha256: sha256(bytes) };
  };
  const run = async (name, argv) => {
    const result = spawnSync(process.execPath, argv, { cwd: ROOT, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) { await write(`${name}-failure.json`, { ok: false, status: result.status, code: 'CANONICAL_READONLY_COMMAND_FAILED', stdoutSha256: sha256(result.stdout || ''), stderrSha256: sha256(result.stderr || ''), rawOutputSuppressed: true }); throw new Error(`${name.toUpperCase()}_CANONICAL_READONLY_COMMAND_FAILED`); }
    return JSON.parse(result.stdout);
  };
  let client; let transaction = false;
  try {
    const runtimeBefore = await runtimeReadback(origin);
    const sourcePlan = await run('source-plan', ['scripts/db-migration-release.mjs', 'plan']); refs.sourcePlanEvidence = await write('source-plan.json', sourcePlan);
    const status = await run('status', ['scripts/db-migration-release.mjs', 'status', '--include-applied', '--database-url-env=CANARY_READONLY_DATABASE_URL']); refs.statusEvidence = await write('status.json', status);
    const ledgerReady = status.ok && status.invalid.length === 0 && status.hashDrifts.length === 0 && status.database.pendingCount === 0 && status.migrationCount === sourcePlan.migrations.length;
    if (options.finalize) fail(ledgerReady, 'CURRENT_LEDGER_NOT_FULLY_APPLIED');
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on', application_name: 'codex-paid-canary-readonly-producer', connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    await client.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    fail((await client.query('show transaction_read_only')).rows[0]?.transaction_read_only === 'on', 'READ_ONLY_TRANSACTION_REQUIRED');
    const identity = await readDatabaseTargetIdentity(client, '127.0.0.1'); fail(identity.fingerprint === FINGERPRINT, 'CANONICAL_APPLICATION_DATABASE_IDENTITY_MISMATCH');
    fail(stableJson(identity) === stableJson(status.database.targetIdentity), 'STATUS_DATABASE_IDENTITY_CHANGED');
    const cluster = (await client.query('select system_identifier::text value from pg_control_system()')).rows[0].value;
    const ledger = (await client.query('select version::text,hash::text from supabase_migrations.schema_migrations order by version')).rows;
    const ledgerDifferences = sourcePlan.migrations.filter(migration => !ledger.some(row => row.version === migration.version && row.hash === migration.sha256));
    if (options.finalize) fail(ledgerDifferences.length === 0, 'TRANSACTION_LEDGER_SOURCE_HASH_MISMATCH');
    refs.transactionLedgerEvidence = await write('transaction-ledger.json', { ledger, sourceDifferences: ledgerDifferences, databaseWrites: 0, providerCalls: 0 });
    const rows = await readSemanticRows(client); const snapshot = semanticSnapshotFromRows(rows);
    const authorityData = await capturePaidAuthority(client, expected.functions);
    await client.query('ROLLBACK'); transaction = false; await client.end(); client = null;
    const core = { kind: 'database-semantic-contract', schemaVersion: 1, profile: DATABASE_SEMANTIC_PROFILE, generatedAt: new Date().toISOString(), sourceDatabase: identity.databaseName, migrationManifestSha256: sourcePlan.manifestSha256, snapshot };
    const semantic = { ...core, contractSha256: sha256(stableJson(core)) }; refs.semanticEvidence = await write('semantic.json', semantic);
    refs.fullSemanticRowsEvidence = await write('semantic-rows.json', rows);
    const authority = { ...authorityData, targetFingerprint: identity.fingerprint, targetDatabaseName: identity.databaseName, systemIdentifier: cluster, manifestSha256: sourcePlan.manifestSha256, applied: status.database.appliedCount, pending: status.database.pendingCount, rollbackAcknowledged: true, databaseWrites: 0, providerCalls: 0 };
    refs.authorityEvidence = await write('authority.json', authority);
    refs.historicalBaselineEvidence = await write('historical-baseline.json', beforeSemantic);
    refs.semanticDiffEvidence = await write('semantic-diff.json', fullSemanticReview(beforeSemantic.snapshot, snapshot, null, rows));
    refs.functionSemanticDiffEvidence = await write('function-semantic-diff.json', await recoverHistoricalFunctionRows(beforeSemantic, snapshot, rows, options.baseline));
    const openApiResponse = await fetch('http://127.0.0.1:54321/rest/v1/', { headers: { apikey: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.COZE_SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/openapi+json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    fail(openApiResponse.ok, 'REAL_REST_OPENAPI_READ_FAILED'); const openApi = await openApiResponse.json();
    refs.openApiEvidence = await write('openapi.json', openApi);
    const { validateProductionDatabaseOpenApi } = await tsImport('../src/lib/production-database-readiness.ts', import.meta.url);
    const probe = validateProductionDatabaseOpenApi(openApi); const applicationProbe = { ...probe, state: probe.ok ? 'ready' : 'migration-not-ready' };
    refs.applicationProbeEvidence = await write('application-probe.json', { probe: applicationProbe, databaseWrites: 0, providerCalls: 0 });
    let liveOutput;
    try { liveOutput = await run('live-catalog', ['scripts/run-node-maintenance-tsx.mjs', 'scripts/verify-release-database-gates.ts', '--live', '--confirm-target-host=127.0.0.1', '--confirm-target-database=zimeiti_local']); }
    catch (error) { if (options.finalize) throw error; liveOutput = { ok: false, liveCatalogChecked: false, code: 'CANONICAL_LIVE_CATALOG_REJECTED_AUDIT_ONLY' }; }
    const liveCatalog = { kind: 'application-paid-canary-live-catalog.v1', createdAt: new Date().toISOString(), identity, cluster, manifestSha256: sourcePlan.manifestSha256, runtime: runtimeBefore, databaseWrites: 0, providerCalls: 0, output: liveOutput };
    refs.liveCatalogEvidence = await write('live-catalog.json', liveCatalog);
    await assertPaidCanonicalFunctionSources();
    const runtimeAfter = await runtimeReadback(origin);
    const sourceAfter = await run('source-plan-after', ['scripts/db-migration-release.mjs', 'plan']);
    const dependenciesUnchanged = (await Promise.all(sourceDependencies.map(async ref => await fileHash(ref.path) === ref.sha256))).every(Boolean);
    const captureStable = dependenciesUnchanged && stableJson(runtimeBefore) === stableJson(runtimeAfter) && stableJson(sourceAfter) === stableJson(sourcePlan)
      && await fileHash(configPath) === configurationFileSha256;
    refs.runtimeCaptureEvidence = await write('runtime-capture.json', { runtimeBefore, runtimeAfter, captureStable, sourcePlanBeforeSha256: sha256(stableJson(sourcePlan)), sourcePlanAfterSha256: sha256(stableJson(sourceAfter)), configurationFileSha256, databaseWrites: 0, providerCalls: 0 });
    if (options.finalize) fail(captureStable, 'RUNTIME_OR_SOURCE_CHANGED_DURING_CAPTURE');
    const index = { kind: 'application-paid-canary-database-readiness.v1', schemaVersion: 1, createdAt: new Date().toISOString(), identity, cluster,
      runtime: { ...runtimeAfter, applicationDatabaseFingerprint: identity.fingerprint, configurationFileSha256 }, manifestSha256: sourcePlan.manifestSha256,
      expectedSemanticSha256: snapshot.sha256, ...refs, applicationProbe, databaseWrites: 0, providerCalls: 0 };
    const evidence = { status, semantic, authority, liveCatalog, databaseContract, contractVersion: databaseContract.contractVersion };
    const consumerOptions = { values: { 'expected-database-identity': identity.fingerprint, 'expected-database-target': '127.0.0.1:54322/zimeiti_local', 'expected-source-version': runtimeAfter.sourceVersion, 'expected-build-id': runtimeAfter.buildId } };
    // Structural validation is explicitly separate from the unchanged reviewed pin.
    let structuralValidation = null; let structuralFailure = null;
    try { fail(captureStable, 'CAPTURE_IDENTITY_CHANGED'); structuralValidation = assertPaidDatabaseReadiness(index, evidence, sourcePlan, consumerOptions, runtimeAfter, Date.now(), snapshot.sha256); }
    catch (error) { if (options.finalize) throw error; structuralFailure = /^(?:PAID_DATABASE|CAPTURE)_[A-Z0-9_]+$/u.test(error?.message || '') ? error.message : 'STRUCTURAL_GATE_REJECTED'; }
    const candidateRef = structuralValidation ? await write('readiness-index.candidate.json', index) : null;
    refs.producerReviewEvidence = await write('producer-review.json', { kind: 'local-paid-canary-producer-review.v1', candidate: candidateRef, structuralValidation, structuralFailure, sourceMigrationCount: sourcePlan.migrations.length, applied: status.database.appliedCount, pending: status.database.pendingCount, beforeSemanticSha256: beforeSemantic.snapshot.sha256, afterSemanticSha256: snapshot.sha256, currentConsumerSemanticPin: expected.semanticSha256, consumerPinMatchesActual: expected.semanticSha256 === snapshot.sha256, runningLatest: runtimeAfter.runningLatest, independentSemanticReviewRequired: true, pinUpdatePerformed: false, databaseWrites: 0, providerCalls: 0 });
    if (options.finalize) {
      fail(runtimeAfter.runningLatest && runtimeAfter.sourceVersion === options['expected-source-version'] && runtimeAfter.buildId === options['expected-build-id'], 'FINAL_CURRENT_BUILD_IDENTITY_REQUIRED');
      fail(expected.semanticSha256 === snapshot.sha256, 'INDEPENDENTLY_REVIEWED_CONSUMER_PIN_REQUIRED');
      const verified = await readPaidDatabaseReadiness({ values: { ...consumerOptions.values, 'database-readiness': path.join(options.output, candidateRef.path), 'database-readiness-sha256': candidateRef.sha256 } }, runtimeAfter);
      fail(verified.verified, 'UNCHANGED_CANONICAL_READER_REJECTED');
      await write('readiness-index.json', index);
    }
    const manifestRef = await write('evidence-manifest.json', { kind: 'local-paid-canary-readonly-evidence-manifest.v1', createdAt: new Date().toISOString(), artifacts: refs, candidate: candidateRef,
      historicalBaseline: { path: options.baseline, sha256: await fileHash(options.baseline) }, sourceDependencies, dependenciesUnchanged, captureStable,
      expectedSemanticPinUnchanged: true, databaseWrites: 0, providerCalls: 0 });
    const result = { ok: true, auditOnly: !options.finalize, structuralGatePassed: !!structuralValidation, structuralFailure, output: options.output, manifest: manifestRef, candidate: candidateRef, finalized: options.finalize, migrations: sourcePlan.migrations.length, applied: status.database.appliedCount, pending: status.database.pendingCount, semanticSha256: snapshot.sha256, currentPinMatches: expected.semanticSha256 === snapshot.sha256, runningLatest: runtimeAfter.runningLatest, databaseWrites: 0, providerCalls: 0 };
    await write('complete.json', result); console.log(JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    await write('failure.json', { ok: false, code: /^[A-Z0-9_]+$/u.test(error?.message || '') ? error.message : 'READONLY_PRODUCER_FAILED', rawErrorSuppressed: true, finalIndexCreated: false, databaseWrites: 0, providerCalls: 0 }); throw error;
  } finally {
    if (client) { if (transaction) await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {}); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({ ok: false, code: /^[A-Z0-9_]+$/u.test(error?.message || '') ? error.message : 'READONLY_PRODUCER_FAILED', rawErrorSuppressed: true })); process.exitCode = 1; });
