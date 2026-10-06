#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002180000";
const MIGRATION_FILE = `${VERSION}_backup_restore_control_plane.sql`;
const ROLLBACK_FILE = `${VERSION}_backup_restore_control_plane.rollback.sql`;
const TABLES = [
  "backup_control_targets", "backup_control_requests", "backup_runs", "backup_artifacts",
  "backup_retention_evidence", "restore_drills", "restore_verification_checks",
  "backup_rpo_rto_receipts", "backup_control_events",
];
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");
assert.match(migrationSource, /^BEGIN;\s*/u, "MIGRATION_BEGIN_REQUIRED");
assert.match(migrationSource, /\sCOMMIT;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
assert.match(rollbackSource, /^BEGIN;\s*/u, "ROLLBACK_BEGIN_REQUIRED");
assert.match(rollbackSource, /\sCOMMIT;\s*$/u, "ROLLBACK_COMMIT_REQUIRED");
const migrationBody = migrationSource.replace(/^BEGIN;\s*/u, "").replace(/\sCOMMIT;\s*$/u, "");
const rollbackBody = rollbackSource.replace(/^BEGIN;\s*/u, "").replace(/\sCOMMIT;\s*$/u, "");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-local-backup-restore-control-plane",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

async function expectConstraintFailure(name, sql, params = []) {
  const savepoint = `probe_${name}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let rejected = false;
  try {
    await client.query(sql, params);
  } catch (error) {
    rejected = error && typeof error === "object" && error.code === "23514";
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.equal(rejected, true, `${name.toUpperCase()}_CONSTRAINT_REQUIRED`);
}

async function expectRollbackGuard() {
  await client.query("SAVEPOINT probe_rollback_guard");
  await client.query(`
    INSERT INTO public.backup_control_requests (
      target_key,operation_kind,request_status,execution_mode,plan
    ) VALUES ('database','restore_drill_plan','planned','plan_request_approval_only','{}'::jsonb)
  `);
  let rejected = false;
  try {
    await client.query(rollbackBody);
  } catch (error) {
    rejected = error && typeof error === "object"
      && error.code === "55000"
      && error.message === "BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE";
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe_rollback_guard");
    await client.query("RELEASE SAVEPOINT probe_rollback_guard");
  }
  assert.equal(rejected, true, "ROLLBACK_GUARD_MUST_PRESERVE_EVIDENCE");
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  assert.deepEqual(identity, {
    database_name: "zimeiti_local",
    server_address: "127.0.0.1",
    server_port: 54322,
  });

  const before = (await client.query(`
    SELECT ${TABLES.map((table) => `to_regclass('public.${table}') AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.ok(Object.values(before).every((value) => value === null), "ISOLATED_EMPTY_TARGET_REQUIRED");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('backup-restore-control-plane:local-probe',0))");
  await client.query(migrationBody);
  await client.query(migrationBody);

  const structure = (await client.query(`
    WITH target_tables(name) AS (VALUES
      ${TABLES.map((table) => `('${table}')`).join(",\n      ")}
    )
    SELECT
      (SELECT count(*)::integer
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN (SELECT name FROM target_tables) AND c.relkind='r') AS table_count,
      (SELECT count(*)::integer
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN (SELECT name FROM target_tables) AND c.relkind='r' AND c.relrowsecurity) AS rls_table_count,
      (SELECT count(*)::integer FROM public.backup_control_targets) AS target_count,
      (SELECT count(*)::integer FROM public.backup_control_targets WHERE operational_status='unavailable') AS unavailable_target_count,
      (SELECT count(*)::integer FROM public.backup_control_targets
        WHERE latest_successful_backup_at IS NULL AND latest_verified_at IS NULL
          AND provider_name IS NULL AND external_account_ref IS NULL
          AND external_region IS NULL AND storage_locator IS NULL) AS null_current_fact_count,
      (SELECT count(*)::integer FROM public.backup_control_requests) AS request_count,
      (SELECT count(*)::integer FROM public.backup_runs) AS run_count,
      (SELECT count(*)::integer FROM public.backup_artifacts) AS artifact_count,
      (SELECT count(*)::integer FROM public.backup_retention_evidence) AS retention_evidence_count,
      (SELECT count(*)::integer FROM public.restore_drills) AS drill_count,
      (SELECT count(*)::integer FROM public.restore_verification_checks) AS verification_check_count,
      (SELECT count(*)::integer FROM public.backup_rpo_rto_receipts) AS rpo_rto_receipt_count,
      (SELECT count(*)::integer FROM public.backup_control_events) AS event_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('service_role','public.' || name,'SELECT')) AS service_select_table_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('service_role','public.' || name,'INSERT,UPDATE,DELETE')) AS service_write_table_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('anon','public.' || name,'SELECT')) AS anon_select_table_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('authenticated','public.' || name,'SELECT')) AS authenticated_select_table_count
  `)).rows[0];
  assert.deepEqual(structure, {
    table_count: 9,
    rls_table_count: 9,
    target_count: 7,
    unavailable_target_count: 7,
    null_current_fact_count: 7,
    request_count: 0,
    run_count: 0,
    artifact_count: 0,
    retention_evidence_count: 0,
    drill_count: 0,
    verification_check_count: 0,
    rpo_rto_receipt_count: 0,
    event_count: 0,
    service_select_table_count: 9,
    service_write_table_count: 0,
    anon_select_table_count: 0,
    authenticated_select_table_count: 0,
  });

  const databaseTarget = (await client.query(`
    SELECT target_key,operational_status,status_reason,provider_name,storage_locator,
           latest_successful_backup_at,latest_verified_at,objective_rpo_seconds,objective_rto_seconds
      FROM public.backup_control_targets
     WHERE target_key='database'
  `)).rows[0];
  assert.deepEqual(databaseTarget, {
    target_key: "database",
    operational_status: "unavailable",
    status_reason: "NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE",
    provider_name: null,
    storage_locator: null,
    latest_successful_backup_at: null,
    latest_verified_at: null,
    objective_rpo_seconds: 300,
    objective_rto_seconds: 7200,
  });

  await expectConstraintFailure("invalid_target_key", `
    INSERT INTO public.backup_control_targets (
      target_key,display_name,data_class,policy_system_of_record,policy_backup_method,
      objective_rpo_label,objective_rto_label
    ) VALUES ('Bad/Target','invalid','invalid','policy','policy','none','none')
  `);
  await expectConstraintFailure("healthy_without_evidence", `
    UPDATE public.backup_control_targets SET operational_status='healthy' WHERE target_key='database'
  `);
  await expectConstraintFailure("execution_enabled", `
    INSERT INTO public.backup_control_requests (
      target_key,operation_kind,request_status,execution_mode,plan,execution_enabled
    ) VALUES ('database','backup_plan','planned','plan_request_approval_only','{}'::jsonb,true)
  `);
  await expectConstraintFailure("self_approval", `
    INSERT INTO public.backup_control_requests (
      target_key,operation_kind,request_status,execution_mode,plan,
      requested_by,requested_at,approved_by,approved_at,approval_reason
    ) VALUES (
      'database','restore_drill_plan','approved','plan_request_approval_only','{}'::jsonb,
      'same-actor',now(),'same-actor',now(),'invalid self approval'
    )
  `);
  await expectConstraintFailure("success_without_manifest", `
    INSERT INTO public.backup_runs (target_key,run_kind,environment,status)
    VALUES ('database','full','production','succeeded')
  `);
  await expectConstraintFailure("production_restore_success", `
    INSERT INTO public.restore_drills (
      target_key,status,environment_kind,isolation_verified,production_write_count
    ) VALUES ('database','succeeded','production',true,0)
  `);
  await expectConstraintFailure("verified_receipt_without_metrics", `
    WITH drill AS (
      INSERT INTO public.restore_drills (target_key,status,environment_kind)
      VALUES ('database','planned','isolated') RETURNING drill_id
    )
    INSERT INTO public.backup_rpo_rto_receipts (drill_id,target_key,status)
    SELECT drill_id,'database','verified' FROM drill
  `);

  await expectRollbackGuard();
  await client.query(rollbackBody);

  const removed = (await client.query(`
    SELECT ${TABLES.map((table) => `to_regclass('public.${table}') IS NULL AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.ok(Object.values(removed).every((value) => value === true), "ROLLBACK_MUST_REMOVE_EMPTY_CONTROL_PLANE");

  await client.query("ROLLBACK");
  transactionOpen = false;
  const after = (await client.query(`
    SELECT ${TABLES.map((table) => `to_regclass('public.${table}') AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.deepEqual(after, before, "LOCAL_PROBE_MUST_NOT_PERSIST_SCHEMA");

  process.stdout.write(`${JSON.stringify({
    passed: true,
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationApplications: 2,
    rollback: ROLLBACK_FILE,
    structure,
    constraintProbes: 7,
    rollbackGuardProbes: 1,
    rollbackRehearsal: { passed: true, persisted: false },
    backupExecutions: 0,
    restoreExecutions: 0,
    externalUploads: 0,
    productionWrites: 0,
  }, null, 2)}\n`);
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
