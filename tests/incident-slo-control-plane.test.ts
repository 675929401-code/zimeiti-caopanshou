import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  INCIDENT_SLO_MIGRATION,
  IncidentSloError,
  incidentSloExecutionPolicy,
  normalizeIncidentSloDatabaseStatus,
  parseIncidentSloControlCommand,
  validateIncidentSloRequestKey,
} from "../src/lib/incident-slo-control-plane";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20261002170000_incident_slo_control_plane.sql"),
  "utf8",
);
const rollback = readFileSync(
  resolve(root, "supabase/rollbacks/20261002170000_incident_slo_control_plane.rollback.sql"),
  "utf8",
);
const domain = readFileSync(resolve(root, "src/lib/incident-slo-control-plane.ts"), "utf8");
const server = readFileSync(resolve(root, "src/lib/server/incident-slo-control-plane.ts"), "utf8");
const statusRoute = readFileSync(resolve(root, "src/app/api/admin/incident-slo/status/route.ts"), "utf8");
const controlRoute = readFileSync(resolve(root, "src/app/api/admin/incident-slo/control/route.ts"), "utf8");
const adminGovernance = readFileSync(resolve(root, "src/lib/admin-governance.ts"), "utf8");
const audit = readFileSync(resolve(root, "scripts/audit-incident-slo-sources-readonly.mjs"), "utf8");
const localVerifier = readFileSync(resolve(root, "scripts/verify-incident-slo-control-plane-local.mjs"), "utf8");

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
] as const;

