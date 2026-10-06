#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002143000";
const MIGRATION_FILE = `${VERSION}_project_registry_control_plane.sql`;
const ROLLBACK_FILE = `${VERSION}_project_registry_control_plane.rollback.sql`;
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
const migrationBody = migrationSource
  .replace(/^BEGIN;\s*/u, "")
  .replace(/\sCOMMIT;\s*$/u, "");
const rollbackBody = rollbackSource
  .replace(/^BEGIN;\s*/u, "")
  .replace(/\sCOMMIT;\s*$/u, "");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-local-project-registry",
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
    UPDATE public.project_registry
       SET responsible_owner='local-probe'
     WHERE project_key='zimeiti-caopanshou'
  `);
  let rejected = false;
  try {
    await client.query(rollbackBody);
  } catch (error) {
    rejected = error && typeof error === "object"
      && error.code === "55000"
      && error.message === "PROJECT_REGISTRY_ROLLBACK_REQUIRES_UNCHANGED_PROJECT_SEED";
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe_rollback_guard");
    await client.query("RELEASE SAVEPOINT probe_rollback_guard");
  }
  assert.equal(rejected, true, "ROLLBACK_GUARD_MUST_REJECT_CHANGED_SEED");
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
    SELECT to_regclass('public.project_registry') AS projects,
           to_regclass('public.project_workspace_registry') AS workspaces,
           to_regclass('public.project_source_registry') AS sources
  `)).rows[0];
  assert.deepEqual(before, { projects: null, workspaces: null, sources: null }, "ISOLATED_EMPTY_TARGET_REQUIRED");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('project-registry-control-plane:local-probe',0))");
  await client.query(migrationBody);
  await client.query(migrationBody);

  const structure = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relname IN ('project_registry','project_workspace_registry','project_source_registry')
          AND c.relkind='r') AS table_count,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relname IN ('project_registry','project_workspace_registry','project_source_registry')
          AND c.relkind='r' AND c.relrowsecurity) AS rls_table_count,
      (SELECT count(*)::integer FROM public.project_registry) AS project_count,
      (SELECT count(*)::integer FROM public.project_workspace_registry) AS workspace_count,
      (SELECT count(*)::integer FROM public.project_source_registry) AS source_count,
      (SELECT count(*)::integer FROM public.project_source_registry WHERE mapping_status='mapped') AS mapped_source_count,
      (SELECT count(*)::integer FROM public.project_source_registry WHERE mapping_status='unregistered') AS unregistered_source_count,
      (SELECT count(*)::integer FROM public.project_workspace_registry w
        JOIN public.project_registry p ON p.project_key=w.project_key
        WHERE w.workspace_key=w.project_key AND w.mapping_status='mapped') AS exact_workspace_count,
      has_table_privilege('service_role','public.project_registry','SELECT') AS service_can_read_projects,
      has_table_privilege('service_role','public.project_workspace_registry','SELECT') AS service_can_read_workspaces,
      has_table_privilege('service_role','public.project_source_registry','SELECT') AS service_can_read_sources,
      has_table_privilege('anon','public.project_registry','SELECT') AS anon_can_read_projects,
      has_table_privilege('authenticated','public.project_registry','SELECT') AS authenticated_can_read_projects
  `)).rows[0];
  assert.deepEqual(structure, {
    table_count: 3,
    rls_table_count: 3,
    project_count: 10,
    workspace_count: 9,
    source_count: 10,
    mapped_source_count: 0,
    unregistered_source_count: 10,
    exact_workspace_count: 9,
    service_can_read_projects: true,
    service_can_read_workspaces: true,
    service_can_read_sources: true,
    anon_can_read_projects: false,
    authenticated_can_read_projects: false,
  });

  const rootProject = (await client.query(`
    SELECT project_key,parent_project_key,display_name,internal_name,primary_route,
           responsible_owner,lifecycle_status,registration_status,
           accepts_new_business,sla_profile,tenant_support,allowed_message_surfaces
      FROM public.project_registry
     WHERE project_key='zimeiti-caopanshou'
  `)).rows[0];
  assert.deepEqual(rootProject, {
    project_key: "zimeiti-caopanshou",
    parent_project_key: null,
    display_name: "自媒体操盘手",
    internal_name: "zimeiti-caopanshou",
    primary_route: null,
    responsible_owner: null,
    lifecycle_status: "active",
    registration_status: "partial",
    accepts_new_business: true,
    sla_profile: { status: "unregistered" },
    tenant_support: "unknown",
    allowed_message_surfaces: [],
  });

  await expectConstraintFailure("invalid_project_key", `
    INSERT INTO public.project_registry (
      project_key,display_name,internal_name,lifecycle_status,registration_status,
      accepts_new_business,sla_profile,tenant_support
    ) VALUES ('Bad/Key','invalid','invalid_key','active','partial',true,'{"status":"unregistered"}'::jsonb,'unknown')
  `);
  await expectConstraintFailure("paused_accepts_business", `
    INSERT INTO public.project_registry (
      project_key,parent_project_key,display_name,internal_name,lifecycle_status,
      registration_status,accepts_new_business,sla_profile,tenant_support
    ) VALUES ('paused_probe','zimeiti-caopanshou','paused probe','paused_probe','paused','partial',true,'{"status":"unregistered"}'::jsonb,'unknown')
  `);
  await expectConstraintFailure("mapped_source_without_key", `
    INSERT INTO public.project_source_registry (
      source_kind,source_key,project_key,mapping_status,project_key_field,evidence_path,reason_code
    ) VALUES ('task','invalid_probe',NULL,'mapped',NULL,'local-probe','PROJECT_KEY_VERIFIED')
  `);

  await expectRollbackGuard();

  await client.query(rollbackBody);
  const removed = (await client.query(`
    SELECT to_regclass('public.project_registry') IS NULL AS projects_removed,
           to_regclass('public.project_workspace_registry') IS NULL AS workspaces_removed,
           to_regclass('public.project_source_registry') IS NULL AS sources_removed
  `)).rows[0];
  assert.deepEqual(removed, {
    projects_removed: true,
    workspaces_removed: true,
    sources_removed: true,
  });

  await client.query("ROLLBACK");
  transactionOpen = false;
  const after = (await client.query(`
    SELECT to_regclass('public.project_registry') AS projects,
           to_regclass('public.project_workspace_registry') AS workspaces,
           to_regclass('public.project_source_registry') AS sources
  `)).rows[0];
  assert.deepEqual(after, before, "LOCAL_PROBE_MUST_NOT_PERSIST_SCHEMA");

  process.stdout.write(`${JSON.stringify({
    passed: true,
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationApplications: 2,
    rollback: ROLLBACK_FILE,
    structure,
    constraintProbes: 3,
    rollbackGuardProbes: 1,
    rollbackRehearsal: { passed: true, persisted: false },
    productionWrites: 0,
    paidCalls: 0,
  }, null, 2)}\n`);
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
