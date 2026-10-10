import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type ProviderAdmissionState = {
  schemaVersion: "provider_admission_control.v1";
  leases: ProviderAdmissionStateLease[];
};

type ProviderAdmissionStateLease = {
  leaseId: string;
  providerKey: string;
  channelKey: string;
  modelKey: string;
  ownerPid: number;
  acquiredAt: number;
  expiresAt: number;
};

export type ProviderAdmissionRequest = {
  provider: string;
  channel: string;
  model: string;
  ttlMs?: number;
  globalLimit?: number;
  providerLimit?: number;
  channelLimit?: number;
  modelLimit?: number;
};

export type ProviderAdmissionLease = {
  leaseId: string;
  expiresAt: number;
  release(): Promise<void>;
};

type ProviderAdmissionControllerOptions = {
  rootDir?: string;
  environment?: RuntimeEnvironment;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  beforeStateWrite?: (state: ProviderAdmissionState) => void | Promise<void>;
  releaseRetryLimit?: number;
};

type MutexOwner = {
  schemaVersion: "provider_admission_mutex.v1";
  ownerToken: string;
  pid: number;
  acquiredAt: number;
};

const STATE_SCHEMA = "provider_admission_control.v1" as const;
const DEFAULT_GLOBAL_LIMIT = 8;
const DEFAULT_PROVIDER_LIMIT = 6;
const DEFAULT_CHANNEL_LIMIT = 3;
const DEFAULT_MODEL_LIMIT = 2;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 30 * 60 * 1000;
const MUTEX_STALE_MS = 5_000;
const MUTEX_WAIT_MS = 1_500;
const MUTEX_SCHEMA = "provider_admission_mutex.v1" as const;
const DEFAULT_RELEASE_RETRY_LIMIT = 3;

function positiveInteger(value: unknown, fallback: number, maximum = 1_000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedTtl(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(parsed)));
}

function stableKey(namespace: string, value: string): string {
  const normalized = value.trim().toLowerCase() || "unknown";
  return `${namespace}:${createHash("sha256").update(normalized).digest("hex")}`;
}

function parseState(raw: string): ProviderAdmissionState {
  const parsed = JSON.parse(raw) as Partial<ProviderAdmissionState>;
  if (parsed.schemaVersion !== STATE_SCHEMA || !Array.isArray(parsed.leases)) {
    throw new Error("PROVIDER_ADMISSION_STATE_INVALID");
  }
  const leases = parsed.leases.filter((lease): lease is ProviderAdmissionStateLease => Boolean(
    lease
    && typeof lease.leaseId === "string"
    && typeof lease.providerKey === "string"
    && typeof lease.channelKey === "string"
    && typeof lease.modelKey === "string"
    && Number.isInteger(lease.ownerPid)
    && Number.isFinite(lease.acquiredAt)
    && Number.isFinite(lease.expiresAt),
  ));
  if (leases.length !== parsed.leases.length) throw new Error("PROVIDER_ADMISSION_STATE_INVALID");
  return { schemaVersion: STATE_SCHEMA, leases };
}

function countBy(leases: ProviderAdmissionStateLease[], field: "providerKey" | "channelKey" | "modelKey", key: string): number {
  return leases.reduce((count, lease) => count + (lease[field] === key ? 1 : 0), 0);
}

function parseMutexOwner(raw: string): MutexOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<MutexOwner>;
    if (value.schemaVersion !== MUTEX_SCHEMA
      || typeof value.ownerToken !== "string"
      || !/^[0-9a-f-]{36}$/iu.test(value.ownerToken)
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || !Number.isFinite(value.acquiredAt)) return null;
    return value as MutexOwner;
  } catch {
    return null;
  }
}

function defaultProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export class ProviderAdmissionBusyError extends Error {
  readonly code = "PROVIDER_ADMISSION_BUSY";
  readonly status = 429;

  constructor(
    readonly retryAfterSeconds: number,
    readonly scope: "global" | "provider" | "channel" | "model",
  ) {
    super("上游通道当前并发已满，本次尚未调用供应商，请稍后重试");
    this.name = "ProviderAdmissionBusyError";
  }
}

export class ProviderAdmissionUnavailableError extends Error {
  readonly code = "PROVIDER_ADMISSION_CONTROL_UNAVAILABLE";
  readonly status = 503;

  constructor(message = "上游并发保护暂不可用，本次尚未调用供应商") {
    super(message);
    this.name = "ProviderAdmissionUnavailableError";
  }
}

export class ProviderAdmissionController {
  private readonly rootDir: string;
  private readonly stateFile: string;
  private readonly mutexFile: string;
  private readonly environment: RuntimeEnvironment;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly beforeStateWrite?: (state: ProviderAdmissionState) => void | Promise<void>;
  private readonly releaseRetryLimit: number;

