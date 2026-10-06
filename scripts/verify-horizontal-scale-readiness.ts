import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HORIZONTAL_SCALE_CAPACITY_TARGETS,
  HORIZONTAL_SCALE_OBSERVABILITY_MIGRATION_RESERVATION,
  HORIZONTAL_SCALE_READINESS_DIMENSIONS,
  horizontalScaleReadinessSnapshot,
} from "../src/lib/horizontal-scale-readiness-contract";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`HORIZONTAL_SCALE_READINESS_CHECK_FAILED: ${message}`);
}

function includesAll(source: string, values: readonly string[]): boolean {
  return values.every((value) => source.includes(value));
}

const files = {
  taskList: read("docs/后台基本设置与控制平面未完成任务清单-2026-10-02.md"),
  pm2: read("deploy/pm2/ecosystem.vnext.config.cjs"),
  auth: read("src/lib/auth.ts"),
  sessions: read("supabase/migrations/20260927103000_user_auth_sessions_two_device_limit.sql"),
  securityEdge: read("src/lib/security-edge.ts"),
  security: read("src/lib/security.ts"),
  llmState: read("src/app/api/llm/llm-state.ts"),
  supabaseClient: read("src/storage/database/supabase-client.ts"),
  legacyDb: read("src/lib/db.ts"),
  queueLoop: read("src/lib/durable-queue-loop.ts"),
  videoQueue: read("supabase/migrations/20260903212000_digital_video_dispatch_queue.sql"),
  humanQueue: read("supabase/migrations/20260904023000_digital_human_long_video_runtime.sql"),
  queueRuntime: read("src/lib/media-queue-worker-runtime.ts"),
  incidentSlo: read("src/lib/incident-slo-control-plane.ts"),
  capacityProbe: read("scripts/verify-release-operational-capacity.mjs"),
  productionEnv: read("deploy/environments/production.env.example"),
  nginx: read("deploy/nginx/agent-hub.vnext.conf.example"),
  domainControl: read("src/lib/domain-tls-brand-release-control-plane.ts"),
  api: read("src/app/api/admin/horizontal-scale-readiness/route.ts"),
  plan: read("docs/大流量与横向扩展一期审计与零成本验证计划-2026-10-02.md"),
};

check(includesAll(files.taskList, [
  "### 14. 建设可水平扩展的大流量架构",
  "状态：一期源码审计已完成；多 Web、容量实测与故障演练尚不可用。",
]), "task 14 must remain explicit about the completed audit and unavailable runtime closure");

check(includesAll(files.pm2, [
  'exec_mode: "fork"',
  "instances: 1",
  'name: "agent-hub-web"',
  'name: "agent-hub-media-worker"',
  'process.env.MEDIA_QUEUE_WORKER_INSTANCES || "2"',
  "Math.min(8",
]), "PM2 must retain the one-Web and bounded 2-to-8-worker topology");

check(includesAll(files.auth, ["payload.sessionId", "isUserAuthSessionActive", "AUTH_AUTHORITY_UNAVAILABLE", "status: 503"]), "authentication must use durable session authority and distinguish authority outage");
check(includesAll(files.sessions, ["user_auth_sessions", "session_id", "pg_advisory_xact_lock", "concurrency_limit"]), "session migration must keep durable concurrency control");

check(includesAll(files.securityEdge, ["rateLimitStore = new Map", "ipBanStore = new Map"]), "security edge process-local state must remain an explicit blocker");
check(files.security.includes("new Map"), "security module process-local Maps must be detected");
check(includesAll(files.llmState, ["agentConfigCache = new Map", "frequencyLimitStore = new Map"]), "LLM process-local caches and limiter must be detected");

check(includesAll(files.supabaseClient, ["let supabaseClient", "if (!supabaseClient)", "return supabaseClient"]), "Supabase client must be recognized as process-cached");
check(/max:\s*10/u.test(files.legacyDb), "legacy pg pool per-process limit must remain visible");

check(includesAll(files.queueLoop, ["A single-process scheduler", "Database claim RPCs remain the cross-process", "bounded graceful drain"]), "queue loop boundary must be explicit");
check(/FOR UPDATE(?: OF [a-z]+)? SKIP LOCKED/iu.test(files.videoQueue), "digital video claim must use SKIP LOCKED");
check(/FOR UPDATE(?: OF [a-z]+)? SKIP LOCKED/iu.test(files.humanQueue), "digital-human claim must use SKIP LOCKED");
check(includesAll(files.queueRuntime, ["stopDigitalVideoQueueWorker", "stopDigitalHumanLongWorker"]), "media workers must retain graceful stop hooks");
check(includesAll(files.incidentSlo, ["worker_and_queue_runtime", 'state: "not_connected"', "no shared heartbeat source"]), "shared worker heartbeat must remain honestly disconnected");

