/**
 * Short-lived, fail-closed readiness snapshot for the public video catalog.
 * The caller supplies the authoritative activation-gate loader; this module
 * only owns TTL, in-flight de-duplication and safe fallback behavior.
 */

export type VideoReadinessSnapshotLoaderInput = {
  modelId: string;
  bindingHash: string;
};

export type VideoReadinessSnapshotValue = {
  generationReady: boolean;
  readinessMessage?: string;
  verificationNotice?: string;
  protocolBindingReady?: boolean;
  canaryVerified?: boolean;
  activationReady?: boolean;
};

export type VideoReadinessSnapshot = Readonly<{
  key: string;
  modelId: string;
  bindingHash: string;
  generationReady: boolean;
  readinessMessage: string;
  verificationNotice: string;
  protocolBindingReady?: boolean;
  canaryVerified?: boolean;
  activationReady?: boolean;
  checkedAt: number;
  expiresAt: number;
  source: "loader" | "cache" | "inflight" | "fail_closed";
  cacheHit: boolean;
  errorCode?: string;
}>;

export type VideoReadinessSnapshotLoader = (
  input: VideoReadinessSnapshotLoaderInput,
) => VideoReadinessSnapshotValue | Promise<VideoReadinessSnapshotValue>;

export type VideoReadinessSnapshotCacheOptions = {
  /** Normal result TTL. Defaults to 30 seconds. */
  ttlMs?: number;
  /** Error/missing-input TTL. Defaults to 5 seconds. */
  errorTtlMs?: number;
  /** Injectable clock for deterministic contract tests. */
  now?: () => number;
  /** Full authoritative readiness inspection supplied by the caller. */
  loader: VideoReadinessSnapshotLoader;
};

type CacheEntry = {
  snapshot: VideoReadinessSnapshot;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_ERROR_TTL_MS = 5_000;
const MAX_MESSAGE_LENGTH = 240;

function cleanText(value: unknown): string {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
}

function positiveDuration(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function normalizedIdentity(value: unknown): string {
  return String(value || "").trim();
}

/** A changed binding hash cannot reuse an old readiness result. */
export function videoReadinessSnapshotKey(modelId: unknown, bindingHash: unknown): string {
  const normalizedModelId = normalizedIdentity(modelId);
  const normalizedBindingHash = normalizedIdentity(bindingHash).toLowerCase();
  if (!normalizedModelId || !normalizedBindingHash) return "";
  return normalizedModelId + "::" + normalizedBindingHash;
}

function safeValue(value: unknown): VideoReadinessSnapshotValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.generationReady !== "boolean") return null;
  return {
    generationReady: candidate.generationReady,
    ...(typeof candidate.readinessMessage === "string" ? { readinessMessage: candidate.readinessMessage } : {}),
    ...(typeof candidate.verificationNotice === "string" ? { verificationNotice: candidate.verificationNotice } : {}),
    ...(typeof candidate.protocolBindingReady === "boolean" ? { protocolBindingReady: candidate.protocolBindingReady } : {}),
    ...(typeof candidate.canaryVerified === "boolean" ? { canaryVerified: candidate.canaryVerified } : {}),
    ...(typeof candidate.activationReady === "boolean" ? { activationReady: candidate.activationReady } : {}),
  };
}

function withSource(
  snapshot: VideoReadinessSnapshot,
  source: VideoReadinessSnapshot["source"],
  cacheHit: boolean,
): VideoReadinessSnapshot {
  return { ...snapshot, source, cacheHit };
}

export class VideoModelReadinessSnapshotCache {
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly now: () => number;
  private readonly loader: VideoReadinessSnapshotLoader;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<VideoReadinessSnapshot>>();

  constructor(options: VideoReadinessSnapshotCacheOptions) {
    this.ttlMs = positiveDuration(options.ttlMs, DEFAULT_TTL_MS);
    this.errorTtlMs = positiveDuration(options.errorTtlMs, DEFAULT_ERROR_TTL_MS);
    this.now = options.now || (() => Date.now());
    this.loader = options.loader;
  }

