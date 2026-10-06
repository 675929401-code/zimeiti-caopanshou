#!/usr/bin/env node

/**
 * Zero-network static acceptance for the AutoDL H3 controller deployment.
 *
 * This script intentionally imports only local path/file/process primitives.
 * It does not load application modules, inspect a real env file, open sockets,
 * call AutoDL, query Supabase, start a worker or submit a generation.
 *
 * Usage:
 *   node scripts/verify-autodl-h3-deployment-topology.mjs --profile pm2
 *   node scripts/verify-autodl-h3-deployment-topology.mjs --profile docker
 *   node scripts/verify-autodl-h3-deployment-topology.mjs --profile all
 *   node scripts/verify-autodl-h3-deployment-topology.mjs --json
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const argv = new Set(process.argv.slice(2));
const profileArg = process.argv.find(argument => argument.startsWith("--profile="));
const profileIndex = process.argv.indexOf("--profile");
const requestedProfile = profileArg?.split("=", 2)[1]
  || (profileIndex >= 0 ? process.argv[profileIndex + 1] : "pm2")
  || "pm2";
const profile = ["pm2", "docker", "all"].includes(requestedProfile) ? requestedProfile : "invalid";
const jsonOutput = argv.has("--json");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultGatewayRoot = path.resolve(
  projectRoot,
  "..",
  "..",
  "算力仓库",
  "06_服务器部署",
  "minimax-h3-server-deployment",
  "gateway",
);
const gatewayArg = process.argv.find(argument => argument.startsWith("--gateway-root="));
const gatewayRoot = gatewayArg ? path.resolve(gatewayArg.split("=", 2)[1]) : defaultGatewayRoot;

const findings = [];
function add(scope, status, id, message) {
  findings.push({ scope, status, id, message });
}
function read(relativePath, scope = "common") {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!existsSync(absolutePath)) {
    add(scope, "FAIL", `missing:${relativePath}`, `Missing required file: ${relativePath}`);
    return "";
  }
  return readFileSync(absolutePath, "utf8");
}
function assert(scope, id, condition, passMessage, failMessage = passMessage) {
  add(scope, condition ? "PASS" : "FAIL", id, condition ? passMessage : failMessage);
}
function warn(scope, id, condition, warningMessage, passMessage) {
  add(scope, condition ? "PASS" : "WARN", id, condition ? passMessage : warningMessage);
}

if (profile === "invalid") {
  add("common", "FAIL", "profile", "--profile must be pm2, docker or all");
}

const instrumentation = read("src/instrumentation.ts");
const runtime = read("src/lib/autodl-h3-production-runtime.ts");
const lifecycle = read("src/lib/autodl-h3-lifecycle.ts");
const providerSecret = read("src/lib/provider-secret.ts");
const ecosystem = read("ecosystem.config.js", "pm2");
const deployScript = read("scripts/git-auto-deploy.sh", "pm2");
const dockerfile = read("Dockerfile", "docker");
const nextConfig = read("next.config.ts", "docker");
const envExample = read("docs/autodl-h3-production.env.example");

assert(
  "common",
  "loopback-address",
  /AUTODL_GATEWAY_LOCAL_HOST\s*=\s*["']127\.0\.0\.1["']/u.test(runtime),
  "Gateway client is pinned to deployment-host loopback 127.0.0.1.",
  "Gateway client is not pinned to loopback; inspect the trust boundary.",
);
assert(
  "common",
  "loopback-ports",
  /AUTODL_GATEWAY_LOCAL_PORT\s*=\s*16_?011/u.test(runtime)
    && /AUTODL_GATEWAY_REMOTE_PORT\s*=\s*6_?011/u.test(runtime),
  "Local 16011 forwards to remote gateway port 6011.",
  "Expected 16011 -> 6011 port contract is missing.",
);
assert(
  "common",
  "ssh-local-forward",
  runtime.includes('"-L"')
    && runtime.includes("AUTODL_GATEWAY_LOCAL_PORT")
    && runtime.includes("AUTODL_GATEWAY_REMOTE_PORT")
    && runtime.includes('"ExitOnForwardFailure=yes"'),
  "Runtime owns an SSH local forward and fails when the bind cannot be established.",
  "Strict SSH local-forward construction is incomplete.",
);
const strictSshTokens = [
  "StrictHostKeyChecking=yes",
  "UserKnownHostsFile=",
  "IdentitiesOnly=yes",
  "PubkeyAuthentication=yes",
  "PasswordAuthentication=no",
  "KbdInteractiveAuthentication=no",
  "ForwardAgent=no",
  "GatewayPorts=no",
  "BatchMode=yes",
];
assert(
  "common",
  "strict-ssh-policy",
  strictSshTokens.every(token => runtime.includes(token)),
  "SSH uses pinned host keys, public-key-only auth and loopback-only forwarding.",
  "One or more strict SSH policy flags are missing.",
);
assert(
  "common",
  "ssh-file-policy",
  runtime.includes("path.isAbsolute")
    && runtime.includes("AUTODL_H3_SSH_KEY_PERMISSIONS_UNSAFE")
    && runtime.includes("stat.mode & 0o077"),
  "SSH executable/key/known_hosts paths are absolute and Linux key mode is enforced.",
  "Absolute-path or private-key permission enforcement is missing.",
);
assert(
  "common",
  "server-only-secrets",
  runtime.includes("AUTODL_DEVELOPER_TOKEN")
    && providerSecret.includes("AUTODL_H3_SELFHOST_API_KEY")
    && !envExample.includes("NEXT_PUBLIC_AUTODL"),
  "Control-plane and gateway credentials resolve from server-only environment names.",
  "A required server-only credential contract is missing or public-prefixed.",
);
assert(
  "common",
  "next-instrumentation",
  instrumentation.includes('process.env.NEXT_RUNTIME === "edge"')
    && instrumentation.indexOf("installAutodlH3ProductionRuntimeSafelyFromEnvironment")
      < instrumentation.indexOf("startAutodlH3LifecycleWorkerFromEnvironment"),
  "Next instrumentation is Node-only and installs runtime dependencies before worker startup.",
  "Next instrumentation ordering or Edge exclusion is missing.",
);
warn(
  "common",
  "installer-result-gate",
  /const\s+\w+\s*=\s*installAutodlH3ProductionRuntimeSafelyFromEnvironment\(\)/u.test(instrumentation)
    && (/\.installed/u.test(instrumentation)
      || instrumentation.includes("shouldStartAutodlH3LifecycleWorker(installResult)")),
  "Installer result is not explicitly gated before worker start; the fallback is fail-closed dry-run, but a misconfigured replica can still contend for the database lease.",
  "Worker startup is explicitly gated on successful production-runtime installation.",
);
assert(
  "common",
  "worker-singleton",
  lifecycle.includes('Symbol.for("agent-hub.autodl-h3-lifecycle-worker.v1")')
    && lifecycle.includes("globalThis")
    && lifecycle.includes("randomUUID()")
    && lifecycle.includes("process.pid"),
  "Worker is a per-process singleton with a unique fencing owner identity.",
  "Per-process singleton or unique owner identity is missing.",
);
assert(
  "common",
  "distributed-lease",
  lifecycle.includes("acquireInstanceLease")
    && lifecycle.includes("renewInstanceLease")
    && lifecycle.includes("leaseToken")
    && lifecycle.includes("AUTODL_H3_LEASE_LOST_DURING_OPERATION"),
  "Lifecycle uses a distributed lease, heartbeat and fencing token.",
  "Distributed lease/fencing contract is incomplete.",
);
assert(
  "common",
  "five-minute-floor",
  /integerEnv\("AUTODL_H3_IDLE_SECONDS",\s*300,\s*300,/u.test(lifecycle),
  "Idle shutdown has a five-minute minimum and default.",
  "Five-minute idle shutdown floor is not enforced.",
);

const envAssignments = new Map();
for (const line of envExample.split(/\r?\n/u)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
  if (match) envAssignments.set(match[1], match[2]);
}
const requiredEnvNames = [
  "COZE_SUPABASE_URL",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  "AUTODL_H3_LIFECYCLE_ENABLED",
  "AUTODL_H3_INSTANCE_UUID",
  "AUTODL_DEVELOPER_TOKEN",
  "AUTODL_H3_SELFHOST_API_KEY",
  "AUTODL_H3_SSH_EXECUTABLE",
  "AUTODL_H3_SSH_KEY_PATH",
  "AUTODL_H3_SSH_KNOWN_HOSTS_PATH",
  "AUTODL_H3_LIFECYCLE_DRY_RUN",
  "AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS",
  "AUTODL_H3_ATOMIC_FINALIZER_ENABLED",
  "AUTODL_H3_LIFECYCLE_LEASE_SECONDS",
  "AUTODL_H3_IDLE_SECONDS",
];
assert(
  "common",
  "env-template-complete",
  requiredEnvNames.every(name => envAssignments.has(name)),
  "Safe environment template contains every required deployment key.",
  "Safe environment template is missing one or more required keys.",
);
const blankSecrets = [
  "COZE_SUPABASE_URL",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  "AUTODL_H3_INSTANCE_UUID",
  "AUTODL_DEVELOPER_TOKEN",
  "AUTODL_H3_SELFHOST_API_KEY",
];
assert(
  "common",
  "env-template-no-secret-values",
  blankSecrets.every(name => envAssignments.get(name) === ""),
  "Environment template contains no credential, instance or database values.",
  "Environment template unexpectedly contains a sensitive value.",
);
assert(
  "common",
  "env-template-safe-default",
  envAssignments.get("AUTODL_H3_LIFECYCLE_ENABLED") === "false"
    && envAssignments.get("AUTODL_H3_LIFECYCLE_DRY_RUN") === "true"
    && envAssignments.get("AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS") === "false",
  "Template defaults to disabled, dry-run and no power actions.",
  "Environment template is not fail-closed by default.",
);

assert(
  "pm2",
  "pm2-single-fork",
  !/exec_mode\s*:\s*["']cluster["']/u.test(ecosystem)
    && !/instances\s*:\s*(?:[2-9]|\d{2,}|["']max["'])/u.test(ecosystem)
    && !/\bpm2\s+start\b[^\n]*\s-i\s+(?:[2-9]|\d{2,}|max)\b/u.test(deployScript),
  "PM2 deployment is a single fork; exactly one process may own lifecycle/tunnel state.",
  "PM2 cluster/multi-instance mode is unsafe for the current loopback-tunnel owner model.",
);
assert(
  "pm2",
  "pm2-next-start",
  /next start -p/u.test(ecosystem) && /pm2 start npx/u.test(deployScript),
  "PM2 directly supervises next start.",
  "PM2 is not configured to supervise next start directly.",
);
assert(
  "pm2",
  "protected-env-symlink",
  deployScript.includes("/data/agent-hub")
    && deployScript.includes("env/.env.local")
    && /ln -sfn "\$ENV_FILE" "\$RELEASE_DIR\/\.env\.local"/u.test(deployScript),
  "Immutable releases receive the protected server env through a stable symlink.",
  "Protected env symlink contract is missing from deployment.",
);
assert(
  "pm2",
  "pm2-boot-persistence",
  deployScript.includes("pm2 save"),
  "Deploy saves the PM2 process list; pm2 startup still must be provisioned once per host.",
  "Deploy does not persist the PM2 process list.",
);

const standaloneEnabled = /^\s*output\s*:\s*["']standalone["']/mu.test(nextConfig);
const dockerCopiesStandalone = dockerfile.includes(".next/standalone");
assert(
  "docker",
  "docker-build-contract",
  !dockerCopiesStandalone || standaloneEnabled,
  "Docker build output and Next output mode agree.",
  "Docker copies .next/standalone, but Next standalone output is disabled.",
);
assert(
  "docker",
  "docker-openssh-client",
  /apk add[^]*openssh-client/u.test(dockerfile),
  "Docker runtime contains an SSH client for the local tunnel.",
  "Docker runtime does not install openssh-client; H3 tunnel startup cannot work.",
);
warn(
  "docker",
  "docker-secret-mount",
  dockerfile.includes("AUTODL_H3_SSH_KEY_PATH") || dockerfile.includes("/run/secrets"),
  "Dockerfile does not declare a read-only secret mount contract. Runtime UID 1001 must be able to read the mode-0600 key and token files supported by the Linux resolvers.",
  "Dockerfile documents a container secret-mount contract.",
);

if (!existsSync(gatewayRoot)) {
  add("gateway", "WARN", "gateway-source", `Gateway source not found at ${gatewayRoot}; pass --gateway-root=<path> for the optional gateway audit.`);
} else {
  const gatewayStart = readFileSync(path.join(gatewayRoot, "start_gateway.sh"), "utf8");
  const gatewayAll = readFileSync(path.join(gatewayRoot, "start_all.sh"), "utf8");
  const gatewayApp = readFileSync(path.join(gatewayRoot, "app.py"), "utf8");
  assert(
    "gateway",
    "gateway-loopback-only",
    gatewayStart.includes("--host 127.0.0.1")
      && gatewayStart.includes("--port 6011")
      && gatewayStart.includes("--workers 1"),
    "Remote gateway listens on 127.0.0.1:6011 with one worker.",
    "Remote gateway bind/worker boundary differs from the audited contract.",
  );
  assert(
    "gateway",
    "gateway-ready-depth",
    gatewayApp.includes('@app.get("/health/ready")')
      && gatewayApp.includes('checks["comfyui"]')
      && gatewayApp.includes('checks["disk_ok"]')
      && gatewayApp.includes('checks: dict[str, Any] = {')
      && gatewayApp.includes('"workflows": all(')
      && gatewayApp.includes('checks["restart_recovery_complete"]'),
    "Gateway readiness covers workflow files, ComfyUI and disk capacity.",
    "Gateway readiness does not cover all required dependencies.",
  );
  assert(
    "gateway",
    "gateway-auth-and-gpu-lock",
    gatewayApp.includes("Depends(require_auth)")
      && gatewayApp.includes("hmac.compare_digest")
      && gatewayApp.includes("fcntl.flock")
      && gatewayApp.includes("gpu-admission.lock"),
    "Gateway API uses Bearer verification and a cross-process GPU admission lock.",
    "Gateway authentication or GPU admission locking is incomplete.",
  );
  assert(
    "gateway",
    "gateway-bootstrap",
    gatewayAll.includes("improved-autostart.sh") && gatewayAll.includes("start_gateway.sh"),
    "Remote bootstrap starts ComfyUI before the gateway.",
    "Remote bootstrap does not contain both ComfyUI and gateway startup.",
  );
  warn(
    "gateway",
    "gateway-pid-identity",
    /\/proc\/[^\n]*cmdline|ps\s+-p/u.test(gatewayStart),
    "Gateway PID file uses kill -0 only; PID reuse could be mistaken for a live gateway process.",
    "Gateway startup verifies that the PID belongs to the expected uvicorn command.",
  );
  warn(
    "gateway",
    "gateway-start-readiness",
    gatewayStart.includes("/health/ready"),
    "Gateway startup waits only for /health/live; lifecycle readiness retries later, but startup itself may report success before ComfyUI is ready.",
    "Gateway startup waits for dependency readiness.",
  );
  const lifespanStart = gatewayApp.indexOf("async def lifespan");
  const lifespanEnd = gatewayApp.indexOf("app = FastAPI", lifespanStart);
  const lifespanBody = lifespanStart >= 0 && lifespanEnd > lifespanStart
    ? gatewayApp.slice(lifespanStart, lifespanEnd)
    : "";
  warn(
    "gateway",
    "gateway-job-recovery",
    /await\s+recover_incomplete_jobs\([^)]*\)/u.test(lifespanBody)
      && gatewayApp.includes("async def recover_incomplete_jobs")
      && gatewayApp.includes("async def recover_attached_prompt")
      && gatewayApp.includes("retry_requires_new_idempotency_key"),
    "Gateway startup does not reconcile persisted queued/running jobs; a gateway restart can leave an upstream job permanently nonterminal.",
    "Gateway startup reconciles persisted nonterminal jobs without resubmitting GPU work.",
  );
}

const selectedScopes = profile === "all"
  ? new Set(["common", "pm2", "docker", "gateway"])
  : new Set(["common", profile, "gateway"]);
const blocking = findings.filter(item => item.status === "FAIL" && selectedScopes.has(item.scope));
const warnings = findings.filter(item => item.status === "WARN" && selectedScopes.has(item.scope));
const result = {
  audit: "autodl-h3-deployment-topology",
  networkUsed: false,
  selectedProfile: profile,
  verdict: blocking.length === 0 ? "PASS_WITH_WARNINGS" : "FAIL",
  blockingCount: blocking.length,
  warningCount: warnings.length,
  findings,
};

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`AutoDL H3 zero-network deployment audit (${profile})\n`);
  for (const item of findings) {
    process.stdout.write(`[${item.status}][${item.scope}] ${item.id}: ${item.message}\n`);
  }
  process.stdout.write(`Verdict: ${result.verdict}; blocking=${blocking.length}; warnings=${warnings.length}; networkUsed=false\n`);
}

process.exitCode = blocking.length === 0 ? 0 : 1;
