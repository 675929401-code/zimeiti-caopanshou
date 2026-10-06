#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002200000";
const MIGRATION_FILE = `${VERSION}_multitenant_brand_boundary.sql`;
const ROLLBACK_FILE = `${VERSION}_multitenant_brand_boundary.rollback.sql`;
const TABLES = [
  "tenants", "tenant_members", "sites", "site_hostnames", "site_brand_releases",
  "tenant_resource_integrations", "tenant_isolation_receipts", "tenant_audits",
];
const LEGACY_TABLES = [
  "users", "user_auth_sessions", "payment_orders", "conversation_messages", "user_files", "announcements",
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
  application_name: "codex-verify-local-multitenant-boundary",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

async function expectFailure(name, sql, expectedCodes, expectedMessage = null) {
  const savepoint = `probe_${name}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let rejected = false;
  try {
    await client.query(sql);
  } catch (error) {
    rejected = error && typeof error === "object"
      && expectedCodes.includes(error.code)
      && (!expectedMessage || error.message === expectedMessage);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.equal(rejected, true, `${name.toUpperCase()}_REJECTION_REQUIRED`);
}

async function expectRollbackGuard(name, fixtureSql, expectedMessage) {
  const savepoint = `probe_${name}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  await client.query(fixtureSql);
  let rejected = false;
  try {
    await client.query(rollbackBody);
  } catch (error) {
    rejected = error && typeof error === "object" && error.code === "55000" && error.message === expectedMessage;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.equal(rejected, true, `${name.toUpperCase()}_ROLLBACK_GUARD_REQUIRED`);
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

  const legacyBefore = (await client.query(`
    SELECT ${LEGACY_TABLES.map((table) => `(SELECT count(*)::bigint FROM public.${table})::text AS ${table}`).join(",\n           ")}
  `)).rows[0];

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('multitenant-boundary:local-probe',0))");
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
      (SELECT count(*)::integer FROM public.tenants) AS tenant_count,
      (SELECT count(*)::integer FROM public.tenants WHERE tenant_key='default' AND operating_mode='single_tenant' AND boundary_status='unavailable') AS single_tenant_fact_count,
      (SELECT count(*)::integer FROM public.tenant_members) AS member_count,
      (SELECT count(*)::integer FROM public.sites) AS site_count,
      (SELECT count(*)::integer FROM public.sites WHERE site_key='default' AND tenant_key='default' AND lifecycle_status='foundation_only') AS default_site_fact_count,
      (SELECT count(*)::integer FROM public.site_hostnames) AS hostname_count,
      (SELECT count(*)::integer FROM public.site_brand_releases) AS brand_release_count,
      (SELECT count(*)::integer FROM public.tenant_resource_integrations) AS resource_count,
      (SELECT count(*)::integer FROM public.tenant_resource_integrations WHERE integration_status='unintegrated') AS unintegrated_resource_count,
      (SELECT count(*)::integer FROM public.tenant_resource_integrations WHERE database_policy_status='tenant_rls_verified') AS tenant_rls_verified_count,
      (SELECT count(*)::integer FROM public.tenant_isolation_receipts) AS isolation_receipt_count,
      (SELECT count(*)::integer FROM public.tenant_audits) AS audit_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('service_role','public.' || name,'SELECT')) AS service_select_table_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('service_role','public.' || name,'INSERT,UPDATE,DELETE')) AS service_write_table_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('anon','public.' || name,'SELECT')) AS anon_select_table_count,
      (SELECT count(*)::integer FROM target_tables
        WHERE has_table_privilege('authenticated','public.' || name,'SELECT')) AS authenticated_select_table_count,
      (SELECT count(*)::integer FROM pg_policy p
        JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN (SELECT name FROM target_tables)) AS client_policy_count
  `)).rows[0];
  assert.deepEqual(structure, {
    table_count: 8,
    rls_table_count: 8,
    tenant_count: 1,
    single_tenant_fact_count: 1,
    member_count: 0,
    site_count: 1,
    default_site_fact_count: 1,
    hostname_count: 0,
    brand_release_count: 0,
    resource_count: 18,
    unintegrated_resource_count: 18,
    tenant_rls_verified_count: 0,
    isolation_receipt_count: 0,
    audit_count: 0,
    service_select_table_count: 8,
    service_write_table_count: 0,
    anon_select_table_count: 0,
    authenticated_select_table_count: 0,
    client_policy_count: 0,
  });

  const legacyAfter = (await client.query(`
    SELECT ${LEGACY_TABLES.map((table) => `(SELECT count(*)::bigint FROM public.${table})::text AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.deepEqual(legacyAfter, legacyBefore, "MIGRATION_MUST_NOT_REASSIGN_LEGACY_ROWS");

  const defaultFacts = (await client.query(`
    SELECT t.tenant_key,t.lifecycle_status,t.operating_mode,t.boundary_status,t.session_claim_status,
           t.business_read_scope_status,t.business_write_scope_status,t.cross_tenant_test_status,
           s.site_key,s.routing_status,s.brand_scope_status,
           t.metadata->>'legacyRowsAttached' AS legacy_rows_attached,
           s.metadata->>'hostAuthorizationEnabled' AS host_authorization_enabled
      FROM public.tenants t JOIN public.sites s ON s.tenant_key=t.tenant_key
     WHERE t.tenant_key='default' AND s.site_key='default'
  `)).rows[0];
  assert.deepEqual(defaultFacts, {
    tenant_key: "default",
    lifecycle_status: "foundation_only",
    operating_mode: "single_tenant",
    boundary_status: "unavailable",
    session_claim_status: "unavailable",
    business_read_scope_status: "unavailable",
    business_write_scope_status: "unavailable",
    cross_tenant_test_status: "not_run",
    site_key: "default",
    routing_status: "unavailable",
    brand_scope_status: "unavailable",
    legacy_rows_attached: "false",
    host_authorization_enabled: "false",
  });

  await expectFailure("invalid_tenant_key", `
    INSERT INTO public.tenants (tenant_key,display_name) VALUES ('Bad/Tenant','invalid')
  `, ["23514"]);
  await expectFailure("verified_tenant_without_evidence", `
    INSERT INTO public.tenants (
      tenant_key,display_name,lifecycle_status,operating_mode,boundary_status,
      session_claim_status,business_read_scope_status,business_write_scope_status,cross_tenant_test_status
    ) VALUES ('tenant-a','Tenant A','active','multi_tenant','verified','verified','verified','verified','passed')
  `, ["23514"]);
  await expectFailure("active_member_without_identity_evidence", `
    INSERT INTO public.tenant_members (tenant_key,user_id,role_key,membership_status)
    VALUES ('default','user-1','owner','active')
  `, ["23514"]);
  await expectFailure("verified_site_without_routing_evidence", `
    INSERT INTO public.sites (site_key,tenant_key,display_name,lifecycle_status,routing_status)
    VALUES ('site-a','default','Site A','active','verified')
  `, ["23514"]);
  await expectFailure("host_authorization_forbidden", `
    INSERT INTO public.site_hostnames (hostname,site_key,tenant_key,hostname_kind,authorization_eligible)
    VALUES ('example.test','default','default','custom',true)
  `, ["23514"]);
  await expectFailure("host_port_forbidden", `
    INSERT INTO public.site_hostnames (hostname,site_key,tenant_key,hostname_kind)
    VALUES ('example.test:443','default','default','custom')
  `, ["23514"]);
  await expectFailure("site_tenant_mismatch", `
    INSERT INTO public.site_hostnames (hostname,site_key,tenant_key,hostname_kind)
    VALUES ('mismatch.example','default','tenant-other','custom')
  `, ["23503"]);
  await expectFailure("published_brand_without_evidence", `
    INSERT INTO public.site_brand_releases (tenant_key,site_key,release_status)
    VALUES ('default','default','published')
  `, ["23514"]);
  await expectFailure("integrated_resource_without_evidence", `
    UPDATE public.tenant_resource_integrations SET
      tenant_scope_status='verified',tenant_column='tenant_id',
      site_scope_requirement='not_required',site_scope_status='not_required',
      read_scope_status='verified',write_scope_status='verified',
      database_policy_status='tenant_rls_verified',session_claim_status='verified',
      cross_tenant_test_status='passed',integration_status='integrated'
    WHERE resource_key='users-table'
  `, ["23514"]);
  await expectFailure("same_tenant_receipt", `
    INSERT INTO public.tenant_isolation_receipts (tenant_a_key,tenant_b_key,test_scope)
    VALUES ('default','default','invalid')
  `, ["23514"]);
  await expectFailure("audit_immutable", `
    DO $probe$
    DECLARE v_audit_id uuid;
    BEGIN
      INSERT INTO public.tenant_audits (tenant_key,action_key,result,reason_code,resource_type)
      VALUES ('default','probe','info','PROBE','tenant') RETURNING audit_id INTO v_audit_id;
      UPDATE public.tenant_audits SET reason_code='CHANGED' WHERE audit_id=v_audit_id;
    END;
    $probe$;
  `, ["55000"], "TENANT_AUDIT_IMMUTABLE");

  await expectRollbackGuard(
    "evidence_row",
    "INSERT INTO public.tenant_members (tenant_key,user_id,role_key) VALUES ('default','user-rollback-probe','viewer')",
    "MULTITENANT_ROLLBACK_REFUSED_EVIDENCE_EXISTS",
  );
  await expectRollbackGuard(
    "integration_revision",
    "UPDATE public.tenant_resource_integrations SET integration_status='partial' WHERE resource_key='users-table'",
    "MULTITENANT_ROLLBACK_REFUSED_INTEGRATION_EVIDENCE_EXISTS",
  );

  await client.query(rollbackBody);
  const removed = (await client.query(`
    SELECT ${TABLES.map((table) => `to_regclass('public.${table}') IS NULL AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.ok(Object.values(removed).every((value) => value === true), "ROLLBACK_MUST_REMOVE_UNTOUCHED_FOUNDATION");

  await client.query("ROLLBACK");
  transactionOpen = false;
  const after = (await client.query(`
    SELECT ${TABLES.map((table) => `to_regclass('public.${table}') AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.deepEqual(after, before, "LOCAL_PROBE_MUST_NOT_PERSIST_SCHEMA");

  const legacyFinal = (await client.query(`
    SELECT ${LEGACY_TABLES.map((table) => `(SELECT count(*)::bigint FROM public.${table})::text AS ${table}`).join(",\n           ")}
  `)).rows[0];
  assert.deepEqual(legacyFinal, legacyBefore, "LOCAL_PROBE_MUST_NOT_PERSIST_LEGACY_WRITES");

  process.stdout.write(`${JSON.stringify({
    passed: true,
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationApplications: 2,
    rollback: ROLLBACK_FILE,
    structure,
    constraintProbes: 11,
    rollbackGuardProbes: 2,
    rollbackRehearsal: { passed: true, persisted: false },
    legacyRowMutations: 0,
    businessWrites: 0,
    hostAuthorizationDecisions: 0,
    productionWrites: 0,
  }, null, 2)}\n`);
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
