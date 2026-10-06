import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  MEMBER_REGION_MIN_COHORT_SIZE,
  MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
  buildMemberRegionDistribution,
  isMemberRegionDistributionResponse,
  type MemberRegionBuildInput,
} from "@/lib/member-region-distribution-contract";
import { MemberRegionAdmissionGate } from "@/lib/server/member-region-distribution";

const root = process.cwd();
const NOW = "2026-10-03T00:00:00.000Z";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

function baseInput(): MemberRegionBuildInput {
  return {
    now: NOW,
    population: {
      state: "available",
      totalMembers: 4,
      latestMemberAt: "2026-10-02T23:00:00.000Z",
      errorCode: null,
    },
    login: {
      state: "available",
      successfulLoginEvents: 10,
      eventsWithNetworkAddress: 7,
      latestLoginAt: "2026-10-02T23:30:00.000Z",
      errorCode: null,
    },
    observations: {
      state: "unavailable",
      summaries: [],
      buckets: [],
      returnedRows: null,
      errorCode: "REGION_OBSERVATION_SOURCE_NOT_DEPLOYED",
    },
  };
}

async function verifyAdmissionGate(): Promise<void> {
  const gate = new MemberRegionAdmissionGate(MEMBER_REGION_MIN_REQUEST_INTERVAL_MS);
  let finishFirst: ((value: string) => void) | undefined;
  const first = gate.run(
    "fixture-admin",
    () => new Promise<string>((resolve) => { finishFirst = resolve; }),
    100_000,
  );
  await Promise.resolve();

  const concurrent = await gate.run("fixture-admin", async () => "unexpected", 100_000);
  assert.equal(concurrent.allowed, false, "MEMBER_REGION_SINGLE_FLIGHT_MUST_REJECT_CONCURRENT_READ");
  if (!concurrent.allowed) assert.equal(concurrent.reason, "single_flight");

  assert(finishFirst, "MEMBER_REGION_FIXTURE_RELEASE_MISSING");
  finishFirst("first");
  assert.equal((await first).allowed, true, "MEMBER_REGION_FIRST_READ_MUST_PASS");

  const early = await gate.run("fixture-admin", async () => "unexpected", 159_999);
  assert.equal(early.allowed, false, "MEMBER_REGION_MINIMUM_INTERVAL_MUST_REJECT_EARLY_READ");
  if (!early.allowed) {
    assert.equal(early.reason, "minimum_interval");
    assert.equal(early.retryAfterMs, 1);
  }

  const released = await gate.run("fixture-admin", async () => "released", 160_000);
  assert.equal(released.allowed, true, "MEMBER_REGION_READ_MUST_RELEASE_AT_SIXTY_SECONDS");
}

