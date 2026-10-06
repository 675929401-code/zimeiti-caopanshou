export const MEMBER_REGION_DISTRIBUTION_SCHEMA_VERSION = 1 as const;
export const MEMBER_REGION_MIN_COHORT_SIZE = 5;
export const MEMBER_REGION_CACHE_TTL_MS = 60_000;
export const MEMBER_REGION_MIN_REQUEST_INTERVAL_MS = 60_000;

export const MEMBER_REGION_DIMENSIONS = [
  "profile_residence",
  "recent_access_region",
  "business_service_city",
] as const;

export type MemberRegionDimension = (typeof MEMBER_REGION_DIMENSIONS)[number];
export type MemberRegionSourceState = "available" | "partial" | "stale" | "unavailable";
export type MemberRegionFreshnessState = "fresh" | "stale" | "unavailable";
export type MemberRegionLevel = "country" | "province" | "city" | "district";

export interface MemberRegionSourceStatus {
  id: string;
  label: string;
  source: string;
  state: MemberRegionSourceState;
  asOf: string;
  latestRecordAt: string | null;
  freshnessSeconds: number | null;
  coverageRatio: number | null;
  returnedRows: number | null;
  totalRows: number | null;
  errorCode: string | null;
  detail: string;
}

export interface MemberRegionPopulation {
  totalMembers: number | null;
  countSuppressed: boolean;
  sourceStateId: "users";
}

export interface MemberRegionAccessInputReadiness {
  successfulLoginEvents: number | null;
  eventsWithNetworkAddress: number | null;
  networkAddressCoverageRatio: number | null;
  latestLoginAt: string | null;
  sourceStateId: "login_logs";
  disclaimer: string;
}

export interface MemberRegionDimensionSnapshot {
  id: MemberRegionDimension;
  label: string;
  definition: string;
  notEquivalentTo: string;
  state: MemberRegionSourceState;
  reasonCode: string | null;
  eligibleMembers: number | null;
  observedMembers: number | null;
  unknownMembers: number | null;
  coverageRatio: number | null;
  publishedBucketCount: number | null;
  suppressedBucketCount: number | null;
  privacySuppressed: boolean;
  latestCollectedAt: string | null;
  freshnessSeconds: number | null;
  sourceStateIds: string[];
}

export interface MemberRegionBucket {
  dimension: MemberRegionDimension;
  regionLevel: MemberRegionLevel;
  countryCode: string | null;
  provinceCode: string | null;
  provinceName: string | null;
  cityCode: string | null;
  cityName: string | null;
  districtCode: string | null;
  districtName: string | null;
  memberCount: number;
  averageConfidence: number | null;
  latestCollectedAt: string | null;
}

export interface MemberRegionDistributionResponse {
  ok: true;
  schemaVersion: typeof MEMBER_REGION_DISTRIBUTION_SCHEMA_VERSION;
  generatedAt: string;
  asOf: string;
  readOnly: true;
  freshness: {
    state: MemberRegionFreshnessState;
    ageSeconds: number | null;
    label: string;
  };
  refresh: {
    cacheStatus: "hit" | "miss";
    cacheTtlMs: number;
    nextRefreshAt: string;
    rateLimit: {
      scope: "process-local-admin";
      minimumIntervalMs: number;
      remainingMs: number;
      retryAfterSeconds: number;
    };
    providerCalls: 0;
    businessWrites: 0;
  };
  population: MemberRegionPopulation;
  accessInputReadiness: MemberRegionAccessInputReadiness;
  dimensions: MemberRegionDimensionSnapshot[];
  regionBuckets: MemberRegionBucket[];
  sourceStates: MemberRegionSourceStatus[];
  privacy: {
    minimumCohortSize: typeof MEMBER_REGION_MIN_COHORT_SIZE;
    smallCohortsSuppressed: true;
    rawIpIncluded: false;
    directIdentifiersIncluded: false;
    preciseAddressIncluded: false;
  };
  limitations: string[];
}

