#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001204000";
const NAME = "invitation_pending_ledger_consistency";
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
assert.ok(process.argv.includes("--confirm-local-invitation-ledger"), "LOCAL_INVITATION_LEDGER_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-invitation-pending-ledger",
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
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('invitation-pending-ledger:20261001204000',0))");
  const prior = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, `MIGRATION_LEDGER_HASH_CONFLICT:${FILE}`);
  } else {
    await client.query(bodyOf(source));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-invitation-pending-ledger"],
    );
    action = "applied";
  }

  const schema = (await client.query(
    `SELECT
       to_regprocedure('public.sync_invitation_welcome_reward_from_package_assignment()')::text AS function_name,
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgrelid='public.member_package_assignments'::regclass
           AND tgname='member_package_assignments_sync_invitation_welcome'
           AND NOT tgisinternal
       ) AS trigger_ready`,
  )).rows[0];
  assert.equal(schema.function_name, "sync_invitation_welcome_reward_from_package_assignment()");
  assert.equal(schema.trigger_ready, true);

  const consistency = (await client.query(
    `SELECT
       count(*) FILTER (
         WHERE assignment.id IS NOT NULL
           AND (grant_row.status <> 'sent' OR grant_row.package_assignment_id IS DISTINCT FROM assignment.id)
       )::integer AS package_reward_mismatches,
       count(*) FILTER (
         WHERE relation.reward_sent IS DISTINCT FROM NOT EXISTS (
           SELECT 1 FROM public.invitation_reward_grants unresolved
           WHERE unresolved.invitation_record_id=relation.id
             AND unresolved.eligibility_at IS NOT NULL
             AND unresolved.status NOT IN ('sent','skipped')
         )
       )::integer AS relation_summary_mismatches
     FROM public.invitation_records relation
     LEFT JOIN LATERAL (
       SELECT package_row.* FROM public.member_package_assignments package_row
       WHERE package_row.invitation_record_id=relation.id
       ORDER BY package_row.created_at DESC,package_row.id DESC LIMIT 1
     ) assignment ON true
     LEFT JOIN public.invitation_reward_grants grant_row
       ON grant_row.invitation_record_id=relation.id
      AND grant_row.reward_stage='invitee_welcome'`,
  )).rows[0];
  assert.equal(Number(consistency.package_reward_mismatches), 0, "PACKAGE_REWARD_STATUS_MISMATCH");
  assert.equal(Number(consistency.relation_summary_mismatches), 0, "RELATION_SUMMARY_STATUS_MISMATCH");

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: { file: FILE, hash, action },
    schema,
    consistency,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "invitation-pending-ledger");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
