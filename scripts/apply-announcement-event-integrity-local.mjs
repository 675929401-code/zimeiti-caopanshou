#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002223000";
const NAME = "announcement_event_integrity";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.announcement_delivery_events/u);
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.record_announcement_delivery_event/u);
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.get_announcement_event_totals/u);
  assert.match(normalized, /UNIQUE \(announcement_id, revision, user_id, event_type\)/u);
  assert.doesNotMatch(
    normalized,
    /(?:FROM|INTO|UPDATE)\s+public\.platform_settings/iu,
    "PLATFORM_SETTINGS_WRITE_PATH_FORBIDDEN",
  );
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-announcement-event-integrity"),
  "LOCAL_ANNOUNCEMENT_EVENT_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = crypto.createHash("sha256").update(source).digest("hex");
const body = migrationBody(source);
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-announcement-event-integrity-migration",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.deepEqual(identity, {
    database_name: "zimeiti_local",
    server_address: "127.0.0.1",
    server_port: 54322,
  });

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", ["261002223000"]);
  const ledgerTable = await client.query(
    "SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name",
  );
  assert.equal(ledgerTable.rows[0]?.name, "supabase_migrations.schema_migrations", "MIGRATION_LEDGER_REQUIRED");
  assert.equal(
    (await client.query("SELECT to_regclass('public.announcement_push_runs')::text AS name")).rows[0]?.name,
    "announcement_push_runs",
    "ANNOUNCEMENT_DELIVERY_PREREQUISITE_REQUIRED",
  );

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
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-announcement-event-integrity"],
    );
    action = "applied";
  }

  const table = (await client.query(
    `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='announcement_delivery_events'`,
  )).rows[0];
  assert.equal(table?.relrowsecurity, true, "ANNOUNCEMENT_EVENT_RLS_REQUIRED");

  const functions = await client.query(
    `SELECT proname, prosecdef
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND proname=ANY($1::text[])
      ORDER BY proname`,
    [["get_announcement_event_totals", "record_announcement_delivery_event"]],
  );
  assert.equal(functions.rowCount, 2, "ANNOUNCEMENT_EVENT_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "ANNOUNCEMENT_EVENT_SECURITY_DEFINER_REQUIRED");

  const privileges = (await client.query(
    `SELECT
       has_table_privilege('anon','public.announcement_delivery_events','SELECT') AS anon_select,
       has_table_privilege('authenticated','public.announcement_delivery_events','SELECT') AS authenticated_select,
       has_table_privilege('service_role','public.announcement_delivery_events','SELECT') AS service_select,
       has_table_privilege('service_role','public.announcement_delivery_events','INSERT') AS service_insert,
       has_table_privilege('service_role','public.announcement_delivery_events','UPDATE') AS service_update,
       has_table_privilege('service_role','public.announcement_delivery_events','DELETE') AS service_delete,
       has_function_privilege('anon','public.record_announcement_delivery_event(text,text,integer,text,text)','EXECUTE') AS anon_execute,
       has_function_privilege('authenticated','public.record_announcement_delivery_event(text,text,integer,text,text)','EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role','public.record_announcement_delivery_event(text,text,integer,text,text)','EXECUTE') AS service_execute`,
  )).rows[0];
  assert.deepEqual(privileges, {
    anon_select: false,
    authenticated_select: false,
    service_select: true,
    service_insert: true,
    service_update: false,
    service_delete: false,
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
  });

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
    ledger: {
      version: String(ledger.rows[0].version),
      name: ledger.rows[0].name,
      hash: ledger.rows[0].hash,
      appliedBy: ledger.rows[0].applied_by,
      appliedAt: ledger.rows[0].applied_at,
    },
    table: "announcement_delivery_events",
    appendOnlyServiceRole: true,
    authoritativeRpc: "record_announcement_delivery_event",
    aggregateRpc: "get_announcement_event_totals",
    productionWrites: 0,
    providerCalls: 0,
    paidCalls: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "announcement-event-integrity");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
