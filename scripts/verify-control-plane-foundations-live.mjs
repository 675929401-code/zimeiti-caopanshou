#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const evidenceDir = path.resolve(".codex-evidence", "control-plane-foundations-live");

const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  endpoints: [],
  providerCalls: 0,
  businessWrites: 0,
  productionWrites: 0,
};

async function readJson(label, pathname) {
  const startedAt = Date.now();
  const response = await fetch(`${origin}${pathname}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`${label}:INVALID_JSON:${raw.slice(0, 160)}`);
  }
  assert.equal(response.status, 200, `${label}:HTTP_${response.status}:${String(body?.code || body?.error || "")}`);
  assert.match(response.headers.get("cache-control") || "", /no-store/iu, `${label}:NO_STORE_REQUIRED`);
  report.endpoints.push({
    label,
    pathname,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return body;
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_PREVIEW_ORIGIN_REQUIRED");
  assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });

  try {
    const [
      projectRegistry,
      unifiedMessaging,
      securityCases,
      securityReliability,
      incidentSlo,
      backupRestore,
      multitenantBoundary,
      domainRelease,
      horizontalScale,
      commandCenter,
    ] = await Promise.all([
      readJson("project-registry", "/api/admin/project-registry"),
      readJson("unified-messaging", "/api/admin/unified-messaging/status"),
      readJson("security-cases", "/api/admin/security-events/cases?page=1&pageSize=20"),
      readJson("security-event-reliability", "/api/admin/security-events/reliability"),
      readJson("incident-slo", "/api/admin/incident-slo/status"),
      readJson("backup-restore", "/api/admin/backup-restore-control-plane"),
      readJson("multitenant-boundary", "/api/admin/multitenant-boundary"),
      readJson("domain-release", "/api/admin/domain-release/status"),
      readJson("horizontal-scale-readiness", "/api/admin/horizontal-scale-readiness"),
      readJson("command-center", "/api/admin/command-center?hours=24&refresh=1"),
    ]);

    assert.notEqual(projectRegistry.registryState, "unavailable", "PROJECT_REGISTRY_MUST_BE_READABLE");
    assert.equal(projectRegistry.readOnly, true, "PROJECT_REGISTRY_MUST_BE_READ_ONLY");

    assert.equal(unifiedMessaging.success, true, "UNIFIED_MESSAGING_STATUS_REQUIRED");
    assert.equal(unifiedMessaging.integration.endUserSurfacesConnected, false, "UNIFIED_MESSAGING_MUST_NOT_OVERSTATE_INTEGRATION");

    assert.equal(securityCases.ok, true, "SECURITY_CASE_LIST_REQUIRED");
    assert.equal(securityCases.executionPolicy.executorAvailable, false, "SECURITY_CASE_EXECUTOR_MUST_REMAIN_DISABLED");
    assert.equal(securityCases.executionPolicy.destructiveExecutionEnabled, false, "SECURITY_CASE_DESTRUCTIVE_EXECUTION_FORBIDDEN");

    assert.equal(securityReliability.ok, true, "SECURITY_RELIABILITY_STATUS_REQUIRED");
    assert.equal(securityReliability.complete, false, "SECURITY_RELIABILITY_MUST_REMAIN_INCOMPLETE");
    assert.equal(securityReliability.producerDeliveryDurable, false, "SECURITY_PRODUCER_DURABILITY_MUST_NOT_BE_INVENTED");
    assert.equal(securityReliability.preReceiverLossObservable, false, "PRE_RECEIVER_LOSS_MUST_REMAIN_UNKNOWN");
    assert.equal(securityReliability.retryWorkerScheduled, false, "RETRY_WORKER_MUST_NOT_BE_INVENTED");
    assert.equal(securityReliability.retentionPurgeExecutorAvailable, false, "RETENTION_EXECUTOR_MUST_NOT_BE_INVENTED");

    assert.equal(incidentSlo.ok, true, "INCIDENT_SLO_STATUS_REQUIRED");
    assert.equal(incidentSlo.integration.collectorsConnected, false, "SLO_COLLECTORS_MUST_NOT_BE_INVENTED");

    assert.equal(backupRestore.schemaState, "available", "BACKUP_CONTROL_PLANE_SCHEMA_REQUIRED");
    assert.equal(backupRestore.evidenceState, "unavailable", "BACKUP_EVIDENCE_MUST_REMAIN_UNAVAILABLE");
    assert.equal(backupRestore.runs.length, 0, "BACKUP_RUNS_MUST_NOT_BE_INVENTED");
    assert.equal(backupRestore.drills.length, 0, "RESTORE_DRILLS_MUST_NOT_BE_INVENTED");

    assert.equal(multitenantBoundary.migrationRequired, false, "MULTITENANT_SCHEMA_REQUIRED");
    assert.equal(multitenantBoundary.boundaryState, "unavailable", "MULTITENANT_ISOLATION_MUST_NOT_BE_OVERSTATED");
    assert.equal(multitenantBoundary.legacyRowMutations, 0, "LEGACY_ROWS_MUST_REMAIN_UNTOUCHED");
    assert.equal(multitenantBoundary.hostAuthorizationDecisions, 0, "HOST_MUST_NOT_AUTHORIZE_TENANT_ACCESS");

    assert.equal(domainRelease.ok, true, "DOMAIN_RELEASE_STATUS_REQUIRED");
    assert.equal(domainRelease.migrationApplied, true, "DOMAIN_RELEASE_SCHEMA_REQUIRED");
    assert.equal(domainRelease.integration.realDomainVerificationRun, false, "REAL_DOMAIN_VERIFICATION_MUST_NOT_BE_INVENTED");
    assert.equal(domainRelease.integration.formalDomainChanged, false, "FORMAL_DOMAIN_MUST_REMAIN_UNCHANGED");
    assert.equal(domainRelease.hostRoutingPolicy.enforcementActive, false, "UNKNOWN_HOST_GATE_MUST_NOT_BE_INVENTED");
    assert.equal(domainRelease.hostRoutingPolicy.observedStatus, null, "UNKNOWN_HOST_OBSERVATION_MUST_REMAIN_NULL");

    assert.equal(horizontalScale.ok, true, "HORIZONTAL_SCALE_STATUS_REQUIRED");
    assert.equal(horizontalScale.overall, "unavailable", "HORIZONTAL_SCALE_READINESS_MUST_NOT_BE_OVERSTATED");
    assert.equal(horizontalScale.readyForMultipleWebInstances, false, "MULTI_WEB_READINESS_MUST_REMAIN_FALSE");
    assert.equal(horizontalScale.capacity.measured, null, "CAPACITY_MEASUREMENT_MUST_NOT_BE_INVENTED");
    assert.equal(horizontalScale.validation.loadOrStressTestExecuted, false, "LOAD_TEST_MUST_NOT_BE_INVENTED");

    assert.equal(commandCenter.schemaVersion, 3, "COMMAND_CENTER_SCHEMA_VERSION_MISMATCH");
    assert.equal(commandCenter.sections.length, 7, "COMMAND_CENTER_SECTION_COUNT_MISMATCH");
    assert.ok(commandCenter.sources.length >= 30, "COMMAND_CENTER_SOURCE_COUNT_TOO_LOW");
    assert.equal(commandCenter.refresh.providerCalls, 0, "COMMAND_CENTER_PROVIDER_CALL_FORBIDDEN");
    assert.equal(commandCenter.refresh.businessWrites, 0, "COMMAND_CENTER_BUSINESS_WRITE_FORBIDDEN");
    const sourceIds = new Set(commandCenter.sources.map((source) => source.id));
    for (const sourceId of [
      "governance.security-event-reliability",
      "governance.multitenant-boundary",
      "governance.domain-release",
      "governance.incident-slo",
      "governance.backup-restore",
      "operations.horizontal-scale-readiness",
    ]) assert.ok(sourceIds.has(sourceId), `COMMAND_CENTER_SOURCE_MISSING:${sourceId}`);
    const metricIds = new Set(commandCenter.sections.flatMap((section) => section.metrics.map((metric) => metric.id)));
    for (const metricId of [
      "governance.security-event-durability",
      "governance.tenant-isolation",
      "governance.domain-release",
      "governance.unknown-host-gate",
      "operations.horizontal-scale-readiness",
    ]) assert.ok(metricIds.has(metricId), `COMMAND_CENTER_METRIC_MISSING:${metricId}`);

    report.summary = {
      projectRegistryState: projectRegistry.registryState,
      unifiedMessagingConnected: unifiedMessaging.integration.endUserSurfacesConnected,
      securityCasesReturned: Array.isArray(securityCases.items) ? securityCases.items.length : null,
      securityReliabilityComplete: securityReliability.complete,
      incidentCollectorsConnected: incidentSlo.integration.collectorsConnected,
      backupEvidenceState: backupRestore.evidenceState,
      multitenantBoundaryState: multitenantBoundary.boundaryState,
      domainVerificationRun: domainRelease.integration.realDomainVerificationRun,
      unknownHostGateActive: domainRelease.hostRoutingPolicy.enforcementActive,
      horizontalScaleReady: horizontalScale.readyForMultipleWebInstances,
      commandCenter: {
        schemaVersion: commandCenter.schemaVersion,
        sections: commandCenter.sections.length,
        sources: commandCenter.sources.length,
        metrics: commandCenter.sections.reduce((total, section) => total + section.metrics.length, 0),
      },
    };
    report.passed = true;
  } finally {
    report.checkedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
