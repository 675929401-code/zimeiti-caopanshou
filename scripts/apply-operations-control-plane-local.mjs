#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const apply = process.argv.includes("--apply");

if (apply) {
  assert.ok(
    process.argv.includes("--confirm-local-operations-control-plane"),
    "LOCAL_OPERATIONS_CONTROL_PLANE_CONFIRMATION_REQUIRED",
  );
}

const migrations = [
  {
    version: "20261002170000",
    name: "incident_slo_control_plane",
    serviceTableAccess: "none",
    tables: [
      "incident_slo_services",
      "incident_slo_definitions",
      "incident_slo_maintenance_windows",
      "incident_slo_measurements",
      "incident_slo_incidents",
      "incident_slo_alerts",
      "incident_slo_incident_events",
      "incident_slo_recovery_probes",
      "incident_slo_postmortems",
      "incident_slo_action_requests",
      "incident_slo_audit_events",
    ],
    functions: [
      { name: "reject_incident_slo_immutable_mutation", serviceExecute: false },
      { name: "record_incident_slo_observation_atomic", serviceExecute: true },
      { name: "claim_incident_slo_incident_cas", serviceExecute: true },
      { name: "request_incident_slo_recovery_probe", serviceExecute: true },
      { name: "record_incident_slo_recovery_probe_result_cas", serviceExecute: true },
      { name: "transition_incident_slo_incident_cas", serviceExecute: true },
      { name: "register_incident_slo_action_request", serviceExecute: true },
      { name: "link_incident_slo_postmortem_cas", serviceExecute: true },
      { name: "get_incident_slo_status", serviceExecute: true },
    ],
  },
  {
    version: "20261002180000",
    name: "backup_restore_control_plane",
    serviceTableAccess: "select",
    tables: [
      "backup_control_targets",
      "backup_control_requests",
      "backup_runs",
      "backup_artifacts",
      "backup_retention_evidence",
      "restore_drills",
      "restore_verification_checks",
      "backup_rpo_rto_receipts",
      "backup_control_events",
    ],
    functions: [],
  },
  {
    version: "20261002190000",
    name: "security_event_reliability",
    serviceTableAccess: "select",
    tables: [
      "security_event_retention_policies",
      "security_event_outbox",
      "security_event_delivery_attempts",
      "security_event_dead_letters",
      "security_rate_limit_windows",
      "security_ip_risk_state",
    ],
    functions: [
      { name: "security_reliability_text_is_safe", serviceExecute: false },
      { name: "guard_security_reliability_write", serviceExecute: false },
      { name: "guard_security_reliability_append_only", serviceExecute: false },
      { name: "enqueue_security_event_atomic", serviceExecute: true },
      { name: "claim_security_event_outbox_batch", serviceExecute: true },
      { name: "settle_security_event_outbox_attempt", serviceExecute: true },
      { name: "consume_security_rate_limit_atomic", serviceExecute: true },
      { name: "get_security_event_reliability_status", serviceExecute: true },
    ],
  },
  {
    version: "20261002200000",
    name: "multitenant_brand_boundary",
    serviceTableAccess: "select",
    tables: [
      "tenants",
      "tenant_members",
      "sites",
      "site_hostnames",
      "site_brand_releases",
      "tenant_resource_integrations",
      "tenant_isolation_receipts",
      "tenant_audits",
    ],
    functions: [
      { name: "reject_tenant_audit_mutation", serviceExecute: false },
      { name: "bump_multitenant_record_revision", serviceExecute: false },
    ],
  },
  {
    version: "20261002210000",
    name: "domain_tls_brand_release_control_plane",
    serviceTableAccess: "none",
    tables: [
      "domain_claims",
      "domain_hostnames",
      "domain_verification_attempts",
      "domain_tls_probes",
      "domain_brand_release_bindings",
      "domain_release_audits",
    ],
    functions: [
      { name: "is_valid_domain_ascii_hostname", serviceExecute: false },
      { name: "is_reserved_domain_ascii_hostname", serviceExecute: false },
      { name: "enforce_domain_site_tenant_consistency", serviceExecute: false },
      { name: "reject_domain_release_evidence_mutation", serviceExecute: false },
      { name: "get_domain_tls_brand_release_status", serviceExecute: true },
    ],
  },
].map((migration) => ({
  ...migration,
  file: `${migration.version}_${migration.name}.sql`,
}));

