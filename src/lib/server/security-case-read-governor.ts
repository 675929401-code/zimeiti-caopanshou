import "server-only";

export const SECURITY_CASE_SERVER_READ_INTERVAL_MS = 10_000;
export const SECURITY_CASE_SERVER_CACHE_TTL_MS = 8_000;

export type SecurityCaseReadCacheStatus = "miss" | "hit" | "shared";

export interface SecurityCaseReadMetadata {
  asOf: string;
  freshnessSeconds: number;
  nextRefreshAt: string;
  cacheStatus: SecurityCaseReadCacheStatus;
  rateLimit: {
    scope: "per_admin_query";
    backend: "process_memory";
    limit: 1;
    windowSeconds: number;
    remaining: 0;
  };
}

interface CachedRead<T> {
  value: T;
  asOfMs: number;
  expiresAtMs: number;
}

interface BaseRead<T> {
  value: T;
  asOfMs: number;
}

const cache = new Map<string, CachedRead<unknown>>();
const inFlight = new Map<string, Promise<BaseRead<unknown>>>();
const lastAdmission = new Map<string, number>();
let cacheGeneration = 0;

const MAX_CACHE_ENTRIES = 250;
const MAX_ADMISSION_ENTRIES = 2_000;

export class SecurityCaseReadRateLimitError extends Error {
  readonly code = "SECURITY_CASE_READ_RATE_LIMITED";

  constructor(
    readonly retryAfterSeconds: number,
    readonly nextRefreshAt: string,
  ) {
    super("安全案件读取过于频繁，请按服务端时间重试");
    this.name = "SecurityCaseReadRateLimitError";
  }
}

function trimOldest<T>(map: Map<string, T>, maximum: number): void {
  while (map.size > maximum) {
    const first = map.keys().next().value;
    if (typeof first !== "string") return;
    map.delete(first);
  }
}

function metadata(asOfMs: number, admittedAtMs: number, status: SecurityCaseReadCacheStatus, nowMs: number): SecurityCaseReadMetadata {
  return {
    asOf: new Date(asOfMs).toISOString(),
    freshnessSeconds: Math.max(0, Math.round((nowMs - asOfMs) / 100) / 10),
    nextRefreshAt: new Date(admittedAtMs + SECURITY_CASE_SERVER_READ_INTERVAL_MS).toISOString(),
    cacheStatus: status,
    rateLimit: {
      scope: "per_admin_query",
      backend: "process_memory",
      limit: 1,
      windowSeconds: SECURITY_CASE_SERVER_READ_INTERVAL_MS / 1_000,
      remaining: 0,
    },
  };
}

export async function governedSecurityCaseRead<T>(params: {
  actorId: string;
  queryKey: string;
  loader: () => Promise<T>;
  nowMs?: number;
}): Promise<{ value: T; metadata: SecurityCaseReadMetadata }> {
  const nowMs = params.nowMs ?? Date.now();
  const actorKey = `${params.actorId}:${params.queryKey}`;
  const activeRead = inFlight.get(params.queryKey) as Promise<BaseRead<T>> | undefined;
  if (activeRead) {
    const base = await activeRead;
    const admittedAtMs = lastAdmission.get(actorKey) ?? nowMs;
    if (!lastAdmission.has(actorKey)) {
      lastAdmission.set(actorKey, nowMs);
      trimOldest(lastAdmission, MAX_ADMISSION_ENTRIES);
    }
    return { value: base.value, metadata: metadata(base.asOfMs, admittedAtMs, "shared", Date.now()) };
  }

  const previousAdmission = lastAdmission.get(actorKey);
  if (typeof previousAdmission === "number" && nowMs - previousAdmission < SECURITY_CASE_SERVER_READ_INTERVAL_MS) {
    const nextAtMs = previousAdmission + SECURITY_CASE_SERVER_READ_INTERVAL_MS;
    throw new SecurityCaseReadRateLimitError(
      Math.max(1, Math.ceil((nextAtMs - nowMs) / 1_000)),
      new Date(nextAtMs).toISOString(),
    );
  }
  lastAdmission.delete(actorKey);
  lastAdmission.set(actorKey, nowMs);
  trimOldest(lastAdmission, MAX_ADMISSION_ENTRIES);

  const cached = cache.get(params.queryKey) as CachedRead<T> | undefined;
  if (cached && cached.expiresAtMs > nowMs) {
    cache.delete(params.queryKey);
    cache.set(params.queryKey, cached as CachedRead<unknown>);
    return { value: cached.value, metadata: metadata(cached.asOfMs, nowMs, "hit", nowMs) };
  }
  if (cached) cache.delete(params.queryKey);

  const generationAtStart = cacheGeneration;
  const work = (async (): Promise<BaseRead<T>> => {
    const value = await params.loader();
    const asOfMs = Date.now();
    if (generationAtStart === cacheGeneration) {
      cache.set(params.queryKey, {
        value,
        asOfMs,
        expiresAtMs: asOfMs + SECURITY_CASE_SERVER_CACHE_TTL_MS,
      });
      trimOldest(cache, MAX_CACHE_ENTRIES);
    }
    return { value, asOfMs };
  })();
  inFlight.set(params.queryKey, work as Promise<BaseRead<unknown>>);
  try {
    const base = await work;
    return { value: base.value, metadata: metadata(base.asOfMs, nowMs, "miss", Date.now()) };
  } finally {
    if (inFlight.get(params.queryKey) === work) inFlight.delete(params.queryKey);
  }
}

export function securityCaseRateLimitHeaders(metadata: SecurityCaseReadMetadata): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(metadata.rateLimit.limit),
    "X-RateLimit-Remaining": String(metadata.rateLimit.remaining),
    "X-RateLimit-Reset": String(Math.ceil(Date.parse(metadata.nextRefreshAt) / 1_000)),
  };
}

export function securityCaseRateLimitErrorHeaders(error: SecurityCaseReadRateLimitError): Record<string, string> {
  return {
    "Retry-After": String(error.retryAfterSeconds),
    "X-RateLimit-Limit": "1",
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(Math.ceil(Date.parse(error.nextRefreshAt) / 1_000)),
  };
}

export function invalidateSecurityCaseReadCache(actorId: string): void {
  cacheGeneration += 1;
  for (const key of cache.keys()) {
    if (key.startsWith("security-case-")) cache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith("security-case-")) inFlight.delete(key);
  }
  const actorPrefix = `${actorId}:security-case-`;
  for (const key of lastAdmission.keys()) {
    if (key.startsWith(actorPrefix)) lastAdmission.delete(key);
  }
}
