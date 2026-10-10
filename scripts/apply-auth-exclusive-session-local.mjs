#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const migrations = [
  { version: "20261009055000", name: "user_auth_session_exclusivity" },
  { version: "20261009056000", name: "user_auth_session_direct_write_guard" },
].map(item => ({ ...item, file: `${item.version}_${item.name}.sql` }));
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-exclusive-session"), "LOCAL_EXCLUSIVE_SESSION_CONFIRMATION_REQUIRED");
const reconcileLocalDraft = process.argv.includes("--reconcile-local-draft");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const sources = await Promise.all(migrations.map(async migration => {
  const source = (await fs.readFile(path.resolve("supabase/migrations", migration.file), "utf8")).replace(/^\uFEFF/u, "");
  const normalized = source.trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return {
    ...migration,
    body: normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim(),
    hash: crypto.createHash("sha256").update(source).digest("hex"),
  };
}));

const db = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-auth-exclusive-session-migration",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
const outputDir = path.resolve(".codex-evidence/auth-exclusive-session");
await fs.mkdir(outputDir, { recursive: true });
await db.connect();
let transactionOpen = false;
try {
  const identity = (await db.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");

  await db.query("BEGIN");
  transactionOpen = true;
  await db.query("SELECT pg_advisory_xact_lock($1)", [260909055000]);
  const migrationReceipts = [];
  for (const migration of sources) {
    const ledger = await db.query(
      "SELECT version, hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [migration.version],
    );
    let action = "already_applied";
    if (ledger.rowCount) {
      const ledgerHash = String(ledger.rows[0].hash || "");
      if (ledgerHash !== migration.hash) {
        assert.equal(reconcileLocalDraft, true, "MIGRATION_LEDGER_HASH_CONFLICT");
        await db.query(migration.body);
        await db.query(
          `UPDATE supabase_migrations.schema_migrations
              SET name=$2, statements=$3, hash=$4, applied_by=$5, applied_at=now()
            WHERE version::text=$1`,
          [migration.version, migration.name, [migration.file], migration.hash, "codex-local-exclusive-session-draft-reconcile"],
        );
        action = "reconciled_local_draft";
      }
    } else {
      await db.query(migration.body);
      await db.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [migration.version, migration.name, [migration.file], migration.hash, "codex-local-exclusive-session"],
      );
      action = "applied";
    }
    migrationReceipts.push({ file: migration.file, hash: migration.hash, action });
  }

  const obsoleteUniqueIndexes = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public'
        AND indexname=ANY($1::text[])`,
    [["user_auth_sessions_one_active_ip_idx", "user_auth_sessions_one_active_user_idx"]],
  );
  assert.equal(obsoleteUniqueIndexes.rowCount, 0, "OBSOLETE_EXCLUSIVE_SESSION_INDEXES_PRESENT");
  const supportIndexes = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public'
        AND indexname=ANY($1::text[])`,
    [["user_auth_sessions_active_ip_user_idx", "user_auth_sessions_active_user_ip_idx"]],
  );
  assert.equal(supportIndexes.rowCount, 2, "SESSION_SCOPE_SUPPORT_INDEXES_MISSING");
  const guard = await db.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid='public.user_auth_sessions'::regclass AND tgname='user_auth_sessions_exclusive_write_guard' AND NOT tgisinternal",
  );
  assert.equal(guard.rowCount, 1, "DIRECT_SESSION_WRITE_GUARD_MISSING");
  await db.query("COMMIT");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migrations: migrationReceipts,
    providerRequests: 0,
  };
  await fs.writeFile(path.join(outputDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await db.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
