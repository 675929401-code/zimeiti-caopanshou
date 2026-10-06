#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const modeArgument = process.argv.find((value) => value.startsWith("--mode="));
const mode = modeArgument?.slice("--mode=".length) || "production";
if (!["code", "production"].includes(mode)) throw new Error(`unsupported mode: ${mode}`);
const probeArgument = process.argv.find((value) => value.startsWith("--probe-origin="));
const probeOriginInput = probeArgument?.slice("--probe-origin=".length)
  || process.env.CAPACITY_PROBE_ORIGIN
  || (mode === "production" ? "http://127.0.0.1:5000" : "");
const PROBE_TOTAL_REQUESTS = 400;
const PROBE_CONCURRENCY = 200;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_P95_LIMIT_MS = 3_000;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function blockFor(source, header) {
  const match = header.exec(source);
  if (!match) return "";
  const opening = source.indexOf("{", match.index);
  if (opening < 0) return "";
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  return "";
}

function loopbackOrigin(input) {
  const parsed = new URL(input);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error("capacity probe origin must be a loopback HTTP origin");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("capacity probe origin must not contain credentials, a path, query or fragment");
  }
  return parsed.origin;
}

async function runNoCostProbe(input) {
  const origin = loopbackOrigin(input);
  const target = new URL("/api/health?liveness=true", origin);
  const latencies = [];
  const failures = [];
  let failureCount = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const requestNumber = cursor;
      cursor += 1;
      if (requestNumber >= PROBE_TOTAL_REQUESTS) return;
      const started = performance.now();
      try {
        const response = await fetch(target, {
          method: "GET",
          headers: { Accept: "application/json", "Cache-Control": "no-store" },
          redirect: "error",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body = await response.text();
        if (body.length > 1_024) throw new Error("liveness response exceeded 1 KiB");
        const parsed = JSON.parse(body);
        if (response.status !== 200 || parsed?.status !== "ok") {
          throw new Error(`unexpected liveness response ${response.status}`);
        }
      } catch (error) {
        failureCount += 1;
        if (failures.length < 10) failures.push(String(error instanceof Error ? error.message : error));
      } finally {
        latencies.push(performance.now() - started);
      }
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => worker()));
  const ordered = latencies.toSorted((left, right) => left - right);
  const p95 = ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || Infinity;
  const maximum = ordered.at(-1) || Infinity;
  return {
    passed: failureCount === 0 && ordered.length === PROBE_TOTAL_REQUESTS
      && p95 <= PROBE_P95_LIMIT_MS && maximum <= PROBE_TIMEOUT_MS,
    origin,
    path: target.pathname,
    totalRequests: PROBE_TOTAL_REQUESTS,
    concurrentClients: PROBE_CONCURRENCY,
    successfulRequests: PROBE_TOTAL_REQUESTS - failureCount,
    failedRequests: failureCount,
    p95Milliseconds: Math.round(p95),
    maximumMilliseconds: Math.round(maximum),
    thresholdMilliseconds: PROBE_P95_LIMIT_MS,
    failureSamples: failures,
    methods: ["GET"],
    authenticatedSessions: 0,
    databaseWrites: 0,
    paidModelCalls: 0,
  };
}

const files = {
  packageJson: JSON.parse(read("package.json")),
  pm2: read("deploy/pm2/ecosystem.vnext.config.cjs"),
  instrumentation: read("src/instrumentation.ts"),
  queueRuntime: read("src/lib/media-queue-worker-runtime.ts"),
  videoWorker: read("src/lib/digital-video-queue-worker.ts"),
  humanWorker: read("src/lib/digital-human-long-worker.ts"),
  videoQueueMigration: read("supabase/migrations/20260903212000_digital_video_dispatch_queue.sql"),
  humanQueueMigration: read("supabase/migrations/20260904023000_digital_human_long_video_runtime.sql"),
  upload: read("src/app/api/digital-human/upload/route.ts"),
  uploadProxy: read("src/lib/digital-human-upload-proxy.ts"),
  nextConfig: read("next.config.ts"),
  nginx: read("deploy/nginx/agent-hub.vnext.conf.example"),
  health: read("src/app/api/health/route.ts"),
  diagnosticApi: read("src/app/api/diagnostic-logs/route.ts"),
  diagnosticClient: read("src/components/diagnostic-sentry.tsx"),
  proxy: read("src/proxy.ts"),
  videoCircuit: read("src/lib/video-channel-health-circuit.ts"),
  security: read("src/lib/security.ts"),
  edgeSecurity: read("src/lib/security-edge.ts"),
  paymentNotify: read("src/app/api/payment/notify/route.ts"),
  paymentRefund: read("src/app/api/payment/refund/route.ts"),
  backupPolicy: JSON.parse(read("deploy/policies/backup-policy.json")),
};

