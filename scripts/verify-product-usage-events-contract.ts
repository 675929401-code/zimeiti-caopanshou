import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PRODUCT_USAGE_MAX_BATCH_EVENTS,
  PRODUCT_USAGE_MIN_COHORT_SIZE,
  PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
  buildProductUsageAnalytics,
  isProductUsageAnalyticsResponse,
  parseProductUsageAnalyticsResponse,
  productUsageEventBatchSchema,
  type ProductUsageBuildInput,
} from "@/lib/product-usage-contract";
import { buildProductUsageBrowserEvent } from "@/lib/product-usage-client";
import {
  ProductUsageAdmissionGate,
  parseProductUsageAggregate,
} from "@/lib/server/product-usage-analytics";

const root = process.cwd();
const NOW = "2026-10-03T00:00:00.000Z";
const EVENT_ID = "8f6efc44-9848-4adf-9713-a9e743f89e92";
const SESSION_ID = "2e646f40-24b2-4af8-900d-0e4de629f0a6";
const JOURNEY_ID = "d5a3347d-70c5-48a3-8941-2e9f20d7556c";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

function unavailableBuildInput(): ProductUsageBuildInput {
  return {
    now: NOW,
    aggregate: {
      state: "unavailable",
      latestRecordAt: null,
      eventCount: null,
      instrumentationStartedAt: null,
      metrics: null,
      retention: [],
      featureAdoption: [],
      valuePath: [],
      errorCode: "PRODUCT_USAGE_FACT_SOURCE_NOT_DEPLOYED",
    },
    fallback: {
      state: "available",
      rows: [
        { id: "flight-1", pseudonymousUserRef: "usr_aaaaaaaaaaaa", outcome: "success", occurredAt: "2026-10-02T23:00:00.000Z" },
        { id: "flight-2", pseudonymousUserRef: "usr_bbbbbbbbbbbb", outcome: "error", occurredAt: "2026-10-02T23:30:00.000Z" },
      ],
      rowLimit: 500,
      truncated: false,
      errorCode: null,
    },
  };
}

async function verifyAdmissionGate(): Promise<void> {
  const gate = new ProductUsageAdmissionGate(PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS);
  let finishFirst: ((value: string) => void) | undefined;
  const first = gate.run("fixture-admin", () => new Promise<string>((resolve) => { finishFirst = resolve; }), 100_000);
  await Promise.resolve();
  const concurrent = await gate.run("fixture-admin", async () => "unexpected", 100_000);
  assert.equal(concurrent.allowed, false, "PRODUCT_USAGE_SINGLE_FLIGHT_MUST_REJECT_CONCURRENT_READ");
  if (!concurrent.allowed) assert.equal(concurrent.reason, "single_flight");
  assert(finishFirst, "PRODUCT_USAGE_FIXTURE_RELEASE_MISSING");
  finishFirst("first");
  assert.equal((await first).allowed, true);
  const early = await gate.run("fixture-admin", async () => "unexpected", 159_999);
  assert.equal(early.allowed, false, "PRODUCT_USAGE_MINIMUM_INTERVAL_MUST_REJECT_EARLY_READ");
  const released = await gate.run("fixture-admin", async () => "released", 160_000);
  assert.equal(released.allowed, true, "PRODUCT_USAGE_READ_MUST_RELEASE_AT_SIXTY_SECONDS");
}

