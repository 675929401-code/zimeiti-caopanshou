#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";

const { Client } = pg;
const root = process.cwd();
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const actor = String(valueOf("--actor") || process.env.USERNAME || process.env.USER || "codex-release").trim().slice(0, 100);
const evidenceRoot = path.resolve(root, valueOf("--evidence-root") || ".codex-evidence/db-migration-release");
const coverageReceiptPath = requiredPath("--coverage-receipt");
const applicationReceiptPath = requiredPath("--application-receipt");
const backupReceiptPath = requiredPath("--backup-receipt");
const confirmedCoverageFileSha256 = requiredHex("--confirm-coverage-file-sha256");
const confirmedApplicationFileSha256 = requiredHex("--confirm-application-file-sha256");
const confirmedBackupReceiptFileSha256 = requiredHex("--confirm-backup-receipt-file-sha256");
const confirmedBackupArchiveSha256 = requiredHex("--confirm-backup-archive-sha256");
const confirmedManifestSha256 = requiredHex("--confirm-manifest-sha256");
const confirmedTargetFingerprint = requiredHex("--confirm-target-fingerprint");
const confirmedTargetHost = String(valueOf("--confirm-target-host") || "").trim().toLowerCase();
const confirmedTargetPort = Number(valueOf("--confirm-target-port"));
const policy = readJson(path.join(root, "deploy", "policies", "release-policy.json"));
const migrationRoot = path.join(root, policy.database?.migrationRoot || "supabase/migrations");
const excluded = new Set(policy.database?.excludedForwardMigrations || []);
const ADVISORY_LOCK_ID = "260830500011";
const COVERAGE_VERSION = "pending-migration-object-coverage.v1";
const EXPECTED_TARGET_HOST = "127.0.0.1";
const EXPECTED_TARGET_PORT = 54322;

const HISTORICAL = [
  ["20260825123000", "20260825123000_manju_config_control_plane.sql", "46e25899d128bbdc054a5c8d134b7a0510e039f9e2e039538f6c3e6a56d3b11f"],
  ["20260825173500", "20260825173500_voice_atomic_authorization_purchase.sql", "ae9ead1db49bb8a8ea41453c2bb69982b648e7587a0c785823bd48a23addb82d"],
  ["20260827093000", "20260827093000_skill_packages_runtime.sql", "33c9367af7a87456a3f49470b46826aad61387c3558ae343e307b5e6af89266f"],
  ["20260829223000", "20260829223000_manju_config_storage_state.sql", "f6adfafdbb80ed8ab15a58fe808311cac810a70dd6dbea5348699e7e8bdffd8a"],
  ["20260902134000", "20260902134000_skill_next_draft_cas.sql", "ce3788edbf72f8eb8a2a97e314365c75f8dff0af9c5bd79d1fa665a01dccaeb3"],
  ["20260903021000", "20260903021000_image_model_validation_governance.sql", "71a420f06b69dc838d02fc3af9c107d4cbf65bef099998b3b3a5cca8a87477dc"],
  ["20260903074000", "20260903074000_llm_stream_credit_reservations.sql", "d22b069ac51f31ad35837c29e64e09da307e362ef36248f97abc091081fc800c"],
  ["20260903153500", "20260903153500_video_fractional_duration.sql", "5979185fe604c56193383624519dd61c6717554a88455299af6209a475be5caf"],
  ["20260903212000", "20260903212000_digital_video_dispatch_queue.sql", "9dddc7eda94e4fd8d22602df1b7dd3d59722816f7f14f8bb6194e510c4585e37"],
].map(([version, name, sourceSha256]) => ({ version, name, sourceSha256, evidenceKind: "semantic-coverage" }));