const checks = [];
function check(name, passed, { hard = true, detail, evidence = {} } = {}) {
  checks.push({
    name,
    passed: Boolean(passed),
    severity: passed ? "pass" : hard ? "blocker" : "warning",
    detail,
    evidence,
  });
}

const dependencies = {
  ...(files.packageJson.dependencies || {}),
  ...(files.packageJson.optionalDependencies || {}),
};
const distributedLimiterPackage = Object.keys(dependencies)
  .find((name) => /(?:redis|rate.?limit)/iu.test(name));
const distributedLimiterSource = /(?:Redis|Upstash|distributed[_-]?rate|rate[_-]?limit.*(?:rpc|database))/iu
  .test(`${files.security}\n${files.edgeSecurity}`);
const sharedIngressLimits = (
  /limit_req_zone \$agent_hub_api_client zone=agent_hub_api_ip:/u.test(files.nginx)
  && /limit_req_zone \$agent_hub_login_client zone=agent_hub_login_ip:/u.test(files.nginx)
  && /limit_req_zone \$agent_hub_paid_write_client zone=agent_hub_paid_write_ip:/u.test(files.nginx)
  && /limit_req zone=agent_hub_login_ip/u.test(files.nginx)
  && /limit_req zone=agent_hub_paid_write_ip/u.test(files.nginx)
  && /limit_req_status 429/u.test(files.nginx)
);
const webAppBlock = blockFor(files.pm2, /\{\s*\.\.\.common,\s*name:\s*["']agent-hub-web["']/u);
const singleWebProcess = (
  /const common\s*=\s*\{[\s\S]*?exec_mode:\s*["']fork["'][\s\S]*?instances:\s*1/u.test(files.pm2)
  && Boolean(webAppBlock)
  && !/exec_mode:\s*["']cluster["']/u.test(webAppBlock)
  && !/instances:\s*(?:[2-9]|[1-9]\d+)/u.test(webAppBlock)
);

check("single-public-web-process-boundary", singleWebProcess, {
  detail: "the accepted hundreds-member topology has exactly one public Web process; media work remains in bounded workers",
  evidence: { publicWebProcesses: singleWebProcess ? 1 : "unverified", topology: "single-web-plus-media-workers" },
});

check("dedicated-media-worker", (
  /name:\s*["']agent-hub-media-worker["']/u.test(files.pm2)
  && /increment_var:\s*["']PORT["']/u.test(files.pm2)
  && !/exec_mode:\s*["']cluster["']/u.test(files.pm2)
  && /MEDIA_QUEUE_WORKER_INSTANCES\s*\|\|\s*["']2["']/u.test(files.pm2)
  && /MEDIA_QUEUE_WORKER_PROCESS:\s*["']0["']/u.test(files.pm2)
  && /MEDIA_QUEUE_WORKER_PROCESS:\s*["']1["']/u.test(files.pm2)
  && /MEDIA_QUEUE_WORKER_PROCESS === ["']1["'][\s\S]*startMediaQueueWorkerRuntime/u.test(files.instrumentation)
), {
  detail: "public web process does not drain paid queues; two bounded worker processes are configured by default",
  evidence: { defaultWorkers: 2, maximumWorkers: 8, webWorkerDisabled: true },
});

check("database-atomic-queue-claims", (
  /claim_digital_video_dispatch/iu.test(files.videoQueueMigration)
  && /FOR UPDATE SKIP LOCKED/iu.test(files.videoQueueMigration)
  && /lease_owner/iu.test(files.videoQueueMigration)
  && /claim_digital_human_long_segment/iu.test(files.humanQueueMigration)
  && /claim_digital_human_long_finalization/iu.test(files.humanQueueMigration)
  && /FOR UPDATE(?: OF s)? SKIP LOCKED/iu.test(files.humanQueueMigration)
  && /stopDigitalVideoQueueWorker/u.test(files.queueRuntime)
  && /stopDigitalHumanLongWorker/u.test(files.queueRuntime)
), {
  detail: "ordinary video and long digital-human jobs use database locks, leases and bounded drain",
  evidence: { leaseBased: true, skipLocked: true, gracefulDrain: true },
});

check("tenant-owned-media-transitions", (
  /\.eq\('id',job\.task_id\)\.eq\('user_id',job\.user_id\)/u.test(files.videoWorker)
  && /ownedDigitalHumanAsset\(job\.user_id/u.test(files.videoWorker)
  && /ownedDigitalHumanAsset\(text\(job\.parent\.user_id\)/u.test(files.humanWorker)
), {
  detail: "queue state and media reads remain fenced to the owning account",
  evidence: { taskOwnerBound: true, assetOwnerBound: true },
});

const appRequestLimit = Number(/MAX_REQUEST_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/u.exec(files.uploadProxy)?.[1] || 0);
const nginxLimit = Number(/client_max_body_size\s+(\d+)m/iu.exec(files.nginx)?.[1] || 0);
const nextLimit = Number(/proxyClientMaxBodySize:\s*["'](\d+)mb["']/iu.exec(files.nextConfig)?.[1] || 0);
check("bounded-buffered-upload", (
  appRequestLimit === 102
  && nginxLimit === 200
  && nextLimit === nginxLimit
   && /MAX_ACTIVE_BUFFERED_UPLOADS\s*=\s*1/u.test(files.uploadProxy)
   && /Retry-After/u.test(files.uploadProxy)
   && /finally\s*\{\s*releaseUploadSlot\(\)/su.test(files.uploadProxy)
), {
  detail: "current compatibility upload is memory-bounded and rejected before the proxy ceiling",
  evidence: { applicationRequestLimitMb: appRequestLimit, proxyLimitMb: nextLimit, nginxLimitMb: nginxLimit, concurrentBufferedUploadsPerProcess: 1 },
});

const notifyBlock = blockFor(files.nginx, /location\s*=\s*\/api\/payment\/notify\s*\{/u);
const refundBlock = blockFor(files.nginx, /location\s*=\s*\/api\/payment\/refund\s*\{/u);
const genericWebBlock = blockFor(files.nginx, /location\s+\/\s*\{/u);
const genericVoiceBlock = blockFor(files.nginx, /location\s+\/voice-platform\/\s*\{/u);
check("payment-edge-body-limits", (
  /client_max_body_size\s+64k\s*;/u.test(notifyBlock)
  && /client_body_buffer_size\s+64k\s*;/u.test(notifyBlock)
  && /MAX_CALLBACK_BODY_BYTES\s*=\s*64\s*\*\s*1024/u.test(files.paymentNotify)
  && /client_max_body_size\s+16k\s*;/u.test(refundBlock)
  && /client_body_buffer_size\s+16k\s*;/u.test(refundBlock)
  && /MAX_REFUND_REQUEST_BYTES\s*=\s*16\s*\*\s*1024/u.test(files.paymentRefund)
  && /limit_req\s+zone=agent_hub_paid_write_ip\s+burst=5\s+nodelay\s*;/u.test(refundBlock)
), {
  detail: "payment notify and refund bodies are rejected at Nginx at the same ceilings enforced by their streaming application parsers",
  evidence: { notifyKilobytes: 64, refundKilobytes: 16, refundSharedRateLimit: true },
});

check("large-upload-edge-separation", (
  nginxLimit === 200
  && nextLimit === 200
  && !/client_max_body_size\s+(?:16|64)k\s*;/u.test(genericWebBlock)
  && !/client_max_body_size\s+(?:16|64)k\s*;/u.test(genericVoiceBlock)
), {
  detail: "payment-only limits do not apply to Web, Voice or digital-human media upload routes, which retain the reviewed 200 MiB proxy ceiling",
  evidence: { genericWebLimitMb: 200, genericVoiceLimitMb: 200, digitalHumanDirectUpload: true },
});

const directUploadRoute = [
  "src/app/api/digital-human/upload-ticket/route.ts",
  "src/app/api/digital-human/upload-session/route.ts",
  "src/app/api/storage/presign/route.ts",
].find(exists);
const bufferedUpload = /request\.formData\(\)/u.test(files.upload) && /file\.arrayBuffer\(\)/u.test(files.upload);
const compatibilityBufferedUpload = /request\.formData\(\)/u.test(files.uploadProxy) && /file\.arrayBuffer\(\)/u.test(files.uploadProxy);
check("direct-object-storage-upload", Boolean(directUploadRoute) && !bufferedUpload, {
  detail: "large digital-human media uses a browser-to-object-storage PUT; the bounded server-buffered path remains compatibility-only",
  evidence: { directUploadRoute: directUploadRoute || "missing", currentCompatibilityPath: compatibilityBufferedUpload ? "delegated-server-buffered" : "missing" },
});

check("distributed-rate-limit", sharedIngressLimits, {
  detail: "Nginx shared-memory zones enforce global API, login and paid-write IP limits before the single public web process",
  evidence: {
    boundary: sharedIngressLimits ? "nginx-shared-memory" : "missing",
    sharedLimiterDependency: distributedLimiterPackage || "not-required-for-current-single-web-process",
    processLocalUserStoresDetected: /new Map</u.test(files.security) || /new Map</u.test(files.edgeSecurity),
    horizontalWebScaleRequiresSharedUserLimiter: !distributedLimiterSource,
  },
});

check("horizontal-web-scale-boundary", singleWebProcess || Boolean(distributedLimiterSource), {
  detail: "more than one public Web process is blocked until user-scoped rate limits use a shared Redis or database backend",
  evidence: {
    currentPublicWebProcesses: singleWebProcess ? 1 : "more-than-one-or-unverified",
    sharedUserLimiterPresent: Boolean(distributedLimiterSource),
    maximumPublicWebProcessesWithoutSharedUserLimiter: 1,
  },
});

check("health-and-diagnostics", (
  /searchParams\.get\(['"]liveness['"]\)\s*===\s*['"]true['"]/u.test(files.health)
  && /authorizeAdminToken/u.test(files.health)
  && /DiagnosticSentry/u.test(files.diagnosticClient)
  && /MAX_REQUEST_BYTES\s*=\s*32\s*\*\s*1024/u.test(files.diagnosticApi)
), {
  hard: false,
  detail: "liveness and bounded client diagnostics exist; external alert routing and production dashboards still require deployment evidence",
  evidence: { liveness: true, adminHealth: true, boundedClientDiagnostics: true, externalAlertingVerified: false },
});

check("provider-health-circuit", (
  /CHANNEL_HEALTH_BLOCKED/u.test(files.videoCircuit)
  && /consecutiveFailures/u.test(files.videoCircuit)
  && /cooldown/iu.test(files.videoCircuit)
), {
  detail: "video provider channels fail closed after repeated failures and require governed recovery",
  evidence: { videoCircuitBreaker: true },
});

check("request-idempotency-contracts", [
  "supabase/migrations/20260901093000_extraction_attempts_exactly_once.sql",
  "supabase/migrations/20260901170000_llm_request_attempts_exactly_once.sql",
  "supabase/migrations/20260903212000_digital_video_dispatch_queue.sql",
  "supabase/migrations/20260904025000_digital_human_long_submission_attempt_accounting.sql",
  "supabase/migrations/20260904193000_payment_refund_exactly_once.sql",
].every(exists), {
  detail: "extraction, LLM, video, digital-human and payment-refund submissions have durable idempotency migrations",
  evidence: { migrationContracts: 5, includesPaymentRefund: true },
});

check("query-string-log-redaction", (
  /log_format agent_hub_no_args/u.test(files.nginx)
  && /\$request_method \$uri \$server_protocol/u.test(files.nginx)
  && !/log_format agent_hub_no_args[^;]*\$(?:request_uri|args)/su.test(files.nginx)
  && /parsed\.pathname/u.test(files.diagnosticApi)
  && /request\.nextUrl\.pathname/u.test(files.proxy)
), {
  detail: "access tickets and query strings are excluded from persistent application and Nginx request logs",
  evidence: { nginxUsesPathOnly: true, applicationUsesPathOnly: true },
});

let noCostProbe = null;
if (probeOriginInput) {
  try {
    noCostProbe = await runNoCostProbe(probeOriginInput);
  } catch (error) {
    noCostProbe = {
      passed: false,
      error: String(error instanceof Error ? error.message : error),
      databaseWrites: 0,
      paidModelCalls: 0,
    };
  }
}
check("single-web-no-cost-concurrency-probe", mode === "code" && !probeOriginInput ? true : noCostProbe?.passed, {
  hard: mode === "production" || Boolean(probeOriginInput),
  detail: probeOriginInput
    ? "one public Web process must answer 400 loopback liveness requests from 200 concurrent clients within the fixed latency budget"
    : "code mode defers the loopback concurrency rehearsal; production mode always runs it",
  evidence: noCostProbe || {
    deferredInCodeMode: true,
    productionDefaultOrigin: "http://127.0.0.1:5000",
    paidModelCalls: 0,
    databaseWrites: 0,
  },
});

const implementation = files.backupPolicy.implementationStatus || {};
const restoreVerified = !/not yet|pending|must be verified/iu.test(String(implementation.productionRestoreDrill || ""));
check("production-restore-drill", mode === "code" || restoreVerified, {
  hard: mode === "production",
  detail: mode === "code" ? "external restore evidence is deferred to the production gate" : "production restore drill evidence is required before commercial release",
  evidence: { productionRestoreDrill: implementation.productionRestoreDrill || "missing" },
});

const blockers = checks.filter((item) => item.severity === "blocker");
const warnings = checks.filter((item) => item.severity === "warning");
const report = {
  verifier: "release-operational-capacity",
  mode,
  status: blockers.length === 0 ? "PASS" : "NO_GO",
  targetConcurrency: "hundreds-of-members",
  acceptedTopology: "one-public-web-process-plus-two-to-eight-media-workers",
  capacityEvidenceScope: "loopback HTTP admission and liveness only; paid workflow throughput requires separate authorized canaries",
  summary: {
    blockers: blockers.length,
    warnings: warnings.length,
    passed: checks.filter((item) => item.severity === "pass").length,
  },
  checks,
  requiredActions: blockers.map((item) => ({ check: item.name, action: item.detail })),
};

console.log(JSON.stringify(report, null, 2));
process.exit(blockers.length === 0 ? 0 : 1);
