export const HORIZONTAL_SCALE_READINESS_SCHEMA = "horizontal-scale-readiness/v1" as const;
export const HORIZONTAL_SCALE_OBSERVABILITY_MIGRATION_RESERVATION =
  "20261002220000_horizontal_scale_observability" as const;

export type HorizontalScaleReadinessState = "partial" | "unavailable";

export interface HorizontalScaleReadinessDimension {
  key: string;
  state: HorizontalScaleReadinessState;
  finding: string;
  requiredBeforeReady: string;
  evidence: readonly string[];
}

export interface HorizontalScaleCapacityTarget {
  workload: string;
  targetRps: number;
  concurrency: number;
  p95Milliseconds: number;
  p99Milliseconds: number;
  maximumUnexpectedErrorRate: number;
  notes: string;
}

export const HORIZONTAL_SCALE_READINESS_DIMENSIONS = [
  {
    key: "public_web_replication",
    state: "unavailable",
    finding: "The release topology has exactly one public Web process. Multiple public Web instances have not been configured or exercised.",
    requiredBeforeReady: "Use a reviewed load-balancer topology and prove shared admission state, session authority, storage and failure recovery with at least two isolated Web candidates.",
    evidence: [
      "deploy/pm2/ecosystem.vnext.config.cjs",
      "scripts/verify-release-operational-capacity.mjs",
    ],
  },
  {
    key: "shared_session_authority",
    state: "partial",
    finding: "Signed sessions are checked against durable user and user_auth_sessions authority, and authority outages fail closed with 503.",
    requiredBeforeReady: "Exercise login, revoke and authenticated browsing through two Web candidates and prove consistent results during one-candidate loss.",
    evidence: [
      "src/lib/auth.ts",
      "src/lib/auth-session-store.ts",
      "supabase/migrations/20260927103000_user_auth_sessions_two_device_limit.sql",
    ],
  },
  {
    key: "shared_admission_and_risk_state",
    state: "unavailable",
    finding: "Application rate, login-attempt and IP-risk state still includes process-local Maps. The durable security state primitives are not connected to the locked request edge.",
    requiredBeforeReady: "Route every security-sensitive admission decision through one shared state authority with bounded outage behavior and multi-instance tests.",
    evidence: [
      "src/lib/security-edge.ts",
      "src/lib/security.ts",
      "src/app/api/llm/llm-state.ts",
      "src/lib/server/security-event-reliability.ts",
    ],
  },
  {
    key: "database_connection_budget",
    state: "unavailable",
    finding: "Supabase HTTP clients are cached per process and the legacy pg Pool allows ten connections per process, but no deployment-wide connection budget, pooler contract or saturation signal is defined.",
    requiredBeforeReady: "Inventory every database client, set a total budget and per-process allocation, document pooler behavior, and expose wait/saturation metrics before adding processes.",
    evidence: [
      "src/storage/database/supabase-client.ts",
      "src/lib/api-middleware.ts",
      "src/lib/db.ts",
    ],
  },
  {
    key: "durable_queue_claims",
    state: "partial",
    finding: "Core video and long digital-human workers use database claims, leases and SKIP LOCKED, while their schedulers and runtime snapshots remain process-local.",
    requiredBeforeReady: "Complete a zero-cost concurrent-claim and lease-expiry drill for every enabled worker class and record duplicate-task invariants.",
    evidence: [
      "src/lib/durable-queue-loop.ts",
      "src/lib/digital-video-queue-worker.ts",
      "src/lib/digital-human-long-worker.ts",
      "supabase/migrations/20260903212000_digital_video_dispatch_queue.sql",
      "supabase/migrations/20260904023000_digital_human_long_video_runtime.sql",
    ],
  },
  {
    key: "worker_heartbeat_and_queue_age",
    state: "unavailable",
    finding: "There is no shared worker heartbeat, normalized queue depth or oldest-ready-item source across the enabled workers.",
    requiredBeforeReady: "Add reviewed shared heartbeat and queue-age observations with expiry, RLS, client revocation and alert thresholds.",
    evidence: [
      "src/lib/media-queue-worker-runtime.ts",
      "src/lib/incident-slo-control-plane.ts",
    ],
  },
  {
    key: "idempotency_and_billing_fencing",
    state: "partial",
    finding: "Several paid workflows have durable idempotency or accounting fences, but no complete route inventory or multi-process fault drill proves exactly-once business effects across the whole product.",
    requiredBeforeReady: "Map every write and paid side effect to its durable key, then inject duplicate delivery and worker loss with zero-cost substitutes and prove one task, one ledger effect and one tenant owner.",
    evidence: [
      "scripts/verify-release-operational-capacity.mjs",
      "src/lib/digital-video-queue-worker.ts",
      "src/lib/digital-human-long-worker.ts",
    ],
  },
  {
    key: "cache_invalidation_and_shared_files",
    state: "unavailable",
    finding: "Configuration, frequency and provider caches are process-local, while production defaults still use disk paths shared only by the current single-host layout.",
    requiredBeforeReady: "Classify every cache as disposable or authoritative, add cross-instance invalidation where required, and remove shared local-disk authority before multi-host rollout.",
    evidence: [
      "src/app/api/llm/llm-state.ts",
      "deploy/pm2/ecosystem.vnext.config.cjs",
      "deploy/environments/production.env.example",
    ],
  },
  {
    key: "cdn_and_waf",
    state: "unavailable",
    finding: "Static cache rules exist at the example ingress, but object-storage CDN delivery is disabled by default and no WAF or gateway connector is configured.",
    requiredBeforeReady: "Validate CDN Range, CORS, cache and rollback behavior on a sandbox edge, then define WAF ownership and multi-ingress shared controls.",
    evidence: [
      "deploy/nginx/agent-hub.vnext.conf.example",
      "deploy/environments/production.env.example",
      "src/lib/domain-tls-brand-release-control-plane.ts",
    ],
  },
  {
    key: "capacity_observability_and_alerts",
    state: "unavailable",
    finding: "The existing capacity probe covers unauthenticated liveness only. CPU, memory, event-loop delay, database saturation, queue age and worker heartbeat are not connected capacity sources.",
    requiredBeforeReady: "Connect resource and workload measurements with freshness, coverage and alert ownership before any capacity claim.",
    evidence: [
      "scripts/verify-release-operational-capacity.mjs",
      "src/lib/incident-slo-control-plane.ts",
      "docs/360实时运营安全指挥中心指标与数据链设计-2026-10-02.md",
    ],
  },
  {
    key: "failure_degradation_and_recovery",
    state: "partial",
    finding: "Authentication authority fails closed, workers have bounded drain, leases reduce blind replay, and PM2 can restart processes; Web/worker loss recovery has not been exercised for the proposed topology.",
    requiredBeforeReady: "Run isolated zero-cost Web and worker termination drills and prove recovery bounds, tenant isolation and absence of duplicate tasks or ledger effects.",
    evidence: [
      "src/lib/auth.ts",
      "src/lib/durable-queue-loop.ts",
      "deploy/pm2/ecosystem.vnext.config.cjs",
    ],
  },
] as const satisfies readonly HorizontalScaleReadinessDimension[];