const EXECUTED = [
  {
    version: "20260904025500",
    name: "20260904025500_video_provider_failure_terminal.sql",
    sourceSha256: "184ca563446dbeb2d87c90dd188d4cf435b31e5947d570619336cb9f5c3b2c8f",
    evidenceKind: "live-effect",
  },
  {
    version: "20260904031000",
    name: "20260904031000_reconcile_pending_legacy_semantics.sql",
    sourceSha256: "6d6726f4468fba80d3c3d4d9d3cec78210b630019c442af76634bdac7619f8a4",
    evidenceKind: "reviewed-single-file-application",
  },
];

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function requiredPath(name) {
  const value = String(valueOf(name) || "").trim();
  if (!value) throw new Error(`${name.slice(2).toUpperCase().replaceAll("-", "_")}_REQUIRED`);
  return path.resolve(root, value);
}

function requiredHex(name) {
  const value = String(valueOf(name) || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name.slice(2).toUpperCase().replaceAll("-", "_")}_REQUIRED`);
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function receiptDigest(receipt) {
  const core = { ...receipt };
  delete core.receiptSha256;
  return sha256(stableJson(core));
}

function normalizeBody(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function slug(name) {
  return name.slice(15, -4);
}

function loadMigrations() {
  return fs.readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/iu.test(entry.name))
    .filter((entry) => !excluded.has(entry.name))
    .map((entry) => {
      const sql = fs.readFileSync(path.join(migrationRoot, entry.name), "utf8");
      const meaningful = sql.replace(/^\uFEFF/u, "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("--"));
      const selfContained = /^begin\s*;/iu.test(meaningful[0] || "") && /^commit\s*;/iu.test(meaningful.at(-1) || "");
      return {
        version: entry.name.slice(0, 14),
        name: entry.name,
        slug: slug(entry.name),
        sha256: sha256(sql),
        bytes: Buffer.byteLength(sql, "utf8"),
        transactionMode: selfContained ? "self-contained" : "wrapped-by-runner",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function manifestFor(migrations) {
  const core = {
    schemaVersion: 1,
    projectId: policy.projectId || "zimeiti-caopanshou",
    migrationRoot: String(policy.database?.migrationRoot || "supabase/migrations").replaceAll("\\", "/"),
    excludedForwardMigrations: [...excluded].sort(),
    migrationCount: migrations.length,
    totalBytes: migrations.reduce((sum, item) => sum + item.bytes, 0),
    migrations: migrations.map((item) => ({
      version: item.version,
      name: item.name,
      sha256: item.sha256,
      transactionMode: item.transactionMode,
    })),
  };
  return { ...core, manifestSha256: sha256(stableJson(core)) };
}

function confirmedJson(filePath, expectedFileSha256, code) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${code}_NOT_FOUND`);
  const actualFileSha256 = fileSha256(filePath);
  if (actualFileSha256 !== expectedFileSha256) throw new Error(`${code}_FILE_SHA256_MISMATCH`);
  return { value: readJson(filePath), fileSha256: actualFileSha256 };
}

function validateCoverageReceipt(confirmed, migrations) {
  const receipt = confirmed.value;
  if (receipt.kind !== "pending-migration-semantic-coverage-receipt" || receipt.semanticCheckVersion !== COVERAGE_VERSION) {
    throw new Error("COVERAGE_RECEIPT_VERSION_UNSUPPORTED");
  }
  if (receipt.receiptSha256 !== receiptDigest(receipt)) throw new Error("COVERAGE_RECEIPT_INTEGRITY_FAILED");
  if (receipt.targetClass !== "local-loopback-only" || receipt.targetHost !== EXPECTED_TARGET_HOST) throw new Error("COVERAGE_RECEIPT_TARGET_UNSAFE");
  if (receipt.profileCount !== HISTORICAL.length || receipt.passedProfiles !== HISTORICAL.length || receipt.blockedProfiles !== 0) {
    throw new Error("COVERAGE_RECEIPT_NOT_ALL_PASS");
  }
  if (receipt.databaseWrites !== 0 || receipt.migrationLedgerWrites !== 0 || !Array.isArray(receipt.results)) {
    throw new Error("COVERAGE_RECEIPT_UNSAFE");
  }
  const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const receiptByName = new Map(receipt.results.map((result) => [result.file, result]));
  for (const expected of HISTORICAL) {
    const migration = migrationsByName.get(expected.name);
    const result = receiptByName.get(expected.name);
    if (!migration || migration.sha256 !== expected.sourceSha256) throw new Error(`HISTORICAL_SOURCE_CHANGED:${expected.version}`);
    if (!result || result.sourceSha256 !== expected.sourceSha256 || result.passed !== true
      || result.passedChecks !== result.totalChecks || (result.failed || []).length !== 0) {
      throw new Error(`COVERAGE_RECEIPT_PROFILE_INVALID:${expected.version}`);
    }
  }
  if (receiptByName.size !== HISTORICAL.length) throw new Error("COVERAGE_RECEIPT_PROFILE_SET_INVALID");
  return receipt;
}

