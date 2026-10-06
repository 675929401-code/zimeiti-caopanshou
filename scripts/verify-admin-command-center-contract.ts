import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  COMMAND_CENTER_DEFINITION_VERSION,
  COMMAND_CENTER_ALL_PERMISSION_KEYS,
  COMMAND_CENTER_ENTRY_PERMISSION_KEYS,
  COMMAND_CENTER_POLL_INTERVAL_MS,
  COMMAND_CENTER_SCHEMA_VERSION,
  COMMAND_CENTER_VIEW_PERMISSION_KEYS,
  COMMAND_CENTER_VIEW_DEFINITIONS,
  clampCommandCenterWindowHours,
  commandCenterApplyFreshnessState,
  commandCenterCredentialCoveragePercent,
  commandCenterDataQuality,
  commandCenterFinanceCashSnapshot,
  commandCenterFreshnessSeconds,
  commandCenterMetric,
  commandCenterOverallStatus,
  commandCenterPercentage,
  commandCenterSourceAnomalies,
  commandCenterPermissionKeysForView,
  commandCenterViewDefinition,
  normalizeCommandCenterView,
  normalizeVisibleCommandCenterView,
  visibleCommandCenterViews,
  type CommandCenterMetric,
  type CommandCenterSourceStatus,
} from "@/lib/admin-command-center-domain";
import {
  ADMIN_COMMAND_CENTER_PERMISSION_KEYS,
  ADMIN_TAB_PERMISSIONS,
  adminRequirementForRequest,
  adminPermissionKeysForTab,
  hasAdminPermissionRequirement,
  missingAdminPermissionKeys,
} from "@/lib/admin-governance";

const root = process.cwd();
const generatedAt = "2026-10-02T08:00:00.000Z";

function source(overrides: Partial<CommandCenterSourceStatus> = {}): CommandCenterSourceStatus {
  return {
    id: "fixture.source",
    label: "合同测试来源",
    source: "fixture_table",
    state: "available",
    asOf: generatedAt,
    latestRecordAt: generatedAt,
    freshnessSeconds: 0,
    coverageRatio: 1,
    returnedRows: 1,
    totalRows: 1,
    partial: false,
    errorCode: null,
    drilldownUrl: "/admin?tab=health",
    staleAfterSeconds: null,
    ...overrides,
  };
}

function assertMetricContract(metric: CommandCenterMetric): void {
  for (const field of [
    "value",
    "definition",
    "source",
    "sourceIds",
    "asOf",
    "freshnessSeconds",
    "coverageRatio",
    "partial",
    "status",
    "drilldownUrl",
  ] as const) {
    assert(Object.prototype.hasOwnProperty.call(metric, field), `COMMAND_CENTER_METRIC_FIELD_MISSING:${field}`);
  }
  assert(Array.isArray(metric.source), "COMMAND_CENTER_METRIC_SOURCE_MUST_BE_ARRAY");
  assert(Array.isArray(metric.sourceIds), "COMMAND_CENTER_METRIC_SOURCE_IDS_MUST_BE_ARRAY");
}

