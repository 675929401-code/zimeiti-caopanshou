import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { adminRequirementForRequest } from "../src/lib/admin-governance";
import { COMMAND_CENTER_DEFINITION_VERSION } from "../src/lib/admin-command-center-domain";
import {
  isSloMetricRegistrySnapshot,
  SLO_METRIC_REGISTRY,
  SLO_METRIC_REGISTRY_VERSION,
  sloMetricAvailability,
} from "../src/lib/slo-metric-registry";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const commandCenterPath = "src/lib/server/admin-command-center.ts";
const commandCenterSource = read(commandCenterPath);
const sourceFile = ts.createSourceFile(commandCenterPath, commandCenterSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const commandCenterMetricIds: string[] = [];
function walk(node: ts.Node): void {
  if (
    ts.isCallExpression(node)
    && node.expression.getText(sourceFile) === "commandCenterMetric"
    && node.arguments.length > 0
    && ts.isObjectLiteralExpression(node.arguments[0])
  ) {
    const idProperty = node.arguments[0].properties.find((property) => (
      ts.isPropertyAssignment(property)
      && ((ts.isIdentifier(property.name) && property.name.text === "id") || (ts.isStringLiteral(property.name) && property.name.text === "id"))
    ));
    if (idProperty && ts.isPropertyAssignment(idProperty) && ts.isStringLiteralLike(idProperty.initializer)) {
      commandCenterMetricIds.push(idProperty.initializer.text);
    }
  }
  ts.forEachChild(node, walk);
}
walk(sourceFile);

assert.equal(commandCenterMetricIds.length, 41, "command center metric inventory drifted from the audited 41 metrics");
assert.equal(SLO_METRIC_REGISTRY.length, 41, "registry must contain exactly the current 41 command-center metrics");
assert.deepEqual(
  [...SLO_METRIC_REGISTRY.map((entry) => entry.id)].sort(),
  [...commandCenterMetricIds].sort(),
  "registry ids must exactly match command-center metric ids",
);
assert.equal(new Set(SLO_METRIC_REGISTRY.map((entry) => entry.id)).size, 41, "metric ids must be unique");

for (const entry of SLO_METRIC_REGISTRY) {
  for (const field of [
    "id",
    "section",
    "name",
    "businessObjective",
    "owner",
    "formula",
    "numerator",
    "denominator",
    "unit",
    "grain",
    "queryVersion",
    "drilldownUrl",
  ] as const) {
    assert.equal(typeof entry[field], "string", `${entry.id}.${field} must be a string`);
    assert.ok(entry[field].trim().length > 0, `${entry.id}.${field} must not be empty`);
  }
  assert.ok(entry.queryVersion.includes(entry.id), `${entry.id} query version must be metric-specific`);
  assert.ok(entry.dataSources.length > 0, `${entry.id} must list at least one data source`);
  assert.ok(Array.isArray(entry.exclusions), `${entry.id} exclusions must be explicit`);
  assert.ok(entry.freshnessTargetSeconds >= 60, `${entry.id} freshness target must be explicit and bounded`);
  assert.ok(entry.alertThreshold.warning.length > 0, `${entry.id} warning threshold missing`);
  assert.ok(entry.alertThreshold.critical.length > 0, `${entry.id} critical threshold missing`);
}

const fixture = JSON.parse(read("scripts/fixtures/slo-metric-registry-statuses.json")) as Record<string, {
  value: number | string | null;
  status: "healthy" | "warning" | "critical" | "unknown" | "unavailable";
  partial: boolean;
  sourceIds: string[];
}>;
assert.equal(sloMetricAvailability(fixture.available), "available");
assert.equal(sloMetricAvailability(fixture.partial), "partial");
assert.equal(sloMetricAvailability(fixture.unavailable), "unavailable");
assert.equal(sloMetricAvailability({ value: 0, status: "healthy", partial: false, sourceIds: ["fixture.zero"] }), "available", "real zero must remain distinguishable from unavailable");
assert.equal(sloMetricAvailability({ value: null, status: "healthy", partial: false, sourceIds: ["fixture"] }), "unavailable", "missing value must never become zero");

const validRuntimeSnapshot = {
  schemaVersion: 1,
  registryVersion: SLO_METRIC_REGISTRY_VERSION,
  commandCenterDefinitionVersion: COMMAND_CENTER_DEFINITION_VERSION,
  asOf: "2026-10-03T08:00:00.000Z",
  freshnessSeconds: 0,
  windowHours: 24,
  summary: { registered: 41, expected: 41, coverageRatio: 1, available: 0, partial: 0, unavailable: 41, historyConnected: 0 },
  historyPersistence: { state: "unavailable", designVersion: "2026-10-03.design-v1", reasonCode: "HISTORY_MIGRATION_NOT_APPLIED", latestCaptureAt: null, runCount: null, boundedPointsPerMetric: 12 },
  incidentSlo: { state: "unavailable", migrationApplied: null, collectorsConnected: false, definitions: null, availableMeasurements: null, note: "fixture" },
  metrics: SLO_METRIC_REGISTRY.map((entry) => ({
    ...entry,
    current: { value: null, unit: entry.unit, metricStatus: "unavailable", availability: "unavailable", partial: false, asOf: null, freshnessSeconds: null, coverageRatio: null, sourceIds: [] },
    history: { state: "unavailable", points: [] },
  })),
  readBudget: { commandCenterViews: 6, maximumHistoryRuns: 12, maximumHistoryRows: 492, providerCalls: 0, businessWrites: 0 },
  refresh: { pollIntervalMs: 300_000, nextRefreshAt: "2026-10-03T08:05:00.000Z", cacheStatus: "miss", buildDurationMs: 12, rateLimit: { scope: "process-local-admin", limit: 1, intervalMs: 60_000, remaining: 1, retryAfterSeconds: 0, nextAllowedAt: "2026-10-03T08:00:00.000Z" }, readOnly: true },
};
assert.equal(isSloMetricRegistrySnapshot(validRuntimeSnapshot), true, "complete runtime snapshot must be accepted");
assert.equal(isSloMetricRegistrySnapshot({ ...validRuntimeSnapshot, refresh: { ...validRuntimeSnapshot.refresh, rateLimit: null } }), false, "malformed nested refresh must be rejected before render");
assert.equal(isSloMetricRegistrySnapshot({ ...validRuntimeSnapshot, metrics: [{ id: "partial-only" }] }), false, "shallow metric payload must be rejected before render");

const server = read("src/lib/server/slo-metric-registry.ts");
for (const view of ["members", "revenue", "production", "security", "system", "evidence"]) {
  assert.match(server, new RegExp(`"${view}"`, "u"), `current read must include ${view}`);
}
assert.match(server, /Promise\.allSettled/u, "view failures must remain isolated");
assert.match(server, /value:\s*value\?\.value\s*\?\?\s*null/u, "missing current values must remain null");
assert.match(server, /HISTORY_MIGRATION_NOT_APPLIED/u, "missing history schema must be explicit");
assert.match(server, /registryCache/u, "server cache missing");
assert.match(server, /!cached\.settled/u, "singleflight reuse missing");
assert.match(server, /MAX_REGISTRY_CACHE_ENTRIES\s*=\s*32/u, "registry cache must have a strict cardinality bound");
assert.match(server, /pruneRegistryCache\(now\)/u, "registry cache must prune before admitting a new key");
assert.match(server, /MAX_REGISTRY_BUILD_CONCURRENCY\s*=\s*2/u, "registry builds must have a global concurrency bound");
assert.match(server, /withRegistryBuildSlot/u, "registry builds must pass through the concurrency gate");
assert.match(server, /maximumHistoryRows/u, "bounded history budget missing");
assert.match(server, /providerCalls:\s*0/u);
assert.match(server, /businessWrites:\s*0/u);

const readRoute = read("src/app/api/admin/slo-metrics/registry/route.ts");
assert.match(readRoute, /authorizeAdminCapability\(request, "logs\.view"/u);
assert.match(readRoute, /ADMIN_COMMAND_CENTER_PERMISSION_KEYS/u, "composite source permissions must be enforced");
assert.match(readRoute, /private, no-store/u);
assert.match(readRoute, /status:\s*429/u);
assert.match(readRoute, /"Retry-After"/u);
assert.match(readRoute, /NORMAL_READ_MIN_INTERVAL_MS\s*=\s*15_000/u, "normal reads need a bounded per-admin-window cadence");
assert.match(readRoute, /MAX_READ_KEYS\s*=\s*2_048/u, "normal read limiter must have a strict cardinality bound");
assert.match(readRoute, /while \(manualRefreshAt\.size > MAX_REFRESH_ACTORS\)/u, "manual refresh limiter must stay cardinality-bounded under a burst of new actors");
assert.match(readRoute, /SLO_METRIC_REGISTRY_READ_RATE_LIMITED/u, "normal read limiter response code missing");
assert.match(readRoute, /SUPPORTED_WINDOW_HOURS\s*=\s*new Set\(\[24, 72, 168\]\)/u, "only product-supported windows may allocate cache keys");
assert.match(readRoute, /FIXED_HISTORY_POINTS\s*=\s*12/u, "history point count must be fixed to the UI contract");

const governance = read("src/lib/admin-governance.ts");
assert.match(governance, /pathname === "\/api\/admin\/slo-metrics\/registry"/u, "exact admin-governance route mapping missing");
assert.match(governance, /slo_metric_registry_read/u);
assert.deepEqual(adminRequirementForRequest("/api/admin/slo-metrics/registry", "GET"), {
  permission: "logs.view",
  requireStepUp: false,
  operation: "slo_metric_registry_read",
});
assert.deepEqual(adminRequirementForRequest("/api/admin/slo-metrics/registry", "POST"), {
  permission: "admin.accounts.manage",
  requireStepUp: true,
  operation: "unmapped_admin_api",
});

const captureRoute = read("src/app/api/internal/slo-metrics/capture/route.ts");
assert.match(captureRoute, /SLO_METRIC_CAPTURE_ENABLED/u);
assert.match(captureRoute, /SLO_METRIC_CAPTURE_SECRET/u);
assert.match(captureRoute, /createHmac\("sha256"/u);
assert.match(captureRoute, /timingSafeEqual/u);
assert.match(captureRoute, /idempotency-key/u);
assert.match(captureRoute, /x-slo-capture-timestamp/u);
assert.match(captureRoute, /status.*429|, 429,/u);
assert.match(captureRoute, /HISTORY_MIGRATION_NOT_APPLIED/u);
assert.doesNotMatch(captureRoute, /authorizeAdminCapability/u, "capture is service-signed and must not be browser-cookie authorized");

const captureScript = read("scripts/capture-slo-metric-snapshot.mjs");
assert.match(captureScript, /mode:\s*"plan"/u);
assert.match(captureScript, /networkRequests:\s*0/u);
assert.match(captureScript, /--execute/u);
assert.match(captureScript, /createHmac/u);

const designSql = read("docs/design-sql/admin-slo-metric-history-v1.sql");
assert.match(designSql, /DESIGN ONLY/u);
assert.match(designSql, /admin_metric_snapshot_runs/u);
assert.match(designSql, /admin_metric_snapshot_values/u);
assert.match(designSql, /capture_admin_metric_snapshot/u);
assert.match(designSql, /enable row level security/u);
assert.match(designSql, /service_role/u);
assert.match(designSql, /IDEMPOTENCY_CONFLICT/u);
const appliedMigrationMentions = fs.readdirSync(path.join(root, "supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .filter((name) => /metric_snapshot|slo_metric_history/u.test(name));
assert.deepEqual(appliedMigrationMentions, [], "history SQL must remain design-only in this task");

const panel = read("src/components/admin/slo-metric-registry-panel.tsx");
assert.match(panel, /document\.hidden/u);
assert.match(panel, /navigator\.onLine/u);
assert.match(panel, /AbortController/u);
assert.match(panel, /Retry-After/u);
assert.match(panel, /windowHours\?:\s*number/u, "command-center window must be forwarded to the registry panel");
assert.match(panel, /hours:\s*String\(windowHours\)/u, "registry request must use the active command-center window");
assert.match(panel, /nextAutoRefreshAtMs/u, "automatic cadence must have an independent timer");
assert.match(panel, /manualRefreshAvailableAtMs/u, "manual cooldown must have an independent timer");
assert.doesNotMatch(panel, /const \[nextRefreshAtMs,/u, "manual and automatic timers must not be conflated");
assert.match(panel, /isSloMetricRegistrySnapshot\(body\)/u, "panel must use the shared deep response guard");
assert.match(panel, /requestAbortRef\.current\?\.abort\(\)/u, "window changes must abort stale reads");
assert.match(panel, /data-window-hours=\{snapshot\?\.windowHours \?\? ""\}/u, "rendered window evidence missing");
assert.match(panel, /data-testid=\{`slo-metric-\$\{entry\.id\}`\}/u, "metric-level DOM evidence missing");
assert.equal((panel.match(/data-missing=/gu) || []).length, 1, "each missing metric must expose exactly one DOM evidence marker");
assert.match(panel, /不会显示空折线或 0/u);
assert.match(panel, /独立签名调度器/u);
assert.doesNotMatch(panel, /setInterval/u, "component must use one-shot timers");
const css = read("src/components/admin/slo-metric-registry-panel.module.css");
assert.match(css, /prefers-reduced-motion/u);
const undersizedFonts = [...css.matchAll(/font-size:\s*([0-9.]+)px/gu)]
  .map((match) => Number(match[1]))
  .filter((size) => size < 12);
assert.deepEqual(undersizedFonts, [], "visible font sizes must be at least 12px");

console.log(JSON.stringify({
  ok: true,
  registryVersion: SLO_METRIC_REGISTRY_VERSION,
  commandCenterMetrics: commandCenterMetricIds.length,
  registeredMetrics: SLO_METRIC_REGISTRY.length,
  historyPersistence: "design_only_unavailable",
  captureExecuted: false,
  databaseWrites: 0,
  providerCalls: 0,
}, null, 2));
