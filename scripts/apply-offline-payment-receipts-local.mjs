#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260930225500";
const NAME = "offline_payment_receipts";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.offline_payment_receipts/u);
  assert.match(normalized, /record_offline_payment_and_activate_member_atomic/u);
  assert.match(normalized, /void_offline_payment_receipt_atomic/u);
  assert.match(normalized, /ENABLE ROW LEVEL SECURITY/u);
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-offline-payment"), "LOCAL_OFFLINE_PAYMENT_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const source = await fs.readFile(migrationPath, "utf8");
const migrationHash = sha256(source);
const body = migrationBody(source);
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-offline-payment-receipts",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
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

  const before = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.user_notifications) AS notifications,
       (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations,
       (SELECT count(*)::integer FROM public.member_activation_events) AS activation_events`,
  )).rows[0];

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260930225500]);
  assert.equal((await client.query("SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name")).rows[0]?.name, "supabase_migrations.schema_migrations", "MIGRATION_LEDGER_REQUIRED");

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
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-offline-payment"],
    );
    action = "applied";
  }

  const table = (await client.query(
    `SELECT relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public' AND relname='offline_payment_receipts'`,
  )).rows[0];
  assert.equal(table?.relrowsecurity, true, "OFFLINE_PAYMENT_RLS_REQUIRED");
  const functions = await client.query(
    `SELECT proname,prosecdef FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public' AND proname=ANY($1::text[])`,
    [["record_offline_payment_and_activate_member_atomic", "void_offline_payment_receipt_atomic"]],
  );
  assert.equal(functions.rowCount, 2, "OFFLINE_PAYMENT_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "OFFLINE_PAYMENT_SECURITY_DEFINER_REQUIRED");
  const indexes = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='offline_payment_receipts'
     AND indexname=ANY($1::text[])`,
    [["offline_payment_reference_unique", "offline_payment_void_request_unique"]],
  );
  assert.equal(indexes.rowCount, 2, "OFFLINE_PAYMENT_DEDUPE_INDEXES_MISSING");
  const privileges = (await client.query(
    `SELECT
       has_table_privilege('anon','public.offline_payment_receipts','SELECT') AS anon_reads,
       has_table_privilege('authenticated','public.offline_payment_receipts','SELECT') AS authenticated_reads,
       has_table_privilege('service_role','public.offline_payment_receipts','SELECT') AS service_reads`,
  )).rows[0];
  assert.equal(privileges.anon_reads, false, "ANON_OFFLINE_PAYMENT_ACCESS_FORBIDDEN");
  assert.equal(privileges.authenticated_reads, false, "AUTHENTICATED_OFFLINE_PAYMENT_ACCESS_FORBIDDEN");
  assert.equal(privileges.service_reads, true, "SERVICE_OFFLINE_PAYMENT_ACCESS_REQUIRED");
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const after = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.offline_payment_receipts) AS offline_receipts,
       (SELECT count(*)::integer FROM public.user_notifications) AS notifications,
       (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations,
       (SELECT count(*)::integer FROM public.member_activation_events) AS activation_events`,
  )).rows[0];
  assert.equal(Number(after.notifications), Number(before.notifications), "MIGRATION_MUST_NOT_PUSH_NOTIFICATIONS");
  assert.equal(Number(after.wallet_operations), Number(before.wallet_operations), "MIGRATION_MUST_NOT_MUTATE_WALLETS");
  assert.equal(Number(after.activation_events), Number(before.activation_events), "MIGRATION_MUST_NOT_ACTIVATE_MEMBERS");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationHash,
    action,
    before,
    after,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "member-activation-workflow");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "offline-payment-migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