async function main(): Promise<void> {
  const available = source();
  const failed = source({
    id: "fixture.failed",
    label: "失败来源",
    source: "failed_table",
    state: "unavailable",
    asOf: null,
    latestRecordAt: null,
    freshnessSeconds: null,
    coverageRatio: 0,
    returnedRows: 0,
    totalRows: null,
    partial: true,
    errorCode: "READ_FAILED",
  });

  const unavailableMetric = commandCenterMetric({
    id: "fixture.unavailable",
    label: "不可用指标",
    value: 0,
    unit: "count",
    definition: "来源失败时禁止以 0 冒充真实值。",
    sources: [failed],
    status: "healthy",
    drilldownUrl: "/admin?tab=health",
  });
  assertMetricContract(unavailableMetric);
  assert.equal(unavailableMetric.value, null, "COMMAND_CENTER_FAILED_SOURCE_MUST_NOT_FALLBACK_TO_ZERO");
  assert.equal(unavailableMetric.status, "unavailable", "COMMAND_CENTER_FAILED_SOURCE_STATUS_INVALID");
  assert.equal(unavailableMetric.partial, true, "COMMAND_CENTER_FAILED_SOURCE_MUST_BE_PARTIAL");
  assert.equal(unavailableMetric.coverageRatio, 0, "COMMAND_CENTER_FAILED_SOURCE_COVERAGE_INVALID");

  const partialMetric = commandCenterMetric({
    id: "fixture.partial",
    label: "部分指标",
    value: 17,
    unit: "count",
    definition: "部分来源成功时保留已读值，并明确降低可信度。",
    sources: [available, failed],
    status: "healthy",
    drilldownUrl: "/admin?tab=health",
  });
  assertMetricContract(partialMetric);
  assert.equal(partialMetric.value, 17, "COMMAND_CENTER_PARTIAL_VALUE_MUST_BE_PRESERVED");
  assert.equal(partialMetric.status, "warning", "COMMAND_CENTER_PARTIAL_STATUS_MUST_WARN");
  assert.equal(partialMetric.partial, true, "COMMAND_CENTER_PARTIAL_FLAG_MISSING");
  assert.equal(partialMetric.coverageRatio, 0.5, "COMMAND_CENTER_PARTIAL_COVERAGE_INVALID");
  assert.deepEqual(partialMetric.sourceIds, ["fixture.source", "fixture.failed"], "COMMAND_CENTER_METRIC_SOURCE_IDS_INVALID");

  const unknownMetric = commandCenterMetric({
    id: "fixture.unknown",
    label: "未知指标",
    value: null,
    unit: "count",
    definition: "来源可读但业务值缺失时必须显示未知，不能显示健康或零。",
    sources: [available],
    status: "healthy",
    drilldownUrl: "/admin?tab=health",
  });
  assert.equal(unknownMetric.value, null, "COMMAND_CENTER_UNKNOWN_VALUE_MUST_REMAIN_NULL");
  assert.equal(unknownMetric.status, "unknown", "COMMAND_CENTER_UNKNOWN_VALUE_MUST_NOT_BE_HEALTHY");
  assert.equal(unknownMetric.partial, true, "COMMAND_CENTER_UNKNOWN_VALUE_MUST_BE_PARTIAL");

  const anomalies = commandCenterSourceAnomalies([available, failed], generatedAt);
  assert.equal(anomalies.length, 1, "COMMAND_CENTER_SOURCE_ANOMALY_COUNT_INVALID");
  assert.match(anomalies[0]?.description || "", /不会回退为 0/u, "COMMAND_CENTER_ZERO_FALLBACK_DISCLOSURE_MISSING");
  assert.equal(commandCenterOverallStatus([{ id: "business", title: "fixture", description: "fixture", metrics: [partialMetric] }], anomalies), "warning");
  assert.deepEqual(commandCenterDataQuality([available, failed], anomalies), {
    totalSources: 2,
    availableSources: 1,
    partialSources: 0,
    unavailableSources: 1,
    staleSources: 0,
    sourceAnomalyCount: 1,
    oldestRecordAgeSeconds: 0,
  }, "COMMAND_CENTER_DATA_QUALITY_SUMMARY_INVALID");
  const staleSource = commandCenterApplyFreshnessState([source({
    id: "fixture.stale",
    freshnessSeconds: 3_601,
    staleAfterSeconds: 3_600,
  })])[0];
  assert.equal(staleSource?.state, "stale", "COMMAND_CENTER_STALE_SOURCE_MUST_NOT_REMAIN_AVAILABLE");
  assert.equal(commandCenterDataQuality([staleSource!], commandCenterSourceAnomalies([staleSource!], generatedAt)).staleSources, 1, "COMMAND_CENTER_STALE_SOURCE_COUNT_INVALID");

  assert.equal(clampCommandCenterWindowHours(null), 24, "COMMAND_CENTER_DEFAULT_WINDOW_INVALID");
  assert.equal(clampCommandCenterWindowHours(0), 1, "COMMAND_CENTER_MIN_WINDOW_INVALID");
  assert.equal(clampCommandCenterWindowHours(1_000), 168, "COMMAND_CENTER_MAX_WINDOW_INVALID");
  assert.equal(COMMAND_CENTER_POLL_INTERVAL_MS, 15_000, "COMMAND_CENTER_POLL_INTERVAL_INVALID");
  assert.equal(COMMAND_CENTER_SCHEMA_VERSION, 5, "COMMAND_CENTER_SCHEMA_VERSION_INVALID");
  assert.match(COMMAND_CENTER_DEFINITION_VERSION, /^\d{4}-\d{2}-\d{2}\.v\d+$/u, "COMMAND_CENTER_DEFINITION_VERSION_INVALID");
  assert.deepEqual(
    COMMAND_CENTER_VIEW_DEFINITIONS.map((definition) => definition.id),
    ["overview", "members", "revenue", "production", "security", "system", "evidence"],
    "COMMAND_CENTER_GOAL_VIEWS_INVALID",
  );
  assert.equal(normalizeCommandCenterView("security"), "security", "COMMAND_CENTER_VIEW_NORMALIZATION_INVALID");
  assert.equal(normalizeCommandCenterView("unknown"), "overview", "COMMAND_CENTER_UNKNOWN_VIEW_MUST_FALLBACK");
  assert.equal(commandCenterViewDefinition("security").pollIntervalMs, 10_000, "COMMAND_CENTER_SECURITY_POLL_INTERVAL_INVALID");
  assert.equal(commandCenterViewDefinition("revenue").pollIntervalMs, 120_000, "COMMAND_CENTER_REVENUE_POLL_INTERVAL_INVALID");
  assert.equal(commandCenterViewDefinition("security").manualRefreshMinIntervalMs, 5_000, "COMMAND_CENTER_SECURITY_MANUAL_REFRESH_LIMIT_INVALID");
  assert.equal(commandCenterViewDefinition("system").manualRefreshMinIntervalMs, 15_000, "COMMAND_CENTER_SYSTEM_MANUAL_REFRESH_LIMIT_INVALID");
  assert.equal(commandCenterViewDefinition("revenue").manualRefreshMinIntervalMs, 60_000, "COMMAND_CENTER_REVENUE_MANUAL_REFRESH_LIMIT_INVALID");
  assert.equal(commandCenterViewDefinition("evidence").querySectionIds.length, 7, "COMMAND_CENTER_EVIDENCE_MUST_QUERY_REGISTERED_DOMAINS");
  assert.equal(commandCenterPercentage(1, 4), 25, "COMMAND_CENTER_PERCENTAGE_CALCULATION_INVALID");
  assert.equal(commandCenterPercentage(12, 10), 100, "COMMAND_CENTER_PERCENTAGE_UPPER_CLAMP_MISSING");
  assert.equal(commandCenterPercentage(-2, 10), 0, "COMMAND_CENTER_PERCENTAGE_LOWER_CLAMP_MISSING");
  assert.equal(commandCenterPercentage(2, 0), null, "COMMAND_CENTER_ZERO_DENOMINATOR_MUST_BE_UNKNOWN");
  assert.equal(commandCenterFreshnessSeconds(null, generatedAt), null, "COMMAND_CENTER_MISSING_BUSINESS_TIMESTAMP_MUST_BE_UNKNOWN");
  assert.equal(commandCenterFreshnessSeconds("invalid", generatedAt), null, "COMMAND_CENTER_INVALID_BUSINESS_TIMESTAMP_MUST_BE_UNKNOWN");
  assert.equal(commandCenterFreshnessSeconds("2026-10-02T07:59:55.000Z", generatedAt), 5, "COMMAND_CENTER_BUSINESS_FRESHNESS_CALCULATION_INVALID");
  assert.deepEqual(commandCenterFinanceCashSnapshot({
    onlineOrders: [
      { amount: 100, provider_paid_amount: 98 },
      { amount: 52, provider_paid_amount: null },
    ],
    offlineReceipts: [{ amount: 25 }],
    refundAttempts: [
      { state: "completed", paid_amount: 52, provider_refund_amount: 52 },
      { state: "reconciliation_required", paid_amount: 20, provider_refund_amount: null },
      { state: "released", paid_amount: 10, provider_refund_amount: null },
    ],
  }), {
    grossCashReceived: 175,
    completedRefundAmount: 52,
    netCashReceived: 123,
    reconciliationRequiredExposure: 20,
  }, "COMMAND_CENTER_FINANCE_CASH_FIXTURE_MUST_RECONCILE");
  assert.equal(
    commandCenterCredentialCoveragePercent(
      ["llm_models:visible-a", "cover_models:visible-b"],
      ["llm_models:visible-a", "llm_models:hidden-c", "llm_models:hidden-c"],
    ),
    50,
    "COMMAND_CENTER_CREDENTIAL_COVERAGE_MUST_INTERSECT_VISIBLE_KEYS",
  );
  assert.equal(
    commandCenterCredentialCoveragePercent(["video_models:visible-a"], ["video_models:visible-a", "video_models:orphan-b"]),
    100,
    "COMMAND_CENTER_ORPHAN_BINDINGS_MUST_NOT_OVERSTATE_COVERAGE",
  );

  const expectedPermissions = [
    "logs.view",
    "members.view",
    "billing.view",
    "models.view",
    "security.view",
    "announcements.manage",
    "backups.manage",
    "platform.settings.manage",
    "brand.settings.manage",
    "integrations.manage",
    "payment.settings.manage",
    "white_label.manage",
  ];
  assert.deepEqual([...ADMIN_COMMAND_CENTER_PERMISSION_KEYS], expectedPermissions, "COMMAND_CENTER_PERMISSION_SET_INVALID");
  assert.deepEqual([...COMMAND_CENTER_ALL_PERMISSION_KEYS], expectedPermissions, "COMMAND_CENTER_ALL_PERMISSION_SET_INVALID");
  assert.deepEqual([...adminPermissionKeysForTab("dashboard")], [...COMMAND_CENTER_ENTRY_PERMISSION_KEYS], "COMMAND_CENTER_ENTRY_PERMISSION_DRIFT");
  assert.deepEqual(ADMIN_TAB_PERMISSIONS.dashboard, { anyOf: COMMAND_CENTER_ENTRY_PERMISSION_KEYS }, "COMMAND_CENTER_TAB_ANY_OF_REQUIREMENT_MISSING");
  assert.equal(hasAdminPermissionRequirement(["members.view"], ADMIN_TAB_PERMISSIONS.dashboard), true, "COMMAND_CENTER_SINGLE_VIEW_ENTRY_REJECTED");
  assert.equal(hasAdminPermissionRequirement(["announcements.manage"], ADMIN_TAB_PERMISSIONS.dashboard), false, "COMMAND_CENTER_EMPTY_ENTRY_PERMISSION_ACCEPTED");
  assert.equal(hasAdminPermissionRequirement(expectedPermissions, ADMIN_COMMAND_CENTER_PERMISSION_KEYS), true, "COMMAND_CENTER_FULL_PERMISSION_SET_REJECTED");
  assert.equal(hasAdminPermissionRequirement(["logs.view", "security.view"], ADMIN_COMMAND_CENTER_PERMISSION_KEYS), false, "COMMAND_CENTER_PARTIAL_PERMISSION_SET_ACCEPTED");
  assert.deepEqual(
    missingAdminPermissionKeys(["logs.view", "security.view"], ADMIN_COMMAND_CENTER_PERMISSION_KEYS),
    ["members.view", "billing.view", "models.view", "announcements.manage", "backups.manage", "platform.settings.manage", "brand.settings.manage", "integrations.manage", "payment.settings.manage", "white_label.manage"],
    "COMMAND_CENTER_MISSING_PERMISSION_REPORT_INVALID",
  );
  assert.deepEqual(
    visibleCommandCenterViews(["members.view", "models.view"]),
    ["members", "production"],
    "COMMAND_CENTER_VISIBLE_VIEW_SET_INVALID",
  );
  assert.deepEqual(
    visibleCommandCenterViews([], true),
    COMMAND_CENTER_VIEW_DEFINITIONS.map((definition) => definition.id),
    "COMMAND_CENTER_SUPER_ADMIN_VIEW_SET_INCOMPLETE",
  );
  assert.equal(
    normalizeVisibleCommandCenterView("evidence", ["members", "production"]),
    "members",
    "COMMAND_CENTER_UNAUTHORIZED_VIEW_MUST_FALLBACK_TO_FIRST_VISIBLE",
  );
  assert.deepEqual(commandCenterPermissionKeysForView("overview"), ["logs.view", "members.view", "billing.view", "models.view", "security.view"]);
  assert.deepEqual(commandCenterPermissionKeysForView("evidence"), expectedPermissions);
  assert.deepEqual(COMMAND_CENTER_VIEW_PERMISSION_KEYS.members, ["members.view"]);
  assert.deepEqual(COMMAND_CENTER_VIEW_PERMISSION_KEYS.revenue, ["billing.view"]);
  assert.deepEqual(COMMAND_CENTER_VIEW_PERMISSION_KEYS.production, ["models.view"]);
  assert.deepEqual(COMMAND_CENTER_VIEW_PERMISSION_KEYS.security, ["security.view"]);
  assert.deepEqual(COMMAND_CENTER_VIEW_PERMISSION_KEYS.system, ["logs.view"]);
  assert.deepEqual(
    adminRequirementForRequest("/api/admin/command-center", "GET", new URLSearchParams("view=members")),
    { permission: "members.view", requireStepUp: false, operation: "command_center_members" },
    "COMMAND_CENTER_MEMBER_PROXY_REQUIREMENT_INVALID",
  );
  assert.deepEqual(
    adminRequirementForRequest("/api/admin/command-center", "GET", new URLSearchParams("view=revenue")),
    { permission: "billing.view", requireStepUp: false, operation: "command_center_revenue" },
    "COMMAND_CENTER_REVENUE_PROXY_REQUIREMENT_INVALID",
  );
  assert.deepEqual(
    adminRequirementForRequest("/api/admin/command-center", "GET"),
    { permission: "logs.view", requireStepUp: false, operation: "command_center_overview" },
    "COMMAND_CENTER_OVERVIEW_PROXY_REQUIREMENT_INVALID",
  );
  assert.deepEqual(
    adminRequirementForRequest("/api/admin/runtime-telemetry", "GET"),
    { permission: "logs.view", requireStepUp: false, operation: "runtime_telemetry_read" },
    "RUNTIME_TELEMETRY_CENTRAL_POLICY_MISSING",
  );
  assert.deepEqual(
    adminRequirementForRequest("/api/admin/llm-test", "POST"),
    { permission: "models.manage", requireStepUp: true, operation: "llm_test" },
    "LLM_TEST_WRITE_MUST_REQUIRE_MODEL_MANAGEMENT_STEP_UP",
  );
  assert.deepEqual(
    adminRequirementForRequest("/api/admin/llm-test", "GET"),
    { permission: "models.manage", requireStepUp: false, operation: "llm_test" },
    "LLM_TEST_READ_POLICY_MUST_STILL_REQUIRE_MODEL_MANAGEMENT",
  );
  assert.deepEqual(
    adminRequirementForRequest("/api/payment/refund", "POST"),
    { permission: "wallet.adjust", requireStepUp: true, operation: "payment_refund" },
    "PAYMENT_REFUND_MUST_BE_MAPPED_BEFORE_NON_ADMIN_API_EARLY_RETURN",
  );

  const [serverSource, routeSource, routeHandlerSource, panelSource, panelCssSource, adminPageSource, governanceSource, selfAccessSource] = await Promise.all([
    readFile(path.join(root, "src/lib/server/admin-command-center.ts"), "utf8"),
    readFile(path.join(root, "src/app/api/admin/command-center/route.ts"), "utf8"),
    readFile(path.join(root, "src/lib/server/admin-command-center-route-handler.ts"), "utf8"),
    readFile(path.join(root, "src/components/admin/command-center-panel.tsx"), "utf8"),
    readFile(path.join(root, "src/components/admin/command-center-panel.module.css"), "utf8"),
    readFile(path.join(root, "src/app/admin/page.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/admin-governance.ts"), "utf8"),
    readFile(path.join(root, "src/app/api/admin/access-control/self/route.ts"), "utf8"),
  ]);

  for (const table of [
    "users",
    "credit_transactions",
    "payment_orders",
    "offline_payment_receipts",
    "payment_refund_attempts",
    "revenue_records",
    "llm_request_attempts",
    "image_generation_requests",
    "video_tasks",
    "voice_generation_requests",
    "extraction_attempts",
    "llm_models",
    "cover_models",
    "video_models",
    "platform_model_credential_bindings",
    "llm_model_validation_evidence",
    "image_model_validations",
    "video_channel_health",
    "security_events",
    "login_logs",
    "security_cases",
    "operation_flight_events",
    "system_logs",
    "health_checks",
  ]) {
    assert(serverSource.includes(`from("${table}")`), `COMMAND_CENTER_REAL_SOURCE_MISSING:${table}`);
  }

  for (const controlPlaneReader of [
    "readAdminProjectRegistrySnapshot",
    "readUnifiedMessagingStatus",
    "readIncidentSloStatus",
    "readAdminBackupRestoreSnapshot",
    "getSecurityEventReliabilityStatus",
    "readAdminMultitenantBoundarySnapshot",
    "readDomainTlsBrandReleaseStatus",
    "horizontalScaleReadinessSnapshot",
  ]) {
    assert(serverSource.includes(controlPlaneReader), `COMMAND_CENTER_CONTROL_PLANE_SOURCE_MISSING:${controlPlaneReader}`);
  }

  for (const metricId of [
    "finance.cash-received",
    "finance.completed-refunds",
    "finance.net-cash-received",
    "finance.refund-frozen-exposure",
    "finance.usage-revenue",
    "finance.provider-cost",
    "finance.gross-profit",
  ]) {
    assert(serverSource.includes(`id: "${metricId}"`), `COMMAND_CENTER_FINANCE_METRIC_MISSING:${metricId}`);
  }
  assert.match(serverSource, /commandCenterCredentialCoveragePercent\(visibleModelKeys, boundModelKeys\)/u, "COMMAND_CENTER_VISIBLE_CREDENTIAL_INTERSECTION_MISSING");
  assert.match(serverSource, /commandCenterFinanceCashSnapshot\(\{/u, "COMMAND_CENTER_FINANCE_CASH_PURE_FUNCTION_NOT_USED");
  assert.match(serverSource, /\.in\("status", \["paid", "refunded"\]\)/u, "COMMAND_CENTER_REFUNDED_ORDER_GROSS_RECEIPT_MISSING");
  assert.match(serverSource, /\.in\("state", \["completed", "reconciliation_required"\]\)/u, "COMMAND_CENTER_REFUND_TERMINAL_AND_FROZEN_SOURCE_MISSING");
  assert.match(serverSource, /不以订单状态或请求意图替代完成证据/u, "COMMAND_CENTER_REFUND_EVIDENCE_SCOPE_DISCLOSURE_MISSING");
  assert.match(serverSource, /保持冻结并等待人工对账/u, "COMMAND_CENTER_RECONCILIATION_EXPOSURE_DISCLOSURE_MISSING");
  assert.match(serverSource, /id:\s*"models\.llm-validations"/u, "COMMAND_CENTER_LLM_VALIDATION_SOURCE_STATUS_MISSING");
  assert.match(serverSource, /assertFreshLlmModelValidationEvidence/u, "COMMAND_CENTER_LLM_SHARED_FRESHNESS_GATE_MISSING");
  assert.match(serverSource, /resolveProviderSecret/u, "COMMAND_CENTER_LLM_SERVER_SECRET_RESOLUTION_MISSING");
  assert.match(serverSource, /通路指令验收不等于业务质量/u, "COMMAND_CENTER_LLM_BUSINESS_QUALITY_DISCLOSURE_MISSING");
  assert.match(serverSource, /`\$\{table\}:\$\{modelId\}`/u, "COMMAND_CENTER_CATALOG_MODEL_KEY_IDENTITY_MISSING");
  assert.doesNotMatch(serverSource, /percentage\(boundModelKeys\.size/u, "COMMAND_CENTER_ORPHAN_BINDING_OVERCOUNT_REGRESSION");
  assert.match(serverSource, /label:\s*"已配置供应商成本快照"/u, "COMMAND_CENTER_CONFIGURED_COST_SCOPE_LABEL_MISSING");
  assert.match(serverSource, /label:\s*"任务毛利快照"/u, "COMMAND_CENTER_TASK_PROFIT_SCOPE_LABEL_MISSING");
  assert.doesNotMatch(serverSource, /label:\s*"(?:供应商成本|毛利)"/u, "COMMAND_CENTER_FINANCE_SCOPE_OVERCLAIM_REGRESSION");

  for (const metricId of [
    "governance.project-workspaces",
    "governance.unregistered-sources",
    "governance.message-integration",
    "governance.message-dead-letters",
    "governance.open-security-cases",
    "governance.active-incidents",
    "governance.slo-coverage",
    "governance.verified-backups",
    "governance.verified-restore-drills",
    "governance.security-event-durability",
    "governance.security-event-dead-letters",
    "governance.tenant-isolation",
    "governance.domain-release",
    "governance.unknown-host-gate",
    "operations.horizontal-scale-readiness",
  ]) {
    assert(serverSource.includes(`id: "${metricId}"`), `COMMAND_CENTER_GOVERNANCE_METRIC_MISSING:${metricId}`);
  }

  assert.match(serverSource, /\.limit\(/u, "COMMAND_CENTER_BOUNDED_ROW_LIMIT_MISSING");
  assert.match(serverSource, /AbortSignal\.timeout\(QUERY_TIMEOUT_MS\)/u, "COMMAND_CENTER_QUERY_TIMEOUT_MISSING");
  const readRowsSource = serverSource.slice(serverSource.indexOf("async function readRows"), serverSource.indexOf("async function readCount"));
  const readCountSource = serverSource.slice(serverSource.indexOf("async function readCount"), serverSource.indexOf("function controlPlaneSource"));
  assert.match(readRowsSource, /freshnessSeconds:\s*commandCenterFreshnessSeconds\(latestRecordAt, asOf\)/u, "COMMAND_CENTER_ROW_FRESHNESS_MUST_USE_BUSINESS_TIMESTAMP");
  assert.match(readCountSource, /freshnessSeconds:\s*null/u, "COMMAND_CENTER_COUNT_FRESHNESS_WITHOUT_BUSINESS_TIMESTAMP_MUST_BE_UNKNOWN");
  const serverWithoutCacheEviction = serverSource.replaceAll("snapshotCache.delete", "snapshotCache.evict");
  assert.doesNotMatch(serverWithoutCacheEviction, /\.(?:insert|update|upsert|delete|rpc)\s*\(/u, "COMMAND_CENTER_SERVER_MUST_BE_READ_ONLY");
  assert.match(serverSource, /providerCalls:\s*0/u, "COMMAND_CENTER_PROVIDER_CALL_DECLARATION_MISSING");
  assert.match(serverSource, /businessWrites:\s*0/u, "COMMAND_CENTER_WRITE_DECLARATION_MISSING");
  assert.match(serverSource, /const snapshotId\s*=\s*`cc-/u, "COMMAND_CENTER_SNAPSHOT_ID_MISSING");
  assert.match(serverSource, /commandCenterDataQuality\(sources, sourceAnomalies\)/u, "COMMAND_CENTER_DATA_QUALITY_SUMMARY_MISSING");
  assert.match(serverSource, /commandCenterApplyFreshnessState\(\[/u, "COMMAND_CENTER_EFFECTIVE_STALE_STATE_MISSING");
  assert.match(serverSource, /cached\s*&&\s*!cached\.settled/u, "COMMAND_CENTER_IN_FLIGHT_SINGLEFLIGHT_MISSING");
  assert.match(serverSource, /deliverSnapshot\(await cached\.promise,\s*"shared"/u, "COMMAND_CENTER_SHARED_BUILD_DISCLOSURE_MISSING");
  assert.match(serverSource, /deliverSnapshot\(await cached\.promise,\s*"hit"/u, "COMMAND_CENTER_CACHE_HIT_DISCLOSURE_MISSING");
  assert.match(serverSource, /buildDurationMs/u, "COMMAND_CENTER_BUILD_DURATION_MISSING");
  assert.match(serverSource, /nextRefreshAt/u, "COMMAND_CENTER_NEXT_REFRESH_MISSING");

  assert.match(routeHandlerSource, /commandCenterPermissionKeysForView\(view\)/u, "COMMAND_CENTER_VIEW_PERMISSION_LOOKUP_MISSING");
  assert.match(routeHandlerSource, /dependencies\.authorize\(request,\s*requiredPermissions\[0\]/u, "COMMAND_CENTER_VIEW_PRIMARY_CAPABILITY_MISSING");
  assert.match(routeHandlerSource, /missingAdminPermissionKeys\([\s\S]*requiredPermissions/u, "COMMAND_CENTER_VIEW_PERMISSION_SET_CHECK_MISSING");
  assert.match(routeHandlerSource, /ADMIN_PERMISSION_SET_INCOMPLETE/u, "COMMAND_CENTER_PERMISSION_SET_FAILURE_MISSING");
  assert.match(routeHandlerSource, /metadata:\s*\{\s*view,\s*requiredPermissions,\s*missingPermissions\s*\}/u, "COMMAND_CENTER_DENIAL_AUDIT_METADATA_MISSING");
  assert.match(routeHandlerSource, /private, no-store, max-age=0/u, "COMMAND_CENTER_NO_STORE_HEADER_MISSING");
  assert.match(routeHandlerSource, /isCommandCenterView\(requestedView\)/u, "COMMAND_CENTER_VIEW_VALIDATION_MISSING");
  assert.match(routeHandlerSource, /dependencies\.readSnapshot\(\{ hours, view, bypassCache \}\)/u, "COMMAND_CENTER_VIEW_NOT_FORWARDED");
  assert.match(routeHandlerSource, /createCommandCenterGetHandler/u, "COMMAND_CENTER_INJECTABLE_ROUTE_HANDLER_MISSING");
  assert.match(routeHandlerSource, /COMMAND_CENTER_REFRESH_RATE_LIMITED/u, "COMMAND_CENTER_MANUAL_REFRESH_RATE_LIMIT_MISSING");
  assert.match(routeHandlerSource, /"Retry-After"/u, "COMMAND_CENTER_RETRY_AFTER_HEADER_MISSING");
  assert.match(routeHandlerSource, /`\$\{actorId\}:\$\{view\}`/u, "COMMAND_CENTER_ADMIN_VIEW_RATE_LIMIT_SCOPE_MISSING");
  assert.match(routeHandlerSource, /"X-RateLimit-Remaining"/u, "COMMAND_CENTER_RATE_LIMIT_EVIDENCE_HEADER_MISSING");
  assert.match(routeSource, /createCommandCenterGetHandler/u, "COMMAND_CENTER_ROUTE_HANDLER_INTEGRATION_MISSING");
  assert.match(routeSource, /export async function GET/u, "COMMAND_CENTER_GET_ROUTE_MISSING");
  assert.doesNotMatch(routeSource, /export (?:interface|type|function|class) (?!GET)/u, "COMMAND_CENTER_NEXT_ROUTE_EXTRA_EXPORT_FORBIDDEN");
  assert.doesNotMatch(routeSource, /export async function (?:POST|PUT|PATCH|DELETE)/u, "COMMAND_CENTER_MUTATING_ROUTE_FORBIDDEN");

  assert.match(governanceSource, /dashboard:\s*\{\s*anyOf:\s*COMMAND_CENTER_ENTRY_PERMISSION_KEYS\s*\}/u, "COMMAND_CENTER_TAB_ANY_OF_PERMISSION_MISSING");
  assert.match(governanceSource, /pathname\.startsWith\("\/api\/admin\/command-center"\)[\s\S]*commandCenterPermissionKeysForView\(view\)\[0\]/u, "COMMAND_CENTER_VIEW_PROXY_POLICY_MISSING");
  assert.match(governanceSource, /pathname === "\/api\/admin\/runtime-telemetry"[^\n]+permission:\s*"logs\.view"/u, "RUNTIME_TELEMETRY_CENTRAL_POLICY_MISSING");
  assert.match(selfAccessSource, /hasAdminPermissionRequirement\(access\.permissionKeys, requirement\)/u, "COMMAND_CENTER_ENTRY_PERMISSION_SET_CHECK_MISSING");
  assert.match(selfAccessSource, /isSuperAdmin[\s\S]*\? true/u, "COMMAND_CENTER_SUPER_ADMIN_TAB_ACCESS_MISSING");
  assert.match(adminPageSource, /function canExposeAdminTab[\s\S]*state\.tabAccess\[tab\] === true/u, "COMMAND_CENTER_CLIENT_PERMISSION_SET_CHECK_MISSING");
  assert.match(adminPageSource, /\.filter\(\(tab, index, tabs\)[\s\S]*canExposeAdminTab\(adminAccess, tab\)/u, "COMMAND_CENTER_CLIENT_PARTIAL_ACCESS_NOT_HIDDEN");
  assert.match(adminPageSource, /visibleCommandCenterViews\([\s\S]*adminAccess\?\.access\.permissionKeys[\s\S]*adminLevel === "super_admin"/u, "COMMAND_CENTER_ALLOWED_VIEW_DERIVATION_MISSING");
  assert.match(adminPageSource, /<CommandCenterPanel\s+token=\{token\}\s+allowedViews=\{allowedCommandCenterViews\}\s+allowedAdminTabs=\{visibleAdminTabs\}/u, "COMMAND_CENTER_ALLOWED_VIEW_PROP_MISSING");

  assert.match(panelSource, /COMMAND_CENTER_VIEW_DEFINITIONS/u, "COMMAND_CENTER_GOAL_NAVIGATION_MISSING");
  assert.match(panelSource, /normalizeVisibleCommandCenterView\(requestedView, allowedViews\)/u, "COMMAND_CENTER_UNAUTHORIZED_DEEP_LINK_NORMALIZATION_MISSING");
  assert.match(panelSource, /window\.history\.replaceState\(\{\}, "", url\)/u, "COMMAND_CENTER_UNAUTHORIZED_DEEP_LINK_REPLACEMENT_MISSING");
  assert.match(panelSource, /visibleViewDefinitions\.map\(\(definition\)/u, "COMMAND_CENTER_UNAUTHORIZED_VIEW_NAVIGATION_FILTER_MISSING");
  assert.match(panelSource, /!allowedViewSet\.has\(nextView\)/u, "COMMAND_CENTER_UNAUTHORIZED_CLIENT_SELECTION_GUARD_MISSING");
  assert.match(panelSource, /!allowedViewSet\.has\(view\)/u, "COMMAND_CENTER_UNAUTHORIZED_CLIENT_READ_GUARD_MISSING");
  assert.match(panelSource, /commandCenterAuthorizedDrilldownUrl/u, "COMMAND_CENTER_DRILLDOWN_PERMISSION_GATE_MISSING");
  assert.match(panelSource, /data-drilldown-authorized="false"/u, "COMMAND_CENTER_RESTRICTED_DRILLDOWN_DISCLOSURE_MISSING");
  assert.match(panelSource, /dynamic\([\s\S]*member-region-readiness-panel/u, "COMMAND_CENTER_SUPPLEMENTS_MUST_BE_CODE_SPLIT");
  assert.doesNotMatch(panelSource, /import\s+\{\s*MemberRegionReadinessPanel\s*\}/u, "COMMAND_CENTER_SUPPLEMENTS_MUST_NOT_BE_STATIC_IMPORTS");
  assert.match(panelSource, /command-center-goal-navigation/u, "COMMAND_CENTER_GOAL_NAVIGATION_TEST_ID_MISSING");
  assert.match(panelSource, /new URLSearchParams\(\{ hours: String\(windowHours\), view \}\)/u, "COMMAND_CENTER_VIEW_QUERY_MISSING");
  assert.match(panelSource, /viewDefinition\.pollIntervalMs/u, "COMMAND_CENTER_VIEW_POLL_INTERVAL_MISSING");
  assert.match(panelSource, /document\.visibilityState === "visible"/u, "COMMAND_CENTER_HIDDEN_PAGE_PAUSE_MISSING");
  assert.match(panelSource, /navigator\.onLine/u, "COMMAND_CENTER_OFFLINE_PAUSE_MISSING");
  assert.match(panelSource, /暂停轮询/u, "COMMAND_CENTER_PANEL_PAUSE_CONTROL_MISSING");
  assert.match(panelSource, /立即刷新/u, "COMMAND_CENTER_PANEL_MANUAL_REFRESH_MISSING");
  assert.match(panelSource, /cache:\s*"no-store"/u, "COMMAND_CENTER_PANEL_NO_STORE_FETCH_MISSING");
  assert.match(panelSource, /params\.set\("refresh",\s*"1"\)/u, "COMMAND_CENTER_PANEL_CACHE_BYPASS_MISSING");
  assert.match(panelSource, /window\.setTimeout/u, "COMMAND_CENTER_ONE_SHOT_REFRESH_SCHEDULER_MISSING");
  assert.doesNotMatch(panelSource, /window\.setInterval/u, "COMMAND_CENTER_FIXED_INTERVAL_OVERLAP_REGRESSION");
  assert.match(panelSource, /0\.9 \+ Math\.random\(\) \* 0\.2/u, "COMMAND_CENTER_REFRESH_JITTER_MISSING");
  assert.match(panelSource, /30_000 \* \(2 \*\* Math\.min\(2,/u, "COMMAND_CENTER_EXPONENTIAL_BACKOFF_MISSING");
  assert.match(panelSource, /response\.headers\.get\("retry-after"\)/u, "COMMAND_CENTER_RETRY_AFTER_CLIENT_SUPPORT_MISSING");
  assert.match(panelSource, /manualRefreshAvailableAtMs/u, "COMMAND_CENTER_MANUAL_REFRESH_CLIENT_GATE_MISSING");
  assert.match(panelSource, /刷新冷却中/u, "COMMAND_CENTER_MANUAL_REFRESH_COOLDOWN_DISCLOSURE_MISSING");
  assert.match(panelSource, /const resumed = active && !wasAutoRefreshActiveRef\.current/u, "COMMAND_CENTER_RESUME_STALENESS_CHECK_MISSING");
  assert.match(panelSource, /role="status" aria-live="polite"/u, "COMMAND_CENTER_SCOPED_LIVE_REGION_MISSING");
  assert.doesNotMatch(panelSource, /className=\{styles\.snapshotBar\}[^>]*aria-live/u, "COMMAND_CENTER_WHOLE_SNAPSHOT_LIVE_REGION_REGRESSION");
  assert.match(panelSource, /已保留上一份快照，未将指标清零/u, "COMMAND_CENTER_PANEL_STALE_SNAPSHOT_DISCLOSURE_MISSING");
  assert.match(panelSource, /degraded:\s*"性能下降"/u, "COMMAND_CENTER_RAW_DEGRADED_STATE_TRANSLATION_MISSING");
  assert.match(panelSource, /部分样本 \/ 覆盖/u, "COMMAND_CENTER_PARTIAL_SAMPLE_DISCLOSURE_MISSING");
  assert.match(panelSource, /不可按精确总量解读/u, "COMMAND_CENTER_PARTIAL_NOT_EXACT_DISCLOSURE_MISSING");
  assert.match(panelSource, /需关注来源/u, "COMMAND_CENTER_ABNORMAL_SOURCE_GROUP_MISSING");
  assert.match(panelSource, /正常来源（默认收起）/u, "COMMAND_CENTER_NORMAL_SOURCE_SUMMARY_MISSING");
  assert.match(panelSource, /按目标只读轮询 · 非实时流/u, "COMMAND_CENTER_NEAR_REALTIME_DISCLOSURE_MISSING");
  assert.match(panelSource, /新鲜度 \$\{snapshot\.freshnessSeconds\} 秒/u, "COMMAND_CENTER_SNAPSHOT_FRESHNESS_UI_MISSING");
  assert.match(panelSource, /metric\.freshnessSeconds != null/u, "COMMAND_CENTER_NULL_FRESHNESS_UI_COMPATIBILITY_MISSING");
  assert.match(panelSource, /证据链 \{evidenceSources\.length\} 项/u, "COMMAND_CENTER_METRIC_EVIDENCE_CHAIN_MISSING");
  assert.match(panelSource, /command-center-data-quality/u, "COMMAND_CENTER_DATA_QUALITY_UI_MISSING");
  assert.match(panelSource, /data-snapshot-id=\{snapshot\?\.snapshotId \|\| ""\}/u, "COMMAND_CENTER_DOM_SNAPSHOT_ID_EVIDENCE_MISSING");
  assert.match(panelSource, /data-window-hours=\{snapshot\?\.window\.hours \?\? ""\}/u, "COMMAND_CENTER_DOM_WINDOW_EVIDENCE_MISSING");
  assert.match(panelSource, /data-testid=\{`command-center-section-\$\{section\.id\}`\}/u, "COMMAND_CENTER_SECTION_DOM_EVIDENCE_MISSING");
  assert.match(panelSource, /view === "members"[\s\S]*<MemberRegionReadinessPanel[\s\S]*variant="command_center"[\s\S]*autoRefresh/u, "COMMAND_CENTER_MEMBER_REGION_LAZY_VIEW_MISSING");
  assert.match(panelSource, /view === "members"[\s\S]*<ProductUsagePanel[\s\S]*variant="command_center"[\s\S]*autoRefresh/u, "COMMAND_CENTER_PRODUCT_USAGE_LAZY_VIEW_MISSING");
  assert.match(panelSource, /view === "revenue"[\s\S]*<RechargeTimelinePanel[\s\S]*token=\{token\}[\s\S]*variant="command_center"[\s\S]*autoRefresh/u, "COMMAND_CENTER_RECHARGE_TIMELINE_LAZY_VIEW_MISSING");
  assert.match(panelSource, /view === "system"[\s\S]*<RuntimeTelemetryPanel token=\{token\}/u, "COMMAND_CENTER_RUNTIME_TELEMETRY_LAZY_VIEW_MISSING");
  assert.match(panelSource, /view === "system"[\s\S]*<ExternalSiteMonitorPanel[\s\S]*token=\{token\}[\s\S]*autoRefresh/u, "COMMAND_CENTER_EXTERNAL_SITE_MONITOR_LAZY_VIEW_MISSING");
  assert.match(panelSource, /showEvidencePanel[\s\S]*<SloMetricRegistryPanel[\s\S]*windowHours=\{windowHours\}[\s\S]*variant="command_center"[\s\S]*autoRefresh=\{!paused\}/u, "COMMAND_CENTER_SLO_REGISTRY_LAZY_VIEW_MISSING");
  for (const component of ["MemberRegionReadinessPanel", "ProductUsagePanel", "RechargeTimelinePanel", "RuntimeTelemetryPanel", "ExternalSiteMonitorPanel", "SloMetricRegistryPanel"]) {
    assert.match(panelSource, new RegExp(`<${component}[\\s\\S]*?autoRefresh=\\{!paused\\}`, "u"), `COMMAND_CENTER_PAUSE_NOT_PROPAGATED:${component}`);
  }
  assert.doesNotMatch(panelSource, /showOverviewDeck[\s\S]{0,160}<RechargeTimelinePanel/u, "COMMAND_CENTER_OVERVIEW_MUST_NOT_EAGER_LOAD_RECHARGE");
  const pixelFontSizes = Array.from(panelCssSource.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gu), (match) => Number(match[1]));
  assert(pixelFontSizes.length > 0, "COMMAND_CENTER_FONT_SIZE_EVIDENCE_MISSING");
  assert.equal(pixelFontSizes.every((size) => size >= 12), true, "COMMAND_CENTER_AUXILIARY_FONT_BELOW_12PX");
  assert.match(panelCssSource, /\.headlinePlaceholder small\s*\{[^}]*font-size:\s*12px/u, "COMMAND_CENTER_PLACEHOLDER_FONT_FLOOR_MISSING");
  assert.match(panelCssSource, /\.sourceLegendRow small\s*\{[^}]*font-size:\s*12px/u, "COMMAND_CENTER_SOURCE_LEGEND_FONT_FLOOR_MISSING");
  assert.match(panelSource, /key=\{snapshot\?\.snapshotId \|\| "idle"\}/u, "COMMAND_CENTER_REAL_SNAPSHOT_MOTION_KEY_MISSING");
  assert.match(panelCssSource, /\.snapshotPulse\[data-active="true"\]\s*\{\s*animation:\s*command-center-snapshot-confirm[^;]*1;/u, "COMMAND_CENTER_ONE_SHOT_SNAPSHOT_MOTION_MISSING");
  assert.match(panelSource, /function AnimatedMetricValue/u, "COMMAND_CENTER_NUMERIC_TRANSITION_MISSING");
  assert.match(panelSource, /requestAnimationFrame\(renderFrame\)/u, "COMMAND_CENTER_NUMERIC_TRANSITION_FRAME_MISSING");
  assert.match(panelSource, /function MetricTrend/u, "COMMAND_CENTER_REAL_SNAPSHOT_TREND_MISSING");
  assert.match(panelSource, /points\.at\(-1\)\?\.snapshotId === snapshot\.snapshotId/u, "COMMAND_CENTER_TREND_SNAPSHOT_DEDUP_MISSING");
  assert.match(panelSource, /slice\(-8\)/u, "COMMAND_CENTER_TREND_HISTORY_BOUND_MISSING");
  assert.match(panelSource, /等待下一份真实快照后显示本页会话趋势/u, "COMMAND_CENTER_TREND_HONEST_EMPTY_STATE_MISSING");
  assert.match(panelSource, /className=\{styles\.alertPulse\}/u, "COMMAND_CENTER_ALERT_CHANGE_SIGNAL_MISSING");
  assert.match(panelSource, /className=\{styles\.headlineSkeleton\}/u, "COMMAND_CENTER_LOADING_SKELETON_MISSING");
  assert.match(panelCssSource, /\.alertPulse\[data-status="critical"\][^}]*animation:[^;]*1;/u, "COMMAND_CENTER_ALERT_MOTION_MUST_BE_ONE_SHOT");
  assert.match(panelCssSource, /\.metricTrend polyline[\s\S]*?animation:\s*command-center-trend-update[^;]*1;/u, "COMMAND_CENTER_TREND_MOTION_MUST_BE_ONE_SHOT");
  assert.match(panelCssSource, /@media \(prefers-reduced-motion:\s*reduce\)/u, "COMMAND_CENTER_REDUCED_MOTION_SUPPORT_MISSING");
  assert.match(panelCssSource, /prefers-reduced-motion:[\s\S]*?\.alertPulse[\s\S]*?\.metricTrend polyline[\s\S]*?\.headlineSkeleton i\s*\{\s*animation:\s*none;/u, "COMMAND_CENTER_REDUCED_MOTION_COVERAGE_MISSING");
  assert.doesNotMatch(panelSource, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/u, "COMMAND_CENTER_PANEL_BUSINESS_WRITE_FORBIDDEN");
  assert.match(adminPageSource, /<CommandCenterPanel\s+token=\{token\}\s+allowedViews=\{allowedCommandCenterViews\}\s+allowedAdminTabs=\{visibleAdminTabs\}/u, "COMMAND_CENTER_ADMIN_INTEGRATION_MISSING");

  console.log(JSON.stringify({
    verifier: "admin-command-center-contract",
    schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
    realSources: 33,
    sections: 7,
    views: COMMAND_CENTER_VIEW_DEFINITIONS.length,
    pollIntervalMs: COMMAND_CENTER_POLL_INTERVAL_MS,
    boundedQueries: true,
    noStore: true,
    requiredCapabilities: expectedPermissions,
    providerCalls: 0,
    businessWrites: 0,
    adminPageIntegrated: true,
    ok: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
