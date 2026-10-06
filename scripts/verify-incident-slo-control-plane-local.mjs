#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002170000";
const MIGRATION_FILE = `${VERSION}_incident_slo_control_plane.sql`;
const ROLLBACK_FILE = `${VERSION}_incident_slo_control_plane.rollback.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_FIXTURE_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-incident-slo-control-plane"),
  "LOCAL_INCIDENT_SLO_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");

function transactionBody(source, label) {
  const withoutBegin = source.replace(/^\uFEFF?BEGIN;\s*/u, "");
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/u, "");
  assert.notEqual(withoutBegin, source, `${label}_BEGIN_REQUIRED`);
  assert.notEqual(withoutCommit, withoutBegin, `${label}_COMMIT_REQUIRED`);
  return withoutCommit;
}

const migrationBody = transactionBody(migrationSource, "MIGRATION");
const rollbackBody = transactionBody(rollbackSource, "ROLLBACK");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const rollbackHash = crypto.createHash("sha256").update(rollbackSource).digest("hex");
const suffix = crypto.randomUUID().replace(/-/gu, "").slice(0, 12);
const fingerprint = crypto.createHash("sha256").update(`verify:incident:${suffix}`).digest("hex");
const maintenanceFingerprint = crypto.createHash("sha256").update(`verify:maintenance:${suffix}`).digest("hex");
const tables = [
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
];

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-incident-slo-verification",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

async function assertLocalIdentity() {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
}

async function relationCount() {
  return Number((await client.query(
    `SELECT count(*)::integer AS count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
    [tables],
  )).rows[0]?.count || 0);
}

function observation(overrides = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60_000);
  return {
    serviceKey: `verify.service.${suffix}`,
    sloKey: `verify.slo.${suffix}`,
    idempotencyKey: `verify:measurement:${suffix}:base`,
    windowKind: "5m",
    windowStartedAt: start.toISOString(),
    windowEndedAt: end.toISOString(),
    sourceStatus: "available",
    sliValue: 0.8,
    goodCount: 80,
    totalCount: 100,
    burnRate: 5,
    errorBudgetRemainingRatio: 0.25,
    violated: true,
    sourceAsOf: end.toISOString(),
    freshnessSeconds: 0,
    coverageRatio: 1,
    sourceReference: { kind: "transaction_probe" },
    alertFingerprint: fingerprint,
    alertSeverity: "P1",
    alertSummary: "Local transaction probe",
    actorId: "codex-local-probe",
    traceId: `verify-trace-${suffix}`,
    ...overrides,
  };
}

async function record(input) {
  return (await client.query(
    "SELECT public.record_incident_slo_observation_atomic($1::jsonb) AS receipt",
    [JSON.stringify(input)],
  )).rows[0].receipt;
}

