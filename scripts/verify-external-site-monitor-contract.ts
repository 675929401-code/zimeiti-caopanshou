import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  EXTERNAL_SITE_MONITOR_MIGRATION,
  externalSiteProbeEvidenceInput,
  isExternalSiteMonitorResponse,
  parseExternalSiteProbePayload,
  stableExternalMonitorJson,
} from "@/lib/external-site-monitor-contract";
import {
  ExternalSiteMonitorAdmissionGate,
  buildExternalSiteMonitorSnapshot,
  createExternalSiteMonitorSignature,
  verifyExternalSiteMonitorSignature,
} from "@/lib/server/external-site-monitor";

const run = promisify(execFile);
const root = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

async function runWorker(args: string[]) {
  const { stdout, stderr } = await run(process.execPath, ["scripts/external-site-monitor-worker.mjs", ...args], {
    cwd: root,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(stderr, "", "EXTERNAL_MONITOR_OFFLINE_WORKER_STDERR_MUST_BE_EMPTY");
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runWorkerFailure(args: string[], expectedCode: RegExp) {
  try {
    await run(process.execPath, ["scripts/external-site-monitor-worker.mjs", ...args], {
      cwd: root,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.fail(`EXTERNAL_MONITOR_WORKER_FAILURE_EXPECTED:${args.join(" ")}`);
  } catch (error) {
    const candidate = error as { stderr?: string };
    assert.match(candidate.stderr || "", expectedCode, `EXTERNAL_MONITOR_WORKER_FAILURE_CODE_MISSING:${args.join(" ")}`);
  }
}

async function verifyAdmissionGate() {
  const gate = new ExternalSiteMonitorAdmissionGate(30_000);
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const first = gate.run("fixture-admin", () => pending, 100_000);
  await Promise.resolve();
  const concurrent = await gate.run("fixture-admin", async () => "unexpected", 100_000);
  assert.equal(concurrent.allowed, false, "EXTERNAL_MONITOR_SINGLE_FLIGHT_REQUIRED");
  finish("first");
  assert.equal((await first).allowed, true, "EXTERNAL_MONITOR_FIRST_READ_MUST_PASS");
  const early = await gate.run("fixture-admin", async () => "unexpected", 129_999);
  assert.equal(early.allowed, false, "EXTERNAL_MONITOR_MINIMUM_INTERVAL_REQUIRED");
  if (!early.allowed) assert.equal(early.retryAfterMs, 1, "EXTERNAL_MONITOR_RETRY_REMAINDER_INVALID");
  assert.equal((await gate.run("fixture-admin", async () => "released", 130_000)).allowed, true, "EXTERNAL_MONITOR_ADMISSION_MUST_RELEASE");
}

async function main() {
  const fixture = parseExternalSiteProbePayload(JSON.parse(await source("scripts/fixtures/external-site-monitor-probe.json")) as unknown);
  const evidenceDigest = createHash("sha256")
    .update(stableExternalMonitorJson(externalSiteProbeEvidenceInput(fixture)))
    .digest("hex");
  assert.equal(evidenceDigest, fixture.evidenceSha256, "EXTERNAL_MONITOR_FIXTURE_EVIDENCE_DIGEST_INVALID");
  assert.equal(fixture.vantage.kind, "external", "EXTERNAL_MONITOR_EXTERNAL_VANTAGE_REQUIRED");
  assert.equal(fixture.privacy.rawResolvedAddressesIncluded, false, "EXTERNAL_MONITOR_RAW_IP_MUST_BE_EXCLUDED");
  assert.equal(fixture.checks.loginDom.probeMode, "server_html_dom", "EXTERNAL_MONITOR_DOM_MODE_MUST_BE_EXPLICIT");

  const secret = "fixture-secret-at-least-thirty-two-characters";
  const rawBody = JSON.stringify(fixture);
  const timestamp = "1791014402";
  const nonce = "fixture_nonce_1234567890";
  const signature = createExternalSiteMonitorSignature(secret, rawBody, timestamp, nonce);
  const verified = verifyExternalSiteMonitorSignature({
    secret,
    rawBody,
    timestamp,
    nonce,
    signature,
    keyId: "fixture-probe-v1",
    nowMs: Number(timestamp) * 1_000,
  });
  assert.match(verified.replayKey, /^external-monitor:[a-f0-9]{64}$/u, "EXTERNAL_MONITOR_DURABLE_REPLAY_KEY_INVALID");
  assert.throws(() => verifyExternalSiteMonitorSignature({
    secret,
    rawBody: `${rawBody} `,
    timestamp,
    nonce,
    signature,
    keyId: "fixture-probe-v1",
    nowMs: Number(timestamp) * 1_000,
  }), /签名不匹配/u, "EXTERNAL_MONITOR_TAMPERED_BODY_MUST_FAIL");
  assert.throws(() => verifyExternalSiteMonitorSignature({
    secret,
    rawBody,
    timestamp,
    nonce,
    signature,
    keyId: "fixture-probe-v1",
    nowMs: (Number(timestamp) + 301) * 1_000,
  }), /签名已过期/u, "EXTERNAL_MONITOR_STALE_SIGNATURE_MUST_FAIL");

  const rawStatus = {
    schemaVersion: 1,
    migration: EXTERNAL_SITE_MONITOR_MIGRATION,
    hostnames: [{
      hostname: fixture.target.hostname,
      tenantKey: "tenant-fixture",
      siteKey: "site-fixture",
      latestProbe: {
        probeId: "018fca65-1223-7dd4-9e35-0b18ce433f51",
        receivedAt: "2026-10-03T08:00:02.500Z",
        details: { monitorKind: "external_site_monitor", payload: fixture },
      },
    }],
  };
  const active = buildExternalSiteMonitorSnapshot({
    rawStatus,
    migrationApplied: true,
    ingestSecretConfigured: true,
    expectedSchedulerId: fixture.schedulerId,
    expectedIntervalSeconds: 300,
    now: "2026-10-03T08:01:00.000Z",
  });
  assert.equal(active.activation.state, "active", "EXTERNAL_MONITOR_FRESH_EXTERNAL_SAMPLE_MUST_ACTIVATE");
  assert.equal(active.activation.productionExternalMonitoringReady, true, "EXTERNAL_MONITOR_READY_REQUIRES_ALL_GATES");
  assert.equal(active.targets[0]?.latestProbe?.checks.https.statusCode, 200, "EXTERNAL_MONITOR_HTTPS_EVIDENCE_MISSING");
  assert.equal(isExternalSiteMonitorResponse(active), true, "EXTERNAL_MONITOR_BROWSER_DTO_MUST_PASS_DEEP_VALIDATION");

  const browserKeys = collectKeys(active);
  for (const forbidden of [
    "tenantKey",
    "siteKey",
    "probeRunId",
    "schedulerId",
    "provider",
    "target",
    "startedAt",
    "overallStatus",
    "privacy",
    "evidenceSha256",
    "probeId",
    "receivedAt",
    "answerSetSha256",
    "certificateFingerprintSha256",
    "sanSetSha256",
    "certificateNotBefore",
    "finalUrlSha256",
    "bytesSampled",
    "discoveredCount",
    "documentSha256",
    "errorCode",
    "probeMode",
  ]) assert.equal(browserKeys.has(forbidden), false, `EXTERNAL_MONITOR_BROWSER_DTO_FORBIDDEN_FIELD:${forbidden}`);
  assert.deepEqual(
    Object.keys(active.targets[0]?.latestProbe?.vantage || {}).sort(),
    ["region"],
    "EXTERNAL_MONITOR_BROWSER_DTO_MUST_NOT_EXPOSE_VANTAGE_IDENTIFIER",
  );

  const withTenantKey = clone(active) as unknown as { targets: Array<Record<string, unknown>> };
  withTenantKey.targets[0].tenantKey = "tenant-fixture";
  assert.equal(isExternalSiteMonitorResponse(withTenantKey), false, "EXTERNAL_MONITOR_BROWSER_DTO_MUST_REJECT_TENANT_KEY");

  const withRawPayload = clone(active) as unknown as { targets: Array<{ latestProbe: Record<string, unknown> }> };
  withRawPayload.targets[0].latestProbe.payload = fixture;
  assert.equal(isExternalSiteMonitorResponse(withRawPayload), false, "EXTERNAL_MONITOR_BROWSER_DTO_MUST_REJECT_RAW_PROBE_PAYLOAD");

  const malformedHttps = clone(active) as unknown as {
    targets: Array<{ latestProbe: { checks: { https: { statusCode: unknown } } } }>;
  };
  malformedHttps.targets[0].latestProbe.checks.https.statusCode = "200";
  assert.equal(isExternalSiteMonitorResponse(malformedHttps), false, "EXTERNAL_MONITOR_MALFORMED_200_HTTPS_MUST_FAIL_CLOSED");

  const malformedMarkers = clone(active) as unknown as {
    targets: Array<{ latestProbe: { checks: { loginDom: Record<string, unknown> } } }>;
  };
  Reflect.deleteProperty(malformedMarkers.targets[0].latestProbe.checks.loginDom, "markers");
  assert.equal(isExternalSiteMonitorResponse(malformedMarkers), false, "EXTERNAL_MONITOR_MALFORMED_200_LOGIN_DOM_MUST_FAIL_CLOSED");

  const crossTargetFixture = clone(fixture);
  crossTargetFixture.target.hostname = "other.example.com";
  crossTargetFixture.target.origin = "https://other.example.com";
  crossTargetFixture.evidenceSha256 = createHash("sha256")
    .update(stableExternalMonitorJson(externalSiteProbeEvidenceInput(crossTargetFixture)))
    .digest("hex");
  const crossTargetStatus = clone(rawStatus);
  crossTargetStatus.hostnames[0].latestProbe.details.payload = parseExternalSiteProbePayload(crossTargetFixture);
  const crossTarget = buildExternalSiteMonitorSnapshot({
    rawStatus: crossTargetStatus,
    migrationApplied: true,
    ingestSecretConfigured: true,
    expectedSchedulerId: fixture.schedulerId,
    expectedIntervalSeconds: 300,
    now: "2026-10-03T08:01:00.000Z",
  });
  assert.equal(crossTarget.targets[0]?.latestProbe, null, "EXTERNAL_MONITOR_CROSS_TARGET_PROBE_MUST_NOT_REACH_BROWSER");

  const malformedStoredTarget = buildExternalSiteMonitorSnapshot({
    rawStatus: { ...rawStatus, hostnames: [{ ...rawStatus.hostnames[0], hostname: "https://app.example.com" }] },
    migrationApplied: true,
    ingestSecretConfigured: true,
    expectedSchedulerId: fixture.schedulerId,
    expectedIntervalSeconds: 300,
    now: "2026-10-03T08:01:00.000Z",
  });
  assert.equal(malformedStoredTarget.targets.length, 0, "EXTERNAL_MONITOR_MALFORMED_STORED_TARGET_MUST_BE_FILTERED");

  const stale = buildExternalSiteMonitorSnapshot({
    rawStatus,
    migrationApplied: true,
    ingestSecretConfigured: true,
    expectedSchedulerId: fixture.schedulerId,
    expectedIntervalSeconds: 300,
    now: "2026-10-03T08:30:00.000Z",
  });
  assert.equal(stale.activation.state, "stale", "EXTERNAL_MONITOR_OLD_SAMPLE_MUST_BE_STALE");
  assert.equal(stale.activation.productionExternalMonitoringReady, false, "EXTERNAL_MONITOR_STALE_SAMPLE_MUST_NOT_BE_READY");

  const migrationMissing = buildExternalSiteMonitorSnapshot({
    rawStatus: null,
    migrationApplied: false,
    ingestSecretConfigured: false,
    expectedSchedulerId: null,
    expectedIntervalSeconds: 300,
    now: "2026-10-03T08:01:00.000Z",
  });
  assert.equal(migrationMissing.activation.state, "unavailable", "EXTERNAL_MONITOR_MISSING_MIGRATION_MUST_BE_UNAVAILABLE");
  assert.equal(migrationMissing.targets.length, 0, "EXTERNAL_MONITOR_MISSING_SOURCE_MUST_NOT_FAKE_TARGETS");
  assert.equal(isExternalSiteMonitorResponse(migrationMissing), true, "EXTERNAL_MONITOR_UNAVAILABLE_BROWSER_DTO_INVALID");
  await verifyAdmissionGate();

  const idleWorker = await runWorker([]);
  assert.equal(idleWorker.mode, "dry_run_idle", "EXTERNAL_MONITOR_WORKER_DEFAULT_MUST_BE_IDLE");
  assert.equal(idleWorker.externalNetworkCalls, 0, "EXTERNAL_MONITOR_WORKER_DEFAULT_MUST_NOT_CALL_NETWORK");
  const configValidation = await runWorker([
    "--config",
    "scripts/fixtures/external-site-monitor-worker-config.json",
    "--validate-config",
  ]);
  assert.equal(configValidation.mode, "config_validation", "EXTERNAL_MONITOR_CONFIG_VALIDATION_MODE_MISSING");
  assert.equal(configValidation.externalNetworkCalls, 0, "EXTERNAL_MONITOR_CONFIG_VALIDATION_MUST_BE_OFFLINE");
  const fixtureWorker = await runWorker(["--fixture", "scripts/fixtures/external-site-monitor-probe.json"]);
  assert.equal(fixtureWorker.mode, "fixture_dry_run", "EXTERNAL_MONITOR_FIXTURE_MODE_MISSING");
  assert.equal(fixtureWorker.externalNetworkCalls, 0, "EXTERNAL_MONITOR_FIXTURE_MUST_NOT_CALL_NETWORK");
  assert.deepEqual(record(fixtureWorker.ingest)?.attempted, false, "EXTERNAL_MONITOR_FIXTURE_MUST_NOT_INGEST");
  const addressClassification = await runWorker(["--self-test-addresses"]);
  assert.equal(addressClassification.mode, "address_classification_self_test", "EXTERNAL_MONITOR_ADDRESS_SELF_TEST_MISSING");
  assert.equal(addressClassification.externalNetworkCalls, 0, "EXTERNAL_MONITOR_ADDRESS_SELF_TEST_MUST_BE_OFFLINE");
  assert.equal(addressClassification.blockedCases, 17, "EXTERNAL_MONITOR_RESERVED_ADDRESS_FIXTURES_INCOMPLETE");
  await runWorkerFailure(["--target-origin", "https://127.0.0.1"], /UNKNOWN_ARGUMENT/u);
  await runWorkerFailure(["--fixture", "scripts/fixtures/external-site-monitor-probe.json", "--send"], /FIXTURE_INGEST_FORBIDDEN/u);

  const [
    serverSource,
    adminRoute,
    ingestRoute,
    governance,
    component,
    styles,
    worker,
    migration,
    rollback,
    design,
  ] = await Promise.all([
    source("src/lib/server/external-site-monitor.ts"),
    source("src/app/api/admin/external-site-monitor/route.ts"),
    source("src/app/api/internal/external-site-monitor/ingest/route.ts"),
    source("src/lib/admin-governance.ts"),
    source("src/components/admin/external-site-monitor-panel.tsx"),
    source("src/components/admin/external-site-monitor-panel.module.css"),
    source("scripts/external-site-monitor-worker.mjs"),
    source("supabase/migrations/20261003113000_external_site_monitor_ingestion.sql"),
    source("supabase/rollbacks/20261003113000_external_site_monitor_ingestion.rollback.sql"),
    source("docs/external-site-monitor-design.md"),
  ]);

  for (const required of [
    "get_external_site_monitor_status",
    "ingest_external_site_monitor_probe",
    "stableExternalMonitorJson",
    "EXTERNAL_SITE_MONITOR_INGEST_SECRET",
    "SIGNATURE_MAX_SKEW_SECONDS",
    "timingSafeEqual",
    "EXTERNAL_SITE_MONITOR_EXPECTED_SCHEDULER_ID",
  ]) assert(serverSource.includes(required), `EXTERNAL_MONITOR_SERVER_GUARD_MISSING:${required}`);
  for (const required of ["projectProbeForBrowser", "projectTargetForBrowser"]) {
    assert(serverSource.includes(required), `EXTERNAL_MONITOR_BROWSER_PROJECTION_MISSING:${required}`);
  }
  assert(serverSource.includes("isExternalSiteMonitorResponse(response)"), "EXTERNAL_MONITOR_SERVER_MUST_VALIDATE_PROJECTED_BROWSER_DTO");
  assert(adminRoute.includes('authorizeAdminCapability(request, "logs.view"'), "EXTERNAL_MONITOR_ADMIN_PERMISSION_MISSING");
  assert(adminRoute.includes("private, no-store"), "EXTERNAL_MONITOR_ADMIN_NO_STORE_MISSING");
  assert(adminRoute.includes("Retry-After"), "EXTERNAL_MONITOR_ADMIN_RATE_LIMIT_HEADERS_MISSING");
  assert.doesNotMatch(adminRoute, /tenantKey|siteKey|probeRunId|evidenceSha256|queryBudget/u, "EXTERNAL_MONITOR_ADMIN_ROUTE_MUST_NOT_BUILD_SENSITIVE_DTO");
  assert(governance.includes('pathname === "/api/admin/external-site-monitor"'), "EXTERNAL_MONITOR_PROXY_MAPPING_MISSING");
  assert.match(governance, /external-site-monitor"\) return \{ permission: "logs\.view", requireStepUp: false/u, "EXTERNAL_MONITOR_PROXY_PERMISSION_INVALID");

  for (const required of [
    "x-external-probe-timestamp",
    "x-external-probe-nonce",
    "x-external-probe-signature",
    "x-external-probe-key-id",
    "BROWSER_REQUEST_REJECTED",
    "MAX_BODY_BYTES",
    "Retry-After",
  ]) assert(ingestRoute.includes(required), `EXTERNAL_MONITOR_INGEST_GUARD_MISSING:${required}`);
  assert.doesNotMatch(ingestRoute, /authorizeAdminToken|authorizeAdminCapability/u, "EXTERNAL_MONITOR_INGEST_MUST_NOT_ACCEPT_ADMIN_JWT_AS_WRITER");

  for (const required of [
    "WORKER_CONFIG_REQUIRED",
    "loadWorkerConfig",
    "isPublicIpv4",
    "isPublicIpv6",
    "DENIED_IPV4_CIDRS",
    "ipv6InCidr",
    "DNS_PUBLIC_ADDRESS_REQUIRED",
    "lookup: (_hostname",
    "HTTPS_REDIRECT_OUTSIDE_TARGET",
    "rawResolvedAddressesIncluded: false",
    'probeMode: "server_html_dom"',
    'if (!args.flag("send"))',
    "FIXTURE_INGEST_FORBIDDEN",
    "query-sha256",
  ]) assert(worker.includes(required), `EXTERNAL_MONITOR_WORKER_SSRF_OR_BOUNDARY_GUARD_MISSING:${required}`);
  assert.doesNotMatch(worker, /args\.one\("target-origin"|args\.one\("ingest-endpoint"/u, "EXTERNAL_MONITOR_WORKER_MUST_NOT_ACCEPT_ARBITRARY_URL_ARGUMENTS");

  for (const required of ["AbortController", "visibilitychange", "navigator.onLine", "window.setTimeout", "生产外部监测尚未激活", "服务端 HTML 模式"]) {
    assert(component.includes(required), `EXTERNAL_MONITOR_PANEL_BEHAVIOR_MISSING:${required}`);
  }
  assert(component.includes("isExternalSiteMonitorResponse"), "EXTERNAL_MONITOR_PANEL_MALFORMED_200_GATE_MISSING");
  for (const required of ["data-target-hostname", "data-evidence-completed-at", "data-check-id", "data-check-state"]) {
    assert(component.includes(required), `EXTERNAL_MONITOR_SAFE_DOM_EVIDENCE_MISSING:${required}`);
  }
  assert.doesNotMatch(component, /probe\.schedulerId|probe\.vantage\.id/u, "EXTERNAL_MONITOR_PANEL_MUST_NOT_RENDER_RAW_PROBE_IDENTIFIERS");
  assert(component.includes("EXTERNAL_SITE_MONITOR_CACHE_TTL_MS"), "EXTERNAL_MONITOR_TRANSIENT_FAILURE_BACKOFF_MISSING");
  assert.match(component, /nextAllowedAtMs > clockMs/u, "EXTERNAL_MONITOR_RETRY_GATE_MUST_USE_REACTIVE_CLOCK");
  assert.match(component, /\[clockMs, load, nextAllowedAtMs, pageActive, snapshot, token\]/u, "EXTERNAL_MONITOR_INITIAL_RETRY_WAKEUP_MISSING");
  assert.doesNotMatch(component, /setInterval/u, "EXTERNAL_MONITOR_PANEL_MUST_NOT_POLL_WITH_SET_INTERVAL");
  const fontSizes = [...styles.matchAll(/font-size:\s*(\d+)px/gu)].map((match) => Number(match[1]));
  assert(fontSizes.length > 0 && fontSizes.every((size) => size >= 12), "EXTERNAL_MONITOR_PANEL_TEXT_BELOW_TWELVE_PIXELS");
  for (const required of [
    "--esm-bg: #f3f4ef",
    "--esm-surface: rgba(255, 254, 250, 0.96)",
    "--esm-text: #17201d",
    "color-scheme: light",
    ":focus-visible",
    "prefers-reduced-motion",
    "@media (max-width: 1280px)",
  ]) {
    assert(styles.includes(required), `EXTERNAL_MONITOR_PANEL_STYLE_MISSING:${required}`);
  }

  for (const required of [
    "domain_tls_probes",
    "SECURITY DEFINER",
    "p_idempotency_key",
    "EXTERNAL_SITE_MONITOR_REPLAY_COLLISION",
    "external_site_monitor",
    "GRANT EXECUTE",
    "service_role",
  ]) assert(migration.includes(required), `EXTERNAL_MONITOR_MIGRATION_GUARD_MISSING:${required}`);
  assert(rollback.includes("Keep append-only probe and audit evidence"), "EXTERNAL_MONITOR_ROLLBACK_MUST_PRESERVE_EVIDENCE");
  for (const required of ["未激活", "独立主机", "服务端 HTML", "SSRF", "5 分钟", "HMAC", "重放", "不会自动切流"]) {
    assert(design.includes(required), `EXTERNAL_MONITOR_DESIGN_BOUNDARY_MISSING:${required}`);
  }

  console.log(JSON.stringify({
    ok: true,
    migration: EXTERNAL_SITE_MONITOR_MIGRATION,
    checks: {
      externalVantageContract: true,
      hmacTimestampNonceAndBodyBinding: true,
      durableReplayKey: true,
      appendOnlyDomainTlsEvidenceReuse: true,
      configAllowlistAndPublicPinnedDns: true,
      offlineWorkerVerification: true,
      adminNoOutboundProbe: true,
      noStoreAndReadRateLimit: true,
      visibilityOfflineAbort: true,
      softWhiteReadableStyles: true,
      productionActivationFailClosed: true,
      browserDtoAllowlistProjection: true,
      malformed200DeepValidation: true,
      tenantAndProbeEvidenceNotExposed: true,
      networkCallsDuringTest: 0,
      databaseWritesDuringTest: 0,
    },
  }, null, 2));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  const row = record(value);
  if (!row) return keys;
  for (const [key, item] of Object.entries(row)) {
    keys.add(key);
    collectKeys(item, keys);
  }
  return keys;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
