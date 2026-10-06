#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001070000";
const NAME = "invited_registration_package_toggle";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function bodyOf(source) {
  const normalized = source.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-member-package-automation"), "LOCAL_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const migrationHash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-member-package-automation",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('member-package-automation:20261001070000',0))");
  const prior = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(bodyOf(source));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], migrationHash, "codex-local-member-package-automation"],
    );
    action = "applied";
  }

  const schema = (await client.query(
    `SELECT
       to_regclass('public.member_package_automation_settings')::text AS settings_table,
       to_regclass('public.member_package_automation_events')::text AS events_table,
       to_regclass('public.member_package_automation_runs')::text AS runs_table,
       to_regclass('public.member_package_automation_runs_created_idx')::text AS runs_index,
       (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=ANY($1::text[])) AS function_count,
       (SELECT count(*)::integer FROM pg_trigger
         WHERE tgrelid='public.invitation_records'::regclass
           AND tgname=ANY($2::text[]) AND NOT tgisinternal) AS trigger_count`,
    [
      ["set_invited_registration_package_automation_atomic", "maybe_assign_invited_registration_welcome_package"],
      ["invitation_records_seed_reward_grants", "zz_invitation_records_auto_welcome_package"],
    ],
  )).rows[0];
  assert.equal(schema.settings_table, "member_package_automation_settings");
  assert.equal(schema.events_table, "member_package_automation_events");
  assert.equal(schema.runs_table, "member_package_automation_runs");
  assert.equal(schema.runs_index, "member_package_automation_runs_created_idx");
  assert.equal(Number(schema.function_count), 2, "PACKAGE_AUTOMATION_FUNCTIONS_REQUIRED");
  assert.equal(Number(schema.trigger_count), 2, "PACKAGE_AUTOMATION_TRIGGER_ORDER_DEPENDENCIES_REQUIRED");

  const setting = (await client.query(
    `SELECT automation_key,enabled,profile_key,revision
       FROM public.member_package_automation_settings
      WHERE automation_key='invited_registration_welcome'`,
  )).rows[0];
  assert.equal(setting.automation_key, "invited_registration_welcome");
  assert.equal(setting.profile_key, "trial_member");
  assert.equal(typeof setting.enabled, "boolean");
  assert.ok(Number(setting.revision) > 0);

  const trialTemplate = (await client.query(
    `SELECT profile_key,version,membership_status,is_active,is_selectable
       FROM public.member_permission_profiles
      WHERE profile_key='trial_member' AND is_active AND is_selectable
      ORDER BY version DESC LIMIT 1`,
  )).rows[0];
  assert.equal(trialTemplate.profile_key, "trial_member");
  assert.equal(trialTemplate.membership_status, "trial");

  const triggerDefinition = String((await client.query(
    "SELECT pg_get_functiondef('public.maybe_assign_invited_registration_welcome_package()'::regprocedure) AS definition",
  )).rows[0]?.definition || "");
  assert.match(triggerDefinition, /assign_member_package_atomic/u);
  assert.match(triggerDefinition, /auto-invited-welcome:/u);
  assert.match(triggerDefinition, /PACKAGE_AUTOMATION_PERMISSION_SNAPSHOT_MISSING/u);

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: { file: FILE, hash: migrationHash, action },
    schema,
    setting,
    trialTemplate,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "member-package-automation");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