function stripTransactionWrapper(source, file) {
  assert.match(source, /^BEGIN;\s*/u, `${file}:BEGIN_REQUIRED`);
  assert.match(source, /\sCOMMIT;\s*$/u, `${file}:COMMIT_REQUIRED`);
  return source.replace(/^BEGIN;\s*/u, "").replace(/\sCOMMIT;\s*$/u, "");
}

async function objectState(client, migration) {
  const tableRows = (await client.query(`
    SELECT c.relname AS name,
           c.relrowsecurity AS rls_enabled,
           has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
           has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
           has_table_privilege('service_role', c.oid, 'SELECT') AS service_select,
           has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert,
           has_table_privilege('service_role', c.oid, 'UPDATE') AS service_update,
           has_table_privilege('service_role', c.oid, 'DELETE') AS service_delete,
           has_table_privilege('service_role', c.oid, 'TRUNCATE') AS service_truncate,
           has_table_privilege('service_role', c.oid, 'REFERENCES') AS service_references,
           has_table_privilege('service_role', c.oid, 'TRIGGER') AS service_trigger
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname
  `, [migration.tables])).rows;
  const functionRows = migration.functions.length
    ? (await client.query(`
        SELECT p.proname AS name,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = ANY($1::text[])
         ORDER BY p.proname
      `, [migration.functions.map((item) => item.name)])).rows
    : [];
  return {
    tables: tableRows.map((row) => ({
      name: row.name,
      rlsEnabled: row.rls_enabled === true,
      anonSelect: row.anon_select === true,
      authenticatedSelect: row.authenticated_select === true,
      serviceSelect: row.service_select === true,
      serviceDml: [
        row.service_insert,
        row.service_update,
        row.service_delete,
        row.service_truncate,
        row.service_references,
        row.service_trigger,
      ].some(Boolean),
    })),
    functions: functionRows.map((row) => ({
      name: row.name,
      anonExecute: row.anon_execute === true,
      authenticatedExecute: row.authenticated_execute === true,
      serviceExecute: row.service_execute === true,
    })),
  };
}