export interface MemberRegionRateLimitedResponse {
  ok: false;
  code: "MEMBER_REGION_DISTRIBUTION_RATE_LIMITED";
  error: string;
  asOf: string | null;
  freshness: MemberRegionDistributionResponse["freshness"] | null;
  nextRefreshAt: string;
  cacheStatus: "rate_limited";
  rateLimit: MemberRegionDistributionResponse["refresh"]["rateLimit"];
}

export interface MemberRegionPopulationEvidence {
  state: MemberRegionSourceState;
  totalMembers: number | null;
  latestMemberAt: string | null;
  errorCode: string | null;
}

export interface MemberRegionLoginEvidence {
  state: MemberRegionSourceState;
  successfulLoginEvents: number | null;
  eventsWithNetworkAddress: number | null;
  latestLoginAt: string | null;
  errorCode: string | null;
}

export interface MemberRegionObservationSummary {
  dimension: MemberRegionDimension;
  observedMemberCount: number | null;
  observationCount: number | null;
  suppressedBucketCount: number;
  privacySuppressed: boolean;
  latestCollectedAt: string | null;
}

export interface MemberRegionObservationEvidence {
  state: MemberRegionSourceState;
  summaries: MemberRegionObservationSummary[];
  buckets: MemberRegionBucket[];
  returnedRows: number | null;
  errorCode: string | null;
}

export interface MemberRegionBuildInput {
  now: string;
  population: MemberRegionPopulationEvidence;
  login: MemberRegionLoginEvidence;
  observations: MemberRegionObservationEvidence;
  cacheStatus?: "hit" | "miss";
}

interface DimensionDefinition {
  label: string;
  definition: string;
  notEquivalentTo: string;
  staleAfterSeconds: number;
  sourceId: string;
}

const DIMENSION_DEFINITIONS: Record<MemberRegionDimension, DimensionDefinition> = {
  profile_residence: {
    label: "会员自报常住地",
    definition: "会员主动提交或管理员核验的常住省、市、区县；必须保留来源、用途、法律依据与采集时间。",
    notEquivalentTo: "近期登录地点、IP 出口位置或业务服务范围",
    staleAfterSeconds: 365 * 24 * 60 * 60,
    sourceId: "profile_residence_observations",
  },
  recent_access_region: {
    label: "近期访问地域",
    definition: "由成功访问事件经可信离线地理库形成的近似省市结果，只能用于安全与聚合分析。",
    notEquivalentTo: "会员常住地、本人实际所在地或攻击者归属地",
    staleAfterSeconds: 7 * 24 * 60 * 60,
    sourceId: "recent_access_region_observations",
  },
  business_service_city: {
    label: "业务服务城市",
    definition: "会员经营或提供服务的城市范围，来自会员自报、管理员核验或版本化业务资料。",
    notEquivalentTo: "会员常住地或近期访问地域",
    staleAfterSeconds: 365 * 24 * 60 * 60,
    sourceId: "business_service_city_observations",
  },
};

function finiteNonNegative(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function clampRatio(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return clampRatio(numerator / denominator);
}

function freshnessSeconds(value: string | null, now: string): number | null {
  if (!value) return null;
  const valueMs = Date.parse(value);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(valueMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - valueMs) / 1_000));
}

function privacyVisibleCount(value: number | null): { value: number | null; suppressed: boolean } {
  const count = finiteNonNegative(value);
  if (count == null) return { value: null, suppressed: false };
  if (count > 0 && count < MEMBER_REGION_MIN_COHORT_SIZE) {
    return { value: null, suppressed: true };
  }
  return { value: count, suppressed: false };
}

function normalizeStateByFreshness(
  state: MemberRegionSourceState,
  latestRecordAt: string | null,
  now: string,
  staleAfterSeconds: number,
): MemberRegionSourceState {
  if (state === "unavailable") return state;
  const age = freshnessSeconds(latestRecordAt, now);
  if (age != null && age > staleAfterSeconds) return "stale";
  return state;
}

