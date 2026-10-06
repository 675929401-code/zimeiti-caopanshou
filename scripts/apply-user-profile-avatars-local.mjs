#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261003140000";
const NAME = "user_profile_avatars";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.rollback.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

const applyRequested = process.argv.includes("--apply");
const rollbackRequested = process.argv.includes("--rollback");
assert.notEqual(applyRequested, rollbackRequested, "CHOOSE_EXACTLY_ONE_OPERATION");
assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-avatar-only"), "LOCAL_AVATAR_CONFIRMATION_REQUIRED");
if (rollbackRequested) {
  assert.ok(process.argv.includes("--confirm-empty-avatar-rollback"), "EMPTY_AVATAR_ROLLBACK_CONFIRMATION_REQUIRED");
}

function transactionBody(sql, label) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, `${label}_BEGIN_REQUIRED`);
  assert.match(normalized, /COMMIT\s*;\s*$/u, `${label}_COMMIT_REQUIRED`);
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const rollbackPath = path.resolve("supabase/rollbacks", ROLLBACK_FILE);
const migrationSource = await fs.readFile(migrationPath, "utf8");
const rollbackSource = await fs.readFile(rollbackPath, "utf8");
const migrationHash = sha256(migrationSource);
const migrationBody = transactionBody(migrationSource, "MIGRATION");
const rollbackBody = transactionBody(rollbackSource, "ROLLBACK");
assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS public\.user_profile_avatars/u);
assert.match(migrationSource, /REFERENCES public\.users\(id\) ON DELETE CASCADE/u);
assert.match(migrationSource, /source IN \('preset', 'upload'\)/u);
assert.match(rollbackSource, /ROLLBACK_BLOCKED_USER_PROFILE_AVATARS_EXIST/u);

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-user-profile-avatars",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1", "LIVE_DATABASE_HOST_MISMATCH");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('user-profile-avatars:20261003140000',0))");
  const prior = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  if (prior.rowCount) assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");

  let action;
  if (applyRequested) {
    if (prior.rowCount) {
      action = "already_applied";
    } else {
      await client.query(migrationBody);
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-user-profile-avatar"],
      );
      action = "applied";
    }

    const table = await client.query(
      `SELECT relrowsecurity FROM pg_class
       JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
       WHERE pg_namespace.nspname='public' AND relname='user_profile_avatars'`,
    );
    assert.equal(table.rowCount, 1, "USER_PROFILE_AVATAR_TABLE_REQUIRED");
    assert.equal(table.rows[0].relrowsecurity, true, "USER_PROFILE_AVATAR_RLS_REQUIRED");
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='user_profile_avatars'`,
    );
    const names = new Set(columns.rows.map(row => row.column_name));
    for (const required of ["user_id", "avatar_url", "storage_provider", "storage_key", "source", "created_at", "updated_at"]) {
      assert.ok(names.has(required), `USER_PROFILE_AVATAR_COLUMN_MISSING:${required}`);
    }
    const privileges = await client.query(
      `SELECT
         has_table_privilege('anon','public.user_profile_avatars','SELECT') AS anon_reads,
         has_table_privilege('authenticated','public.user_profile_avatars','SELECT') AS authenticated_reads,
         has_table_privilege('service_role','public.user_profile_avatars','SELECT') AS service_reads`,
    );
    assert.equal(privileges.rows[0]?.anon_reads, false, "ANON_AVATAR_READ_FORBIDDEN");
    assert.equal(privileges.rows[0]?.authenticated_reads, false, "AUTHENTICATED_DIRECT_AVATAR_READ_FORBIDDEN");
    assert.equal(privileges.rows[0]?.service_reads, true, "SERVICE_ROLE_AVATAR_READ_REQUIRED");
  } else {
    await client.query(rollbackBody);
    await client.query("DELETE FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
    const table = await client.query("SELECT to_regclass('public.user_profile_avatars')::text AS name");
    assert.equal(table.rows[0]?.name, null, "USER_PROFILE_AVATAR_ROLLBACK_INCOMPLETE");
    action = "rolled_back";
  }

  // The local PostgREST process may already be running when this migration is
  // applied. Reload its schema cache so the new table is immediately usable.
  await client.query("NOTIFY pgrst, 'reload schema'");

  const ledger = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledger.rowCount, applyRequested ? 1 : 0, "MIGRATION_LEDGER_FINAL_STATE_INVALID");
  if (applyRequested) assert.equal(String(ledger.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_MISMATCH");

  await client.query("COMMIT");
  transactionOpen = false;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    operation: applyRequested ? "apply" : "rollback",
    action,
    migration: MIGRATION_FILE,
    rollback: ROLLBACK_FILE,
    migrationHash,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "user-profile-avatars");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, `${report.operation}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