function assertCompleteState(migration, state) {
  assert.deepEqual(
    state.tables.map((row) => row.name),
    [...migration.tables].sort(),
    `${migration.version}:TABLE_SET_INCOMPLETE`,
  );
  assert.ok(state.tables.every((row) => row.rlsEnabled), `${migration.version}:RLS_REQUIRED`);
  assert.ok(
    state.tables.every((row) => !row.anonSelect && !row.authenticatedSelect),
    `${migration.version}:CLIENT_SELECT_MUST_BE_REVOKED`,
  );
  assert.ok(state.tables.every((row) => !row.serviceDml), `${migration.version}:SERVICE_DIRECT_DML_MUST_BE_REVOKED`);
  assert.ok(
    state.tables.every((row) => row.serviceSelect === (migration.serviceTableAccess === "select")),
    `${migration.version}:SERVICE_TABLE_ACCESS_MISMATCH`,
  );
  assert.deepEqual(
    state.functions.map((row) => row.name),
    migration.functions.map((item) => item.name).sort(),
    `${migration.version}:FUNCTION_SET_INCOMPLETE`,
  );
  for (const expected of migration.functions) {
    const actual = state.functions.find((item) => item.name === expected.name);
    assert.ok(actual, `${migration.version}:${expected.name}:FUNCTION_REQUIRED`);
    assert.equal(actual.anonExecute, false, `${migration.version}:${expected.name}:ANON_EXECUTE_REVOKE_REQUIRED`);
    assert.equal(actual.authenticatedExecute, false, `${migration.version}:${expected.name}:AUTH_EXECUTE_REVOKE_REQUIRED`);
    assert.equal(actual.serviceExecute, expected.serviceExecute, `${migration.version}:${expected.name}:SERVICE_EXECUTE_MISMATCH`);
  }
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const sources = new Map();
for (const migration of migrations) {
  const source = await fs.readFile(path.resolve("supabase/migrations", migration.file), "utf8");
  sources.set(migration.version, {
    source,
    body: stripTransactionWrapper(source, migration.file),
    hash: crypto.createHash("sha256").update(source).digest("hex"),
  });
}

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-operations-control-plane",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port,
           current_user AS database_user,
           current_setting('server_version') AS server_version
  `)).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(identity.server_address, "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(
    (await client.query("SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name")).rows[0]?.name,
    "supabase_migrations.schema_migrations",
    "MIGRATION_LEDGER_REQUIRED",
  );

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('operations-control-plane:20261002',0))");
  const actions = [];
  for (const migration of migrations) {
    const source = sources.get(migration.version);
    const ledger = await client.query(
      "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1 FOR UPDATE",
      [migration.version],
    );
    const before = await objectState(client, migration);
    if (ledger.rowCount) {
      assert.equal(String(ledger.rows[0].hash || ""), source.hash, `${migration.version}:MIGRATION_LEDGER_HASH_CONFLICT`);
      assertCompleteState(migration, before);
      actions.push({ version: migration.version, action: "already_applied", hash: source.hash });
      continue;
    }
    assert.equal(before.tables.length, 0, `${migration.version}:UNLEDGERED_TABLES_PRESENT`);
    assert.equal(before.functions.length, 0, `${migration.version}:UNLEDGERED_FUNCTIONS_PRESENT`);
    await client.query(source.body);
    assertCompleteState(migration, await objectState(client, migration));
    if (apply) {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [migration.version, migration.name, [migration.file], source.hash, "codex-local-operations-control-plane"],
      );
    }
    actions.push({ version: migration.version, action: apply ? "applied" : "validated_then_rolled_back", hash: source.hash });
  }

  if (apply) {
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  transactionOpen = false;

  const finalStates = [];
  for (const migration of migrations) {
    const state = await objectState(client, migration);
    const ledger = (await client.query(
      "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [migration.version],
    )).rows[0] || null;
    if (apply) {
      assertCompleteState(migration, state);
      assert.equal(String(ledger?.hash || ""), sources.get(migration.version).hash, `${migration.version}:COMMITTED_LEDGER_HASH_MISMATCH`);
    }
    finalStates.push({
      version: migration.version,
      name: migration.name,
      tables: state.tables,
      functions: state.functions,
      ledger: ledger ? {
        version: String(ledger.version),
        name: ledger.name,
        hash: ledger.hash,
        appliedBy: ledger.applied_by,
        appliedAt: ledger.applied_at,
      } : null,
    });
  }

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    mode: apply ? "apply" : "check-rollback",
    identity: {
      databaseName: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: Number(identity.server_port),
      databaseUser: identity.database_user,
      serverVersion: identity.server_version,
    },
    actions,
    finalStates,
    backupTargetSeedRows: actions.some((item) => item.version === "20261002180000" && item.action === "applied") ? 7 : 0,
    migrationLedgerWrites: actions.filter((item) => item.action === "applied").length,
    incidentFixtures: 0,
    securityReliabilityFixtures: 0,
    tenantBoundaryFixtures: 0,
    domainReleaseFixtures: 0,
    backupExecutions: 0,
    restoreExecutions: 0,
    externalUploads: 0,
    businessDataWrites: 0,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "operations-control-plane-local");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, apply ? "migration-apply.json" : "migration-check.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