function dimensionSnapshot(
  dimension: MemberRegionDimension,
  input: MemberRegionBuildInput,
  visiblePopulation: number | null,
  populationSuppressed: boolean,
): MemberRegionDimensionSnapshot {
  const definition = DIMENSION_DEFINITIONS[dimension];
  const summary = input.observations.summaries.find((candidate) => candidate.dimension === dimension);
  const rawObserved = finiteNonNegative(summary?.observedMemberCount ?? null);
  const latestCollectedAt = summary?.latestCollectedAt ?? null;
  const sourceAvailable = input.observations.state !== "unavailable";
  const observedPrivacy = privacyVisibleCount(rawObserved);
  const suppressCoverage = populationSuppressed || Boolean(summary?.privacySuppressed) || observedPrivacy.suppressed;

  let state: MemberRegionSourceState = input.observations.state;
  let reasonCode = input.observations.errorCode;
  if (sourceAvailable && (!summary || rawObserved === 0)) {
    state = "partial";
    reasonCode = "NO_USABLE_REGION_OBSERVATIONS";
  } else if (sourceAvailable && suppressCoverage) {
    state = "partial";
    reasonCode = "SMALL_COHORT_SUPPRESSED";
  } else if (sourceAvailable && rawObserved != null && input.population.totalMembers != null && rawObserved < input.population.totalMembers) {
    state = "partial";
    reasonCode = "SOURCE_COVERAGE_INCOMPLETE";
  }
  state = normalizeStateByFreshness(state, latestCollectedAt, input.now, definition.staleAfterSeconds);
  if (state === "stale") reasonCode = "REGION_OBSERVATIONS_STALE";

  const observedMembers = sourceAvailable && rawObserved != null && rawObserved > 0 && !suppressCoverage
    ? observedPrivacy.value
    : null;
  const coverageRatio = observedMembers != null && visiblePopulation != null
    ? ratio(observedMembers, visiblePopulation)
    : null;
  const unknownMembers = sourceAvailable && visiblePopulation != null
    ? rawObserved == null || rawObserved === 0
      ? visiblePopulation
      : suppressCoverage
        ? null
        : Math.max(0, visiblePopulation - rawObserved)
    : null;
  const bucketCount = input.observations.buckets.filter((bucket) => bucket.dimension === dimension).length;

  return {
    id: dimension,
    label: definition.label,
    definition: definition.definition,
    notEquivalentTo: definition.notEquivalentTo,
    state,
    reasonCode,
    eligibleMembers: visiblePopulation,
    observedMembers,
    unknownMembers,
    coverageRatio,
    publishedBucketCount: sourceAvailable && rawObserved != null && rawObserved > 0 ? bucketCount : null,
    suppressedBucketCount: summary ? finiteNonNegative(summary.suppressedBucketCount) : null,
    privacySuppressed: suppressCoverage,
    latestCollectedAt,
    freshnessSeconds: freshnessSeconds(latestCollectedAt, input.now),
    sourceStateIds: dimension === "recent_access_region"
      ? [definition.sourceId, "login_logs", "geoip_resolver"]
      : [definition.sourceId],
  };
}

function observationSourceStatus(
  dimension: MemberRegionDimension,
  snapshot: MemberRegionDimensionSnapshot,
  evidence: MemberRegionObservationEvidence,
  now: string,
): MemberRegionSourceStatus {
  const definition = DIMENSION_DEFINITIONS[dimension];
  return {
    id: definition.sourceId,
    label: definition.label,
    source: `member_region_observations[${dimension}]`,
    state: snapshot.state,
    asOf: now,
    latestRecordAt: snapshot.latestCollectedAt,
    freshnessSeconds: snapshot.freshnessSeconds,
    coverageRatio: snapshot.coverageRatio,
    returnedRows: evidence.state === "unavailable" ? null : evidence.returnedRows,
    totalRows: snapshot.observedMembers,
    errorCode: snapshot.reasonCode,
    detail: snapshot.state === "unavailable"
      ? "持久化地域观测与只读聚合函数尚未部署；本次不以 0 代替缺失。"
      : snapshot.privacySuppressed
        ? `地域样本少于 ${MEMBER_REGION_MIN_COHORT_SIZE} 人，精确人数与覆盖率已隐藏。`
        : "仅统计具备来源、用途、法律依据、行政区代码、置信度与采集时间的当前观测。",
  };
}