  constructor(options: ProviderAdmissionControllerOptions = {}) {
    this.environment = options.environment || process.env;
    this.rootDir = options.rootDir || path.join(resolveAppRuntimeDir(this.environment), "provider-admission-control");
    this.stateFile = path.join(this.rootDir, "leases.json");
    this.mutexFile = path.join(this.rootDir, "leases.lock");
    this.now = options.now || Date.now;
    this.isProcessAlive = options.isProcessAlive || defaultProcessAlive;
    this.beforeStateWrite = options.beforeStateWrite;
    this.releaseRetryLimit = positiveInteger(options.releaseRetryLimit, DEFAULT_RELEASE_RETRY_LIMIT, 10);
  }

  private async readMutexOwner(file = this.mutexFile): Promise<MutexOwner | null> {
    try {
      return parseMutexOwner(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new ProviderAdmissionUnavailableError();
    }
  }

  private async removeMutexOwnedBy(ownerToken: string, reason: "release" | "stale"): Promise<boolean> {
    const observed = await this.readMutexOwner();
    if (!observed || observed.ownerToken !== ownerToken) return false;
    const quarantine = `${this.mutexFile}.${reason}.${ownerToken}.${randomUUID()}`;
    try {
      await rename(this.mutexFile, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw new ProviderAdmissionUnavailableError();
    }
    const moved = await this.readMutexOwner(quarantine);
    if (!moved || moved.ownerToken !== ownerToken) {
      // Never delete a file whose ownership changed between comparison and
      // rename. Restoration is best-effort; acquisition remains fail-closed.
      await rename(quarantine, this.mutexFile).catch(() => undefined);
      throw new ProviderAdmissionUnavailableError();
    }
    await unlink(quarantine);
    return true;
  }

  private async recoverStaleMutex(): Promise<boolean> {
    let mutexStats;
    try {
      mutexStats = await stat(this.mutexFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
      throw new ProviderAdmissionUnavailableError();
    }
    const first = await this.readMutexOwner();
    if (!first) return false;
    const staleForMs = this.now() - Math.max(mutexStats.mtimeMs, first.acquiredAt);
    if (staleForMs <= MUTEX_STALE_MS || this.isProcessAlive(first.pid)) return false;
    const compared = await this.readMutexOwner();
    if (!compared || compared.ownerToken !== first.ownerToken || compared.pid !== first.pid
      || compared.acquiredAt !== first.acquiredAt) return false;
    return this.removeMutexOwnedBy(first.ownerToken, "stale");
  }

  private async withMutex<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.rootDir, { recursive: true });
    const deadline = this.now() + MUTEX_WAIT_MS;
    while (true) {
      let handle;
      const owner: MutexOwner = {
        schemaVersion: MUTEX_SCHEMA,
        ownerToken: randomUUID(),
        pid: process.pid,
        acquiredAt: this.now(),
      };
      try {
        handle = await open(this.mutexFile, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw new ProviderAdmissionUnavailableError();
        }
        if (await this.recoverStaleMutex()) continue;
        if (this.now() >= deadline) throw new ProviderAdmissionUnavailableError();
        await new Promise((resolve) => setTimeout(resolve, randomInt(8, 26)));
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify(owner));
        await handle.sync();
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await this.removeMutexOwnedBy(owner.ownerToken, "release").catch((error) => {
          console.error("[ProviderAdmission] mutex release failed", error instanceof Error ? error.message : "unknown");
        });
      }
    }
  }