test("migration creates the full stage-one control-plane boundary with private RLS tables", () => {
  assert.match(migration, /^BEGIN;/u);
  assert.match(migration, /COMMIT;\s*$/u);
  for (const table of tables) {
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS public.${table}`), `missing ${table}`);
    assert.ok(migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`), `RLS missing for ${table}`);
    assert.ok(
      migration.includes(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role`),
      `client revoke missing for ${table}`,
    );
  }
  assert.doesNotMatch(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /reject_incident_slo_immutable_mutation/u);
  assert.match(migration, /INCIDENT_SLO_IMMUTABLE_EVIDENCE/u);
});

test("atomic observation preserves unavailable/null and deduplicates alerts and incidents", () => {
  assert.match(migration, /FUNCTION public\.record_incident_slo_observation_atomic\(p_input jsonb\)/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /INCIDENT_SLO_MEASUREMENT_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /ON CONFLICT \(fingerprint\) DO UPDATE/u);
  assert.match(migration, /incident_slo_one_active_incident_per_fingerprint/u);
  assert.match(migration, /ACTIVE_MAINTENANCE_WINDOW/u);
  assert.match(migration, /source_status = 'unavailable'/u);
  assert.match(migration, /sli_value IS NULL.*violated = false/su);
  assert.match(migration, /coalesce\(m\.source_status, 'unavailable'\)/u);
  assert.match(migration, /m\.sli_value AS "value"/u);
});

test("ownership, recovery, closeout and postmortem mutations are fenced by CAS and immutable events", () => {
  for (const name of [
    "claim_incident_slo_incident_cas",
    "request_incident_slo_recovery_probe",
    "record_incident_slo_recovery_probe_result_cas",
    "transition_incident_slo_incident_cas",
    "link_incident_slo_postmortem_cas",
  ]) {
    assert.ok(migration.includes(`FUNCTION public.${name}`), `missing ${name}`);
  }
  assert.match(migration, /INCIDENT_SLO_REVISION_CONFLICT/u);
  assert.match(migration, /INCIDENT_SLO_LEASE_INVALID/u);
  assert.match(migration, /INCIDENT_SLO_RECOVERY_PROBE_REQUIRED/u);
  assert.match(migration, /postmortem_linked/u);
  assert.match(migration, /UNIQUE \(incident_id, idempotency_key\)/u);
});

test("automatic operations are registration-only and cannot encode paid work or restarts", () => {
  assert.match(migration, /mode text NOT NULL CHECK \(mode IN \('preview','request'\)\)/u);
  assert.match(migration, /execution_enabled boolean NOT NULL DEFAULT false CHECK \(execution_enabled = false\)/u);
  assert.match(migration, /paid_operation boolean NOT NULL DEFAULT false CHECK \(paid_operation = false\)/u);
  assert.match(migration, /service_restart boolean NOT NULL DEFAULT false CHECK \(service_restart = false\)/u);
  assert.doesNotMatch(
    migration,
    /action_kind text[^;]*(?:restart_service|replay_paid|generate_media|execute_remediation)/su,
  );
  assert.match(server, /register_incident_slo_action_request/u);
  assert.doesNotMatch(server, /child_process|process\.kill|fetch\(|startMediaQueueWorkerRuntime|provider.*generate/iu);
  assert.deepEqual(incidentSloExecutionPolicy(), {
    registrationOnly: true,
    executorAvailable: false,
    paidExecutionEnabled: false,
    serviceRestartEnabled: false,
    productionRemediationEnabled: false,
  });
});

test("RPC and API permissions are minimized", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_incident_slo_status\(\) FROM PUBLIC, anon, authenticated, service_role/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_incident_slo_status\(\) TO service_role/u);
  assert.match(statusRoute, /export async function GET/u);
  assert.doesNotMatch(statusRoute, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.match(statusRoute, /authorizeAdminCapability\(request, "logs\.view"/u);
  assert.match(statusRoute, /authorizeAdminCapability\(request, "security\.view"/u);
  assert.match(controlRoute, /export async function POST/u);
  assert.match(controlRoute, /authorizeAdminCapability\(request, "security\.manage"/u);
  assert.match(controlRoute, /requireStepUp: true/u);
  assert.match(controlRoute, /idempotency-key/u);
  assert.match(adminGovernance, /pathname\.startsWith\("\/api\/admin\/incident-slo"\)[^\n]+write \? "security\.manage" : "security\.view"/u);
  assert.doesNotMatch(statusRoute + controlRoute, /\.from\([^)]*\)\.(?:insert|update|upsert|delete)/u);
});

test("status contract declares every unconnected source and preserves unavailable values as null", () => {
  for (const source of [
    "health_checks",
    "system_logs",
    "diagnostic_logs",
    "operation_flight_events",
    "worker_and_queue_runtime",
    "admin_command_center",
  ]) {
    assert.ok(domain.includes(`source: "${source}"`), `missing source boundary ${source}`);
  }
  for (const flag of [
    "collectorsConnected: false",
    "alertNotificationConnected: false",
    "commandCenterConnected: false",
    "workerHeartbeatConnected: false",
    "actionExecutorConnected: false",
    "postmortemPublisherConnected: false",
  ]) {
    assert.ok(server.includes(flag), `missing integration boundary ${flag}`);
  }
  const status = normalizeIncidentSloDatabaseStatus({
    schemaVersion: 1,
    migration: INCIDENT_SLO_MIGRATION,
    asOf: "2026-10-02T09:00:00.000Z",
    tableCounts: { services: 1, definitions: 1 },
    definitions: [{
      serviceKey: "example",
      sloKey: "example.availability",
      indicatorKind: "availability",
      objectiveRatio: 0.99,
      objectiveWindowSeconds: 2_592_000,
      sourceStatus: "unavailable",
      value: 0,
      asOf: "2026-10-02T08:59:00.000Z",
      freshnessSeconds: 60,
      coverageRatio: 1,
      partial: false,
      measurementId: null,
    }],
  });
  assert.equal(status.definitions[0].sourceStatus, "unavailable");
  assert.equal(status.definitions[0].value, null);
  assert.equal(status.definitions[0].asOf, null);
  assert.equal(status.definitions[0].freshnessSeconds, null);
  assert.equal(status.definitions[0].coverageRatio, null);
});

test("control request parser rejects executable actions and accepts the bounded preview contract", () => {
  const incidentId = "00000000-0000-4000-8000-000000000001";
  const fixtureLeaseToken = "00000000-0000-4000-8000-000000000002";
  const parsed = parseIncidentSloControlCommand({
    kind: "register_action",
    incidentId,
    leaseToken: fixtureLeaseToken,
    expectedRevision: 2,
    mode: "preview",
    actionKind: "read_only_probe",
    parameters: { probe: "health" },
  });
  assert.equal(parsed.kind, "register_action");
  assert.throws(
    () => parseIncidentSloControlCommand({
      kind: "register_action",
      incidentId,
      leaseToken: fixtureLeaseToken,
      expectedRevision: 2,
      mode: "request",
      actionKind: "restart_service",
    }),
    (error: unknown) => error instanceof IncidentSloError && error.code === "INCIDENT_SLO_REQUEST_INVALID",
  );
  assert.equal(validateIncidentSloRequestKey("verify-request-123"), "verify-request-123");
  assert.throws(() => validateIncidentSloRequestKey("short"));
});

test("rollback is transactional and refuses to erase durable evidence", () => {
  assert.match(rollback, /^BEGIN;/u);
  assert.match(rollback, /ROLLBACK_BLOCKED_INCIDENT_SLO_EVIDENCE_EXISTS/u);
  assert.match(rollback, /COMMIT;\s*$/u);
  for (const table of tables) {
    assert.ok(rollback.includes(`SELECT 1 FROM public.${table}`), `rollback guard missing ${table}`);
    assert.ok(rollback.includes(`DROP TABLE IF EXISTS public.${table}`), `rollback drop missing ${table}`);
  }
});

test("source audit and local verifier are identity-locked, zero-production-write probes", () => {
  for (const source of [audit, localVerifier]) {
    assert.ok(source.includes('runtime.localOnly, true'));
    assert.ok(source.includes('runtime.ownerConnection?.host, "127.0.0.1"'));
    assert.ok(source.includes('Number(runtime.ownerConnection?.port), 54322'));
    assert.ok(source.includes('runtime.ownerConnection?.database, "zimeiti_local"'));
    assert.ok(source.includes("productionWrites: 0"));
  }
  assert.match(audit, /BEGIN READ ONLY/u);
  assert.match(audit, /transactionRolledBack: true/u);
  for (const fragment of [
    "--confirm-local-incident-slo-control-plane",
    'await client.query("BEGIN")',
    'await client.query("ROLLBACK")',
    "persistentFixtures: 0",
    "migrationLedgerWrites: 0",
    "persisted: false",
    "automaticRepairs: 0",
    "externalCalls: 0",
    "ROLLBACK_BLOCKED_INCIDENT_SLO_EVIDENCE_EXISTS",
    "FINGERPRINT_MUST_DEDUP_TO_ONE_ACTIVE_INCIDENT",
    "MAINTENANCE_ALERT_MUST_NOT_OPEN_INCIDENT",
  ]) {
    assert.ok(localVerifier.includes(fragment), `local verifier missing ${fragment}`);
  }
});