function latestTimestamp(values: Array<string | null>): string | null {
  const valid = values
    .map((value) => value ? { value, time: Date.parse(value) } : null)
    .filter((entry): entry is { value: string; time: number } => Boolean(entry && Number.isFinite(entry.time)));
  if (valid.length === 0) return null;
  valid.sort((left, right) => right.time - left.time);
  return valid[0].value;
}

export function buildMemberRegionDistribution(input: MemberRegionBuildInput): MemberRegionDistributionResponse {
  const rawPopulation = finiteNonNegative(input.population.totalMembers);
  const populationPrivacy = privacyVisibleCount(rawPopulation);
  const dimensions = MEMBER_REGION_DIMENSIONS.map((dimension) => dimensionSnapshot(
    dimension,
    input,
    populationPrivacy.value,
    populationPrivacy.suppressed,
  ));

  const loginEvents = finiteNonNegative(input.login.successfulLoginEvents);
  const loginEventsWithNetworkAddress = finiteNonNegative(input.login.eventsWithNetworkAddress);
  const loginCoverage = ratio(loginEventsWithNetworkAddress, loginEvents);
  const populationFreshness = freshnessSeconds(input.population.latestMemberAt, input.now);
  const loginFreshness = freshnessSeconds(input.login.latestLoginAt, input.now);
  const latestRegionAt = latestTimestamp(dimensions.map((dimension) => dimension.latestCollectedAt));
  const regionAge = freshnessSeconds(latestRegionAt, input.now);
  const anyRegionAvailable = dimensions.some((dimension) => dimension.state !== "unavailable");
  const anyRegionStale = dimensions.some((dimension) => dimension.state === "stale");
  const freshnessState: MemberRegionFreshnessState = !anyRegionAvailable
    ? "unavailable"
    : anyRegionStale
      ? "stale"
      : "fresh";

  const userSource: MemberRegionSourceStatus = {
    id: "users",
    label: "平台注册会员",
    source: "users(role=student)",
    state: input.population.state,
    asOf: input.now,
    latestRecordAt: input.population.latestMemberAt,
    freshnessSeconds: populationFreshness,
    coverageRatio: populationPrivacy.suppressed || rawPopulation == null ? null : 1,
    returnedRows: populationPrivacy.suppressed ? null : rawPopulation,
    totalRows: populationPrivacy.value,
    errorCode: input.population.errorCode,
    detail: populationPrivacy.suppressed
      ? `会员总量低于 ${MEMBER_REGION_MIN_COHORT_SIZE}，在地域聚合面板隐藏精确人数。`
      : "仅以 role=student 的平台注册账号作为会员分母。",
  };

  const loginSource: MemberRegionSourceStatus = {
    id: "login_logs",
    label: "成功登录网络输入",
    source: "login_logs(status=success)",
    state: input.login.state,
    asOf: input.now,
    latestRecordAt: input.login.latestLoginAt,
    freshnessSeconds: loginFreshness,
    coverageRatio: loginCoverage,
    returnedRows: loginEvents,
    totalRows: loginEvents,
    errorCode: input.login.errorCode,
    detail: "只统计是否存在网络地址，不返回地址值；登录网络输入包含管理员等账号，未经过会员地域观测聚合前不进入地图。",
  };

  const geoIpSource: MemberRegionSourceStatus = {
    id: "geoip_resolver",
    label: "可信 GeoIP 解析器",
    source: "trusted_offline_geoip",
    state: "unavailable",
    asOf: input.now,
    latestRecordAt: null,
    freshnessSeconds: null,
    coverageRatio: null,
    returnedRows: null,
    totalRows: null,
    errorCode: "GEOIP_RESOLVER_NOT_CONFIGURED",
    detail: "当前没有可信离线 GeoIP 库及版本化解析快照；不会调用第三方猜测接口，也不会把 IP 出口位置当成住址。",
  };

  const sourceStates = [
    userSource,
    loginSource,
    ...dimensions.map((dimension) => observationSourceStatus(dimension.id, dimension, input.observations, input.now)),
    geoIpSource,
  ];

  const nextRefreshAt = new Date(Date.parse(input.now) + MEMBER_REGION_CACHE_TTL_MS).toISOString();

  return {
    ok: true,
    schemaVersion: MEMBER_REGION_DISTRIBUTION_SCHEMA_VERSION,
    generatedAt: input.now,
    asOf: input.now,
    readOnly: true,
    freshness: {
      state: freshnessState,
      ageSeconds: regionAge,
      label: freshnessState === "unavailable"
        ? "地域事实源未接入"
        : freshnessState === "stale"
          ? "地域观测已过期"
          : "地域观测在有效期内",
    },
    refresh: {
      cacheStatus: input.cacheStatus ?? "miss",
      cacheTtlMs: MEMBER_REGION_CACHE_TTL_MS,
      nextRefreshAt,
      rateLimit: {
        scope: "process-local-admin",
        minimumIntervalMs: MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
        remainingMs: MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
        retryAfterSeconds: Math.ceil(MEMBER_REGION_MIN_REQUEST_INTERVAL_MS / 1_000),
      },
      providerCalls: 0,
      businessWrites: 0,
    },
    population: {
      totalMembers: populationPrivacy.value,
      countSuppressed: populationPrivacy.suppressed,
      sourceStateId: "users",
    },
    accessInputReadiness: {
      successfulLoginEvents: loginEvents,
      eventsWithNetworkAddress: loginEventsWithNetworkAddress,
      networkAddressCoverageRatio: loginCoverage,
      latestLoginAt: input.login.latestLoginAt,
      sourceStateId: "login_logs",
      disclaimer: "登录 IP 只能作为近期访问地域的近似解析输入，不能证明会员常住地、本人实时位置或攻击者身份。",
    },
    dimensions,
    regionBuckets: input.observations.buckets.filter((bucket) => (
      Number.isFinite(bucket.memberCount) && bucket.memberCount >= MEMBER_REGION_MIN_COHORT_SIZE
    )),
    sourceStates,
    privacy: {
      minimumCohortSize: MEMBER_REGION_MIN_COHORT_SIZE,
      smallCohortsSuppressed: true,
      rawIpIncluded: false,
      directIdentifiersIncluded: false,
      preciseAddressIncluded: false,
    },
    limitations: [
      "会员常住地、近期访问地域和业务服务城市是三种独立事实，不互相推断。",
      "没有可信地域观测时不绘制省市地图，不把缺失值显示为 0。",
      "VPN、代理、共享出口、移动网络与反向代理会降低 IP 地域精度。",
      `任何地域分组少于 ${MEMBER_REGION_MIN_COHORT_SIZE} 名会员时不返回精确人数。`,
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMemberRegionDistributionResponse(value: unknown): value is MemberRegionDistributionResponse {
  if (!isRecord(value) || value.ok !== true || value.schemaVersion !== MEMBER_REGION_DISTRIBUTION_SCHEMA_VERSION) return false;
  if (value.readOnly !== true || typeof value.generatedAt !== "string" || typeof value.asOf !== "string") return false;
  if (!Array.isArray(value.dimensions) || value.dimensions.length !== MEMBER_REGION_DIMENSIONS.length) return false;
  if (!Array.isArray(value.regionBuckets) || !Array.isArray(value.sourceStates) || !Array.isArray(value.limitations)) return false;
  if (!isRecord(value.privacy) || value.privacy.minimumCohortSize !== MEMBER_REGION_MIN_COHORT_SIZE) return false;
  if (value.privacy.rawIpIncluded !== false || value.privacy.directIdentifiersIncluded !== false) return false;
  return value.regionBuckets.every((bucket) => (
    isRecord(bucket)
    && typeof bucket.memberCount === "number"
    && bucket.memberCount >= MEMBER_REGION_MIN_COHORT_SIZE
  ));
}
