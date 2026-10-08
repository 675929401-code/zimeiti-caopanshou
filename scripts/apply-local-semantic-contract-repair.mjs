#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const root = process.cwd();
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const dryRun = args.includes("--dry-run");
const runtimePath = path.resolve(process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
const backupPath = path.resolve(valueOf("--backup-path") || "");
const confirmedBackupSha256 = String(valueOf("--confirm-backup-sha256") || "").trim().toLowerCase();
const advisoryLockId = "261009031000";
const migrations = [
  {
    version: "20260923182900",
    name: "20260923182900_llm_models_provider_column.sql",
    sha256: "9b08d8f4ea56039af089d4db36a0a742266fbfe66957800c334b288a10d36bac",
  },
  {
    version: "20261003123000",
    name: "20261003123000_payment_refund_manual_reconciliation.sql",
    sha256: "b10d094501ef107150edb15e69d56cb718d7c9a471b8f246d1f92ed64fc68561",
  },
];

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function migrationBody(source, name) {
  const match = source.replace(/^\uFEFF/u, "").match(
    /^\s*(?:(?:--[^\r\n]*)(?:\r?\n|$)\s*)*BEGIN\s*;\s*([\s\S]*?)\s*COMMIT\s*;\s*$/iu,
  );
  assert.ok(match, `MIGRATION_TRANSACTION_BOUNDARY_INVALID:${name}`);
  return match[1].trim();
}

function safeRuntime() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8").replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(typeof runtime.ownerConnection?.password, "string", "LOCAL_DATABASE_PASSWORD_REQUIRED");
  return runtime;
}

function verifiedSources() {
  return migrations.map((migration) => {
    const filePath = path.join(root, "supabase", "migrations", migration.name);
    assert.ok(fs.existsSync(filePath), `MIGRATION_NOT_FOUND:${migration.name}`);
    const source = fs.readFileSync(filePath, "utf8");
    assert.equal(crypto.createHash("sha256").update(source).digest("hex"), migration.sha256, `MIGRATION_HASH_DRIFT:${migration.name}`);
    return { ...migration, source, body: migrationBody(source, migration.name) };
  });
}

function verifyBackup() {
  assert.ok(backupPath && fs.existsSync(backupPath) && fs.statSync(backupPath).isFile(), "LOCAL_BACKUP_NOT_FOUND");
  assert.match(confirmedBackupSha256, /^[a-f0-9]{64}$/u, "LOCAL_BACKUP_SHA256_CONFIRMATION_REQUIRED");
  const actualSha256 = sha256File(backupPath);
  assert.equal(actualSha256, confirmedBackupSha256, "LOCAL_BACKUP_SHA256_MISMATCH");
  return { path: backupPath, sha256: actualSha256, bytes: fs.statSync(backupPath).size };
}

async function readLedger(client) {
  const exists = await client.query("select to_regclass('supabase_migrations.schema_migrations') as ledger");
  if (!exists.rows[0]?.ledger) return new Map();
  const result = await client.query("select version::text, coalesce(hash::text, '') as hash from supabase_migrations.schema_migrations order by version");
  return new Map(result.rows.map((row) => [String(row.version), String(row.hash || "").toLowerCase()]));
}

async function ensureLedger(client) {
  await client.query("create schema if not exists supabase_migrations");
  await client.query(`create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    name text,
    statements text[],
    hash text,
    applied_by text,
    applied_at timestamptz not null default now()
  )`);
}

async function main() {
  assert.notEqual(execute, dryRun, "CHOOSE_EXACTLY_ONE_OF_DRY_RUN_OR_EXECUTE");
  const runtime = safeRuntime();
  const backup = verifyBackup();
  const sources = verifiedSources();
  const client = new Client({
    ...runtime.ownerConnection,
    application_name: "codex-local-semantic-contract-repair",
    connectionTimeoutMillis: 10_000,
    query_timeout: 180_000,
  });
  let locked = false;
  let transactionOpen = false;
  const applied = [];
  const skipped = [];
  await client.connect();
  try {
    const identity = (await client.query(`select current_database() as database_name,
      inet_server_addr()::text as server_address, inet_server_port() as server_port`)).rows[0];
    assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
    assert.equal(String(identity.server_address || "").split("/")[0], "127.0.0.1", "LIVE_LOCAL_DATABASE_HOST_REQUIRED");
    assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");
    const ledger = await readLedger(client);
    for (const migration of sources) {
      const recordedHash = ledger.get(migration.version);
      if (recordedHash === migration.sha256) skipped.push({ version: migration.version, name: migration.name, reason: "already-applied-hash-verified" });
      else if (recordedHash) throw new Error(`APPLIED_MIGRATION_HASH_DRIFT:${migration.version}`);
    }
    if (dryRun) {
      console.log(JSON.stringify({
        passed: true,
        mode: "dry-run",
        target: "127.0.0.1:54322/zimeiti_local",
        pending: sources.filter((migration) => !ledger.has(migration.version)).map(({ version, name, sha256 }) => ({ version, name, sha256 })),
        skipped,
        backup: { sha256: backup.sha256, bytes: backup.bytes },
        databaseWrites: 0,
        paidModelCalls: 0,
        credentialsPrinted: false,
      }, null, 2));
      return;
    }
    await client.query("select pg_advisory_lock($1)", [advisoryLockId]);
    locked = true;
    await client.query("begin");
    transactionOpen = true;
    await ensureLedger(client);
    const lockedLedger = await readLedger(client);
    for (const migration of sources) {
      const recordedHash = lockedLedger.get(migration.version);
      if (recordedHash === migration.sha256) continue;
      if (recordedHash) throw new Error(`APPLIED_MIGRATION_HASH_DRIFT:${migration.version}`);
      await client.query(migration.body);
      await client.query(
        `insert into supabase_migrations.schema_migrations
           (version, name, statements, hash, applied_by, applied_at)
         values ($1, $2, $3, $4, $5, now())`,
        [migration.version, migration.name.replace(/^\d{14}_|\.sql$/gu, ""), [migration.name], migration.sha256, "codex:local-semantic-contract-repair"],
      );
      applied.push({ version: migration.version, name: migration.name, sha256: migration.sha256 });
    }
    await client.query("notify pgrst, 'reload schema'");
    await client.query("commit");
    transactionOpen = false;
    await client.query("select pg_advisory_unlock($1)", [advisoryLockId]);
    locked = false;
  } catch (error) {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [advisoryLockId]).catch(() => {});
    await client.end();
  }
  console.log(JSON.stringify({
    passed: true,
    mode: "execute",
    target: "127.0.0.1:54322/zimeiti_local",
    applied,
    skipped,
    backup: { sha256: backup.sha256, bytes: backup.bytes },
    databaseWrites: applied.length ? applied.length + 1 : 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    passed: false,
    mode: execute ? "execute" : dryRun ? "dry-run" : "invalid",
    code: error instanceof Error ? error.message.slice(0, 240) : "UNKNOWN_ERROR",
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exitCode = 1;
});