  /** Concurrent requests for one key share the same promise. */
  get(modelId: unknown, bindingHash: unknown): Promise<VideoReadinessSnapshot> {
    const normalizedModelId = normalizedIdentity(modelId);
    const normalizedBindingHash = normalizedIdentity(bindingHash).toLowerCase();
    const key = videoReadinessSnapshotKey(normalizedModelId, normalizedBindingHash);
    const checkedAt = this.now();
    if (!key) {
      return Promise.resolve(this.failClosed(
        normalizedModelId,
        normalizedBindingHash,
        "VIDEO_READINESS_BINDING_REQUIRED",
        "模型绑定指纹缺失，暂不可提交",
        checkedAt,
      ));
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > checkedAt) {
      return Promise.resolve(withSource(cached.snapshot, "cache", true));
    }
    const active = this.inFlight.get(key);
    if (active) return active.then((snapshot) => withSource(snapshot, "inflight", true));

    const request = this.load({ key, modelId: normalizedModelId, bindingHash: normalizedBindingHash });
    this.inFlight.set(key, request);
    return request;
  }

  peek(modelId: unknown, bindingHash: unknown): VideoReadinessSnapshot | null {
    const key = videoReadinessSnapshotKey(modelId, bindingHash);
    if (!key) return null;
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.cache.delete(key);
      return null;
    }
    return withSource(entry.snapshot, "cache", true);
  }

  invalidate(modelId: unknown, bindingHash: unknown): void {
    const key = videoReadinessSnapshotKey(modelId, bindingHash);
    if (key) this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private async load(input: { key: string; modelId: string; bindingHash: string }): Promise<VideoReadinessSnapshot> {
    const checkedAt = this.now();
    try {
      const loaded = safeValue(await this.loader({ modelId: input.modelId, bindingHash: input.bindingHash }));
      if (!loaded) {
        const blocked = this.failClosed(input.modelId, input.bindingHash, "VIDEO_READINESS_RESULT_INVALID", "模型验收结果格式无效，暂不可提交", checkedAt);
        this.cache.set(input.key, { snapshot: blocked, expiresAt: blocked.expiresAt });
        return blocked;
      }
      const snapshot: VideoReadinessSnapshot = {
        key: input.key,
        modelId: input.modelId,
        bindingHash: input.bindingHash,
        generationReady: loaded.generationReady,
        readinessMessage: cleanText(loaded.readinessMessage),
        verificationNotice: cleanText(loaded.verificationNotice),
        ...(loaded.protocolBindingReady !== undefined ? { protocolBindingReady: loaded.protocolBindingReady } : {}),
        ...(loaded.canaryVerified !== undefined ? { canaryVerified: loaded.canaryVerified } : {}),
        ...(loaded.activationReady !== undefined ? { activationReady: loaded.activationReady } : {}),
        checkedAt,
        expiresAt: checkedAt + this.ttlMs,
        source: "loader",
        cacheHit: false,
      };
      this.cache.set(input.key, { snapshot, expiresAt: snapshot.expiresAt });
      return snapshot;
    } catch (error) {
      const blocked = this.failClosed(input.modelId, input.bindingHash, "VIDEO_READINESS_LOADER_FAILED", "模型验收状态暂不可用，暂不可提交", checkedAt, error);
      this.cache.set(input.key, { snapshot: blocked, expiresAt: blocked.expiresAt });
      return blocked;
    } finally {
      this.inFlight.delete(input.key);
    }
  }

  private failClosed(
    modelId: string,
    bindingHash: string,
    errorCode: string,
    readinessMessage: string,
    checkedAt: number,
    error?: unknown,
  ): VideoReadinessSnapshot {
    const key = videoReadinessSnapshotKey(modelId, bindingHash) || modelId + "::" + bindingHash;
    const safeError = error instanceof Error ? error.message : String(error || "");
    return {
      key,
      modelId,
      bindingHash,
      generationReady: false,
      readinessMessage: cleanText(readinessMessage),
      verificationNotice: safeError ? cleanText(safeError) : "",
      checkedAt,
      expiresAt: checkedAt + this.errorTtlMs,
      source: "fail_closed",
      cacheHit: false,
      errorCode,
    };
  }
}

export function createVideoModelReadinessSnapshotCache(
  options: VideoReadinessSnapshotCacheOptions,
): VideoModelReadinessSnapshotCache {
  return new VideoModelReadinessSnapshotCache(options);
}