// Planning targets are deliberately unvalidated. They define the future test
// contract and must never be surfaced as measured production capacity.
export const HORIZONTAL_SCALE_CAPACITY_TARGETS = [
  {
    workload: "public_liveness",
    targetRps: 100,
    concurrency: 200,
    p95Milliseconds: 3_000,
    p99Milliseconds: 5_000,
    maximumUnexpectedErrorRate: 0,
    notes: "Dependency-free GET only; existing evidence is a 400-request shape, not a sustained-RPS result.",
  },
  {
    workload: "authenticated_browse",
    targetRps: 25,
    concurrency: 100,
    p95Milliseconds: 750,
    p99Milliseconds: 1_500,
    maximumUnexpectedErrorRate: 0.01,
    notes: "Read-only authenticated routes using isolated test accounts and durable session authority.",
  },
  {
    workload: "login",
    targetRps: 2,
    concurrency: 20,
    p95Milliseconds: 1_000,
    p99Milliseconds: 2_000,
    maximumUnexpectedErrorRate: 0.01,
    notes: "Expected policy rejections such as 429 and invalid credentials are reported separately from unexpected errors.",
  },
  {
    workload: "chat_zero_cost_mock",
    targetRps: 10,
    concurrency: 50,
    p95Milliseconds: 1_500,
    p99Milliseconds: 3_000,
    maximumUnexpectedErrorRate: 0.01,
    notes: "P95/P99 measure time to first byte. The upstream must be a deterministic local zero-cost substitute.",
  },
  {
    workload: "upload_ticket_metadata",
    targetRps: 10,
    concurrency: 50,
    p95Milliseconds: 750,
    p99Milliseconds: 1_500,
    maximumUnexpectedErrorRate: 0.01,
    notes: "Ticket metadata only; no large binary, object-storage charge or signed URL is retained.",
  },
  {
    workload: "webhook_zero_cost_mock",
    targetRps: 5,
    concurrency: 25,
    p95Milliseconds: 1_000,
    p99Milliseconds: 2_000,
    maximumUnexpectedErrorRate: 0.01,
    notes: "Duplicate delivery is mandatory and must result in one durable business effect.",
  },
  {
    workload: "queue_claim",
    targetRps: 20,
    concurrency: 8,
    p95Milliseconds: 500,
    p99Milliseconds: 1_000,
    maximumUnexpectedErrorRate: 0.01,
    notes: "Eight isolated workers, zero-cost fixtures, no duplicate claim and no paid provider call.",
  },
] as const satisfies readonly HorizontalScaleCapacityTarget[];

export function horizontalScaleReadinessSnapshot() {
  return {
    schema: HORIZONTAL_SCALE_READINESS_SCHEMA,
    phase: "repository_audit_v1" as const,
    auditedOn: "2026-10-02" as const,
    overall: "unavailable" as const,
    complete: false,
    readyForMultipleWebInstances: false,
    currentSupportedTopology: "single_public_web_plus_2_to_8_media_workers" as const,
    evidenceScope: "repository_and_configuration_source_audit_only" as const,
    validation: {
      productionRuntimeVerified: false,
      loadOrStressTestExecuted: false,
      faultInjectionExecuted: false,
      paidUpstreamCalls: 0,
      databaseWrites: 0,
    },
    capacity: {
      measured: null,
      targetStatus: "proposed_unvalidated" as const,
      targets: HORIZONTAL_SCALE_CAPACITY_TARGETS,
    },
    migrationReservation: {
      name: HORIZONTAL_SCALE_OBSERVABILITY_MIGRATION_RESERVATION,
      status: "design_only" as const,
      sqlFileCreated: false,
      applied: false,
      intendedScope: [
        "worker heartbeat with expiry",
        "normalized queue depth and oldest-ready-item observations",
        "capacity samples with freshness and coverage",
      ],
    },
    dimensions: HORIZONTAL_SCALE_READINESS_DIMENSIONS,
    nextGate: "review_and_accept_unvalidated_capacity_targets_before_isolated_zero_cost_execution" as const,
  };
}