  private async readState(): Promise<ProviderAdmissionState> {
    try {
      return parseState(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { schemaVersion: STATE_SCHEMA, leases: [] };
      }
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "PROVIDER_ADMISSION_STATE_INVALID")) {
        throw new ProviderAdmissionUnavailableError("上游并发保护状态异常，本次尚未调用供应商");
      }
      throw new ProviderAdmissionUnavailableError();
    }
  }

  private async writeState(state: ProviderAdmissionState): Promise<void> {
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.beforeStateWrite?.(state);
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.stateFile);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new ProviderAdmissionUnavailableError();
    }
  }

  async acquire(request: ProviderAdmissionRequest): Promise<ProviderAdmissionLease> {
    const ttlMs = boundedTtl(request.ttlMs || this.environment.PROVIDER_ADMISSION_TTL_MS);
    const globalLimit = positiveInteger(request.globalLimit || this.environment.PROVIDER_ADMISSION_GLOBAL_LIMIT, DEFAULT_GLOBAL_LIMIT);
    const providerLimit = positiveInteger(request.providerLimit || this.environment.PROVIDER_ADMISSION_PROVIDER_LIMIT, DEFAULT_PROVIDER_LIMIT);
    const channelLimit = positiveInteger(request.channelLimit || this.environment.PROVIDER_ADMISSION_CHANNEL_LIMIT, DEFAULT_CHANNEL_LIMIT);
    const modelLimit = positiveInteger(request.modelLimit || this.environment.PROVIDER_ADMISSION_MODEL_LIMIT, DEFAULT_MODEL_LIMIT);
    const keys = {
      providerKey: stableKey("provider", request.provider),
      channelKey: stableKey("channel", request.channel),
      modelKey: stableKey("model", request.model),
    };
    const leaseId = randomUUID();
    let expiresAt = 0;

    await this.withMutex(async () => {
      const now = this.now();
      const state = await this.readState();
      const leases = state.leases.filter((lease) => lease.expiresAt > now);
      const checks = [
        { scope: "global" as const, count: leases.length, limit: globalLimit, matches: leases },
        { scope: "provider" as const, count: countBy(leases, "providerKey", keys.providerKey), limit: providerLimit, matches: leases.filter((lease) => lease.providerKey === keys.providerKey) },
        { scope: "channel" as const, count: countBy(leases, "channelKey", keys.channelKey), limit: channelLimit, matches: leases.filter((lease) => lease.channelKey === keys.channelKey) },
        { scope: "model" as const, count: countBy(leases, "modelKey", keys.modelKey), limit: modelLimit, matches: leases.filter((lease) => lease.modelKey === keys.modelKey) },
      ];
      const blocked = checks.find((check) => check.count >= check.limit);
      if (blocked) {
        const earliestExpiry = Math.min(...blocked.matches.map((lease) => lease.expiresAt));
        const jitterMs = randomInt(100, 901);
        throw new ProviderAdmissionBusyError(
          Math.max(1, Math.ceil((earliestExpiry - now + jitterMs) / 1000)),
          blocked.scope,
        );
      }
      expiresAt = now + ttlMs;
      leases.push({ leaseId, ...keys, ownerPid: process.pid, acquiredAt: now, expiresAt });
      await this.writeState({ schemaVersion: STATE_SCHEMA, leases });
    });

    let released = false;
    let releaseRequested = false;
    let releaseInFlight: Promise<void> | null = null;
    const heartbeatMs = Math.max(1_000, Math.floor(ttlMs / 3));
    const renew = async () => {
      if (released || releaseRequested) return;
      await this.withMutex(async () => {
        const state = await this.readState();
        const lease = state.leases.find((candidate) => candidate.leaseId === leaseId);
        if (!lease) return;
        lease.expiresAt = this.now() + ttlMs;
        expiresAt = lease.expiresAt;
        await this.writeState(state);
      }).catch(() => undefined);
    };
    const releaseOnce = async () => {
      await this.withMutex(async () => {
        const state = await this.readState();
        const retained = state.leases.filter((lease) => lease.leaseId !== leaseId && lease.expiresAt > this.now());
        if (retained.length === state.leases.length) return;
        await this.writeState({ schemaVersion: STATE_SCHEMA, leases: retained });
        const confirmed = await this.readState();
        if (confirmed.leases.some((lease) => lease.leaseId === leaseId)) {
          throw new ProviderAdmissionUnavailableError("上游并发租约释放尚未持久确认");
        }
      });
    };
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      releaseRequested = true;
      if (releaseInFlight) return releaseInFlight;
      releaseInFlight = (async () => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.releaseRetryLimit; attempt += 1) {
          try {
            await releaseOnce();
            released = true;
            clearInterval(heartbeat);
            return;
          } catch (error) {
            lastError = error;
            if (attempt < this.releaseRetryLimit) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(100, attempt * 20)));
            }
          }
        }
        throw lastError instanceof Error ? lastError : new ProviderAdmissionUnavailableError("上游并发租约释放失败");
      })();
      releaseInFlight = releaseInFlight.finally(() => {
        if (!released) releaseInFlight = null;
      });
      return releaseInFlight;
    };
    const heartbeat = setInterval(() => {
      if (releaseRequested) {
        void release().catch((error) => {
          console.error("[ProviderAdmission] deferred lease release failed", error instanceof Error ? error.message : "unknown");
        });
        return;
      }
      void renew();
    }, heartbeatMs);
    heartbeat.unref?.();

    return {
      leaseId,
      get expiresAt() { return expiresAt; },
      release,
    };
  }
}

let sharedController: ProviderAdmissionController | null = null;

export function acquireProviderAdmission(request: ProviderAdmissionRequest): Promise<ProviderAdmissionLease> {
  sharedController ||= new ProviderAdmissionController();
  return sharedController.acquire(request);
}

export async function holdProviderAdmissionUntilResponseEnds(
  response: Response,
  lease: ProviderAdmissionLease,
): Promise<Response> {
  if (!response.body) {
    await lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let settleInFlight: Promise<void> | null = null;
  const settle = async () => {
    settleInFlight ||= lease.release().catch((error) => {
      settleInFlight = null;
      console.error("[ProviderAdmission] response-end lease release failed", error instanceof Error ? error.message : "unknown");
      throw error;
    });
    return settleInFlight;
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await settle();
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        await settle().catch((releaseError) => {
          console.error("[ProviderAdmission] response-error lease release failed", releaseError instanceof Error ? releaseError.message : "unknown");
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await settle();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}