async function main(): Promise<void> {
  const unavailable = buildMemberRegionDistribution(baseInput());
  assert(isMemberRegionDistributionResponse(unavailable), "MEMBER_REGION_RESPONSE_CONTRACT_INVALID");
  assert.equal(unavailable.population.totalMembers, null, "MEMBER_REGION_SMALL_POPULATION_MUST_BE_SUPPRESSED");
  assert.equal(unavailable.population.countSuppressed, true, "MEMBER_REGION_SMALL_POPULATION_DISCLOSURE_MISSING");
  assert.equal(unavailable.regionBuckets.length, 0, "MEMBER_REGION_UNAVAILABLE_SOURCE_MUST_NOT_DRAW_MAP");
  assert.equal(unavailable.freshness.state, "unavailable", "MEMBER_REGION_MISSING_FACT_SOURCE_MUST_BE_UNAVAILABLE");
  assert.equal(unavailable.privacy.minimumCohortSize, 5);
  assert.equal(unavailable.privacy.rawIpIncluded, false);
  assert.equal(unavailable.accessInputReadiness.successfulLoginEvents, 10);
  assert.equal(unavailable.accessInputReadiness.eventsWithNetworkAddress, 7);
  assert.equal(unavailable.accessInputReadiness.networkAddressCoverageRatio, 0.7);
  for (const dimension of unavailable.dimensions) {
    assert.equal(dimension.state, "unavailable");
    assert.equal(dimension.observedMembers, null, "MEMBER_REGION_UNKNOWN_MUST_NOT_FALL_BACK_TO_ZERO");
    assert.equal(dimension.coverageRatio, null, "MEMBER_REGION_MISSING_COVERAGE_MUST_NOT_FALL_BACK_TO_ZERO");
    assert.equal(dimension.publishedBucketCount, null, "MEMBER_REGION_MISSING_BUCKETS_MUST_NOT_FALL_BACK_TO_ZERO");
  }
  const serializedUnavailable = JSON.stringify(unavailable);
  assert.doesNotMatch(serializedUnavailable, /"(?:ip_address|ipAddress|rawIp)"/u, "MEMBER_REGION_RESPONSE_MUST_NOT_EXPOSE_IP_FIELDS");

  const smallCohortInput = baseInput();
  smallCohortInput.population.totalMembers = 20;
  smallCohortInput.observations = {
    state: "available",
    summaries: [{
      dimension: "profile_residence",
      observedMemberCount: 4,
      observationCount: 4,
      suppressedBucketCount: 1,
      privacySuppressed: true,
      latestCollectedAt: "2026-10-02T22:00:00.000Z",
    }],
    buckets: [{
      dimension: "profile_residence",
      regionLevel: "city",
      countryCode: "CN",
      provinceCode: "320000",
      provinceName: "江苏省",
      cityCode: "320200",
      cityName: "无锡市",
      districtCode: null,
      districtName: null,
      memberCount: 4,
      averageConfidence: 1,
      latestCollectedAt: "2026-10-02T22:00:00.000Z",
    }],
    returnedRows: 2,
    errorCode: null,
  };
  const smallCohort = buildMemberRegionDistribution(smallCohortInput);
  const smallResidence = smallCohort.dimensions.find((dimension) => dimension.id === "profile_residence");
  assert.equal(smallResidence?.privacySuppressed, true);
  assert.equal(smallResidence?.observedMembers, null);
  assert.equal(smallResidence?.coverageRatio, null);
  assert.equal(smallCohort.regionBuckets.length, 0, "MEMBER_REGION_BUCKET_BELOW_K_MUST_BE_REMOVED_AGAIN_IN_APP");

  const publishableInput = baseInput();
  publishableInput.population.totalMembers = 20;
  publishableInput.observations = {
    state: "available",
    summaries: [{
      dimension: "business_service_city",
      observedMemberCount: 5,
      observationCount: 5,
      suppressedBucketCount: 0,
      privacySuppressed: false,
      latestCollectedAt: "2026-10-02T22:00:00.000Z",
    }],
    buckets: [{
      dimension: "business_service_city",
      regionLevel: "city",
      countryCode: "CN",
      provinceCode: "320000",
      provinceName: "江苏省",
      cityCode: "320200",
      cityName: "无锡市",
      districtCode: null,
      districtName: null,
      memberCount: MEMBER_REGION_MIN_COHORT_SIZE,
      averageConfidence: 0.9,
      latestCollectedAt: "2026-10-02T22:00:00.000Z",
    }],
    returnedRows: 2,
    errorCode: null,
  };
  const publishable = buildMemberRegionDistribution(publishableInput);
  assert.equal(publishable.regionBuckets.length, 1);
  assert.equal(publishable.regionBuckets[0].memberCount, 5);
  const serviceCity = publishable.dimensions.find((dimension) => dimension.id === "business_service_city");
  assert.equal(serviceCity?.coverageRatio, 0.25);
  assert.match(serviceCity?.notEquivalentTo ?? "", /常住地/u);
  const accessRegion = publishable.dimensions.find((dimension) => dimension.id === "recent_access_region");
  assert.match(accessRegion?.notEquivalentTo ?? "", /常住地/u);
  assert.match(unavailable.accessInputReadiness.disclaimer, /不能证明会员常住地/u);

  await verifyAdmissionGate();

  const [serverSource, routeSource, panelSource, panelStyles, designSql] = await Promise.all([
    source("src/lib/server/member-region-distribution.ts"),
    source("src/app/api/admin/users/regions/route.ts"),
    source("src/components/admin/member-region-readiness-panel.tsx"),
    source("src/components/admin/member-region-readiness-panel.module.css"),
    source("supabase/design-only/20261003_member_region_observations.sql"),
  ]);

  for (const required of [
    '.select("created_at", { count: "exact" })',
    '.eq("role", "student")',
    '.eq("status", "success")',
    '.not("ip_address", "is", null)',
    ".limit(1)",
    "AbortSignal.timeout(QUERY_TIMEOUT_MS)",
    "read_admin_member_region_distribution",
    "REGION_OBSERVATION_SOURCE_NOT_DEPLOYED",
    "__agentHubMemberRegionDistributionCacheV1",
    "MemberRegionAdmissionGate",
  ]) {
    assert(serverSource.includes(required), `MEMBER_REGION_READ_MODEL_BOUNDARY_MISSING:${required}`);
  }
  assert.doesNotMatch(
    serverSource,
    /select\([^\n]*ip_address/iu,
    "MEMBER_REGION_READ_MODEL_MUST_COUNT_NETWORK_INPUT_WITHOUT_SELECTING_IP_VALUES",
  );
  assert.doesNotMatch(serverSource, /fetch\(|https?:\/\//iu, "MEMBER_REGION_MUST_NOT_CALL_EXTERNAL_GEO_PROVIDER");

  for (const required of [
    'authorizeAdminCapability(request, "members.view"',
    "private, no-store",
    "status: 429",
    "Retry-After",
    "MEMBER_REGION_MIN_REQUEST_INTERVAL_MS",
  ]) {
    assert(routeSource.includes(required), `MEMBER_REGION_API_GUARD_MISSING:${required}`);
  }

  for (const required of [
    'variant?: "admin" | "command_center"',
    'variant === "command_center"',
    "document.visibilityState",
    "navigator.onLine",
    "visibilitychange",
    "当前不绘制地图",
    "不能证明会员常住地",
  ]) {
    assert(panelSource.includes(required), `MEMBER_REGION_PANEL_BOUNDARY_MISSING:${required}`);
  }
  const fontSizes = [...panelStyles.matchAll(/font-size:\s*(\d+)px/gu)].map((match) => Number(match[1]));
  assert(fontSizes.length > 0, "MEMBER_REGION_PANEL_FONT_SIZES_MISSING");
  assert(fontSizes.every((size) => size >= 12), "MEMBER_REGION_PANEL_TEXT_BELOW_TWELVE_PIXELS");
  for (const required of [
    ".commandCenter",
    "--foreground: #17201d",
    "--card: #fffefa",
    "--primary: #0b7466",
    "color-scheme: light",
    "prefers-reduced-motion",
  ]) {
    assert(panelStyles.includes(required), `MEMBER_REGION_COMMAND_CENTER_STYLE_MISSING:${required}`);
  }

  for (const required of [
    "DESIGN ONLY",
    "DO NOT APPLY",
    "member_region_observations",
    "source_type",
    "purpose_code",
    "legal_basis",
    "consent_status",
    "province_code",
    "city_code",
    "district_code",
    "confidence",
    "collected_at",
    "resolver_version",
    "source_address_hmac",
    "privacy_suppressed",
    "greatest(5, p_min_cohort_size)",
    "REVOKE ALL",
    "service_role",
  ]) {
    assert(designSql.includes(required), `MEMBER_REGION_DESIGN_FIELD_MISSING:${required}`);
  }
  assert.doesNotMatch(designSql, /\braw_ip\b|\bip_address\b/iu, "MEMBER_REGION_DESIGN_MUST_NOT_STORE_RAW_IP");

  console.log(JSON.stringify({
    ok: true,
    checks: {
      currentMissingSourceUnavailable: true,
      noZeroFallback: true,
      kAnonymity: MEMBER_REGION_MIN_COHORT_SIZE,
      rawIpExcluded: true,
      threeMeaningsSeparated: true,
      boundedReads: true,
      cacheAndSingleFlight: true,
      minimumIntervalMs: MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
      noStoreAdminApi: true,
      hiddenAndOfflinePause: true,
      commandCenterSoftWhiteVariant: true,
      minimumVisibleFontPx: Math.min(...fontSizes),
      persistenceDesignOnly: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
