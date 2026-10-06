import "server-only";

import crypto from "node:crypto";

import {
  MEMBER_REGION_CACHE_TTL_MS,
  MEMBER_REGION_DIMENSIONS,
  MEMBER_REGION_MIN_COHORT_SIZE,
  MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
  buildMemberRegionDistribution,
  type MemberRegionBucket,
  type MemberRegionDimension,
  type MemberRegionDistributionResponse,
  type MemberRegionLoginEvidence,
  type MemberRegionObservationEvidence,
  type MemberRegionObservationSummary,
  type MemberRegionPopulationEvidence,
  type MemberRegionSourceState,
} from "@/lib/member-region-distribution-contract";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

interface DatabaseError {
  code?: string | null;
  message?: string | null;
}

interface DatabaseResult {
  data?: unknown;
  count?: number | null;
  error?: DatabaseError | null;
}

interface DatabaseQuery extends PromiseLike<DatabaseResult> {
  eq(column: string, value: unknown): DatabaseQuery;
  neq(column: string, value: unknown): DatabaseQuery;
  not(column: string, operator: string, value: unknown): DatabaseQuery;
  order(column: string, options?: { ascending?: boolean }): DatabaseQuery;
  limit(value: number): DatabaseQuery;
  abortSignal(signal: AbortSignal): DatabaseQuery;
}

interface DatabaseTable {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): DatabaseQuery;
}

interface DatabaseRpcQuery extends PromiseLike<DatabaseResult> {
  abortSignal(signal: AbortSignal): DatabaseRpcQuery;
}

export interface MemberRegionDatabase {
  from(table: string): DatabaseTable;
  rpc(name: string, parameters?: Record<string, unknown>): DatabaseRpcQuery;
}

interface MemberRegionCacheState {
  value: MemberRegionDistributionResponse | null;
  expiresAtMs: number;
  inFlight: Promise<MemberRegionDistributionResponse> | null;
}

interface MemberRegionAdmissionEntry {
  inFlight: boolean;
  lastAllowedAtMs: number | null;
  lastTouchedAtMs: number;
}

export type MemberRegionAdmissionResult<T> =
  | {
      allowed: true;
      value: T;
      admittedAtMs: number;
      nextAllowedAtMs: number;
    }
  | {
      allowed: false;
      reason: "single_flight" | "minimum_interval";
      retryAfterMs: number;
      nextAllowedAtMs: number;
    };

declare global {
  var __agentHubMemberRegionDistributionCacheV1: MemberRegionCacheState | undefined;
  var __agentHubMemberRegionAdmissionGateV1: MemberRegionAdmissionGate | undefined;
}

const QUERY_TIMEOUT_MS = 4_000;
const ADMISSION_ENTRY_TTL_MS = 10 * 60_000;
const MAX_ADMISSION_ENTRIES = 1_024;

function cacheState(): MemberRegionCacheState {
  if (!globalThis.__agentHubMemberRegionDistributionCacheV1) {
    globalThis.__agentHubMemberRegionDistributionCacheV1 = {
      value: null,
      expiresAtMs: 0,
      inFlight: null,
    };
  }
  return globalThis.__agentHubMemberRegionDistributionCacheV1;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function text(value: unknown, maxLength = 160): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, maxLength) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function confidence(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.min(1, Math.max(0, parsed)) * 10_000) / 10_000;
}

function errorCode(error: DatabaseError | null | undefined, fallback: string): string {
  const code = text(error?.code, 64);
  return code ? `${fallback}:${code}` : fallback;
}

function missingObservationSource(error: DatabaseError | null | undefined): boolean {
  const code = text(error?.code, 64)?.toUpperCase() ?? "";
  const message = text(error?.message, 300)?.toLowerCase() ?? "";
  return new Set(["42P01", "42883", "PGRST202", "PGRST205"]).has(code)
    || message.includes("read_admin_member_region_distribution")
    || message.includes("member_region_observations");
}