async function main(): Promise<void> {
  const event = buildProductUsageBrowserEvent({
    eventType: "workflow_started",
    featureKey: "agent_chat",
    journeyId: JOURNEY_ID,
    entryPoint: "direct",
  }, {
    id: EVENT_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    occurredAt: NOW,
  });
  const validBatch = productUsageEventBatchSchema.safeParse({ events: [event] });
  assert.equal(validBatch.success, true, "PRODUCT_USAGE_VALID_EVENT_REJECTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: [{ ...event, journey_id: null }],
  }).success, false, "PRODUCT_USAGE_WORKFLOW_WITHOUT_JOURNEY_ACCEPTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: [{ ...event, prompt: "sensitive content" }],
  }).success, false, "PRODUCT_USAGE_GENERIC_CONTENT_FIELD_ACCEPTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: [{
      ...event,
      event_type: "session_heartbeat",
      journey_id: null,
      page_key: "home",
    }],
  }).success, true, "PRODUCT_USAGE_HEARTBEAT_REJECTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: Array.from({ length: PRODUCT_USAGE_MAX_BATCH_EVENTS + 1 }, (_, index) => ({
      ...event,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  }).success, false, "PRODUCT_USAGE_OVERSIZED_BATCH_ACCEPTED");

  const unavailable = buildProductUsageAnalytics(unavailableBuildInput());
  assert.equal(unavailable.availability, "partial");
  assert.equal(unavailable.sourceMode, "operation_flight_events_limited_fallback");
  assert.equal(unavailable.metrics.dau.value, null, "FLIGHT_EVENTS_MUST_NOT_BECOME_DAU");
  assert.equal(unavailable.metrics.activation.value, null, "FLIGHT_EVENTS_MUST_NOT_BECOME_ACTIVATION");
  assert.equal(unavailable.retention.every((point) => point.rate === null), true, "FLIGHT_EVENTS_MUST_NOT_BECOME_RETENTION");
  assert.equal(unavailable.featureAdoption.length, 0, "FLIGHT_EVENTS_MUST_NOT_BECOME_ADOPTION");
  assert.equal(unavailable.valuePath.length, 0, "FLIGHT_EVENTS_MUST_NOT_BECOME_VALUE_PATH");
  assert.equal(unavailable.fallbackSignal.eventCount, 2);
  assert.equal(unavailable.fallbackSignal.pseudonymousUserCount, null, "SMALL_FALLBACK_COHORT_MUST_BE_SUPPRESSED");
  assert.equal(unavailable.privacy.minimumCohortSize, PRODUCT_USAGE_MIN_COHORT_SIZE);
  assert.equal(unavailable.privacy.directIdentifiersIncluded, false);
  assert.equal(unavailable.privacy.promptOrContentIncluded, false);

  const parsedResponseFixture = parseProductUsageAnalyticsResponse(unavailable);
  assert(parsedResponseFixture, "PRODUCT_USAGE_VALID_ANALYTICS_RESPONSE_REJECTED");
  assert.equal(parsedResponseFixture.refresh.rateLimit.scope, "process-local-admin");
  assert.equal(parsedResponseFixture.metrics.dau.value, null);
  assert.equal(parsedResponseFixture.privacy.ipIncluded, false);
  assert.equal(isProductUsageAnalyticsResponse(unavailable), true, "PRODUCT_USAGE_VALID_TYPE_GUARD_REJECTED");

  const malformedResponseFixtures: Array<{ name: string; value: unknown }> = [
    {
      name: "missing nested refresh rate limit",
      value: { ...unavailable, refresh: { ...unavailable.refresh, rateLimit: undefined } },
    },
    {
      name: "invalid nested refresh timestamp",
      value: { ...unavailable, refresh: { ...unavailable.refresh, nextRefreshAt: "later" } },
    },
    {
      name: "freshness label is missing",
      value: { ...unavailable, freshness: { ...unavailable.freshness, label: undefined } },
    },
    {
      name: "missing metric definition",
      value: {
        ...unavailable,
        metrics: {
          ...unavailable.metrics,
          dau: { ...unavailable.metrics.dau, definition: undefined },
        },
      },
    },
    {
      name: "wrong activation unit",
      value: {
        ...unavailable,
        metrics: {
          ...unavailable.metrics,
          activation: { ...unavailable.metrics.activation, unit: "users" },
        },
      },
    },
    {
      name: "privacy flag claims raw IP is included",
      value: { ...unavailable, privacy: { ...unavailable.privacy, ipIncluded: true } },
    },
    {
      name: "privacy-suppressed adoption leaks cohort values",
      value: {
        ...unavailable,
        featureAdoption: [{
          featureKey: "agent_chat",
          label: "智能体对话",
          state: "partial",
          activeUsers: 3,
          monthlyActiveUsers: null,
          adoptionRate: null,
          workflowCompletedUsers: null,
          reasonCode: "SMALL_COHORT_SUPPRESSED",
          privacySuppressed: true,
        }],
      },
    },
    {
      name: "retention contains an unsupported day",
      value: {
        ...unavailable,
        retention: [{
          ...unavailable.retention[0],
          day: 14,
        }],
      },
    },
    {
      name: "value path conversion exceeds one",
      value: {
        ...unavailable,
        valuePath: [{
          key: "active",
          label: "产生合规行为",
          state: "available",
          users: 6,
          conversionFromPrevious: 1.2,
          reasonCode: null,
          privacySuppressed: false,
        }],
      },
    },
    {
      name: "duplicate source evidence",
      value: { ...unavailable, sourceStates: [unavailable.sourceStates[0], unavailable.sourceStates[0]] },
    },
    {
      name: "source evidence is missing detail",
      value: {
        ...unavailable,
        sourceStates: [
          { ...unavailable.sourceStates[0], detail: undefined },
          unavailable.sourceStates[1],
        ],
      },
    },
    {
      name: "unavailable fallback leaks event count",
      value: {
        ...unavailable,
        fallbackSignal: {
          ...unavailable.fallbackSignal,
          state: "unavailable",
          eventCount: 2,
        },
      },
    },
    {
      name: "unexpected nested privacy field",
      value: { ...unavailable, privacy: { ...unavailable.privacy, rawIp: "127.0.0.1" } },
    },
    {
      name: "read budget accepts a negative row limit",
      value: { ...unavailable, readBudget: { ...unavailable.readBudget, fallbackRowLimit: -1 } },
    },
  ];
  for (const fixture of malformedResponseFixtures) {
    assert.equal(
      parseProductUsageAnalyticsResponse(fixture.value),
      null,
      `PRODUCT_USAGE_MALFORMED_RESPONSE_ACCEPTED:${fixture.name}`,
    );
    assert.equal(
      isProductUsageAnalyticsResponse(fixture.value),
      false,
      `PRODUCT_USAGE_MALFORMED_TYPE_GUARD_ACCEPTED:${fixture.name}`,
    );
  }

  const parsed = parseProductUsageAggregate({
    instrumentation: {
      eventCount: 24,
      startedAt: "2026-09-01T00:00:00.000Z",
      latestRecordAt: "2026-10-02T23:55:00.000Z",
    },
    metrics: {
      dau: { state: "available", value: 6 },
      wau: { state: "available", value: 10 },
      mau: { state: "available", value: 12 },
      activation: { state: "available", value: 0.5, numerator: 5, denominator: 10 },
    },
    retention: [{ day: 1, state: "available", retainedUsers: 3, eligibleUsers: 6, rate: 0.5 }],
    featureAdoption: [{ featureKey: "agent_chat", state: "available", activeUsers: 3, monthlyActiveUsers: 12, adoptionRate: 0.25, workflowCompletedUsers: 2 }],
    valuePath: [{ key: "active", state: "available", users: 6, conversionFromPrevious: 1 }],
  });
  assert.equal(parsed.metrics?.dau.value, 6);
  assert.equal(parsed.retention[0].privacySuppressed, true, "SMALL_RETENTION_NUMERATOR_MUST_BE_SUPPRESSED");
  assert.equal(parsed.retention[0].rate, null);
  assert.equal(parsed.featureAdoption[0].privacySuppressed, true, "SMALL_FEATURE_COHORT_MUST_BE_SUPPRESSED");

  await verifyAdmissionGate();

  const [
    contractSource,
    clientSource,
    serverSource,
    ingestRoute,
    adminRoute,
    governanceSource,
    panelSource,
    panelStyles,
    globalRecorder,
    diagnosticSource,
    designSql,
    operationRecorder,
    designDoc,
  ] = await Promise.all([
    source("src/lib/product-usage-contract.ts"),
    source("src/lib/product-usage-client.ts"),
    source("src/lib/server/product-usage-analytics.ts"),
    source("src/app/api/product-usage/events/route.ts"),
    source("src/app/api/admin/product-usage/route.ts"),
    source("src/lib/admin-governance.ts"),
    source("src/components/admin/product-usage-panel.tsx"),
    source("src/components/admin/product-usage-panel.module.css"),
    source("src/components/diagnostic-sentry.tsx"),
    source("src/lib/diagnostic-sentry.ts"),
    source("supabase/design-only/20261003_product_usage_events.sql"),
    source("src/lib/operation-flight-recorder.ts"),
    source("docs/产品使用数据闭环设计-2026-10-03.md"),
  ]);

  for (const required of [
    "PRODUCT_USAGE_EVENT_TYPES",
    '"page_view"',
    '"session_heartbeat"',
    '"feature_open"',
    '"workflow_started"',
    '"workflow_completed"',
    '"workflow_failed"',
    '"value_milestone"',
    ".strict()",
    "PRODUCT_USAGE_MAX_BATCH_EVENTS",
    "productUsageAnalyticsResponseSchema",
    "parseProductUsageAnalyticsResponse",
  ]) assert(contractSource.includes(required), `PRODUCT_USAGE_CONTRACT_BOUNDARY_MISSING:${required}`);
  assert.doesNotMatch(contractSource, /\bmetadata\s*:/u, "PRODUCT_USAGE_GENERIC_METADATA_BAG_MUST_NOT_EXIST");

  for (const required of [
    'endpoint ?? "/api/product-usage/events"',
    'credentials: "same-origin"',
    'document.visibilityState === "hidden"',
    "navigator.onLine === false",
    "buildProductUsageBrowserEvent",
  ]) assert(clientSource.includes(required), `PRODUCT_USAGE_CLIENT_BOUNDARY_MISSING:${required}`);

  for (const required of [
    "read_admin_product_usage_snapshot_v1",
    '.from("operation_flight_events")',
    '.select("id,user_id,outcome,occurred_at")',
    `.limit(FALLBACK_ROW_LIMIT + 1)`,
    "AbortSignal.timeout(QUERY_TIMEOUT_MS)",
    "__agentHubProductUsageAnalyticsCacheV1",
    "__agentHubProductUsageReadInFlightV1",
    "ProductUsageAdmissionGate",
  ]) assert(serverSource.includes(required), `PRODUCT_USAGE_READ_MODEL_BOUNDARY_MISSING:${required}`);
  assert.doesNotMatch(serverSource, /operation_flight_events[\s\S]{0,400}(?:dau|activation|retention|adoption)/iu, "FLIGHT_FALLBACK_MUST_NOT_FEED_PRODUCT_KPIS");

  for (const required of [
    "sameOrigin(request)",
    "process.env.BASE_URL",
    "process.env.PRODUCTION_SITE_URL",
    "parsedRequestOrigin(request.headers.get(\"origin\"))",
    "parsedConfiguredOrigin(value)",
    "sameLoopbackOrigin(suppliedOrigin, allowedOrigin)",
    'fetchSite !== "same-origin"',
    "authorizeToken(token)",
    "PRODUCT_USAGE_MAX_REQUEST_BYTES",
    "PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE",
    "PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE",
    "productUsageEventBatchSchema.safeParse",
    "createHmac",
    'from("product_usage_events")',
    'ignoreDuplicates: true',
    "PRODUCT_USAGE_POLICY_BASIS_CODE",
    "PRODUCT_USAGE_NOTICE_VERSION",
    "PRODUCT_USAGE_POLICY_NOT_CONFIGURED",
    "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED",
    "storageMissing ? 503",
    'policyMissing || code === "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED" ? 503',
  ]) assert(ingestRoute.includes(required), `PRODUCT_USAGE_INGEST_GUARD_MISSING:${required}`);
  assert.doesNotMatch(ingestRoute, /headers\.get\(["']host["']\)/u, "PRODUCT_USAGE_INGEST_MUST_NOT_TRUST_HOST_HEADER");
  assert.doesNotMatch(ingestRoute, /headers\.get\(["']user-agent|x-forwarded-for|\b(?:ip_address|email|prompt|material_url)\s*:/iu, "PRODUCT_USAGE_INGEST_MUST_NOT_READ_SENSITIVE_FIELDS");

  for (const required of [
    'authorizeAdminCapability(request, "members.view"',
    "private, no-store",
    "status: 429",
    "Retry-After",
    "PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS",
  ]) assert(adminRoute.includes(required), `PRODUCT_USAGE_ADMIN_API_GUARD_MISSING:${required}`);
  assert(governanceSource.includes('pathname === "/api/admin/product-usage"'), "PRODUCT_USAGE_ADMIN_PROXY_RULE_MISSING");
  assert(governanceSource.includes('pathname === "/api/admin/external-site-monitor"'), "CONCURRENT_EXTERNAL_MONITOR_RULE_LOST");

  for (const required of [
    'variant?: "admin" | "command_center"',
    'variant === "command_center"',
    "document.visibilityState",
    "navigator.onLine",
    "AbortController",
    "window.setTimeout",
    "事实源未接入",
    "不能用于计算 DAU",
    "不替代产品分析",
    'data-testid="product-usage-panel"',
    "data-snapshot-state=",
    "data-availability=",
    "data-source-mode=",
    "data-freshness=",
    "data-window-hours=",
    "data-schema-version=",
  ]) assert(panelSource.includes(required), `PRODUCT_USAGE_PANEL_BOUNDARY_MISSING:${required}`);
  assert.doesNotMatch(panelSource, /setInterval/u, "PRODUCT_USAGE_PANEL_MUST_NOT_POLL_WITH_SET_INTERVAL");
  const fontSizes = [...panelStyles.matchAll(/font-size:\s*(\d+)px/gu)].map((match) => Number(match[1]));
  assert(fontSizes.length > 0 && fontSizes.every((size) => size >= 12), "PRODUCT_USAGE_PANEL_TEXT_BELOW_TWELVE_PIXELS");
  for (const required of [
    ".commandCenter",
    "--pu-bg: #f3f4ef",
    "--pu-panel: #fffefa",
    "--pu-text: #17201d",
    "color-scheme: light",
    "prefers-reduced-motion",
    "panelEnter",
  ]) {
    assert(panelStyles.includes(required), `PRODUCT_USAGE_COMMAND_CENTER_STYLE_MISSING:${required}`);
  }

  for (const required of [
    'eventType: "page_view"',
    'eventType: "session_heartbeat"',
    "PRODUCT_USAGE_HEARTBEAT_MS",
    "window.setTimeout",
    "visibilitychange",
  ]) assert(globalRecorder.includes(required), `PRODUCT_USAGE_GLOBAL_TRIGGER_MISSING:${required}`);
  assert.doesNotMatch(globalRecorder, /setInterval/u, "PRODUCT_USAGE_HEARTBEAT_MUST_BE_ONE_SHOT_TIMEOUT");
  for (const required of [
    "productUsageFeatureForApi",
    'return "agent_chat"',
    'eventType: "workflow_started"',
    'eventType: "workflow_completed"',
    'eventType: "workflow_failed"',
  ]) assert(diagnosticSource.includes(required), `PRODUCT_USAGE_VALUE_ACTION_TRIGGER_MISSING:${required}`);

  for (const required of [
    "DESIGN ONLY",
    "DO NOT APPLY",
    "product_usage_events",
    "product_usage_daily_user_facts",
    "product_usage_user_lifecycle",
    "session_hmac",
    "journey_hmac",
    "policy_basis_code",
    "notice_version",
    "retained_until",
    "read_admin_product_usage_snapshot_v1",
    "greatest(5, p_min_cohort_size)",
    "REVOKE ALL",
    "service_role",
  ]) assert(designSql.includes(required), `PRODUCT_USAGE_DESIGN_FIELD_MISSING:${required}`);
  assert.doesNotMatch(designSql, /^\s*(?:raw_ip|ip_address|user_agent|email|prompt|content|material_url)\s+/imu, "PRODUCT_USAGE_DESIGN_MUST_NOT_DECLARE_SENSITIVE_COLUMNS");

  assert(operationRecorder.includes("operation_flight_events"));
  assert(operationRecorder.includes("domain"));
  assert(operationRecorder.includes("outcome"));
  assert.doesNotMatch(operationRecorder, /retention|featureAdoption|valuePath/u, "OPERATION_FLIGHT_RECORDER_MUST_REMAIN_OPERATIONAL_ONLY");
  assert(designDoc.includes("操作事实不等于产品分析"));
  assert(designDoc.includes("尚未应用"));

  console.log(JSON.stringify({
    ok: true,
    checks: {
      strictAllowlist: true,
      sameOriginAndAuthenticatedIngest: true,
      serverAttributedUser: true,
      sessionAndJourneyHmac: true,
      noSensitivePayloadFields: true,
      dedupeAndRateLimit: true,
      policyFailClosed: true,
      durableSchemaDesignOnly: true,
      migrationApplied: false,
      flightFallbackOperationalOnly: true,
      missingFactsNotZero: true,
      deepResponseValidation: true,
      malformed200Rejected: malformedResponseFixtures.length,
      minimumCohortSize: PRODUCT_USAGE_MIN_COHORT_SIZE,
      boundedAdminRead: true,
      cacheAndSingleFlight: true,
      minimumIntervalMs: PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
      noStoreAdminApi: true,
      globalPageViewAndHeartbeatMounted: true,
      realChatWorkflowTriggerMounted: true,
      hiddenAndOfflinePause: true,
      commandCenterSoftWhiteVariant: true,
      minimumVisibleFontPx: Math.min(...fontSizes),
      productionWrites: 0,
      providerCalls: 0,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
