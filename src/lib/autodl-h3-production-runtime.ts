import { execFileSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  createSupabaseAutodlH3LifecycleStore,
  installAutodlH3LifecycleRuntimeDependencies,
  isAutodlH3LifecycleEnabled,
  isAutodlH3ProviderDeliveryResultUrl,
  type AutodlH3InstanceClient,
  type AutodlH3Job,
  type AutodlH3JobDispatcher,
  type AutodlH3PowerState,
  type AutodlH3SafeSnapshot,
  type AutodlH3TunnelSupervisor,
} from "@/lib/autodl-h3-lifecycle";
import { resolveAutodlH3QueuedAssetPayload } from "@/lib/autodl-h3-assets";
import {
  finalizeAutodlH3VideoSuccess,
  hasAutodlH3VideoFinalizerDependencies,
  installAutodlH3VideoFinalizerDependencies,
} from "@/lib/autodl-h3-video-finalizer";
import { createAutodlH3ProductionFinalizerDependencies } from "@/lib/autodl-h3-production-finalizer";
import {
  assertAutodlH3SelfhostModelBinding,
  AUTODL_H3_SELFHOST_SECRET_REF,
  autodlH3VideoPixelSize,
  normalizeAutodlH3VideoResolutionTier,
} from "@/lib/autodl-h3-selfhost";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { probeAutodlH3ProviderDeliveryReadiness } from "@/lib/autodl-h3-provider-delivery-readiness";
import {
  createDefaultServerSecretFilePolicy,
  readServerOnlySecretFile,
  type ServerSecretFilePolicy,
} from "@/lib/server-secret";
import type { VideoGenerateParams, VideoModelConfig, VideoTaskResult } from "@/lib/video-adapter";
import {
  generateAutodlH3SelfhostVideo,
  pollAutodlH3SelfhostVideo,
} from "@/lib/video-autodl-h3-selfhost";

if (typeof window !== "undefined") {
  throw new Error("AUTODL_H3_RUNTIME_SERVER_ONLY");
}

const AUTODL_CONTROL_HOST = "www.autodl.art";
const AUTODL_CONTROL_ORIGIN = `https://${AUTODL_CONTROL_HOST}`;
const AUTODL_CONTROL_PATHS = {
  status: "/api/v1/adl_dev/dev/instance/pro/status",
  snapshot: "/api/v1/adl_dev/dev/instance/pro/snapshot",
  powerOn: "/api/v1/adl_dev/dev/instance/pro/power_on",
  powerOff: "/api/v1/adl_dev/dev/instance/pro/power_off",
} as const;
// Fixed server-side bootstrap command supplied by the instance owner. Never
// accept this value from a browser request or a queued generation payload.
const AUTODL_H3_POWER_ON_START_COMMAND = "bash /root/zealman-app/scripts/improved-autostart.sh";
const AUTODL_GATEWAY_LOCAL_HOST = "127.0.0.1";
const AUTODL_GATEWAY_LOCAL_PORT = 16_011;
const AUTODL_GATEWAY_REMOTE_PORT = 6_011;
const AUTODL_GATEWAY_READY_PATH = "/health/ready";
const AUTODL_GATEWAY_START_SHELL = "/bin/bash";
const AUTODL_GATEWAY_START_SCRIPT = "/root/codex-h3-gateway/start_all.sh";
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const TOKEN_CACHE_TTL_MS = 5 * 60_000;
const AUTODL_DEVELOPER_CONTAINER_SECRET_FILE = "/run/secrets/autodl-developer-token";
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/u;
const INSTANCE_UUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/u;
const SSH_HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+seetacloud\.com$/u;
const SSH_HOST_KEY_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireInstanceUuid(value: unknown): string {
  const normalized = String(value || "").trim();
  if (!INSTANCE_UUID_PATTERN.test(normalized)) throw new Error("AUTODL_INSTANCE_UUID_INVALID");
  return normalized;
}

function createInstanceUuidAllowlist(values: readonly string[]): (value: unknown) => string {
  const allowed = new Set(values.map(requireInstanceUuid));
  if (allowed.size < 1) throw new Error("AUTODL_INSTANCE_UUID_ALLOWLIST_REQUIRED");
  return (value: unknown) => {
    const normalized = requireInstanceUuid(value);
    if (!allowed.has(normalized)) throw new Error("AUTODL_INSTANCE_UUID_NOT_ALLOWED");
    return normalized;
  };
}

function requireSafeDeveloperToken(value: unknown): string {
  const raw = String(value || "");
  const normalized = raw.trim();
  if (raw !== normalized || !TOKEN_PATTERN.test(normalized) || /[\r\n\u0000]/u.test(normalized)) {
    throw new Error("AUTODL_DEVELOPER_TOKEN_INVALID");
  }
  return normalized;
}

function defaultDeveloperTokenFile(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string {
  const configuredRoot = String(environment.CODEX_HOME || "").trim();
  const codexRoot = configuredRoot || path.join(homeDirectory, ".codex");
  return path.join(codexRoot, "secrets", "autodl-developer.token");
}

function decryptWindowsDpapiDeveloperToken(filePath: string): string {
  if (process.platform !== "win32") throw new Error("AUTODL_DEVELOPER_DPAPI_WINDOWS_ONLY");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    "$encrypted=[System.IO.File]::ReadAllText($env:AUTODL_DEVELOPER_TOKEN_FILE,[System.Text.Encoding]::UTF8)",
    "$secure=ConvertTo-SecureString $encrypted",
    "$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}",
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, AUTODL_DEVELOPER_TOKEN_FILE: filePath },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

export interface AutodlDeveloperTokenResolverOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  now?: () => number;
  fileExists?: (filePath: string) => boolean;
  decryptFile?: (filePath: string) => string;
  serverSecretFilePolicy?: ServerSecretFilePolicy;
  containerSecretPath?: string;
}

/**
 * Resolve the AutoDL control-plane credential lazily. The application model
 * credential resolver is intentionally not reused, so a provider record can
 * never select this higher-privilege token.
 */
