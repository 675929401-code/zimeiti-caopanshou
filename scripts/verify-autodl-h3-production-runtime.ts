import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";

import type { AutodlH3Job } from "../src/lib/autodl-h3-lifecycle";
import {
  AUTODL_H3_RUNTIME_CONSTANTS,
  AutodlH3StrictSshTunnelSupervisor,
  createAutodlDeveloperTokenResolver,
  createAutodlH3InstanceClient,
  createAutodlH3ProductionDispatcher,
  installAutodlH3ProductionRuntimeSafelyFromEnvironment,
  installAutodlH3TunnelProcessCleanup,
  parseAutodlH3GatewayHealth,
  parseAutodlH3SafeSnapshot,
  type AutodlControlPlaneRequest,
  type AutodlControlPlaneTransport,
  type AutodlH3ManagedSshProcess,
} from "../src/lib/autodl-h3-production-runtime";
import {
  AUTODL_H3_SELFHOST_SECRET_REF,
  createProviderSecretResolver,
} from "../src/lib/provider-secret";
import type { ServerSecretFilePolicy } from "../src/lib/server-secret";
import type { VideoGenerateParams, VideoModelConfig, VideoTaskResult } from "../src/lib/video-adapter";

const DEVELOPER_SENTINEL = "DeveloperTokenSentinel_1234567890";
const GATEWAY_SENTINEL = "GatewayTokenSentinel_1234567890";
const INSTANCE_UUID = "pro-runtime123456";
const CLIENT_REQUEST_ID = "h3-client-request-123456";

