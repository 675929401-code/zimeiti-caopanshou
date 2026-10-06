#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260929093000";
const NAME = "announcement_account_delivery";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.announcement_user_reads/u);
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.repush_announcement_atomic/u);
  assert.match(normalized, /REVOKE ALL ON TABLE public\.announcement_user_reads FROM PUBLIC, anon, authenticated/u);
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-announcement-delivery"),
  "LOCAL_ANNOUNCEMENT_DELIVERY_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
assert.equal(Number(runtime.databasePort), 54322, "LOCAL_RUNTIME_PORT_REQUIRED");
assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_RUNTIME_DATABASE_REQUIRED");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const source = await fs.readFile(migrationPath, "utf8");
const migrationHash = sha256(source);
const body = migrationBody(source);
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-announcement-delivery-migration",
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
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260929093000]);
  const ledgerTable = await client.query(
    "SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name",
  );
  assert.equal(ledgerTable.rows[0]?.name, "supabase_migrations.schema_migrations", "MIGRATION_LEDGER_REQUIRED");

  const prior = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-announcement-delivery"],
    );
    action = "applied";
  }

  const columns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='announcements'
       AND column_name=ANY($1::text[])`,
    [["push_revision", "first_published_at", "last_pushed_at", "target_audience", "target_user_ids"]],
  );
  assert.equal(columns.rowCount, 5, "ANNOUNCEMENT_DELIVERY_COLUMNS_MISSING");
  const tables = await client.query(
    `SELECT relname, relrowsecurity FROM pg_class
     JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public'
       AND relname=ANY($1::text[])`,
    [["announcement_push_runs", "announcement_user_reads"]],
  );
  assert.equal(tables.rowCount, 2, "ANNOUNCEMENT_DELIVERY_TABLES_MISSING");
  assert.ok(tables.rows.every((row) => row.relrowsecurity === true), "ANNOUNCEMENT_DELIVERY_RLS_REQUIRED");
  const functions = await client.query(
    `SELECT proname, prosecdef FROM pg_proc
     JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public'
       AND proname=ANY($1::text[])`,
    [["mark_announcement_read", "repush_announcement_atomic", "get_announcement_delivery_status"]],
  );
  assert.equal(functions.rowCount, 3, "ANNOUNCEMENT_DELIVERY_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "ANNOUNCEMENT_FUNCTION_SECURITY_DEFINER_REQUIRED");
  const triggers = await client.query(
    `SELECT tgname FROM pg_trigger
     WHERE tgrelid='public.announcements'::regclass
       AND tgname=ANY($1::text[]) AND NOT tgisinternal`,
    [["announcements_initialize_first_push", "announcements_record_initial_push"]],
  );
  assert.equal(triggers.rowCount, 2, "ANNOUNCEMENT_DELIVERY_TRIGGERS_MISSING");
  const privileges = await client.query(
    `SELECT
       has_table_privilege('anon','public.announcement_user_reads','SELECT') AS anon_reads,
       has_table_privilege('authenticated','public.announcement_user_reads','SELECT') AS authenticated_reads,
       has_table_privilege('service_role','public.announcement_user_reads','SELECT') AS service_reads`,
  );
  assert.equal(privileges.rows[0]?.anon_reads, false, "ANON_ANNOUNCEMENT_READ_ACCESS_FORBIDDEN");
  assert.equal(privileges.rows[0]?.authenticated_reads, false, "AUTHENTICATED_DIRECT_READ_ACCESS_FORBIDDEN");
  assert.equal(privileges.rows[0]?.service_reads, true, "SERVICE_ROLE_ANNOUNCEMENT_READ_ACCESS_REQUIRED");

  const ledger = await client.query(
    "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledger.rowCount, 1, "MIGRATION_LEDGER_WRITE_FAILED");
  assert.equal(String(ledger.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_MISMATCH");

  await client.query("COMMIT");
  transactionOpen = false;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationHash,
    action,
    migrationCount: 1,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "announcement-account-delivery");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
