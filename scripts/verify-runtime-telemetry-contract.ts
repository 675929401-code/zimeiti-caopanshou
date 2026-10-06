import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  RUNTIME_TELEMETRY_IDLE_AFTER_MS,
  RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
  RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE,
  RUNTIME_TELEMETRY_SCOPE,
  isRuntimeTelemetryResponse,
  runtimeTelemetryFreshness,
} from "@/lib/runtime-telemetry-contract";
import {
  RuntimeTelemetryAdmissionGate,
  calculateCpuPercentOfSingleCore,
  evaluateRuntimeTelemetryIdleState,
  readRuntimeTelemetrySnapshot,
} from "@/lib/server/runtime-telemetry";
import { adminRequirementForRequest } from "@/lib/admin-governance";

const root = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

async function verifyAdmissionGate(): Promise<void> {
  const gate = new RuntimeTelemetryAdmissionGate(RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS);
  let finishFirst: ((value: string) => void) | undefined;
  const first = gate.run(
    "fixture-admin",
    () => new Promise<string>((resolve) => { finishFirst = resolve; }),
    100_000,
  );
  await Promise.resolve();

  const concurrent = await gate.run("fixture-admin", async () => "unexpected", 100_000);
  assert.equal(concurrent.allowed, false, "RUNTIME_TELEMETRY_SINGLE_FLIGHT_MUST_REJECT_CONCURRENT_READ");
  if (!concurrent.allowed) {
    assert.equal(concurrent.reason, "single_flight", "RUNTIME_TELEMETRY_SINGLE_FLIGHT_REASON_INVALID");
    assert(concurrent.retryAfterMs >= 1_000, "RUNTIME_TELEMETRY_SINGLE_FLIGHT_RETRY_TOO_SHORT");
  }

  assert(finishFirst, "RUNTIME_TELEMETRY_FIXTURE_RELEASE_MISSING");
  finishFirst("first");
  const completed = await first;
  assert.equal(completed.allowed, true, "RUNTIME_TELEMETRY_FIRST_READ_MUST_PASS");

  const early = await gate.run("fixture-admin", async () => "unexpected", 114_999);
  assert.equal(early.allowed, false, "RUNTIME_TELEMETRY_MINIMUM_INTERVAL_MUST_REJECT_EARLY_READ");
  if (!early.allowed) {
    assert.equal(early.reason, "minimum_interval", "RUNTIME_TELEMETRY_MINIMUM_INTERVAL_REASON_INVALID");
    assert.equal(early.retryAfterMs, 1, "RUNTIME_TELEMETRY_RETRY_REMAINDER_INVALID");
  }

  const released = await gate.run("fixture-admin", async () => "released", 115_000);
  assert.equal(released.allowed, true, "RUNTIME_TELEMETRY_READ_MUST_RELEASE_AT_FIFTEEN_SECONDS");
}