function fakeServerSecretFilePolicy(
  value: string,
  overrides: { mode?: number; uid?: number; effectiveUserId?: number; exists?: boolean } = {},
): ServerSecretFilePolicy {
  return {
    platform: "linux",
    exists: () => overrides.exists !== false,
    stat: () => ({
      isFile: () => true,
      mode: overrides.mode ?? 0o600,
      size: Buffer.byteLength(value, "utf8"),
      uid: overrides.uid ?? 0,
    }),
    readText: () => value,
    effectiveUserId: () => overrides.effectiveUserId ?? 0,
  };
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function rejectsCode(operation: () => unknown | Promise<unknown>, expected: string) {
  await assert.rejects(async () => operation(), (error: unknown) => errorCode(error) === expected);
}

function baseJob(overrides: Partial<AutodlH3Job> = {}): AutodlH3Job {
  const now = "2026-08-21T00:00:00.000Z";
  return {
    id: "job-runtime-1",
    publicTaskId: "h3q_runtime_public_1",
    clientRequestId: CLIENT_REQUEST_ID,
    videoTaskInternalId: "video-internal-1",
    userId: "00000000-0000-4000-8000-000000000001",
    modelId: "model-video-h3",
    instanceUuid: INSTANCE_UUID,
    requestPayload: {
      prompt: "A safe zero-network runtime test",
      duration: 10,
      aspectRatio: "16:9",
      resolution: "480p",
      resolutionTier: "480p",
      idempotencyKey: CLIENT_REQUEST_ID,
    },
    state: "WAITING_POWER",
    upstreamTaskId: null,
    contentUrl: null,
    resultAssetUrl: null,
    progress: 0,
    attemptCount: 0,
    notBefore: null,
    leaseOwner: null,
    leaseToken: 0,
    leaseExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function exactModelRow() {
  return {
    id: "model-video-h3",
    name: "MiniMax H3 self-hosted",
    model_name: "minimax-h3-turbo",
    provider: "autodl_h3_selfhost",
    protocol_type: "autodl_h3_selfhost",
    api_endpoint: "http://127.0.0.1:16011/v1/video/generations",
    api_key: "secret://autodl-h3-selfhost",
    price_per_use: 0,
    duration_seconds: 10,
    supports_image_input: true,
    is_active: true,
    is_hidden: false,
  };
}

function readyHealth(queueRunning = 0, queuePending = 0) {
  return {
    ready: true as const,
    workflows: true as const,
    comfyui: true as const,
    diskOk: true as const,
    queueRunning,
    queuePending,
  };
}

async function verifyTokenResolver() {
  let decryptCount = 0;
  const fileResolver = createAutodlDeveloperTokenResolver({
    environment: {
      AUTODL_DEVELOPER_TOKEN_FILE: "/run/secrets/autodl-developer-token",
      AUTODL_DEVELOPER_TOKEN: "EnvironmentFallbackMustNotWin_123456",
    },
    platform: "linux",
    serverSecretFilePolicy: fakeServerSecretFilePolicy(`${DEVELOPER_SENTINEL}\n`),
  });
  assert.equal(fileResolver(), DEVELOPER_SENTINEL, "root-only file must take precedence over env fallback");

  const unsafeFileResolver = createAutodlDeveloperTokenResolver({
    environment: { AUTODL_DEVELOPER_TOKEN_FILE: "/run/secrets/autodl-developer-token" },
    platform: "linux",
    serverSecretFilePolicy: fakeServerSecretFilePolicy(DEVELOPER_SENTINEL, { mode: 0o644 }),
  });
  await rejectsCode(() => unsafeFileResolver(), "AUTODL_DEVELOPER_TOKEN_FILE_PERMISSIONS_UNSAFE");
  const wrongOwnerResolver = createAutodlDeveloperTokenResolver({
    environment: { AUTODL_DEVELOPER_TOKEN_FILE: "/run/secrets/autodl-developer-token" },
    platform: "linux",
    serverSecretFilePolicy: fakeServerSecretFilePolicy(DEVELOPER_SENTINEL, { uid: 1001, effectiveUserId: 0 }),
  });
  await rejectsCode(() => wrongOwnerResolver(), "AUTODL_DEVELOPER_TOKEN_FILE_OWNER_UNSAFE");
  const missingServerResolver = createAutodlDeveloperTokenResolver({
    environment: {},
    platform: "linux",
    serverSecretFilePolicy: fakeServerSecretFilePolicy(DEVELOPER_SENTINEL, { exists: false }),
  });
  await rejectsCode(() => missingServerResolver(), "AUTODL_DEVELOPER_TOKEN_FILE_OR_ENV_REQUIRED");

  const providerFileResolver = createProviderSecretResolver({
    environment: {
      AUTODL_H3_SELFHOST_API_KEY_FILE: "/run/secrets/autodl-h3-selfhost-api-key",
      AUTODL_H3_SELFHOST_API_KEY: "EnvironmentGatewayFallbackMustNotWin_123456",
    },
    platform: "linux",
    filePolicy: fakeServerSecretFilePolicy(`${GATEWAY_SENTINEL}\n`),
  });
  assert.equal(providerFileResolver(AUTODL_H3_SELFHOST_SECRET_REF), GATEWAY_SENTINEL);
  const unsafeProviderFileResolver = createProviderSecretResolver({
    environment: { AUTODL_H3_SELFHOST_API_KEY_FILE: "/run/secrets/autodl-h3-selfhost-api-key" },
    platform: "linux",
    filePolicy: fakeServerSecretFilePolicy(GATEWAY_SENTINEL, { mode: 0o640 }),
  });
  await rejectsCode(
    () => unsafeProviderFileResolver(AUTODL_H3_SELFHOST_SECRET_REF),
    "AUTODL_H3_SELFHOST_SECRET_FILE_PERMISSIONS_UNSAFE",
  );

  const environmentResolver = createAutodlDeveloperTokenResolver({
    environment: { AUTODL_DEVELOPER_TOKEN: DEVELOPER_SENTINEL },
    platform: "win32",
    homeDirectory: "C:\\Users\\runtime-test",
    fileExists: () => true,
    decryptFile: () => {
      decryptCount += 1;
      return "unused";
    },
  });
  assert.equal(environmentResolver(), DEVELOPER_SENTINEL);
  assert.equal(decryptCount, 0, "environment token must prevent DPAPI file access");

  let now = 1000;
  const visitedFiles: string[] = [];
  const dpapiResolver = createAutodlDeveloperTokenResolver({
    environment: {},
    platform: "win32",
    homeDirectory: "C:\\Users\\runtime-test",
    now: () => now,
    fileExists: (filePath) => {
      visitedFiles.push(filePath);
      return true;
    },
    decryptFile: () => {
      decryptCount += 1;
      return DEVELOPER_SENTINEL;
    },
  });
  assert.equal(dpapiResolver(), DEVELOPER_SENTINEL);
  assert.equal(dpapiResolver(), DEVELOPER_SENTINEL);
  assert.equal(decryptCount, 1, "DPAPI value should be cached in memory");
  assert.equal(visitedFiles.length, 1);
  assert.ok(visitedFiles[0].endsWith(path.join(".codex", "secrets", "autodl-developer.token")));
  now += 6 * 60_000;
  dpapiResolver();
  assert.equal(decryptCount, 2, "expired token cache should be refreshed");

  const invalidResolver = createAutodlDeveloperTokenResolver({
    environment: { AUTODL_DEVELOPER_TOKEN: `${DEVELOPER_SENTINEL}\r\nInjected: yes` },
  });
  await rejectsCode(() => invalidResolver(), "AUTODL_DEVELOPER_TOKEN_INVALID");
}

async function verifyOfficialControlClient() {
  const requests: AutodlControlPlaneRequest[] = [];
  const transport: AutodlControlPlaneTransport = {
    async request(input) {
      requests.push(input);
      if (input.path === AUTODL_H3_RUNTIME_CONSTANTS.controlPaths.status) {
        return { statusCode: 200, body: { code: "Success", data: "running" } };
      }
      if (input.path === AUTODL_H3_RUNTIME_CONSTANTS.controlPaths.snapshot) {
        return {
          statusCode: 200,
          body: {
            code: "Success",
            data: {
              region: "北京B区",
              payg: true,
              proxy_host: "connect.bjb1.seetacloud.com",
              ssh_port: 26603,
              ssh_command: "ssh -p 26603 root@connect.bjb1.seetacloud.com",
              status: "running",
              root_password: "must-not-survive-the-whitelist", // fixture-only credential shape
            },
          },
        };
      }
      return { statusCode: 200, body: { code: "Success", data: null } };
    },
  };
  const client = createAutodlH3InstanceClient({
    allowedInstanceUuids: [INSTANCE_UUID],
    resolveDeveloperToken: () => DEVELOPER_SENTINEL,
    transport,
  });
  assert.deepEqual(await client.getStatus(INSTANCE_UUID), { powerState: "running" });
  const snapshot = await client.getSnapshot(INSTANCE_UUID);
  assert.deepEqual(snapshot, {
    instanceUuid: INSTANCE_UUID,
    sshHost: "connect.bjb1.seetacloud.com",
    sshPort: 26603,
    status: "running",
  });
  assert.equal("rootPassword" in snapshot, false);
  assert.deepEqual(await client.powerOn(INSTANCE_UUID), { accepted: true });
  assert.deepEqual(await client.powerOff(INSTANCE_UUID), { accepted: true });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "POST", "POST"]);
  assert.deepEqual(requests.map((request) => request.path), [
    AUTODL_H3_RUNTIME_CONSTANTS.controlPaths.status,
    AUTODL_H3_RUNTIME_CONSTANTS.controlPaths.snapshot,
    AUTODL_H3_RUNTIME_CONSTANTS.controlPaths.powerOn,
    AUTODL_H3_RUNTIME_CONSTANTS.controlPaths.powerOff,
  ]);
  assert.equal(requests.every((request) => request.authorization === DEVELOPER_SENTINEL), true);
  assert.deepEqual(requests[2].body, {
    instance_uuid: INSTANCE_UUID,
    payload: "gpu",
    start_command: "bash /root/zealman-app/scripts/improved-autostart.sh",
  });
  assert.equal(
    requests[2].body.start_command,
    AUTODL_H3_RUNTIME_CONSTANTS.powerOnStartCommand,
    "power_on must use the fixed server-side bootstrap command",
  );
  assert.deepEqual(requests[3].body, { instance_uuid: INSTANCE_UUID });
  await rejectsCode(
    () => client.getStatus("pro-not-allowlisted-123"),
    "AUTODL_INSTANCE_UUID_NOT_ALLOWED",
  );
  assert.equal(requests.length, 4, "allowlist rejection must happen before token or transport I/O");
  assert.equal(Object.values(AUTODL_H3_RUNTIME_CONSTANTS.controlPaths).length, 4);
  assert.equal(Object.values(AUTODL_H3_RUNTIME_CONSTANTS.controlPaths).some((value) => value.includes("release")), false);

  const stoppedClient = createAutodlH3InstanceClient({
    allowedInstanceUuids: [INSTANCE_UUID],
    resolveDeveloperToken: () => DEVELOPER_SENTINEL,
    transport: { async request() { return { statusCode: 200, body: { code: "Success", data: "shutdown" } }; } },
  });
  assert.deepEqual(await stoppedClient.getStatus(INSTANCE_UUID), { powerState: "stopped" });

  const rejectedClient = createAutodlH3InstanceClient({
    allowedInstanceUuids: [INSTANCE_UUID],
    resolveDeveloperToken: () => DEVELOPER_SENTINEL,
    transport: { async request() { return { statusCode: 200, body: { code: "success", data: null } }; } },
  });
  await rejectsCode(() => rejectedClient.powerOff(INSTANCE_UUID), "AUTODL_CONTROL_RESPONSE_NOT_SUCCESS");

  await rejectsCode(() => Promise.resolve(parseAutodlH3SafeSnapshot({
    code: "Success",
    data: {
      instance_uuid: "pro-someother123",
      proxy_host: "connect.bjb1.seetacloud.com",
      ssh_port: 26603,
    },
  }, INSTANCE_UUID)), "AUTODL_SNAPSHOT_INSTANCE_MISMATCH");
  await rejectsCode(() => Promise.resolve(parseAutodlH3SafeSnapshot({
    code: "Success",
    data: { proxy_host: "127.0.0.1", ssh_port: 26603 },
  }, INSTANCE_UUID)), "AUTODL_SNAPSHOT_SSH_HOST_INVALID");
}

class FakeSshProcess implements AutodlH3ManagedSshProcess {
  exitCode: number | null = null;
  killed = false;
  private listeners: Partial<Record<"exit" | "error", Array<(...args: unknown[]) => void>>> = {};

  once(event: "exit" | "error", listener: (...args: unknown[]) => void) {
    this.listeners[event] ||= [];
    this.listeners[event]!.push(listener);
    return this;
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    for (const listener of this.listeners.exit || []) listener(0, "SIGTERM");
    return true;
  }
}

class FakeProcessLifecycleTarget {
  private readonly listeners = new Map<string, Array<() => void>>();

  once(event: string, listener: () => void) {
    const current = this.listeners.get(event) || [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  removeListener(event: string, listener: () => void) {
    this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== listener));
    return this;
  }

  listenerCount(event: string) {
    return (this.listeners.get(event) || []).length;
  }

  emit(event: string) {
    const current = [...(this.listeners.get(event) || [])];
    for (const listener of current) {
      this.removeListener(event, listener);
      listener();
    }
  }
}

function verifyTunnelProcessCleanup() {
  let stopCount = 0;
  const resentSignals: NodeJS.Signals[] = [];
  const target = new FakeProcessLifecycleTarget();
  const dispose = installAutodlH3TunnelProcessCleanup(
    { stop() { stopCount += 1; } },
    {
      target,
      resendSignal: signal => { resentSignals.push(signal); },
    },
  );
  assert.equal(target.listenerCount("SIGTERM"), 1);
  target.emit("SIGTERM");
  assert.equal(stopCount, 1);
  assert.deepEqual(resentSignals, ["SIGTERM"]);
  assert.equal(target.listenerCount("SIGINT"), 0);
  dispose();
  assert.equal(stopCount, 1, "cleanup must be idempotent");

  let frameworkSignalCount = 0;
  const frameworkTarget = new FakeProcessLifecycleTarget();
  frameworkTarget.once("SIGINT", () => { frameworkSignalCount += 1; });
  installAutodlH3TunnelProcessCleanup(
    { stop() { stopCount += 1; } },
    {
      target: frameworkTarget,
      resendSignal: signal => { resentSignals.push(signal); },
    },
  );
  frameworkTarget.emit("SIGINT");
  assert.equal(frameworkSignalCount, 1);
  assert.deepEqual(resentSignals, ["SIGTERM"], "an existing framework signal handler owns process exit");
}

async function verifyHealthAndTunnel() {
  assert.deepEqual(parseAutodlH3GatewayHealth({
    status: "ready",
    checks: { workflows: true, comfyui: true, disk_ok: true, queue_running: 2, queue_pending: 3 },
  }), readyHealth(2, 3));
  await rejectsCode(() => Promise.resolve(parseAutodlH3GatewayHealth({
    status: "ready",
    checks: { workflows: true, comfyui: false, disk_ok: true, queue_running: 0, queue_pending: 0 },
  })), "AUTODL_GATEWAY_CHECK_FAILED");

  const spawned: Array<{ executable: string; args: string[]; options: SpawnOptions; process: FakeSshProcess }> = [];
  const supervisor = new AutodlH3StrictSshTunnelSupervisor({
    sshExecutable: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    privateKeyPath: "C:\\safe\\autodl_ed25519",
    knownHostsPath: "C:\\safe\\known_hosts",
    hostKeyAlias: "autodl-h3-production",
    probe: async () => readyHealth(),
    filePolicy: {
      exists: () => true,
      stat: () => ({ isFile: () => true, mode: 0o600 }),
      platform: "win32",
    },
    spawnSsh: (executable, args, options) => {
      const process = new FakeSshProcess();
      spawned.push({ executable, args, options, process });
      return process;
    },
  });
  const snapshot = {
    instanceUuid: INSTANCE_UUID,
    sshHost: "connect.bjb1.seetacloud.com",
    sshPort: 26603,
    status: "running",
  };
  assert.deepEqual(await supervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot }), { ready: true });
  assert.equal(await supervisor.isReady({ instanceUuid: INSTANCE_UUID }), true);
  assert.equal(spawned.length, 1);
  const invocation = spawned[0];
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.options.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal(invocation.args.includes("StrictHostKeyChecking=yes"), true);
  assert.equal(invocation.args.includes("UserKnownHostsFile=C:\\safe\\known_hosts"), true);
  assert.equal(invocation.args.includes("HostKeyAlias=autodl-h3-production"), true);
  assert.equal(invocation.args.includes("GlobalKnownHostsFile=NUL"), true);
  assert.equal(invocation.args.includes("PasswordAuthentication=no"), true);
  assert.equal(invocation.args.includes("KbdInteractiveAuthentication=no"), true);
  assert.equal(invocation.args.includes("ExitOnForwardFailure=yes"), true);
  assert.equal(invocation.args.includes("127.0.0.1:16011:127.0.0.1:6011"), true);
  assert.equal(invocation.args.at(-1), "root@connect.bjb1.seetacloud.com");
  await supervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot });
  assert.equal(spawned.length, 1, "an owned healthy tunnel must be reused");
  const rotatedSnapshot = { ...snapshot, sshPort: 27777 };
  assert.deepEqual(
    await supervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot: rotatedSnapshot }),
    { ready: true },
  );
  assert.equal(spawned.length, 2, "a fresh snapshot endpoint must replace the old owned tunnel");
  assert.equal(invocation.process.killed, true);
  assert.equal(spawned[1].args.includes("27777"), true);
  assert.equal(spawned[1].args.includes("HostKeyAlias=autodl-h3-production"), true);
  supervisor.stop();
  assert.equal(spawned[1].process.killed, true);

  let bootstrapProbeCount = 0;
  const bootstrapCalls: Array<{ executable: string; args: string[]; options: SpawnOptions }> = [];
  const bootstrapSupervisor = new AutodlH3StrictSshTunnelSupervisor({
    sshExecutable: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    privateKeyPath: "C:\\safe\\autodl_ed25519",
    knownHostsPath: "C:\\safe\\known_hosts",
    hostKeyAlias: "autodl-h3-production",
    probe: async () => {
      bootstrapProbeCount += 1;
      if (bootstrapProbeCount === 1) throw new Error("gateway not listening");
      return readyHealth();
    },
    filePolicy: {
      exists: () => true,
      stat: () => ({ isFile: () => true, mode: 0o600 }),
      platform: "win32",
    },
    spawnSsh: () => new FakeSshProcess(),
    runSshCommand: async (executable, args, options) => {
      bootstrapCalls.push({ executable, args, options });
      return { exitCode: 0 };
    },
    wait: async () => undefined,
  });
  assert.deepEqual(await bootstrapSupervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot }), { ready: true });
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].options.shell, false);
  assert.deepEqual(bootstrapCalls[0].args.slice(-2), ["/bin/bash", "/root/codex-h3-gateway/start_all.sh"]);
  assert.equal(bootstrapCalls[0].args.includes("PasswordAuthentication=no"), true);
  assert.equal(bootstrapCalls[0].args.includes("--"), true);
  await bootstrapSupervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot });
  assert.equal(bootstrapCalls.length, 1, "fixed gateway bootstrap runs once per owned tunnel generation");
  bootstrapSupervisor.stop();

  const unsafeSupervisor = new AutodlH3StrictSshTunnelSupervisor({
    sshExecutable: "/usr/bin/ssh",
    privateKeyPath: "/safe/autodl_ed25519",
    knownHostsPath: "/safe/known_hosts",
    hostKeyAlias: "autodl-h3-production",
    probe: async () => readyHealth(),
    filePolicy: {
      exists: () => true,
      stat: () => ({ isFile: () => true, mode: 0o644 }),
      platform: "linux",
    },
    spawnSsh: () => new FakeSshProcess(),
  });
  await rejectsCode(() => unsafeSupervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot }), "AUTODL_H3_SSH_KEY_PERMISSIONS_UNSAFE");

  const invalidAliasSupervisor = new AutodlH3StrictSshTunnelSupervisor({
    sshExecutable: "/usr/bin/ssh",
    privateKeyPath: "/safe/autodl_ed25519",
    knownHostsPath: "/safe/known_hosts",
    hostKeyAlias: "-oProxyCommand=forbidden",
    probe: async () => readyHealth(),
    filePolicy: {
      exists: () => true,
      stat: () => ({ isFile: () => true, mode: 0o600 }),
      platform: "linux",
    },
    spawnSsh: () => new FakeSshProcess(),
  });
  await rejectsCode(
    () => invalidAliasSupervisor.ensureReady({ instanceUuid: INSTANCE_UUID, snapshot }),
    "AUTODL_H3_SSH_HOST_KEY_ALIAS_INVALID",
  );
}