check(includesAll(files.capacityProbe, [
  "PROBE_TOTAL_REQUESTS = 400",
  "PROBE_CONCURRENCY = 200",
  "PROBE_P95_LIMIT_MS = 3_000",
  "authenticatedSessions: 0",
  "databaseWrites: 0",
  "paidModelCalls: 0",
]), "existing capacity evidence must be limited to the zero-cost liveness probe");

check(includesAll(files.productionEnv, ["ASSET_DELIVERY_MODE=disk", "ASSET_STORAGE_DRIVER=disk", "COS_CDN_BASE_URL="]), "production template must show disk default and inactive CDN base");
check(files.nginx.includes("COS/CDN"), "Nginx example must retain an explicit CDN boundary");
check(files.domainControl.includes("No Cloudflare for SaaS or explicit gateway connector is configured."), "WAF/gateway gap must remain explicit");

const snapshot = horizontalScaleReadinessSnapshot();
check(snapshot.overall === "unavailable" && snapshot.readyForMultipleWebInstances === false, "contract must not claim multi-Web readiness");
check(snapshot.capacity.measured === null && snapshot.capacity.targetStatus === "proposed_unvalidated", "capacity targets must not masquerade as measurements");
check(snapshot.validation.loadOrStressTestExecuted === false && snapshot.validation.paidUpstreamCalls === 0 && snapshot.validation.databaseWrites === 0, "contract must preserve zero-cost, no-write evidence boundary");
check(HORIZONTAL_SCALE_READINESS_DIMENSIONS.length >= 10, "all required scale dimensions must be represented");
check(HORIZONTAL_SCALE_READINESS_DIMENSIONS.every((dimension) => dimension.state === "partial" || dimension.state === "unavailable"), "no dimension may claim ready in phase one");
check(HORIZONTAL_SCALE_CAPACITY_TARGETS.length >= 7, "capacity plan must cover all task-14 workloads");
check(HORIZONTAL_SCALE_CAPACITY_TARGETS.every((target) => target.targetRps > 0
  && target.concurrency > 0
  && target.p95Milliseconds > 0
  && target.p99Milliseconds >= target.p95Milliseconds
  && target.maximumUnexpectedErrorRate >= 0), "every unvalidated target must define RPS, concurrency, P95, P99 and error rate");

check(includesAll(files.api, [
  'authorizeAdminCapability(request, "logs.view"',
  'operation: "horizontal_scale_readiness_status_read"',
  '"Cache-Control": "private, no-store, max-age=0"',
  'Vary: "Authorization, Cookie"',
  "horizontalScaleReadinessSnapshot()",
]), "admin API must be authorized, private and read-only");
check(!files.api.includes("auditAllowed: true"), "status read must not request an allowed audit write");

check(includesAll(files.plan, [
  "1 个公共 Web",
  "零成本验证阶段",
  "P95",
  "P99",
  "最终回滚",
  "sqlFileCreated=false",
  "applied=false",
]), "plan must document topology, capacity, rollback and design-only migration boundary");

const reservedMigrationFile = join(root, "supabase", "migrations", `${HORIZONTAL_SCALE_OBSERVABILITY_MIGRATION_RESERVATION}.sql`);
const reservedRollbackFile = join(root, "supabase", "rollbacks", `${HORIZONTAL_SCALE_OBSERVABILITY_MIGRATION_RESERVATION}.rollback.sql`);
check(!existsSync(reservedMigrationFile) && !existsSync(reservedRollbackFile), "220000 must remain a design-only reservation with no SQL files");

console.log(JSON.stringify({
  ok: true,
  schema: snapshot.schema,
  overall: snapshot.overall,
  currentSupportedTopology: snapshot.currentSupportedTopology,
  dimensions: HORIZONTAL_SCALE_READINESS_DIMENSIONS.reduce<Record<string, string>>((result, dimension) => {
    result[dimension.key] = dimension.state;
    return result;
  }, {}),
  capacityTargets: HORIZONTAL_SCALE_CAPACITY_TARGETS.length,
  migrationReservation: snapshot.migrationReservation,
  execution: {
    httpRequests: 0,
    databaseWrites: 0,
    paidUpstreamCalls: 0,
    loadOrStressTestExecuted: false,
  },
}, null, 2));