export function createAutodlDeveloperTokenResolver(
  options: AutodlDeveloperTokenResolverOptions = {},
): () => string {
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const homeDirectory = options.homeDirectory || os.homedir();
  const now = options.now || Date.now;
  const fileExists = options.fileExists || existsSync;
  const decryptFile = options.decryptFile || decryptWindowsDpapiDeveloperToken;
  const serverSecretFilePolicy = options.serverSecretFilePolicy
    || createDefaultServerSecretFilePolicy(platform);
  const containerSecretPath = options.containerSecretPath || AUTODL_DEVELOPER_CONTAINER_SECRET_FILE;
  let cached: { source: string; value: string; expiresAt: number } | undefined;

  return () => {
    if (typeof window !== "undefined") throw new Error("AUTODL_DEVELOPER_TOKEN_SERVER_ONLY");
    const configuredServerFile = String(environment.AUTODL_DEVELOPER_TOKEN_FILE || "").trim();
    const serverFile = configuredServerFile
      || (platform !== "win32" && serverSecretFilePolicy.exists(containerSecretPath)
        ? containerSecretPath
        : "");
    if (serverFile) {
      const source = `file:${serverFile}`;
      if (cached?.source === source && cached.expiresAt > now()) return cached.value;
      const value = requireSafeDeveloperToken(readServerOnlySecretFile({
        filePath: serverFile,
        errorLabel: "AUTODL_DEVELOPER_TOKEN",
        policy: serverSecretFilePolicy,
      }));
      cached = { source, value, expiresAt: now() + TOKEN_CACHE_TTL_MS };
      return value;
    }
    const environmentToken = String(environment.AUTODL_DEVELOPER_TOKEN || "");
    if (environmentToken) return requireSafeDeveloperToken(environmentToken);
    if (platform !== "win32") throw new Error("AUTODL_DEVELOPER_TOKEN_FILE_OR_ENV_REQUIRED");

    const filePath = defaultDeveloperTokenFile(environment, homeDirectory);
    const source = `dpapi:${filePath}`;
    if (cached?.source === source && cached.expiresAt > now()) return cached.value;
    if (!fileExists(filePath)) throw new Error("AUTODL_DEVELOPER_DPAPI_FILE_MISSING");
    const value = requireSafeDeveloperToken(decryptFile(filePath));
    cached = { source, value, expiresAt: now() + TOKEN_CACHE_TTL_MS };
    return value;
  };
}

export interface AutodlControlPlaneRequest {
  method: "GET" | "POST";
  origin: typeof AUTODL_CONTROL_ORIGIN;
  path: (typeof AUTODL_CONTROL_PATHS)[keyof typeof AUTODL_CONTROL_PATHS];
  authorization: string;
  body: JsonRecord;
  timeoutMs: number;
}

export interface AutodlControlPlaneTransport {
  request(input: AutodlControlPlaneRequest): Promise<{ statusCode: number; body: unknown }>;
}

export function createNodeAutodlControlPlaneTransport(): AutodlControlPlaneTransport {
  return {
    async request(input) {
      if (input.origin !== AUTODL_CONTROL_ORIGIN || !Object.values(AUTODL_CONTROL_PATHS).includes(input.path)) {
        throw new Error("AUTODL_CONTROL_ENDPOINT_NOT_ALLOWED");
      }
      const bodyText = JSON.stringify(input.body);
      return new Promise((resolve, reject) => {
        const request = https.request({
          protocol: "https:",
          hostname: AUTODL_CONTROL_HOST,
          port: 443,
          path: input.path,
          method: input.method,
          minVersion: "TLSv1.2",
          headers: {
            Accept: "application/json",
            Authorization: input.authorization,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyText, "utf8"),
          },
          agent: false,
        }, (response) => {
          const statusCode = response.statusCode || 0;
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > MAX_CONTROL_RESPONSE_BYTES) {
              request.destroy(new Error("AUTODL_CONTROL_RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error("AUTODL_CONTROL_HTTP_STATUS_INVALID"));
              return;
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
              resolve({ statusCode, body: parsed });
            } catch {
              reject(new Error("AUTODL_CONTROL_RESPONSE_NOT_JSON"));
            }
          });
        });
        request.setTimeout(input.timeoutMs, () => request.destroy(new Error("AUTODL_CONTROL_TIMEOUT")));
        request.on("error", () => reject(new Error("AUTODL_CONTROL_REQUEST_FAILED")));
        request.end(bodyText);
      });
    },
  };
}

function requireSuccessfulAutodlResponse(value: unknown): JsonRecord {
  if (!isRecord(value) || value.code !== "Success") {
    throw new Error("AUTODL_CONTROL_RESPONSE_NOT_SUCCESS");
  }
  return value;
}

function requireSuccessfulAutodlData(value: unknown): JsonRecord {
  const response = requireSuccessfulAutodlResponse(value);
  if (!isRecord(response.data)) throw new Error("AUTODL_CONTROL_RESPONSE_DATA_INVALID");
  return response.data;
}

const POWER_STATE_MAP: Readonly<Record<string, AutodlH3PowerState>> = Object.freeze({
  running: "running",
  stopped: "stopped",
  shutdown: "stopped",
  starting: "starting",
  stopping: "stopping",
});

function parsePowerState(value: unknown): AutodlH3PowerState {
  const normalized = String(value || "").trim().toLowerCase();
  return POWER_STATE_MAP[normalized] || "unknown";
}

function requireSshHost(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SSH_HOST_PATTERN.test(normalized)) throw new Error("AUTODL_SNAPSHOT_SSH_HOST_INVALID");
  return normalized;
}

function requireSshPort(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value || ""));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("AUTODL_SNAPSHOT_SSH_PORT_INVALID");
  }
  return parsed;
}