function validateBackupReceipt(confirmed, target) {
  const receipt = confirmed.value;
  if (receipt.kind !== "local-pre-reconciliation-database-backup-receipt" || receipt.readable !== true
    || receipt.targetClass !== "local-loopback-only" || receipt.targetHost !== target.host || Number(receipt.targetPort) !== target.port
    || receipt.database !== target.database) {
    throw new Error("BACKUP_RECEIPT_UNSAFE");
  }
  const archivePath = path.resolve(String(receipt.archivePath || ""));
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) throw new Error("BACKUP_ARCHIVE_NOT_FOUND");
  const archiveSha256 = fileSha256(archivePath);
  if (archiveSha256 !== receipt.archiveSha256 || archiveSha256 !== confirmedBackupArchiveSha256) {
    throw new Error("BACKUP_ARCHIVE_SHA256_MISMATCH");
  }
  const header = fs.readFileSync(archivePath).subarray(0, 5).toString("ascii");
  if (header !== "PGDMP" || Number(receipt.pgRestoreEntryCount) < 1) throw new Error("BACKUP_ARCHIVE_NOT_READABLE");
  return { receipt, archiveSha256 };
}

function validateApplicationReceipt(confirmed, backup) {
  const receipt = confirmed.value;
  const expected = EXECUTED.find((item) => item.version === "20260904031000");
  if (receipt.kind !== "reviewed-single-forward-migration-application-receipt"
    || receipt.targetClass !== "local-loopback-only" || receipt.targetHost !== EXPECTED_TARGET_HOST
    || Number(receipt.targetPort) !== EXPECTED_TARGET_PORT || receipt.database !== backup.receipt.database || receipt.migrationVersion !== expected.version
    || receipt.migrationSha256 !== expected.sourceSha256 || receipt.executionMethod !== "psql-single-reviewed-file"
    || receipt.prefixExpansionUsed !== false || Number(receipt.psqlExitCode) !== 0 || receipt.migrationLedgerWritten !== false
    || receipt.backupArchiveSha256 !== backup.archiveSha256) {
    throw new Error("APPLICATION_RECEIPT_UNSAFE");
  }
  return receipt;
}