async function verifyLiveBackgroundSampler(): Promise<void> {
  const warmup = readRuntimeTelemetrySnapshot();
  assert.equal(warmup.current?.cpuDelta.status, "warming_up", "RUNTIME_TELEMETRY_FIRST_SAMPLE_MUST_DISCLOSE_WARMUP");
  assert((warmup.current?.memory.rssBytes || 0) > 0, "RUNTIME_TELEMETRY_WARMUP_MUST_INCLUDE_PROCESS_MEMORY");

  await wait(warmup.sampling.intervalMs + 250);
  const sampled = readRuntimeTelemetrySnapshot();
  assert.equal(sampled.sampling.startedAt, warmup.sampling.startedAt, "RUNTIME_TELEMETRY_MUST_REUSE_ONE_PROCESS_SAMPLER");
  assert.equal(sampled.current?.cpuDelta.status, "available", "RUNTIME_TELEMETRY_BACKGROUND_CPU_DELTA_MISSING");
  assert.equal(sampled.current?.eventLoop.status, "available", "RUNTIME_TELEMETRY_BACKGROUND_EVENT_LOOP_MISSING");
  assert((sampled.series.length || 0) >= 2, "RUNTIME_TELEMETRY_BACKGROUND_SERIES_DID_NOT_ADVANCE");

  const simulatedIdleAt = Date.parse(sampled.idlePolicy.lastReadAt) + RUNTIME_TELEMETRY_IDLE_AFTER_MS + 1;
  assert.equal(evaluateRuntimeTelemetryIdleState(simulatedIdleAt), "idle_suspended", "RUNTIME_TELEMETRY_IDLE_SUSPENSION_MISSING");
  const suspended = readRuntimeTelemetrySnapshot({ nowMs: simulatedIdleAt, touchActivity: false });
  assert.equal(suspended.idlePolicy.state, "idle_suspended", "RUNTIME_TELEMETRY_IDLE_STATE_NOT_DISCLOSED");
  assert.equal(suspended.cacheStatus, "background_sampler_idle_suspended", "RUNTIME_TELEMETRY_IDLE_CACHE_STATUS_INVALID");

  const samplesAtSuspension = suspended.series.length;
  await wait(suspended.sampling.intervalMs + 250);
  const stillSuspended = readRuntimeTelemetrySnapshot({
    nowMs: simulatedIdleAt + suspended.sampling.intervalMs + 250,
    touchActivity: false,
  });
  assert.equal(stillSuspended.series.length, samplesAtSuspension, "RUNTIME_TELEMETRY_IDLE_TIMER_MUST_STOP_SAMPLING");

  const resumed = readRuntimeTelemetrySnapshot();
  assert.equal(resumed.sampling.startedAt, warmup.sampling.startedAt, "RUNTIME_TELEMETRY_RESUME_MUST_NOT_CREATE_SECOND_SAMPLER");
  assert.equal(resumed.idlePolicy.state, "running", "RUNTIME_TELEMETRY_IDLE_RESUME_FAILED");
  assert.equal(resumed.idlePolicy.resumedOnThisRead, true, "RUNTIME_TELEMETRY_RESUME_DISCLOSURE_MISSING");
  assert.equal(resumed.cacheStatus, "background_sampler_resumed", "RUNTIME_TELEMETRY_RESUME_CACHE_STATUS_INVALID");

  await wait(resumed.sampling.intervalMs + 250);
  const sampledAfterResume = readRuntimeTelemetrySnapshot();
  assert(sampledAfterResume.series.length > samplesAtSuspension, "RUNTIME_TELEMETRY_RESUME_MUST_RESTART_BACKGROUND_SAMPLING");
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await source("scripts/fixtures/runtime-telemetry-current-web-process.json")) as unknown;
  assert(isRuntimeTelemetryResponse(fixture), "RUNTIME_TELEMETRY_FIXTURE_CONTRACT_INVALID");
  assert.equal(fixture.scope, RUNTIME_TELEMETRY_SCOPE, "RUNTIME_TELEMETRY_SCOPE_MUST_BE_CURRENT_WEB_PROCESS");
  assert.equal(fixture.rateLimit.scope, RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE, "RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE_INVALID");
  assert.equal(fixture.rateLimit.minimumIntervalMs, 15_000, "RUNTIME_TELEMETRY_MINIMUM_INTERVAL_INVALID");
  assert.equal(fixture.idlePolicy.idleAfterMs, 300_000, "RUNTIME_TELEMETRY_IDLE_INTERVAL_INVALID");
  assert.equal(fixture.idlePolicy.suspendsTimer, true, "RUNTIME_TELEMETRY_IDLE_TIMER_POLICY_MISSING");
  assert.equal(fixture.idlePolicy.disablesEventLoopDelay, true, "RUNTIME_TELEMETRY_IDLE_DELAY_POLICY_MISSING");
  assert.equal(fixture.sampling.persistence, "process_memory_only", "RUNTIME_TELEMETRY_PHASE_ONE_MUST_NOT_CLAIM_PERSISTENCE");
  assert.equal(fixture.current?.cpuDelta.totalMicros, 125_000, "RUNTIME_TELEMETRY_CPU_DELTA_MISSING");
  assert.equal(fixture.current?.memory.rssBytes, 268_435_456, "RUNTIME_TELEMETRY_RSS_MISSING");
  assert.equal(fixture.current?.eventLoop.delayP95Ms, 3.75, "RUNTIME_TELEMETRY_EVENT_LOOP_DELAY_MISSING");
  assert.equal(fixture.current?.uptimeSeconds, 3_600.25, "RUNTIME_TELEMETRY_UPTIME_MISSING");

  for (const metric of Object.values(fixture.unavailable)) {
    assert.equal(metric.status, "unavailable", "RUNTIME_TELEMETRY_MISSING_HOST_METRIC_MUST_BE_UNAVAILABLE");
    assert.equal(metric.reason, "not_collected_in_phase_1", "RUNTIME_TELEMETRY_UNAVAILABLE_REASON_INVALID");
  }
  assert.deepEqual(fixture.privacy, {
    includesSecrets: false,
    includesUserData: false,
    includesRoutes: false,
    includesHostIdentity: false,
  }, "RUNTIME_TELEMETRY_PRIVACY_BOUNDARY_INVALID");

  assert.deepEqual(
    runtimeTelemetryFreshness("2026-10-03T00:00:15.000Z", Date.parse("2026-10-03T00:00:15.250Z")),
    { state: "fresh", ageMs: 250, staleAfterMs: 15_000 },
    "RUNTIME_TELEMETRY_FRESHNESS_CALCULATION_INVALID",
  );
  assert.equal(
    runtimeTelemetryFreshness("2026-10-03T00:00:15.000Z", Date.parse("2026-10-03T00:00:31.000Z")).state,
    "stale",
    "RUNTIME_TELEMETRY_STALE_STATE_MISSING",
  );
  assert.equal(calculateCpuPercentOfSingleCore(250_000, 1_000), 25, "RUNTIME_TELEMETRY_CPU_PERCENT_INVALID");
  assert.equal(calculateCpuPercentOfSingleCore(1, 0), null, "RUNTIME_TELEMETRY_CPU_ZERO_INTERVAL_MUST_BE_UNKNOWN");
  await verifyAdmissionGate();
  await verifyLiveBackgroundSampler();

  assert.deepEqual(
    adminRequirementForRequest("/api/admin/runtime-telemetry", "GET"),
    { permission: "logs.view", requireStepUp: false, operation: "runtime_telemetry_read" },
    "RUNTIME_TELEMETRY_CENTRAL_PROXY_POLICY_MISSING",
  );

  const [samplerSource, routeSource, panelSource, panelStyles, persistenceDesign, governanceSource] = await Promise.all([
    source("src/lib/server/runtime-telemetry.ts"),
    source("src/app/api/admin/runtime-telemetry/route.ts"),
    source("src/components/admin/runtime-telemetry-panel.tsx"),
    source("src/components/admin/runtime-telemetry-panel.module.css"),
    source("docs/server-load-telemetry-persistence-design.md"),
    source("src/lib/admin-governance.ts"),
  ]);

  for (const required of [
    "process.cpuUsage()",
    "process.memoryUsage()",
    "process.uptime()",
    "performance.eventLoopUtilization",
    "monitorEventLoopDelay",
    "timer.unref()",
    "eventLoopDelay.disable()",
    "RUNTIME_TELEMETRY_IDLE_AFTER_MS",
    "__agentHubRuntimeTelemetrySamplerV1",
  ]) {
    assert(samplerSource.includes(required), `RUNTIME_TELEMETRY_SAMPLER_PRIMITIVE_MISSING:${required}`);
  }
  assert.equal(
    (samplerSource.match(/monitorEventLoopDelay\(\{ resolution:/gu) || []).length,
    1,
    "RUNTIME_TELEMETRY_MUST_CREATE_ONLY_ONE_DELAY_MONITOR_PER_SAMPLER",
  );
  assert.doesNotMatch(
    samplerSource,
    /node:os|os\.(?:cpus|totalmem|freemem|networkInterfaces|hostname)|statfs/iu,
    "RUNTIME_TELEMETRY_PHASE_ONE_MUST_NOT_COLLECT_HOST_TOTALS",
  );
  assert.doesNotMatch(
    routeSource,
    /process\.(?:cpuUsage|memoryUsage|uptime)|eventLoopUtilization|monitorEventLoopDelay/u,
    "RUNTIME_TELEMETRY_ROUTE_MUST_NOT_RECOMPUTE_METRICS_PER_REQUEST",
  );
  for (const required of ["authorizeAdminCapability", "private, no-store", "status: 429", "Retry-After", "touchActivity: false", "idlePolicy: snapshot.idlePolicy"]) {
    assert(routeSource.includes(required), `RUNTIME_TELEMETRY_API_GUARD_MISSING:${required}`);
  }
  assert.match(routeSource, /authorizeAdminCapability\(request,\s*"logs\.view"/u, "RUNTIME_TELEMETRY_ROUTE_LOG_PERMISSION_MISSING");
  assert.match(governanceSource, /pathname === "\/api\/admin\/runtime-telemetry"[^\n]+permission:\s*"logs\.view"/u, "RUNTIME_TELEMETRY_PROXY_LOG_PERMISSION_MISSING");
  for (const required of [
    "scope: current_web_process",
    "第一阶段未接入",
    "不会用当前开发电脑的一次性采样冒充服务器总量",
    "document.hidden",
    "navigator.onLine",
    "visibilitychange",
    "恢复可见且联网后，仅在快照已到期时读取",
  ]) {
    assert(panelSource.includes(required), `RUNTIME_TELEMETRY_PANEL_BOUNDARY_MISSING:${required}`);
  }
  const fontSizes = [...panelStyles.matchAll(/font-size:\s*(\d+)px/gu)].map((match) => Number(match[1]));
  assert(fontSizes.length > 0, "RUNTIME_TELEMETRY_PANEL_FONT_SIZES_MISSING");
  assert(fontSizes.every((size) => size >= 12), "RUNTIME_TELEMETRY_PANEL_TEXT_BELOW_TWELVE_PIXELS");
  for (const required of [
    "--rt-bg: #f3f4ef",
    "--rt-panel: rgba(255, 254, 250, 0.96)",
    "--rt-text: #17201d",
    "color-scheme: light",
    ":focus-visible",
    "@media (max-width: 1180px)",
    "prefers-reduced-motion",
  ]) {
    assert(panelStyles.includes(required), `RUNTIME_TELEMETRY_SOFT_WHITE_STYLE_MISSING:${required}`);
  }
  for (const required of ["DESIGN-ONLY", "RLS", "30 天", "回滚", "未应用", "5 分钟无读取", "eventLoopDelay.disable", "页面隐藏或离线"]) {
    assert(persistenceDesign.includes(required), `RUNTIME_TELEMETRY_PERSISTENCE_DESIGN_MISSING:${required}`);
  }

  console.log(JSON.stringify({
    ok: true,
    scope: fixture.scope,
    checks: {
      fixtureContract: true,
      backgroundSampler: true,
      singletonSamplerRuntime: true,
      idleSuspensionAndResume: true,
      visibilityAndOfflinePause: true,
      softWhiteReadableStyles: true,
      processOnlyBoundary: true,
      singleFlight: true,
      minimumIntervalMs: RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
      noStoreAdminApi: true,
      persistenceDesignOnly: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