function requireSshHostKeyAlias(value: unknown): string {
  const normalized = String(value || "").trim();
  if (!SSH_HOST_KEY_ALIAS_PATTERN.test(normalized)) {
    throw new Error("AUTODL_H3_SSH_HOST_KEY_ALIAS_INVALID");
  }
  return normalized;
}

function parseOfficialSshCommand(value: unknown): { host: string; port: number } | null {
  const command = String(value || "").trim();
  if (!command) return null;
  const match = /^ssh(?:\.exe)?\s+-p\s+(\d{1,5})\s+root@([a-z0-9.-]+)$/iu.exec(command);
  if (!match) throw new Error("AUTODL_SNAPSHOT_SSH_COMMAND_INVALID");
  return { host: requireSshHost(match[2]), port: requireSshPort(match[1]) };
}

export function parseAutodlH3SafeSnapshot(value: unknown, expectedInstanceUuid: string): AutodlH3SafeSnapshot {
  const data = requireSuccessfulAutodlData(value);
  const instanceUuid = requireInstanceUuid(expectedInstanceUuid);
  const returnedInstanceUuid = data.instance_uuid ?? data.uuid;
  if (typeof returnedInstanceUuid !== "undefined"
    && requireInstanceUuid(returnedInstanceUuid) !== instanceUuid) {
    throw new Error("AUTODL_SNAPSHOT_INSTANCE_MISMATCH");
  }
  const command = parseOfficialSshCommand(data.ssh_command);
  const explicitHost = typeof data.proxy_host === "undefined" ? null : requireSshHost(data.proxy_host);
  const explicitPort = typeof data.ssh_port === "undefined" ? null : requireSshPort(data.ssh_port);
  const sshHost = explicitHost || command?.host;
  const sshPort = explicitPort || command?.port;
  if (!sshHost || !sshPort) throw new Error("AUTODL_SNAPSHOT_SSH_FIELDS_MISSING");
  if (command && (command.host !== sshHost || command.port !== sshPort)) {
    throw new Error("AUTODL_SNAPSHOT_SSH_FIELDS_MISMATCH");
  }
  const status = parsePowerState(data.status);
  return { instanceUuid, sshHost, sshPort, status };
}

export function createAutodlH3InstanceClient(options: {
  allowedInstanceUuids: readonly string[];
  resolveDeveloperToken?: () => string;
  transport?: AutodlControlPlaneTransport;
  timeoutMs?: number;
}): AutodlH3InstanceClient {
  const requireAllowedInstanceUuid = createInstanceUuidAllowlist(options.allowedInstanceUuids);
  const resolveDeveloperToken = options.resolveDeveloperToken || createAutodlDeveloperTokenResolver();
  const transport = options.transport || createNodeAutodlControlPlaneTransport();
  const timeoutMs = Math.max(1000, Math.min(60_000, options.timeoutMs || 15_000));

  const request = async (
    method: "GET" | "POST",
    requestPath: AutodlControlPlaneRequest["path"],
    body: JsonRecord,
  ) => transport.request({
    method,
    origin: AUTODL_CONTROL_ORIGIN,
    path: requestPath,
    authorization: resolveDeveloperToken(),
    body,
    timeoutMs,
  });

  return {
    async getStatus(instanceUuid) {
      const normalized = requireAllowedInstanceUuid(instanceUuid);
      const response = await request("GET", AUTODL_CONTROL_PATHS.status, { instance_uuid: normalized });
      const envelope = requireSuccessfulAutodlResponse(response.body);
      const rawStatus = typeof envelope.data === "string"
        ? envelope.data
        : isRecord(envelope.data)
          ? envelope.data.status
          : undefined;
      if (typeof rawStatus !== "string") throw new Error("AUTODL_CONTROL_STATUS_DATA_INVALID");
      return { powerState: parsePowerState(rawStatus) };
    },
    async getSnapshot(instanceUuid) {
      const normalized = requireAllowedInstanceUuid(instanceUuid);
      const response = await request("GET", AUTODL_CONTROL_PATHS.snapshot, { instance_uuid: normalized });
      return parseAutodlH3SafeSnapshot(response.body, normalized);
    },
    async powerOn(instanceUuid) {
      const normalized = requireAllowedInstanceUuid(instanceUuid);
      const response = await request("POST", AUTODL_CONTROL_PATHS.powerOn, {
        instance_uuid: normalized,
        payload: "gpu",
        start_command: AUTODL_H3_POWER_ON_START_COMMAND,
      });
      requireSuccessfulAutodlResponse(response.body);
      return { accepted: true };
    },
    async powerOff(instanceUuid) {
      const normalized = requireAllowedInstanceUuid(instanceUuid);
      const response = await request("POST", AUTODL_CONTROL_PATHS.powerOff, { instance_uuid: normalized });
      requireSuccessfulAutodlResponse(response.body);
      return { accepted: true };
    },
  };
}

export interface AutodlH3GatewayHealth {
  ready: true;
  workflows: true;
  comfyui: true;
  diskOk: true;
  queueRunning: number;
  queuePending: number;
}

export type AutodlH3GatewayHealthProbe = () => Promise<AutodlH3GatewayHealth>;

function requireQueueCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`AUTODL_GATEWAY_${field}_INVALID`);
  return Number(value);
}

export function parseAutodlH3GatewayHealth(value: unknown): AutodlH3GatewayHealth {
  if (!isRecord(value) || value.status !== "ready" || !isRecord(value.checks)) {
    throw new Error("AUTODL_GATEWAY_NOT_READY");
  }
  const checks = value.checks;
  if (checks.workflows !== true || checks.comfyui !== true || checks.disk_ok !== true) {
    throw new Error("AUTODL_GATEWAY_CHECK_FAILED");
  }
  return {
    ready: true,
    workflows: true,
    comfyui: true,
    diskOk: true,
    queueRunning: requireQueueCount(checks.queue_running, "QUEUE_RUNNING"),
    queuePending: requireQueueCount(checks.queue_pending, "QUEUE_PENDING"),
  };
}