function databaseConfig() {
  const names = policy.database?.migrationDatabaseUrlEnv || ["DEPLOY_DATABASE_URL"];
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (!value) continue;
    const url = new URL(value);
    const target = { host: url.hostname.toLowerCase(), port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.replace(/^\//u, "")) };
    if (target.host !== EXPECTED_TARGET_HOST || target.port !== EXPECTED_TARGET_PORT) throw new Error("NON_LOCAL_DATABASE_WRITE_REFUSED");
    if (confirmedTargetHost !== target.host || confirmedTargetPort !== target.port) throw new Error("TARGET_CONFIRMATION_REQUIRED");
    return { envName: name, value, target };
  }
  throw new Error("DEPLOY_DATABASE_URL_NOT_CONFIGURED");
}

async function targetIdentity(client, config) {
  const result = await client.query(`select current_database() as database_name,
    current_setting('server_version_num') as server_version,
    coalesce(inet_server_addr()::text, 'local') as server_address,
    coalesce(inet_server_port()::text, 'local') as server_port`);
  const row = result.rows[0] || {};
  if (String(row.server_address) !== "127.0.0.1/32" || Number(row.server_port) !== EXPECTED_TARGET_PORT
    || String(row.database_name) !== config.target.database) throw new Error("LIVE_DATABASE_TARGET_MISMATCH");
  return {
    // Keep this byte-for-byte compatible with the dedicated coverage verifier.
    fingerprint: sha256(stableJson({ configuredHost: config.target.host, ...row })),
    databaseName: row.database_name,
  };
}

async function readLedger(client) {
  const result = await client.query(`select version::text as version, coalesce(hash::text, '') as hash
    from supabase_migrations.schema_migrations order by version`);
  return new Map(result.rows.map((row) => [row.version, row]));
}

function assertNoHashDrift(migrations, ledger) {
  const drift = migrations.filter((migration) => ledger.has(migration.version) && ledger.get(migration.version).hash !== migration.sha256);
  if (drift.length > 0) throw new Error(`APPLIED_MIGRATION_HASH_DRIFT:${drift.map((item) => item.version).join(",")}`);
}

function liveCoverageRecheck(expectedReceipt) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-pending-migration-semantics.mjs")], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("LIVE_COVERAGE_RECHECK_FAILED");
  let live;
  try { live = JSON.parse(result.stdout); } catch { throw new Error("LIVE_COVERAGE_RECHECK_OUTPUT_INVALID"); }
  if (live.ok !== true || live.passedProfiles !== HISTORICAL.length || live.blockedProfiles !== 0
    || live.targetFingerprint !== expectedReceipt.targetFingerprint || live.databaseWrites !== 0 || live.migrationLedgerWrites !== 0) {
    throw new Error("LIVE_COVERAGE_RECHECK_MISMATCH");
  }
  const byName = new Map(live.results.map((item) => [item.file, item]));
  for (const expected of HISTORICAL) {
    const item = byName.get(expected.name);
    if (!item || item.passed !== true || item.sourceSha256 !== expected.sourceSha256 || item.passedChecks !== item.totalChecks) {
      throw new Error(`LIVE_COVERAGE_PROFILE_FAILED:${expected.version}`);
    }
  }
  return live;
}

function expected0255BodySha256() {
  const source = fs.readFileSync(path.join(migrationRoot, EXECUTED[0].name), "utf8");
  const match = source.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.finalize_video_generation_failure_atomic[\s\S]*?AS\s+\$function\$([\s\S]*?)\$function\$/iu);
  if (!match) throw new Error("EXECUTED_0255_SOURCE_PARSE_FAILED");
  return sha256(normalizeBody(match[1]));
}

async function verify0255LiveEffect(client) {
  const result = await client.query(`select pg_get_function_identity_arguments(p.oid) as identity_arguments,
    l.lanname as language_name, p.prosecdef,
    coalesce(array_to_string(p.proconfig, ','), '') as configuration, p.prosrc,
    exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.proname = 'finalize_video_generation_failure_atomic'`);
  if (result.rowCount !== 1) throw new Error("EXECUTED_0255_FUNCTION_MISSING_OR_AMBIGUOUS");
  const row = result.rows[0];
  const expectedArguments = "p_task_id text, p_user_id text, p_provider_task_id text, p_error_code text, p_error_message text";
  const bodySha256 = sha256(normalizeBody(row.prosrc));
  if (row.identity_arguments !== expectedArguments || row.language_name !== "plpgsql" || row.prosecdef !== true
    || row.configuration !== "search_path=public, pg_temp" || row.public_execute !== false || row.anon_execute !== false
    || row.authenticated_execute !== false || row.service_execute !== true || bodySha256 !== expected0255BodySha256()) {
    throw new Error("EXECUTED_0255_LIVE_EFFECT_MISMATCH");
  }
  return { functionBodySha256: bodySha256, permissions: "service_role-only" };
}