function latestTimestampFromRows(data: Record<string, unknown>[], field: string): string | null {
  for (const row of data) {
    const value = text(row[field], 64);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

async function readPopulation(database: MemberRegionDatabase): Promise<MemberRegionPopulationEvidence> {
  try {
    const result = await database
      .from("users")
      .select("created_at", { count: "exact" })
      .eq("role", "student")
      .order("created_at", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (result.error) {
      return {
        state: "unavailable",
        totalMembers: null,
        latestMemberAt: null,
        errorCode: errorCode(result.error, "USERS_READ_FAILED"),
      };
    }
    const memberRows = rows(result.data);
    const totalMembers = nonNegativeInteger(result.count);
    return {
      state: totalMembers == null ? "partial" : "available",
      totalMembers,
      latestMemberAt: latestTimestampFromRows(memberRows, "created_at"),
      errorCode: totalMembers == null ? "USERS_COUNT_UNAVAILABLE" : null,
    };
  } catch {
    return {
      state: "unavailable",
      totalMembers: null,
      latestMemberAt: null,
      errorCode: "USERS_READ_FAILED",
    };
  }
}

async function readLoginInput(database: MemberRegionDatabase): Promise<MemberRegionLoginEvidence> {
  try {
    const [allResult, addressResult] = await Promise.all([
      database
        .from("login_logs")
        .select("created_at", { count: "exact" })
        .eq("status", "success")
        .order("created_at", { ascending: false })
        .limit(1)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
      database
        .from("login_logs")
        .select("id", { count: "exact", head: true })
        .eq("status", "success")
        .not("ip_address", "is", null)
        .neq("ip_address", "")
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    ]);

    if (allResult.error) {
      return {
        state: "unavailable",
        successfulLoginEvents: null,
        eventsWithNetworkAddress: null,
        latestLoginAt: null,
        errorCode: errorCode(allResult.error, "LOGIN_LOGS_READ_FAILED"),
      };
    }

    const successfulLoginEvents = nonNegativeInteger(allResult.count);
    const eventsWithNetworkAddress = addressResult.error ? null : nonNegativeInteger(addressResult.count);
    const completeAddressCoverage = successfulLoginEvents != null
      && successfulLoginEvents > 0
      && eventsWithNetworkAddress === successfulLoginEvents;
    const state: MemberRegionSourceState = addressResult.error
      || successfulLoginEvents == null
      || !completeAddressCoverage
      ? "partial"
      : "available";

    return {
      state,
      successfulLoginEvents,
      eventsWithNetworkAddress,
      latestLoginAt: latestTimestampFromRows(rows(allResult.data), "created_at"),
      errorCode: addressResult.error
        ? errorCode(addressResult.error, "LOGIN_ADDRESS_COVERAGE_READ_FAILED")
        : successfulLoginEvents == null
          ? "LOGIN_LOGS_COUNT_UNAVAILABLE"
          : null,
    };
  } catch {
    return {
      state: "unavailable",
      successfulLoginEvents: null,
      eventsWithNetworkAddress: null,
      latestLoginAt: null,
      errorCode: "LOGIN_LOGS_READ_FAILED",
    };
  }
}

function isDimension(value: unknown): value is MemberRegionDimension {
  return typeof value === "string" && (MEMBER_REGION_DIMENSIONS as readonly string[]).includes(value);
}

function observationSummary(row: Record<string, unknown>): MemberRegionObservationSummary | null {
  if (row.row_kind !== "summary" || !isDimension(row.dimension)) return null;
  return {
    dimension: row.dimension,
    observedMemberCount: nonNegativeInteger(row.observed_member_count),
    observationCount: nonNegativeInteger(row.observation_count),
    suppressedBucketCount: nonNegativeInteger(row.suppressed_bucket_count) ?? 0,
    privacySuppressed: row.privacy_suppressed === true,
    latestCollectedAt: text(row.latest_collected_at, 64),
  };
}

function observationBucket(row: Record<string, unknown>): MemberRegionBucket | null {
  if (row.row_kind !== "region" || !isDimension(row.dimension)) return null;
  const memberCount = nonNegativeInteger(row.member_count);
  if (memberCount == null || memberCount < MEMBER_REGION_MIN_COHORT_SIZE) return null;
  const level = text(row.region_level, 20);
  if (level !== "country" && level !== "province" && level !== "city" && level !== "district") return null;
  return {
    dimension: row.dimension,
    regionLevel: level,
    countryCode: text(row.country_code, 16),
    provinceCode: text(row.province_code, 24),
    provinceName: text(row.province_name, 80),
    cityCode: text(row.city_code, 24),
    cityName: text(row.city_name, 80),
    districtCode: text(row.district_code, 24),
    districtName: text(row.district_name, 80),
    memberCount,
    averageConfidence: confidence(row.average_confidence),
    latestCollectedAt: text(row.latest_collected_at, 64),
  };
}

async function readObservations(database: MemberRegionDatabase): Promise<MemberRegionObservationEvidence> {
  try {
    const result = await database
      .rpc("read_admin_member_region_distribution", {
        p_min_cohort_size: MEMBER_REGION_MIN_COHORT_SIZE,
      })
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));

    if (result.error) {
      return {
        state: "unavailable",
        summaries: [],
        buckets: [],
        returnedRows: null,
        errorCode: missingObservationSource(result.error)
          ? "REGION_OBSERVATION_SOURCE_NOT_DEPLOYED"
          : errorCode(result.error, "REGION_OBSERVATION_READ_FAILED"),
      };
    }

    const resultRows = rows(result.data);
    const summaries = resultRows
      .map(observationSummary)
      .filter((entry): entry is MemberRegionObservationSummary => entry !== null);
    const buckets = resultRows
      .map(observationBucket)
      .filter((entry): entry is MemberRegionBucket => entry !== null);
    return {
      state: summaries.length > 0 ? "available" : "partial",
      summaries,
      buckets,
      returnedRows: resultRows.length,
      errorCode: summaries.length > 0 ? null : "NO_USABLE_REGION_OBSERVATIONS",
    };
  } catch {
    return {
      state: "unavailable",
      summaries: [],
      buckets: [],
      returnedRows: null,
      errorCode: "REGION_OBSERVATION_READ_FAILED",
    };
  }
}

function unavailablePopulation(code: string): MemberRegionPopulationEvidence {
  return { state: "unavailable", totalMembers: null, latestMemberAt: null, errorCode: code };
}

function unavailableLogin(code: string): MemberRegionLoginEvidence {
  return {
    state: "unavailable",
    successfulLoginEvents: null,
    eventsWithNetworkAddress: null,
    latestLoginAt: null,
    errorCode: code,
  };
}

function unavailableObservations(code: string): MemberRegionObservationEvidence {
  return { state: "unavailable", summaries: [], buckets: [], returnedRows: null, errorCode: code };
}

async function buildSnapshot(database: MemberRegionDatabase | null, now: string): Promise<MemberRegionDistributionResponse> {
  if (!database) {
    return buildMemberRegionDistribution({
      now,
      population: unavailablePopulation("DATABASE_CLIENT_UNAVAILABLE"),
      login: unavailableLogin("DATABASE_CLIENT_UNAVAILABLE"),
      observations: unavailableObservations("REGION_OBSERVATION_SOURCE_NOT_DEPLOYED"),
    });
  }

  const [population, login, observations] = await Promise.all([
    readPopulation(database),
    readLoginInput(database),
    readObservations(database),
  ]);
  return buildMemberRegionDistribution({ now, population, login, observations, cacheStatus: "miss" });
}

function cacheHit(value: MemberRegionDistributionResponse): MemberRegionDistributionResponse {
  return {
    ...value,
    refresh: {
      ...value.refresh,
      cacheStatus: "hit",
    },
  };
}

export async function readMemberRegionDistribution(options: {
  database?: MemberRegionDatabase;
  now?: string;
  bypassCache?: boolean;
} = {}): Promise<MemberRegionDistributionResponse> {
  const hasInjectedDatabase = Boolean(options.database);
  const shouldUseCache = !options.bypassCache && !hasInjectedDatabase && !options.now;
  const nowMs = Date.now();
  const cache = cacheState();
  if (shouldUseCache && cache.value && cache.expiresAtMs > nowMs) return cacheHit(cache.value);
  if (shouldUseCache && cache.inFlight) return cacheHit(await cache.inFlight);

  let database: MemberRegionDatabase | null = options.database ?? null;
  if (!database) {
    try {
      database = getSupabaseAdminClient() as unknown as MemberRegionDatabase;
    } catch {
      database = null;
    }
  }
  const now = options.now ?? new Date(nowMs).toISOString();
  const producer = buildSnapshot(database, now);
  if (!shouldUseCache) return producer;

  cache.inFlight = producer;
  try {
    const value = await producer;
    cache.value = value;
    const responseExpiryMs = Date.parse(value.refresh.nextRefreshAt);
    cache.expiresAtMs = Number.isFinite(responseExpiryMs)
      ? responseExpiryMs
      : Date.now() + MEMBER_REGION_CACHE_TTL_MS;
    return value;
  } finally {
    cache.inFlight = null;
  }
}

export function readCachedMemberRegionDistribution(): MemberRegionDistributionResponse | null {
  return cacheState().value;
}

export class MemberRegionAdmissionGate {
  private readonly entries = new Map<string, MemberRegionAdmissionEntry>();

  constructor(private readonly minimumIntervalMs = MEMBER_REGION_MIN_REQUEST_INTERVAL_MS) {}

  private sweep(nowMs: number): void {
    if (this.entries.size <= MAX_ADMISSION_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && nowMs - entry.lastTouchedAtMs > ADMISSION_ENTRY_TTL_MS) this.entries.delete(key);
    }
  }

  async run<T>(actorKey: string, producer: () => Promise<T>, nowMs = Date.now()): Promise<MemberRegionAdmissionResult<T>> {
    this.sweep(nowMs);
    const entry = this.entries.get(actorKey) ?? {
      inFlight: false,
      lastAllowedAtMs: null,
      lastTouchedAtMs: nowMs,
    };
    entry.lastTouchedAtMs = nowMs;
    this.entries.set(actorKey, entry);

    const elapsedMs = entry.lastAllowedAtMs == null ? Number.POSITIVE_INFINITY : nowMs - entry.lastAllowedAtMs;
    const intervalRemainingMs = Number.isFinite(elapsedMs)
      ? Math.max(0, this.minimumIntervalMs - elapsedMs)
      : 0;
    if (entry.inFlight) {
      const retryAfterMs = Math.max(1_000, intervalRemainingMs || this.minimumIntervalMs);
      return {
        allowed: false,
        reason: "single_flight",
        retryAfterMs,
        nextAllowedAtMs: nowMs + retryAfterMs,
      };
    }
    if (intervalRemainingMs > 0) {
      return {
        allowed: false,
        reason: "minimum_interval",
        retryAfterMs: intervalRemainingMs,
        nextAllowedAtMs: nowMs + intervalRemainingMs,
      };
    }

    entry.inFlight = true;
    entry.lastAllowedAtMs = nowMs;
    try {
      const value = await producer();
      return {
        allowed: true,
        value,
        admittedAtMs: nowMs,
        nextAllowedAtMs: nowMs + this.minimumIntervalMs,
      };
    } finally {
      entry.inFlight = false;
      entry.lastTouchedAtMs = Date.now();
    }
  }
}

function admissionGate(): MemberRegionAdmissionGate {
  if (!globalThis.__agentHubMemberRegionAdmissionGateV1) {
    globalThis.__agentHubMemberRegionAdmissionGateV1 = new MemberRegionAdmissionGate();
  }
  return globalThis.__agentHubMemberRegionAdmissionGateV1;
}

function actorKey(actorId: string): string {
  return crypto.createHash("sha256").update(actorId).digest("hex");
}

export async function readMemberRegionDistributionForAdmin(
  actorId: string,
  nowMs = Date.now(),
): Promise<MemberRegionAdmissionResult<MemberRegionDistributionResponse>> {
  return admissionGate().run(actorKey(actorId), async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshot = await readMemberRegionDistribution();
    return {
      ...snapshot,
      refresh: {
        ...snapshot.refresh,
        nextRefreshAt: new Date(nowMs + MEMBER_REGION_MIN_REQUEST_INTERVAL_MS).toISOString(),
        rateLimit: {
          scope: "process-local-admin",
          minimumIntervalMs: MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
          remainingMs: MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
          retryAfterSeconds: Math.ceil(MEMBER_REGION_MIN_REQUEST_INTERVAL_MS / 1_000),
        },
      },
    };
  }, nowMs);
}