async function verifyDispatcher() {
  const order: string[] = [];
  const generateCalls: Array<{ config: VideoModelConfig; params: VideoGenerateParams }> = [];
  const dispatcher = createAutodlH3ProductionDispatcher({
    loadModel: async () => exactModelRow(),
    resolveGatewaySecret: () => {
      order.push("secret");
      return GATEWAY_SENTINEL;
    },
    resolveQueuedAssets: async ({ payload }) => {
      order.push("asset");
      return { ...payload };
    },
    generate: async (config, params) => {
      generateCalls.push({ config, params });
      return { taskId: "h3_abcdef1234", status: "queued" };
    },
    poll: async () => ({ taskId: "h3_abcdef1234", status: "processing", progress: 0.25 }),
    finalizeSuccess: async () => ({
      state: "RECOVERY_REQUIRED",
      errorCode: "TEST_FINALIZER_DISABLED",
      errorMessage: "test finalizer disabled",
    }),
    canSubmit: () => true,
    ensureGatewayReady: async () => readyHealth(2, 3),
  });
  const job = baseJob();
  assert.deepEqual(await dispatcher.dispatch(job), { upstreamTaskId: "h3_abcdef1234", contentUrl: null });
  assert.deepEqual(await dispatcher.recoverUnknownDispatch(job), {
    outcome: "found",
    upstreamTaskId: "h3_abcdef1234",
    contentUrl: null,
  });
  assert.deepEqual(order, ["asset", "secret", "asset", "secret"]);
  assert.equal(generateCalls.length, 2);
  assert.equal(generateCalls.every((call) => call.config.api_key === GATEWAY_SENTINEL), true);
  assert.equal(generateCalls.every((call) => call.params.idempotencyKey === CLIENT_REQUEST_ID), true);
  assert.equal(generateCalls.every((call) => call.params.duration === 10), true);

  const activeJob = baseJob({ state: "RUNNING", upstreamTaskId: "h3_abcdef1234", progress: 10 });
  assert.deepEqual(await dispatcher.reconcile(activeJob), { state: "RUNNING", progress: 25 });
  assert.deepEqual(await dispatcher.getActivity(INSTANCE_UUID), {
    queued: 3,
    running: 2,
    resultStaging: 0,
    persisting: 0,
    finalizing: 0,
    recovery: 0,
  });

  const resultFor = async (result: VideoTaskResult, finalizerState: "success" | "recovery" = "recovery") =>
    createAutodlH3ProductionDispatcher({
      loadModel: async () => exactModelRow(),
      resolveGatewaySecret: () => GATEWAY_SENTINEL,
      resolveQueuedAssets: async ({ payload }) => ({ ...payload }),
      generate: async () => ({ taskId: "h3_abcdef1234", status: "queued" }),
      poll: async () => result,
      finalizeSuccess: finalizerState === "success"
        ? async () => ({
            state: "SUCCEEDED" as const,
            taskIdInternal: "video-internal-1",
            resultAssetUrl: "object://tencent_cos/video/h3/result.mp4",
            chargedYuan: 0,
          })
        : async () => ({
            state: "RECOVERY_REQUIRED" as const,
            errorCode: "H3_ATOMIC_FINALIZER_DISABLED",
            errorMessage: "H3 atomic finalizer is not enabled",
          }),
      canSubmit: () => true,
      ensureGatewayReady: async () => readyHealth(),
    });

  const queuedDispatcher = await resultFor({ taskId: "h3_abcdef1234", status: "queued", progress: 0 });
  assert.deepEqual(await queuedDispatcher.reconcile(activeJob), { state: "QUEUED", progress: 0 });
  const failedDispatcher = await resultFor({ taskId: "h3_abcdef1234", status: "failed", error: "sensitive upstream text" });
  assert.deepEqual(await failedDispatcher.reconcile(activeJob), {
    state: "FAILED_TERMINAL",
    progress: 10,
    errorCode: "AUTODL_H3_GENERATION_FAILED",
    errorMessage: "AutoDL H3 generation failed",
  });
  const successDispatcher = await resultFor({
    taskId: "h3_abcdef1234",
    status: "success",
    videoUrl: "http://127.0.0.1:16011/v1/files/result?expires=1&sig=redacted",
  }, "success");
  assert.deepEqual(await successDispatcher.reconcile(activeJob), {
    state: "SUCCEEDED",
    progress: 100,
    resultAssetUrl: "object://tencent_cos/video/h3/result.mp4",
  });
  const recoveryDispatcher = await resultFor({
    taskId: "h3_abcdef1234",
    status: "success",
    videoUrl: "http://127.0.0.1:16011/v1/files/result?expires=1&sig=redacted",
  });
  assert.deepEqual(await recoveryDispatcher.reconcile(activeJob), {
    state: "RECOVERY_REQUIRED",
    progress: 99,
    errorCode: "H3_ATOMIC_FINALIZER_DISABLED",
    errorMessage: "H3 atomic finalizer is not enabled",
  });

  let invalidSecretReads = 0;
  const invalidResolutionDispatcher = createAutodlH3ProductionDispatcher({
    loadModel: async () => exactModelRow(),
    resolveGatewaySecret: () => {
      invalidSecretReads += 1;
      return GATEWAY_SENTINEL;
    },
    resolveQueuedAssets: async ({ payload }) => ({ ...payload }),
    generate: async () => ({ taskId: "h3_abcdef1234", status: "queued" }),
    poll: async () => ({ taskId: "h3_abcdef1234", status: "queued" }),
    finalizeSuccess: async () => ({
      state: "RECOVERY_REQUIRED",
      errorCode: "not-used",
      errorMessage: "not-used",
    }),
    canSubmit: () => true,
    ensureGatewayReady: async () => readyHealth(),
  });
  await rejectsCode(() => invalidResolutionDispatcher.dispatch(baseJob({
    requestPayload: { ...job.requestPayload, resolution: "1080p", resolutionTier: "1080p" },
  })), "AutoDL H3 自租视频尚未启用 1080p增强");
  assert.equal(invalidSecretReads, 0, "invalid payload must be rejected before credential resolution");

  let blockedAssetReads = 0;
  const blockedDispatcher = createAutodlH3ProductionDispatcher({
    loadModel: async () => exactModelRow(),
    resolveGatewaySecret: () => GATEWAY_SENTINEL,
    resolveQueuedAssets: async ({ payload }) => {
      blockedAssetReads += 1;
      return { ...payload };
    },
    generate: async () => ({ taskId: "h3_abcdef1234", status: "queued" }),
    poll: async () => ({ taskId: "h3_abcdef1234", status: "queued" }),
    finalizeSuccess: async () => ({
      state: "RECOVERY_REQUIRED",
      errorCode: "not-used",
      errorMessage: "not-used",
    }),
    canSubmit: () => false,
    ensureGatewayReady: async () => readyHealth(),
  });
  await rejectsCode(() => blockedDispatcher.dispatch(job), "AUTODL_H3_RUNTIME_SUBMISSION_NOT_ENABLED");
  assert.equal(blockedAssetReads, 0, "disabled runtime must stop before storage or credential I/O");
}