let began = false;
await client.connect();
try {
  await assertLocalIdentity();
  const ledgerBefore = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledgerBefore.rowCount, 0, "INCIDENT_SLO_MIGRATION_ALREADY_APPLIED");
  assert.equal(await relationCount(), 0, "INCIDENT_SLO_SCHEMA_ALREADY_PRESENT");

  await client.query("BEGIN");
  began = true;
  await client.query(migrationBody);

  const rls = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      ORDER BY c.relname`,
    [tables],
  );
  assert.equal(rls.rowCount, tables.length, "INCIDENT_SLO_TABLE_COUNT_INVALID");
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}_RLS_REQUIRED`);
    assert.equal(row.relforcerowsecurity, false, `${row.relname}_OWNER_RPC_ACCESS_REQUIRED`);
  }
  const grants = await client.query(
    `SELECT
       bool_or(has_table_privilege('anon', format('public.%I', c.relname), 'SELECT')) AS anon_select,
       bool_or(has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT')) AS authenticated_select,
       bool_or(has_table_privilege('anon', format('public.%I', c.relname), 'INSERT,UPDATE,DELETE')) AS anon_write,
       bool_or(has_table_privilege('authenticated', format('public.%I', c.relname), 'INSERT,UPDATE,DELETE')) AS authenticated_write,
       bool_or(has_table_privilege('service_role', format('public.%I', c.relname), 'SELECT')) AS service_select,
       bool_or(has_table_privilege('service_role', format('public.%I', c.relname), 'INSERT,UPDATE,DELETE')) AS service_write
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
    [tables],
  );
  assert.equal(grants.rows[0].anon_select, false, "ANON_SELECT_MUST_BE_REVOKED");
  assert.equal(grants.rows[0].authenticated_select, false, "AUTHENTICATED_SELECT_MUST_BE_REVOKED");
  assert.equal(grants.rows[0].anon_write, false, "ANON_WRITE_MUST_BE_REVOKED");
  assert.equal(grants.rows[0].authenticated_write, false, "AUTHENTICATED_WRITE_MUST_BE_REVOKED");
  assert.equal(grants.rows[0].service_select, false, "SERVICE_ROLE_DIRECT_SELECT_MUST_BE_REVOKED");
  assert.equal(grants.rows[0].service_write, false, "SERVICE_ROLE_DIRECT_DML_MUST_BE_REVOKED");
  const functionGrants = (await client.query(
    `SELECT
       has_function_privilege('anon', 'public.get_incident_slo_status()', 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', 'public.get_incident_slo_status()', 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', 'public.get_incident_slo_status()', 'EXECUTE') AS service_execute`,
  )).rows[0];
  assert.equal(functionGrants.anon_execute, false);
  assert.equal(functionGrants.authenticated_execute, false);
  assert.equal(functionGrants.service_execute, true);

  const serviceId = (await client.query(
    `INSERT INTO public.incident_slo_services
       (service_key, display_name, owner_key, criticality, source_contract)
       VALUES ($1, 'Local transaction probe', 'codex', 'P1', '{"source":"transaction_probe"}'::jsonb)
       RETURNING id`,
    [`verify.service.${suffix}`],
  )).rows[0].id;
  await client.query(
    `INSERT INTO public.incident_slo_definitions
       (service_id, slo_key, display_name, indicator_kind, objective_ratio,
        objective_window_seconds, measurement_source, burn_rate_policy, status)
       VALUES ($1, $2, 'Availability', 'availability', 0.99, 2592000,
         'transaction_probe', '{"fast":{"window":"5m","threshold":14.4}}'::jsonb, 'active')`,
    [serviceId, `verify.slo.${suffix}`],
  );

  const unavailable = observation({
    idempotencyKey: `verify:measurement:${suffix}:unavailable`,
    sourceStatus: "unavailable",
    sliValue: null,
    goodCount: null,
    totalCount: null,
    burnRate: null,
    errorBudgetRemainingRatio: null,
    violated: false,
    sourceAsOf: null,
    freshnessSeconds: null,
    coverageRatio: null,
    alertFingerprint: null,
    alertSeverity: null,
    alertSummary: null,
  });
  const unavailableReceipt = await record(unavailable);
  assert.equal(unavailableReceipt.sourceStatus, "unavailable");
  assert.equal(unavailableReceipt.sliValue, null, "MISSING_SOURCE_MUST_REMAIN_NULL");
  assert.equal(unavailableReceipt.incidentId, null);

  const firstObservation = observation();
  const firstReceipt = await record(firstObservation);
  assert.equal(firstReceipt.alreadyExisted, false);
  assert.ok(firstReceipt.alertId);
  assert.ok(firstReceipt.incidentId);
  assert.equal(firstReceipt.occurrenceCount, 1);
  const duplicateReceipt = await record(firstObservation);
  assert.equal(duplicateReceipt.alreadyExisted, true);
  assert.equal(duplicateReceipt.incidentId, firstReceipt.incidentId);
  const secondReceipt = await record(observation({
    idempotencyKey: `verify:measurement:${suffix}:dedup`,
    windowStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    windowEndedAt: new Date(Date.now() + 1_000).toISOString(),
  }));
  assert.equal(secondReceipt.incidentId, firstReceipt.incidentId, "FINGERPRINT_MUST_DEDUP_TO_ONE_ACTIVE_INCIDENT");
  assert.equal(secondReceipt.occurrenceCount, 2);
  assert.equal(Number((await client.query(
    "SELECT count(*)::integer AS count FROM public.incident_slo_incidents WHERE fingerprint=$1",
    [fingerprint],
  )).rows[0].count), 1);

  await client.query("SAVEPOINT expected_measurement_conflict");
  try {
    await record({ ...firstObservation, sliValue: 0.7 });
    assert.fail("MEASUREMENT_IDEMPOTENCY_CONFLICT_REQUIRED");
  } catch (error) {
    assert.match(String(error.message || ""), /INCIDENT_SLO_MEASUREMENT_IDEMPOTENCY_CONFLICT/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_measurement_conflict");

  await client.query(
    `INSERT INTO public.incident_slo_maintenance_windows
       (service_id, window_key, title, reason, starts_at, ends_at, status, approved_by)
       VALUES ($1, $2, 'Local maintenance', 'Transaction probe', now()-interval '1 minute',
         now()+interval '10 minutes', 'active', 'codex-local-probe')`,
    [serviceId, `verify:maintenance:${suffix}`],
  );
  const suppressed = await record(observation({
    idempotencyKey: `verify:measurement:${suffix}:suppressed`,
    alertFingerprint: maintenanceFingerprint,
    windowStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    windowEndedAt: new Date().toISOString(),
  }));
  assert.equal(suppressed.alertState, "suppressed");
  assert.equal(suppressed.incidentId, null, "MAINTENANCE_ALERT_MUST_NOT_OPEN_INCIDENT");

  const claim = (await client.query(
    "SELECT public.claim_incident_slo_incident_cas($1,$2,$3,$4,$5) AS receipt",
    [firstReceipt.incidentId, "codex-local-probe", 0, 600, `verify-claim-${suffix}`],
  )).rows[0].receipt;
  assert.equal(claim.status, "owned");
  assert.equal(claim.revision, 1);
  assert.ok(claim.leaseToken);

  await client.query("SAVEPOINT expected_cas_conflict");
  try {
    await client.query(
      "SELECT public.claim_incident_slo_incident_cas($1,$2,$3,$4,$5)",
      [firstReceipt.incidentId, "stale-actor", 0, 600, `verify-stale-${suffix}`],
    );
    assert.fail("STALE_REVISION_MUST_FAIL");
  } catch (error) {
    assert.match(String(error.message || ""), /INCIDENT_SLO_REVISION_CONFLICT/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_cas_conflict");

  const actionArgs = [
    firstReceipt.incidentId,
    "codex-local-probe",
    claim.leaseToken,
    1,
    "preview",
    "read_only_probe",
    `verify-action-${suffix}`,
    JSON.stringify({ probe: "health" }),
  ];
  const actionSql = "SELECT public.register_incident_slo_action_request($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS receipt";
  const action = (await client.query(actionSql, actionArgs)).rows[0].receipt;
  const duplicateAction = (await client.query(actionSql, actionArgs)).rows[0].receipt;
  assert.equal(action.executionEnabled, false);
  assert.equal(action.paidOperation, false);
  assert.equal(action.serviceRestart, false);
  assert.equal(duplicateAction.alreadyExisted, true);
  assert.equal(duplicateAction.actionRequestId, action.actionRequestId);

  const probe = (await client.query(
    "SELECT public.request_incident_slo_recovery_probe($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS receipt",
    [
      firstReceipt.incidentId,
      "codex-local-probe",
      claim.leaseToken,
      1,
      `verify-probe-${suffix}`,
      "read_only_health",
      `verify-probe-request-${suffix}`,
      JSON.stringify({ endpoint: "local-transaction-probe" }),
    ],
  )).rows[0].receipt;
  assert.equal(probe.status, "requested");
  assert.equal(probe.executionEnabled, false);
  const probeResult = (await client.query(
    "SELECT public.record_incident_slo_recovery_probe_result_cas($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS receipt",
    [
      firstReceipt.incidentId,
      probe.probeId,
      "codex-local-probe",
      claim.leaseToken,
      1,
      "passed",
      `verify-probe-result-${suffix}`,
      "Read-only probe passed",
      JSON.stringify({ verified: true }),
    ],
  )).rows[0].receipt;
  assert.equal(probeResult.status, "passed");
  assert.equal(probeResult.incidentRevision, 2);

  const resolved = (await client.query(
    "SELECT public.transition_incident_slo_incident_cas($1,$2,$3,$4,$5,$6,$7) AS receipt",
    [
      firstReceipt.incidentId,
      "codex-local-probe",
      claim.leaseToken,
      2,
      "resolved",
      `verify-resolve-${suffix}`,
      "Recovered in local transaction probe",
    ],
  )).rows[0].receipt;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.revision, 3);

  const postmortem = (await client.query(
    "SELECT public.link_incident_slo_postmortem_cas($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) AS receipt",
    [
      firstReceipt.incidentId,
      "codex-local-probe",
      3,
      `verify-postmortem-${suffix}`,
      "draft",
      "Local transaction probe postmortem",
      JSON.stringify({ category: "verification" }),
      JSON.stringify([{ owner: "codex", action: "none", verificationOnly: true }]),
      null,
    ],
  )).rows[0].receipt;
  assert.equal(postmortem.status, "draft");
  assert.equal(postmortem.incidentRevision, 4);

  await client.query("SAVEPOINT expected_immutable_guard");
  try {
    await client.query(
      "UPDATE public.incident_slo_incident_events SET summary='mutated' WHERE incident_id=$1",
      [firstReceipt.incidentId],
    );
    assert.fail("IMMUTABLE_EVENT_UPDATE_MUST_FAIL");
  } catch (error) {
    assert.match(String(error.message || ""), /INCIDENT_SLO_IMMUTABLE_EVIDENCE/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_immutable_guard");

  const status = (await client.query("SELECT public.get_incident_slo_status() AS status")).rows[0].status;
  assert.equal(status.migration, VERSION);
  assert.equal(Number(status.tableCounts.services), 1);
  assert.equal(Number(status.measurements.unavailable), 1);
  assert.equal(Number(status.alerts.suppressed), 1);
  assert.equal(Number(status.incidents.resolved), 1);
  assert.equal(status.actions.executorAvailable, false);
  assert.equal(status.actions.paidExecutionEnabled, false);
  assert.equal(status.actions.serviceRestartEnabled, false);
  assert.equal(status.definitions[0].sourceStatus, "available");

  await client.query("SAVEPOINT expected_rollback_guard");
  try {
    await client.query(rollbackBody);
    assert.fail("ROLLBACK_EVIDENCE_GUARD_REQUIRED");
  } catch (error) {
    assert.match(String(error.message || ""), /ROLLBACK_BLOCKED_INCIDENT_SLO_EVIDENCE_EXISTS/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_rollback_guard");

  await client.query("TRUNCATE TABLE public.incident_slo_services CASCADE");
  await client.query(rollbackBody);
  assert.equal(await relationCount(), 0, "ROLLBACK_MUST_REMOVE_NEW_SCHEMA_INSIDE_PROBE");

  await client.query("ROLLBACK");
  began = false;
  assert.equal(await relationCount(), 0, "OUTER_ROLLBACK_MUST_LEAVE_NO_SCHEMA");
  const ledgerAfter = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledgerAfter.rowCount, 0, "OUTER_ROLLBACK_MUST_LEAVE_LEDGER_UNCHANGED");

  console.log(JSON.stringify({
    passed: true,
    mode: "local-outer-transaction",
    migration: VERSION,
    migrationSha256: migrationHash,
    rollbackSha256: rollbackHash,
    checks: {
      tables: tables.length,
      rlsEnabled: true,
      clientPrivilegesRevoked: true,
      serviceRoleDirectTableAccess: false,
      rpcPrivilegesMinimized: true,
      unavailableIsNull: true,
      atomicObservation: true,
      idempotentMeasurement: true,
      alertFingerprintDedup: true,
      oneActiveIncident: true,
      maintenanceSuppression: true,
      ownershipLeaseCas: true,
      recoveryProbeEvidence: true,
      actionRegistrationOnly: true,
      incidentRecoveryClosure: true,
      postmortemLinkage: true,
      immutableEvidence: true,
      statusRpc: true,
      rollbackEvidenceGuard: true,
      rollbackSql: true,
      outerRollback: true,
    },
    persisted: false,
    persistentFixtures: 0,
    migrationLedgerWrites: 0,
    automaticRepairs: 0,
    externalCalls: 0,
    productionWrites: 0,
  }, null, 2));
} finally {
  if (began) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