async function main() {
  const migrations = loadMigrations();
  const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const expected of [...HISTORICAL, ...EXECUTED]) {
    const current = migrationsByName.get(expected.name);
    if (!current || current.sha256 !== expected.sourceSha256) throw new Error(`EVIDENCED_SOURCE_CHANGED:${expected.version}`);
  }
  const manifest = manifestFor(migrations);
  if (manifest.manifestSha256 !== confirmedManifestSha256) throw new Error("MANIFEST_SHA256_CONFIRMATION_REQUIRED");

  const coverageConfirmed = confirmedJson(coverageReceiptPath, confirmedCoverageFileSha256, "COVERAGE_RECEIPT");
  const coverage = validateCoverageReceipt(coverageConfirmed, migrations);
  const config = databaseConfig();
  const backupConfirmed = confirmedJson(backupReceiptPath, confirmedBackupReceiptFileSha256, "BACKUP_RECEIPT");
  const backup = validateBackupReceipt(backupConfirmed, config.target);
  const applicationConfirmed = confirmedJson(applicationReceiptPath, confirmedApplicationFileSha256, "APPLICATION_RECEIPT");
  const application = validateApplicationReceipt(applicationConfirmed, backup);

  const expectedPending = [...HISTORICAL, ...EXECUTED].map((item) => item.version).sort();
  const client = new Client({
    connectionString: config.value,
    ssl: false,
    statement_timeout: 120_000,
    connectionTimeoutMillis: 15_000,
    application_name: "codex-evidenced-migration-ledger-adoption",
  });
  let locked = false;
  let transactionOpen = false;
  const adopted = [];
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    locked = true;
    const identity = await targetIdentity(client, config);
    if (identity.fingerprint !== confirmedTargetFingerprint || identity.fingerprint !== coverage.targetFingerprint) {
      throw new Error("TARGET_FINGERPRINT_CONFIRMATION_REQUIRED");
    }
    const ledgerBefore = await readLedger(client);
    assertNoHashDrift(migrations, ledgerBefore);
    for (const requiredApplied of ["20260904024500", "20260904025000"]) {
      if (!ledgerBefore.has(requiredApplied)) throw new Error(`REQUIRED_PREDECESSOR_NOT_APPLIED:${requiredApplied}`);
    }
    const pendingBefore = migrations.filter((migration) => !ledgerBefore.has(migration.version)).map((migration) => migration.version).sort();
    if (stableJson(pendingBefore) !== stableJson(expectedPending)) throw new Error(`PENDING_SET_MISMATCH:${pendingBefore.join(",")}`);

    const liveCoverage = liveCoverageRecheck(coverage);
    const live0255 = await verify0255LiveEffect(client);

    if (!execute) {
      writeEvidence({
        ok: true,
        mode: "evidenced-adoption-plan",
        executeRequired: true,
        manifestSha256: manifest.manifestSha256,
        targetHost: config.target.host,
        targetPort: config.target.port,
        targetFingerprint: identity.fingerprint,
        coverageReceiptFileSha256: coverageConfirmed.fileSha256,
        coverageReceiptSha256: coverage.receiptSha256,
        backupReceiptFileSha256: backupConfirmed.fileSha256,
        backupArchiveSha256: backup.archiveSha256,
        applicationReceiptFileSha256: applicationConfirmed.fileSha256,
        applicationMigrationVersion: application.migrationVersion,
        pendingCount: pendingBefore.length,
        candidates: [...HISTORICAL, ...EXECUTED].map(({ version, name, sourceSha256, evidenceKind }) => ({ version, name, sourceSha256, evidenceKind })),
        liveCoverage: { passedProfiles: liveCoverage.passedProfiles, blockedProfiles: liveCoverage.blockedProfiles },
        live0255,
        migrationSqlExecuted: 0,
        databaseWrites: 0,
        migrationLedgerWrites: 0,
        credentialsPrinted: false,
      });
      return;
    }

    await client.query("begin");
    transactionOpen = true;
    const ledgerRecheck = await readLedger(client);
    assertNoHashDrift(migrations, ledgerRecheck);
    const pendingRecheck = migrations.filter((migration) => !ledgerRecheck.has(migration.version)).map((migration) => migration.version).sort();
    if (stableJson(pendingRecheck) !== stableJson(expectedPending)) throw new Error("PENDING_SET_CHANGED_BEFORE_LEDGER_WRITE");
    for (const expected of [...HISTORICAL, ...EXECUTED]) {
      const migration = migrationsByName.get(expected.name);
      const suffix = expected.evidenceKind === "semantic-coverage"
        ? "semantic-coverage-adopt"
        : expected.evidenceKind === "live-effect" ? "live-effect-adopt" : "reviewed-single-file-adopt";
      const inserted = await client.query(`insert into supabase_migrations.schema_migrations
        (version, name, statements, hash, applied_by, applied_at)
        values ($1, $2, $3, $4, $5, now()) on conflict (version) do nothing`,
      [migration.version, migration.slug, [migration.name], migration.sha256, `${actor}:${suffix}`]);
      if (inserted.rowCount !== 1) throw new Error(`LEDGER_ADOPTION_CONFLICT:${migration.version}`);
      adopted.push({ version: migration.version, name: migration.name, sha256: migration.sha256, evidenceKind: expected.evidenceKind });
    }
    await client.query("commit");
    transactionOpen = false;

    const ledgerAfter = await readLedger(client);
    assertNoHashDrift(migrations, ledgerAfter);
    const pendingAfter = migrations.filter((migration) => !ledgerAfter.has(migration.version));
    if (pendingAfter.length !== 0) throw new Error(`POST_ADOPTION_PENDING_REMAINS:${pendingAfter.map((item) => item.version).join(",")}`);

    writeEvidence({
      ok: true,
      mode: "evidenced-adoption-execute",
      manifestSha256: manifest.manifestSha256,
      targetHost: config.target.host,
      targetPort: config.target.port,
      targetFingerprint: identity.fingerprint,
      coverageReceiptFileSha256: coverageConfirmed.fileSha256,
      coverageReceiptSha256: coverage.receiptSha256,
      backupReceiptFileSha256: backupConfirmed.fileSha256,
      backupArchiveSha256: backup.archiveSha256,
      applicationReceiptFileSha256: applicationConfirmed.fileSha256,
      adoptedCount: adopted.length,
      adopted,
      remainingPendingCount: 0,
      hashDriftCount: 0,
      migrationSqlExecuted: 0,
      databaseWrites: adopted.length,
      migrationLedgerWrites: adopted.length,
      credentialsPrinted: false,
    });
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("rollback"); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    if (locked) {
      try { await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]); } catch { /* session closes next */ }
    }
    await client.end();
  }
}

function writeEvidence(result) {
  const body = `${JSON.stringify(result, null, 2)}\n`;
  console.log(body.trimEnd());
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  fs.writeFileSync(path.join(evidenceRoot, `${stamp}-${result.mode}.json`), body, "utf8");
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    mode: execute ? "evidenced-adoption-execute" : "evidenced-adoption-plan",
    code: String(error?.message || "EVIDENCED_ADOPTION_FAILED").replace(/[^A-Za-z0-9_.:,-]/gu, "_").slice(0, 300),
    migrationSqlExecuted: 0,
    databaseWrites: 0,
    migrationLedgerWrites: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exitCode = 1;
});