function withEnvironment(updates: Record<string, string | undefined>, operation: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (typeof value === "undefined") delete process.env[key];
    else process.env[key] = value;
  }
  try {
    operation();
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === "undefined") delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function verifyFailClosedInstallAndStaticWiring() {
  withEnvironment({ AUTODL_H3_LIFECYCLE_ENABLED: "false" }, () => {
    assert.deepEqual(installAutodlH3ProductionRuntimeSafelyFromEnvironment(), {
      installed: false,
      reason: "disabled",
    });
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
  try {
    withEnvironment({
      AUTODL_H3_LIFECYCLE_ENABLED: "true",
      AUTODL_H3_INSTANCE_UUID: INSTANCE_UUID,
      AUTODL_H3_SSH_EXECUTABLE: undefined,
      AUTODL_H3_SSH_KEY_PATH: undefined,
      AUTODL_H3_SSH_KNOWN_HOSTS_PATH: undefined,
      AUTODL_DEVELOPER_TOKEN: DEVELOPER_SENTINEL,
    }, () => {
      assert.deepEqual(installAutodlH3ProductionRuntimeSafelyFromEnvironment(), {
        installed: false,
        reason: "failed",
      });
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["[AutoDL H3 Lifecycle] production runtime install failed"]);
  assert.equal(warnings.some((line) => line.includes(DEVELOPER_SENTINEL)), false);

  warnings.length = 0;
  console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
  try {
    withEnvironment({
      AUTODL_H3_LIFECYCLE_ENABLED: "true",
      AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS: "true",
      AUTODL_H3_ATOMIC_FINALIZER_ENABLED: undefined,
      AUTODL_H3_INSTANCE_UUID: INSTANCE_UUID,
      AUTODL_H3_SSH_EXECUTABLE: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      AUTODL_H3_SSH_KEY_PATH: "C:\\safe\\autodl_ed25519",
      AUTODL_H3_SSH_KNOWN_HOSTS_PATH: "C:\\safe\\known_hosts",
      AUTODL_DEVELOPER_TOKEN: DEVELOPER_SENTINEL,
    }, () => {
      assert.deepEqual(installAutodlH3ProductionRuntimeSafelyFromEnvironment(), {
        installed: false,
        reason: "failed",
      });
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["[AutoDL H3 Lifecycle] production runtime install failed"]);
  assert.equal(warnings.some((line) => line.includes(DEVELOPER_SENTINEL)), false);

  const root = process.cwd();
  const runtimeSource = readFileSync(path.join(root, "src/lib/autodl-h3-production-runtime.ts"), "utf8");
  const providerSecretSource = readFileSync(path.join(root, "src/lib/provider-secret.ts"), "utf8");
  const instrumentationSource = readFileSync(path.join(root, "src/instrumentation.ts"), "utf8");
  const serverSource = readFileSync(path.join(root, "src/server.ts"), "utf8");
  const environmentExample = readFileSync(path.join(root, ".env.example"), "utf8");
  assert.equal(runtimeSource.includes("/release"), false);
  assert.ok(runtimeSource.includes("installAutodlH3VideoFinalizerDependencies"));
  assert.ok(runtimeSource.includes("/root/codex-h3-gateway/start_all.sh"));
  assert.ok(runtimeSource.includes("allowedInstanceUuids: [instanceUuid]"));
  assert.ok(runtimeSource.includes("AUTODL_DEVELOPER_TOKEN_FILE"));
  assert.ok(runtimeSource.includes("HostKeyAlias="));
  assert.ok(runtimeSource.includes("installAutodlH3TunnelProcessCleanup(tunnel)"));
  assert.ok(providerSecretSource.includes("AUTODL_H3_SELFHOST_API_KEY_FILE"));
  assert.ok(providerSecretSource.includes("/run/secrets/autodl-h3-selfhost-api-key"));
  assert.equal(/^[ \t]*NEXT_PUBLIC_AUTODL_/mu.test(environmentExample), false);
  assert.ok(instrumentationSource.indexOf("installAutodlH3ProductionRuntimeSafelyFromEnvironment()")
    < instrumentationSource.indexOf("startAutodlH3LifecycleWorkerFromEnvironment()"));
  assert.ok(serverSource.indexOf("installAutodlH3ProductionRuntimeSafelyFromEnvironment()")
    < serverSource.indexOf("startAutodlH3LifecycleWorkerFromEnvironment()"));
}

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ZERO_NETWORK_TEST_FETCH_FORBIDDEN");
  };
  try {
    await verifyTokenResolver();
    await verifyOfficialControlClient();
    verifyTunnelProcessCleanup();
    await verifyHealthAndTunnel();
    await verifyDispatcher();
    verifyFailClosedInstallAndStaticWiring();
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("PASS verify-autodl-h3-production-runtime (zero network)");
}

void main().catch((error) => {
  console.error(errorCode(error));
  process.exitCode = 1;
});
