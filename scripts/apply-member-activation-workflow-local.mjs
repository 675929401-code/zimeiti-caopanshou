#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260930221000";
const NAME = "member_activation_cami_invitation_rewards";
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
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.invitation_reward_grants/u);
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.redeem_cami_membership_atomic/u);
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.send_invitation_reward_atomic/u);
  assert.match(normalized, /ENABLE ROW LEVEL SECURITY/u);
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-member-activation"), "LOCAL_MEMBER_ACTIVATION_CONFIRMATION_REQUIRED");

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
  application_name: "codex-local-member-activation-workflow",
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
       (SELECT count(*)::integer FROM public.invitation_records) AS invitation_records,
       (SELECT count(*)::integer FROM public.cami_codes) AS cami_codes,
       (SELECT count(*)::integer FROM public.user_notifications) AS notifications,
       (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations`,
  )).rows[0];

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260930221000]);
  const ledgerTable = await client.query("SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name");
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
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-member-activation"],
    );
    action = "applied";
  }

  const invitationColumns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='invitation_records'
       AND column_name=ANY($1::text[])`,
    [["activation_method", "activation_reference", "activation_fee", "activation_note", "activated_by"]],
  );
  assert.equal(invitationColumns.rowCount, 5, "INVITATION_ACTIVATION_COLUMNS_MISSING");
  const camiColumns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cami_codes'
       AND column_name=ANY($1::text[])`,
    [["assigned_to", "assigned_at", "assigned_by", "assignment_request_key", "delivery_notification_id", "redemption_request_key"]],
  );
  assert.equal(camiColumns.rowCount, 6, "CAMI_WORKFLOW_COLUMNS_MISSING");
  const tables = await client.query(
    `SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public' AND relname=ANY($1::text[])`,
    [["member_activation_events", "invitation_reward_grants"]],
  );
  assert.equal(tables.rowCount, 2, "MEMBER_WORKFLOW_TABLES_MISSING");
  assert.ok(tables.rows.every((row) => row.relrowsecurity === true), "MEMBER_WORKFLOW_RLS_REQUIRED");
  const functions = await client.query(
    `SELECT proname, prosecdef FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public' AND proname=ANY($1::text[])`,
    [["set_member_activation_state_atomic", "assign_cami_to_user_atomic", "redeem_cami_membership_atomic", "save_invitation_reward_decision_atomic", "send_invitation_reward_atomic"]],
  );
  assert.equal(functions.rowCount, 5, "MEMBER_WORKFLOW_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "MEMBER_WORKFLOW_SECURITY_DEFINER_REQUIRED");
  const missingRewards = await client.query(
    `SELECT count(*)::integer AS count
     FROM public.invitation_records record
     LEFT JOIN public.invitation_reward_grants grant_row ON grant_row.invitation_record_id=record.id
     GROUP BY record.id HAVING count(grant_row.id) <> 2`,
  );
  assert.equal(missingRewards.rowCount, 0, "INVITATION_REWARD_BACKFILL_INCOMPLETE");
  const privileges = await client.query(
    `SELECT
       has_table_privilege('anon','public.invitation_reward_grants','SELECT') AS anon_reads,
       has_table_privilege('authenticated','public.invitation_reward_grants','SELECT') AS authenticated_reads,
       has_table_privilege('service_role','public.invitation_reward_grants','SELECT') AS service_reads`,
  );
  assert.equal(privileges.rows[0]?.anon_reads, false, "ANON_INVITATION_REWARD_ACCESS_FORBIDDEN");
  assert.equal(privileges.rows[0]?.authenticated_reads, false, "AUTHENTICATED_INVITATION_REWARD_ACCESS_FORBIDDEN");
  assert.equal(privileges.rows[0]?.service_reads, true, "SERVICE_INVITATION_REWARD_ACCESS_REQUIRED");
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const after = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.invitation_reward_grants) AS reward_grants,
       (SELECT count(*)::integer FROM public.member_activation_events) AS activation_events,
       (SELECT count(*)::integer FROM public.user_notifications) AS notifications,
       (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations`,
  )).rows[0];
  assert.equal(Number(after.notifications), Number(before.notifications), "MIGRATION_MUST_NOT_PUSH_NOTIFICATIONS");
  assert.equal(Number(after.wallet_operations), Number(before.wallet_operations), "MIGRATION_MUST_NOT_MUTATE_WALLETS");

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
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
