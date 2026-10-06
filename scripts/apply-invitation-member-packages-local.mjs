#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const migrations = [
  ["20261001062000", "invitation_recipient_gift_split"],
  ["20261001063000", "member_package_templates"],
  ["20261001113000", "cami_package_profile_snapshots"],
  ["20261001114500", "invitation_reward_custom_notification_body"],
].map(([version, name]) => ({ version, name, file: `${version}_${name}.sql` }));
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function bodyOf(source) {
  const normalized = source.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-invitation-member-packages"), "LOCAL_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const sources = [];
for (const migration of migrations) {
  const source = await fs.readFile(path.resolve("supabase/migrations", migration.file), "utf8");
  sources.push({
    ...migration,
    source,
    hash: crypto.createHash("sha256").update(source).digest("hex"),
  });
}

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-invitation-member-packages",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let open = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");

  await client.query("BEGIN");
  open = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [261001063000]);
  const applied = [];
  for (const migration of sources) {
    const prior = await client.query(
      "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [migration.version],
    );
    let action = "already_applied";
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), migration.hash, `MIGRATION_LEDGER_HASH_CONFLICT:${migration.file}`);
    } else {
      await client.query(bodyOf(migration.source));
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [migration.version, migration.name, [migration.file], migration.hash, "codex-local-invitation-member-packages"],
      );
      action = "applied";
    }
    applied.push({ file: migration.file, hash: migration.hash, action });
  }

  const rewardInvariant = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.invitation_records) AS relations,
       (SELECT count(*)::integer FROM public.invitation_reward_grants) AS grants,
       (SELECT count(*)::integer FROM (
          SELECT invitation_record_id
          FROM public.invitation_reward_grants
          GROUP BY invitation_record_id
          HAVING count(*) <> 3
       ) broken) AS broken_stage_counts,
       (SELECT count(*)::integer
          FROM public.invitation_reward_grants g
          JOIN public.invitation_records r ON r.id=g.invitation_record_id
         WHERE (g.reward_stage='invitee_welcome' AND g.recipient_user_id::text<>r.invitee_id::text)
            OR (g.reward_stage IN ('registration','activation') AND g.recipient_user_id::text<>r.inviter_id::text)
       ) AS recipient_mismatches`,
  )).rows[0];
  assert.equal(Number(rewardInvariant.broken_stage_counts), 0, "THREE_REWARD_STAGES_REQUIRED");
  assert.equal(Number(rewardInvariant.recipient_mismatches), 0, "REWARD_RECIPIENTS_MUST_MATCH_STAGE");

  const packageInvariant = (await client.query(
    `SELECT
       to_regclass('public.member_permission_resources')::text AS resources_table,
       to_regclass('public.member_package_assignments')::text AS assignments_table,
       (SELECT count(*)::integer FROM public.member_permission_resources) AS resource_count,
       (SELECT count(*)::integer FROM public.member_permission_profiles WHERE is_active AND is_selectable) AS selectable_templates,
       (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=ANY($1::text[])) AS function_count`,
    [["create_member_package_profile_version_atomic", "assign_member_package_atomic"]],
  )).rows[0];
  assert.equal(packageInvariant.resources_table, "member_permission_resources", "RESOURCE_CATALOG_REQUIRED");
  assert.equal(packageInvariant.assignments_table, "member_package_assignments", "PACKAGE_ASSIGNMENTS_REQUIRED");
  assert.ok(Number(packageInvariant.resource_count) >= 14, "CURRENT_RESOURCE_CATALOG_REQUIRED");
  assert.ok(Number(packageInvariant.selectable_templates) >= 3, "THREE_SELECTABLE_TEMPLATES_REQUIRED");
  assert.equal(Number(packageInvariant.function_count), 2, "PACKAGE_RPC_REQUIRED");

  const camiInvariant = (await client.query(
    `SELECT
       count(*) FILTER (WHERE column_name IN (
         'profile_key','profile_version','feature_navigation_keys','created_by',
         'redemption_notification_id','package_assignment_id'
       ))::integer AS snapshot_columns,
       pg_get_functiondef('public.assign_cami_to_user_atomic(text,text,text,text)'::regprocedure) AS assignment_definition,
       pg_get_functiondef('public.redeem_cami_membership_atomic(text,text,text)'::regprocedure) AS redemption_definition,
       pg_get_functiondef('public.send_invitation_reward_atomic(text,text,text,text)'::regprocedure) AS reward_definition
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cami_codes'`,
  )).rows[0];
  assert.equal(Number(camiInvariant.snapshot_columns), 6, "CAMI_PACKAGE_SNAPSHOT_COLUMNS_REQUIRED");
  assert.match(camiInvariant.assignment_definition, /CAMI_ASSIGNMENT_PENDING_EXISTS/u, "CAMI_DUPLICATE_PENDING_GUARD_REQUIRED");
  assert.match(camiInvariant.redemption_definition, /member_package_assignments/u, "CAMI_PACKAGE_RECEIPT_REQUIRED");
  assert.match(camiInvariant.redemption_definition, /set_member_permissions_atomic/u, "CAMI_PERMISSION_SNAPSHOT_APPLY_REQUIRED");
  assert.match(camiInvariant.redemption_definition, /set_member_activation_state_atomic/u, "CAMI_ACTIVATION_RECEIPT_REQUIRED");
  assert.match(camiInvariant.reward_definition, /WHEN nullif\(btrim\(v_grant.note\), ''\) IS NOT NULL/u, "REWARD_TEMPLATE_NOTIFICATION_BODY_REQUIRED");

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  open = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migrations: applied,
    rewardInvariant,
    packageInvariant,
    camiInvariant: {
      snapshotColumns: Number(camiInvariant.snapshot_columns),
      duplicatePendingGuard: true,
      packageReceipt: true,
      permissionSnapshotApply: true,
      activationReceipt: true,
      rewardTemplateNotificationBody: true,
    },
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "invitation-member-packages");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (open) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