export function createNodeAutodlH3GatewayHealthProbe(options: { timeoutMs?: number } = {}): AutodlH3GatewayHealthProbe {
  const timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs || 5_000));
  return async () => new Promise((resolve, reject) => {
    const request = http.request({
      protocol: "http:",
      hostname: AUTODL_GATEWAY_LOCAL_HOST,
      port: AUTODL_GATEWAY_LOCAL_PORT,
      path: AUTODL_GATEWAY_READY_PATH,
      method: "GET",
      agent: false,
      headers: { Accept: "application/json", Host: `${AUTODL_GATEWAY_LOCAL_HOST}:${AUTODL_GATEWAY_LOCAL_PORT}` },
    }, (response) => {
      const statusCode = response.statusCode || 0;
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_HEALTH_RESPONSE_BYTES) {
          request.destroy(new Error("AUTODL_GATEWAY_HEALTH_TOO_LARGE"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (statusCode !== 200) {
          reject(new Error("AUTODL_GATEWAY_HEALTH_STATUS_INVALID"));
          return;
        }
        try {
          resolve(parseAutodlH3GatewayHealth(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
        } catch {
          reject(new Error("AUTODL_GATEWAY_HEALTH_INVALID"));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("AUTODL_GATEWAY_HEALTH_TIMEOUT")));
    request.on("error", () => reject(new Error("AUTODL_GATEWAY_HEALTH_UNAVAILABLE")));
    request.end();
  });
}

export interface AutodlH3ManagedSshProcess {
  exitCode: number | null;
  killed?: boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AutodlH3SshSpawner = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => AutodlH3ManagedSshProcess;

export type AutodlH3SshCommandRunner = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => Promise<{ exitCode: number }>;

export interface AutodlH3TunnelFilePolicy {
  exists(filePath: string): boolean;
  stat(filePath: string): { isFile(): boolean; mode: number };
  platform: NodeJS.Platform;
}

export interface AutodlH3SshTunnelOptions {
  sshExecutable: string;
  privateKeyPath: string;
  knownHostsPath: string;
  hostKeyAlias: string;
  probe?: AutodlH3GatewayHealthProbe;
  spawnSsh?: AutodlH3SshSpawner;
  runSshCommand?: AutodlH3SshCommandRunner;
  wait?: (milliseconds: number) => Promise<void>;
  filePolicy?: AutodlH3TunnelFilePolicy;
}

function defaultSshSpawner(executable: string, args: string[], options: SpawnOptions): AutodlH3ManagedSshProcess {
  return spawn(executable, args, options) as ChildProcess as AutodlH3ManagedSshProcess;
}

function defaultSshCommandRunner(executable: string, args: string[], options: SpawnOptions): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once("error", reject);
    child.once("exit", code => resolve({ exitCode: typeof code === "number" ? code : -1 }));
  });
}

function defaultTunnelFilePolicy(): AutodlH3TunnelFilePolicy {
  return {
    exists: existsSync,
    stat: statSync,
    platform: process.platform,
  };
}

function requireStrictRuntimeFile(
  filePath: string,
  field: string,
  filePolicy: AutodlH3TunnelFilePolicy,
  privateKey: boolean,
): string {
  const normalized = String(filePath || "").trim();
  if (!normalized || !path.isAbsolute(normalized)) throw new Error(`AUTODL_H3_${field}_ABSOLUTE_PATH_REQUIRED`);
  if (!filePolicy.exists(normalized)) throw new Error(`AUTODL_H3_${field}_MISSING`);
  const stat = filePolicy.stat(normalized);
  if (!stat.isFile()) throw new Error(`AUTODL_H3_${field}_NOT_FILE`);
  if (privateKey && filePolicy.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("AUTODL_H3_SSH_KEY_PERMISSIONS_UNSAFE");
  }
  return normalized;
}

export class AutodlH3StrictSshTunnelSupervisor implements AutodlH3TunnelSupervisor {
  private active?: {
    instanceUuid: string;
    host: string;
    port: number;
    generation: number;
    process: AutodlH3ManagedSshProcess;
  };
  private generation = 0;
  private ensuring?: Promise<{ ready: boolean; reason?: string }>;
  private readonly probe: AutodlH3GatewayHealthProbe;
  private readonly spawnSsh: AutodlH3SshSpawner;
  private readonly runSshCommand: AutodlH3SshCommandRunner;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly filePolicy: AutodlH3TunnelFilePolicy;
  private bootstrappedGeneration = 0;

  constructor(private readonly options: AutodlH3SshTunnelOptions) {
    this.probe = options.probe || createNodeAutodlH3GatewayHealthProbe();
    this.spawnSsh = options.spawnSsh || defaultSshSpawner;
    this.runSshCommand = options.runSshCommand || defaultSshCommandRunner;
    this.wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.filePolicy = options.filePolicy || defaultTunnelFilePolicy();
  }

  private processAlive(): boolean {
    return Boolean(this.active && this.active.process.exitCode === null && !this.active.process.killed);
  }

  private closeOwnedProcess(): void {
    const active = this.active;
    this.active = undefined;
    if (active && active.process.exitCode === null && !active.process.killed) {
      active.process.kill("SIGTERM");
    }
  }

  private strictSshOptions(
    port: number,
    privateKeyPath: string,
    knownHostsPath: string,
    hostKeyAlias: string,
  ): string[] {
    return [
      "-F", "none", "-p", String(port), "-i", privateKeyPath,
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", `HostKeyAlias=${hostKeyAlias}`,
      "-o", `GlobalKnownHostsFile=${this.filePolicy.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
      "-o", "PubkeyAuthentication=yes", "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no", "-o", "UpdateHostKeys=no",
      "-o", "VerifyHostKeyDNS=no", "-o", "CanonicalizeHostname=no",
      "-o", "ForwardAgent=no", "-o", "GatewayPorts=no",
      "-o", "PermitLocalCommand=no", "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR",
    ];
  }

  private async bootstrapGateway(input: {
    executable: string;
    host: string;
    port: number;
    privateKeyPath: string;
    knownHostsPath: string;
    hostKeyAlias: string;
    generation: number;
  }): Promise<boolean> {
    if (this.bootstrappedGeneration === input.generation) return false;
    this.bootstrappedGeneration = input.generation;
    const result = await this.runSshCommand(input.executable, [
      "-T",
      ...this.strictSshOptions(input.port, input.privateKeyPath, input.knownHostsPath, input.hostKeyAlias),
      "--", `root@${input.host}`,
      AUTODL_GATEWAY_START_SHELL,
      AUTODL_GATEWAY_START_SCRIPT,
    ], {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.exitCode !== 0) throw new Error("AUTODL_H3_GATEWAY_BOOTSTRAP_FAILED");
    return true;
  }

  private async probeAfterBootstrap(input: Parameters<AutodlH3StrictSshTunnelSupervisor["bootstrapGateway"]>[0]) {
    await this.bootstrapGateway(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.probe();
        return true;
      } catch {
        if (attempt < 2) await this.wait(1_000);
      }
    }
    return false;
  }

  private async ensureReadyInner(input: {
    instanceUuid: string;
    snapshot: AutodlH3SafeSnapshot;
  }): Promise<{ ready: boolean; reason?: string }> {
    const instanceUuid = requireInstanceUuid(input.instanceUuid);
    if (input.snapshot.instanceUuid !== instanceUuid) throw new Error("AUTODL_H3_TUNNEL_INSTANCE_MISMATCH");
    const host = requireSshHost(input.snapshot.sshHost);
    const port = requireSshPort(input.snapshot.sshPort);
    const executable = requireStrictRuntimeFile(this.options.sshExecutable, "SSH_EXECUTABLE", this.filePolicy, false);
    const privateKeyPath = requireStrictRuntimeFile(this.options.privateKeyPath, "SSH_KEY", this.filePolicy, true);
    const knownHostsPath = requireStrictRuntimeFile(this.options.knownHostsPath, "KNOWN_HOSTS", this.filePolicy, false);
    const hostKeyAlias = requireSshHostKeyAlias(this.options.hostKeyAlias);

    if (this.processAlive()
      && this.active?.instanceUuid === instanceUuid
      && this.active.host === host
      && this.active.port === port) {
      try {
        await this.probe();
        return { ready: true };
      } catch {
        try {
          const ready = await this.probeAfterBootstrap({ executable, host, port, privateKeyPath, knownHostsPath, hostKeyAlias, generation: this.active!.generation });
          return ready ? { ready: true } : { ready: false, reason: "AUTODL_H3_GATEWAY_NOT_READY" };
        } catch {
          return { ready: false, reason: "AUTODL_H3_GATEWAY_BOOTSTRAP_FAILED" };
        }
      }
    }
    this.closeOwnedProcess();

    const args = [
      "-N",
      "-T",
      ...this.strictSshOptions(port, privateKeyPath, knownHostsPath, hostKeyAlias),
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=20",
      "-o", "ServerAliveCountMax=3",
      "-L", `${AUTODL_GATEWAY_LOCAL_HOST}:${AUTODL_GATEWAY_LOCAL_PORT}:${AUTODL_GATEWAY_LOCAL_HOST}:${AUTODL_GATEWAY_REMOTE_PORT}`,
      `root@${host}`,
    ];
    const child = this.spawnSsh(executable, args, {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const generation = ++this.generation;
    this.active = { instanceUuid, host, port, generation, process: child };
    const clearIfCurrent = () => {
      if (this.active?.generation === generation) this.active = undefined;
    };
    child.once("exit", clearIfCurrent);
    child.once("error", clearIfCurrent);

    // Give ExitOnForwardFailure a short window to report a stale/unowned
    // listener on 16011 before accepting a health response from that port.
    await this.wait(100);
    if (!this.processAlive()) {
      this.active = undefined;
      return { ready: false, reason: "AUTODL_H3_SSH_PROCESS_EXITED" };
    }
    try {
      await this.probe();
      return { ready: true };
    } catch {
      try {
        const ready = await this.probeAfterBootstrap({ executable, host, port, privateKeyPath, knownHostsPath, hostKeyAlias, generation });
        return ready ? { ready: true } : { ready: false, reason: "AUTODL_H3_GATEWAY_NOT_READY" };
      } catch {
        return { ready: false, reason: "AUTODL_H3_GATEWAY_BOOTSTRAP_FAILED" };
      }
    }
  }

  async ensureReady(input: {
    instanceUuid: string;
    snapshot: AutodlH3SafeSnapshot;
  }): Promise<{ ready: boolean; reason?: string }> {
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.ensureReadyInner(input).finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  async isReady(input: { instanceUuid: string }): Promise<boolean> {
    if (!this.processAlive() || this.active?.instanceUuid !== requireInstanceUuid(input.instanceUuid)) return false;
    try {
      await this.probe();
      return true;
    } catch {
      return false;
    }
  }

  async readHealth(instanceUuid: string): Promise<AutodlH3GatewayHealth> {
    if (!this.processAlive() || this.active?.instanceUuid !== requireInstanceUuid(instanceUuid)) {
      throw new Error("AUTODL_H3_OWNED_TUNNEL_NOT_READY");
    }
    return this.probe();
  }

  stop(): void {
    this.closeOwnedProcess();
  }
}

export interface AutodlH3ProcessLifecycleTarget {
  once(event: "exit" | NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: "exit" | NodeJS.Signals, listener: () => void): unknown;
  listenerCount(event: "exit" | NodeJS.Signals): number;
}

/**
 * Keep the deployment server as the owner of the local SSH forward. A signal
 * first closes the owned child; if no framework signal handler remains, the
 * signal is re-sent so installing this cleanup never suppresses normal exit.
 */
export function installAutodlH3TunnelProcessCleanup(
  tunnel: Pick<AutodlH3StrictSshTunnelSupervisor, "stop">,
  options: {
    target?: AutodlH3ProcessLifecycleTarget;
    resendSignal?: (signal: NodeJS.Signals) => void;
  } = {},
): () => void {
  const target = options.target || process;
  const resendSignal = options.resendSignal || (signal => process.kill(process.pid, signal));
  const hadExternalSignalHandler = {
    SIGINT: target.listenerCount("SIGINT") > 0,
    SIGTERM: target.listenerCount("SIGTERM") > 0,
  } as const;
  let cleaned = false;
  const stopOwnedTunnel = () => {
    if (cleaned) return;
    cleaned = true;
    tunnel.stop();
  };
  const onExit = () => stopOwnedTunnel();
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const detach = () => {
    target.removeListener("exit", onExit);
    target.removeListener("SIGINT", onSigint);
    target.removeListener("SIGTERM", onSigterm);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    stopOwnedTunnel();
    detach();
    if (!hadExternalSignalHandler[signal === "SIGINT" ? "SIGINT" : "SIGTERM"]
      && target.listenerCount(signal) === 0) {
      resendSignal(signal);
    }
  };
  target.once("exit", onExit);
  target.once("SIGINT", onSigint);
  target.once("SIGTERM", onSigterm);
  return () => {
    stopOwnedTunnel();
    detach();
  };
}

function finiteProgress(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const percent = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVideoModel(row: JsonRecord, resolvedSecret: string): VideoModelConfig {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name) || "AutoDL H3",
    provider: stringValue(row.provider),
    api_endpoint: stringValue(row.api_endpoint),
    api_key: resolvedSecret,
    protocol_type: stringValue(row.protocol_type),
    price_per_use: numberValue(row.selling_price ?? row.price_per_use, 0),
    duration_seconds: numberValue(row.duration_seconds, 10),
    supports_image_input: row.supports_image_input === true,
    model_name: stringValue(row.model_name) || stringValue(row.id),
    api_protocol_config: isRecord(row.api_protocol_config) ? row.api_protocol_config : undefined,
  };
}

function assertNoUnsupportedH3Media(payload: Record<string, unknown>): void {
  const unsupported = ["audioUrl", "audioUrls", "imageUrls", "sourceVideoUrl", "negativePrompt"];
  for (const field of unsupported) {
    const value = payload[field];
    if ((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value !== undefined && value !== null && value !== "")) {
      throw new Error(`AUTODL_H3_UNSUPPORTED_${field.toUpperCase()}`);
    }
  }
  const resolution = stringValue(payload.resolution);
  const resolutionTier = stringValue(payload.resolutionTier);
  if ((resolution && !normalizeAutodlH3VideoResolutionTier(resolution))
    || (resolutionTier && !normalizeAutodlH3VideoResolutionTier(resolutionTier))) {
    throw new Error("AUTODL_H3_RESOLUTION_OVERRIDE_UNSUPPORTED");
  }
  if (resolution && resolutionTier
    && normalizeAutodlH3VideoResolutionTier(resolution) !== normalizeAutodlH3VideoResolutionTier(resolutionTier)) {
    throw new Error("AUTODL_H3_RESOLUTION_FIELDS_MISMATCH");
  }
}

function toVideoGenerateParams(
  job: AutodlH3Job,
  payload: Record<string, unknown>,
  model: VideoModelConfig,
): VideoGenerateParams {
  assertNoUnsupportedH3Media(payload);
  const prompt = stringValue(payload.prompt);
  if (!prompt || prompt.length > 10_000) throw new Error("AUTODL_H3_PROMPT_INVALID");
  const payloadKey = stringValue(payload.idempotencyKey);
  if (payloadKey && payloadKey !== job.clientRequestId) throw new Error("AUTODL_H3_IDEMPOTENCY_KEY_MISMATCH");
  const duration = numberValue(payload.duration, 10);
  if (![5, 10, 15].includes(duration)) throw new Error("AUTODL_H3_DURATION_UNSUPPORTED");
  const aspectRatio = stringValue(payload.aspectRatio) || "16:9";
  if (!["16:9", "9:16", "1:1"].includes(aspectRatio)) throw new Error("AUTODL_H3_ASPECT_RATIO_UNSUPPORTED");
  const requestedResolution = stringValue(payload.resolutionTier)
    || stringValue(payload.resolution)
    || stringValue(model.api_protocol_config?.default_resolution)
    || "480p";
  const resolutionTier = normalizeAutodlH3VideoResolutionTier(requestedResolution);
  if (!resolutionTier) throw new Error("AUTODL_H3_RESOLUTION_OVERRIDE_UNSUPPORTED");
  // This validates both the enabled DB profile and the exact per-aspect base size
  // before the dispatcher sends a paid provider request.
  autodlH3VideoPixelSize(aspectRatio, resolutionTier, model.api_protocol_config);
  return {
    prompt,
    imageUrl: stringValue(payload.imageUrl) || undefined,
    lastFrameUrl: stringValue(payload.lastFrameUrl) || undefined,
    referenceImageUrl: stringValue(payload.referenceImageUrl) || undefined,
    duration,
    aspectRatio,
    resolution: resolutionTier,
    resolutionTier,
    idempotencyKey: job.clientRequestId,
  };
}

export interface AutodlH3ProductionDispatcherOptions {
  loadModel?: (modelId: string) => Promise<JsonRecord | null>;
  resolveGatewaySecret?: (secretRef: unknown) => string;
  resolveQueuedAssets?: typeof resolveAutodlH3QueuedAssetPayload;
  generate?: typeof generateAutodlH3SelfhostVideo;
  poll?: typeof pollAutodlH3SelfhostVideo;
  finalizeSuccess?: typeof finalizeAutodlH3VideoSuccess;
  canSubmit?: () => boolean;
  providerDeliveryReadiness?: typeof probeAutodlH3ProviderDeliveryReadiness;
  ensureGatewayReady(instanceUuid: string): Promise<AutodlH3GatewayHealth>;
}

async function loadRuntimeVideoModel(modelId: string): Promise<JsonRecord | null> {
  const normalized = stringValue(modelId);
  if (!normalized) throw new Error("AUTODL_H3_VIDEO_MODEL_ID_MISSING");
  const { getSupabaseAdminClient } = await import("@/storage/database/supabase-client");
  const { data, error } = await getSupabaseAdminClient()
    .from("video_models")
    .select("id,name,model_name,provider,api_endpoint,api_key,protocol_type,price_per_use,duration_seconds,supports_image_input,is_active,is_hidden,api_protocol_config")
    .eq("id", normalized)
    .maybeSingle();
  if (error) throw new Error("AUTODL_H3_VIDEO_MODEL_LOOKUP_FAILED");
  if (!data || data.is_hidden === true) return null;
  return data as JsonRecord;
}

export function createAutodlH3ProductionDispatcher(
  options: AutodlH3ProductionDispatcherOptions,
): AutodlH3JobDispatcher {
  const loadModel = options.loadModel || loadRuntimeVideoModel;
  const resolveGatewaySecret = options.resolveGatewaySecret || resolveProviderSecret;
  const resolveQueuedAssets = options.resolveQueuedAssets || resolveAutodlH3QueuedAssetPayload;
  const generate = options.generate || generateAutodlH3SelfhostVideo;
  const poll = options.poll || pollAutodlH3SelfhostVideo;
  const finalizeSuccess = options.finalizeSuccess || finalizeAutodlH3VideoSuccess;
  const canSubmit = options.canSubmit || (() => process.env.AUTODL_H3_LIFECYCLE_DRY_RUN === "false"
    && process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED === "true"
    && hasAutodlH3VideoFinalizerDependencies());

  const modelFor = async (job: AutodlH3Job, withSecret = true): Promise<VideoModelConfig> => {
    const row = await loadModel(job.modelId);
    if (!row || row.is_active === false) throw new Error("AUTODL_H3_VIDEO_MODEL_UNAVAILABLE");
    const exact = assertAutodlH3SelfhostModelBinding({
      kind: "video",
      provider: row.provider,
      protocolType: row.protocol_type,
      modelName: row.model_name || row.id,
      apiEndpoint: row.api_endpoint,
      apiKey: row.api_key,
    });
    if (!exact || stringValue(row.api_key) !== AUTODL_H3_SELFHOST_SECRET_REF) {
      throw new Error("AUTODL_H3_VIDEO_MODEL_BINDING_INVALID");
    }
    return normalizeVideoModel(row, withSecret ? resolveGatewaySecret(row.api_key) : "");
  };

  const submit = async (job: AutodlH3Job): Promise<VideoTaskResult> => {
    if (!canSubmit()) throw new Error("AUTODL_H3_RUNTIME_SUBMISSION_NOT_ENABLED");
    if (!(await (options.providerDeliveryReadiness || probeAutodlH3ProviderDeliveryReadiness)()).ready) throw new Error("AUTODL_H3_PROVIDER_DELIVERY_NOT_READY");
    // Ownership/existence is checked before a provider credential is resolved.
    const hydratedPayload = await resolveQueuedAssets({ userId: job.userId, payload: job.requestPayload });
    const uncredentialedModel = await modelFor(job, false);
    const params = toVideoGenerateParams(job, hydratedPayload, uncredentialedModel);
    const model = { ...uncredentialedModel, api_key: resolveGatewaySecret(AUTODL_H3_SELFHOST_SECRET_REF) };
    return generate(model, params);
  };

  return {
    async dispatch(job) {
      const result = await submit(job);
      if (!result.taskId) throw new Error("AUTODL_H3_DISPATCH_TASK_ID_MISSING");
      if (result.status === "failed") throw new Error("AUTODL_H3_DISPATCH_REJECTED");
      return { upstreamTaskId: result.taskId, contentUrl: result.contentUrl || null };
    },
    async recoverUnknownDispatch(job) {
      try {
        // The gateway stores a request hash behind this same stable key. A
        // repeated POST returns the original task or rejects a payload drift.
        const result = await submit(job);
        if (!result.taskId || result.status === "failed") {
          return { outcome: "unknown", errorCode: "AUTODL_H3_DISPATCH_RECOVERY_UNCERTAIN" };
        }
        return { outcome: "found", upstreamTaskId: result.taskId, contentUrl: result.contentUrl || null };
      } catch {
        return { outcome: "unknown", errorCode: "AUTODL_H3_DISPATCH_RECOVERY_UNAVAILABLE" };
      }
    },
    async reconcile(job) {
      if (!job.upstreamTaskId) {
        return {
          state: "RECOVERY_REQUIRED",
          progress: job.progress,
          errorCode: "AUTODL_H3_UPSTREAM_TASK_ID_MISSING",
          errorMessage: "H3 upstream task id is missing",
        };
      }
      const model = await modelFor(job);
      const result = await poll(model, job.upstreamTaskId);
      if (result.status === "queued") {
        return { state: "QUEUED", progress: finiteProgress(result.progress) ?? job.progress };
      }
      if (result.status === "processing") {
        return { state: "RUNNING", progress: finiteProgress(result.progress) ?? Math.max(1, job.progress) };
      }
      if (result.status === "failed") {
        return {
          state: "FAILED_TERMINAL",
          progress: job.progress,
          errorCode: "AUTODL_H3_GENERATION_FAILED",
          errorMessage: "AutoDL H3 generation failed",
        };
      }
      if (!result.videoUrl) {
        return {
          state: "RECOVERY_REQUIRED",
          progress: 99,
          errorCode: "AUTODL_H3_RESULT_URL_MISSING",
          errorMessage: "AutoDL H3 result requires recovery",
        };
      }
      const finalized = await finalizeSuccess({ job, resultUrl: result.videoUrl });
      if (finalized.state === "RECOVERY_REQUIRED") {
        return {
          state: "RECOVERY_REQUIRED",
          progress: 99,
          errorCode: finalized.errorCode,
          errorMessage: finalized.errorMessage,
        };
      }
      if (!isAutodlH3ProviderDeliveryResultUrl(finalized.resultAssetUrl, job.upstreamTaskId)) {
        return {
          state: "RECOVERY_REQUIRED",
          progress: 99,
          errorCode: "AUTODL_H3_FINALIZER_RESULT_UNSTABLE",
          errorMessage: "AutoDL H3 finalizer did not return a stable result",
        };
      }
      return { state: "SUCCEEDED", progress: 100, resultAssetUrl: finalized.resultAssetUrl };
    },
    async getActivity(instanceUuid) {
      const health = await options.ensureGatewayReady(requireInstanceUuid(instanceUuid));
      return {
        queued: health.queuePending,
        running: health.queueRunning,
        resultStaging: 0,
        persisting: 0,
        finalizing: 0,
        recovery: 0,
      };
    },
  };
}

type ProductionRuntimeGlobalState = { installed: boolean; disposeTunnelCleanup?: () => void };
const PRODUCTION_RUNTIME_GLOBAL_KEY = Symbol.for("agent-hub.autodl-h3-production-runtime.v1");

function productionRuntimeGlobalState(): ProductionRuntimeGlobalState {
  const target = globalThis as typeof globalThis & { [PRODUCTION_RUNTIME_GLOBAL_KEY]?: ProductionRuntimeGlobalState };
  target[PRODUCTION_RUNTIME_GLOBAL_KEY] ||= { installed: false };
  return target[PRODUCTION_RUNTIME_GLOBAL_KEY]!;
}

function requiredAbsoluteEnvironmentPath(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`AUTODL_H3_${name}_REQUIRED`);
  return value;
}

/**
 * Install real server adapters, but never start the worker. When the lifecycle
 * flag is off this returns before reading any credential or touching network.
 */
export function installAutodlH3ProductionRuntimeFromEnvironment(): {
  installed: boolean;
  reason: "disabled" | "installed" | "already-installed";
} {
  if (!isAutodlH3LifecycleEnabled()) return { installed: false, reason: "disabled" };
  const globalState = productionRuntimeGlobalState();
  if (globalState.installed) return { installed: true, reason: "already-installed" };

  const instanceUuid = requireInstanceUuid(process.env.AUTODL_H3_INSTANCE_UUID);
  if (process.env.AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS === "true"
    && process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED !== "true") {
    throw new Error("AUTODL_H3_ATOMIC_FINALIZER_REQUIRED_FOR_POWER_ACTIONS");
  }
  const tokenResolver = createAutodlDeveloperTokenResolver();
  const instanceClient = createAutodlH3InstanceClient({
    allowedInstanceUuids: [instanceUuid],
    resolveDeveloperToken: tokenResolver,
  });
  const tunnel = new AutodlH3StrictSshTunnelSupervisor({
    sshExecutable: requiredAbsoluteEnvironmentPath("AUTODL_H3_SSH_EXECUTABLE"),
    privateKeyPath: requiredAbsoluteEnvironmentPath("AUTODL_H3_SSH_KEY_PATH"),
    knownHostsPath: requiredAbsoluteEnvironmentPath("AUTODL_H3_SSH_KNOWN_HOSTS_PATH"),
    hostKeyAlias: requireSshHostKeyAlias(process.env.AUTODL_H3_SSH_HOST_KEY_ALIAS),
  });
  const ensureGatewayReady = async (requestedInstanceUuid: string) => {
    if (requestedInstanceUuid !== instanceUuid) throw new Error("AUTODL_H3_RUNTIME_INSTANCE_MISMATCH");
    try {
      return await tunnel.readHealth(instanceUuid);
    } catch {
      // On process restart the instance may still be running while this
      // process owns no tunnel. Rebuild it from a fresh safe snapshot.
    }
    const snapshot = await instanceClient.getSnapshot(instanceUuid);
    const ready = await tunnel.ensureReady({ instanceUuid, snapshot });
    if (!ready.ready || !await tunnel.isReady({ instanceUuid })) {
      throw new Error("AUTODL_H3_GATEWAY_NOT_READY");
    }
    return tunnel.readHealth(instanceUuid);
  };
  const store = createSupabaseAutodlH3LifecycleStore();
  installAutodlH3VideoFinalizerDependencies(createAutodlH3ProductionFinalizerDependencies({ store }));
  const dispatcher = createAutodlH3ProductionDispatcher({ ensureGatewayReady });
  installAutodlH3LifecycleRuntimeDependencies({
    store,
    instanceClient,
    tunnel,
    dispatcher,
  });
  globalState.disposeTunnelCleanup = installAutodlH3TunnelProcessCleanup(tunnel);
  globalState.installed = true;
  return { installed: true, reason: "installed" };
}

/** Website-safe entrypoint: configuration faults disable only H3 lifecycle. */
export function installAutodlH3ProductionRuntimeSafelyFromEnvironment(): {
  installed: boolean;
  reason: "disabled" | "installed" | "already-installed" | "failed";
} {
  try {
    return installAutodlH3ProductionRuntimeFromEnvironment();
  } catch {
    console.warn("[AutoDL H3 Lifecycle] production runtime install failed");
    return { installed: false, reason: "failed" };
  }
}

export const AUTODL_H3_RUNTIME_CONSTANTS = Object.freeze({
  controlOrigin: AUTODL_CONTROL_ORIGIN,
  controlPaths: AUTODL_CONTROL_PATHS,
  powerOnStartCommand: AUTODL_H3_POWER_ON_START_COMMAND,
  gatewayHost: AUTODL_GATEWAY_LOCAL_HOST,
  gatewayLocalPort: AUTODL_GATEWAY_LOCAL_PORT,
  gatewayRemotePort: AUTODL_GATEWAY_REMOTE_PORT,
  gatewayReadyPath: AUTODL_GATEWAY_READY_PATH,
  gatewayStartShell: AUTODL_GATEWAY_START_SHELL,
  gatewayStartScript: AUTODL_GATEWAY_START_SCRIPT,
});
