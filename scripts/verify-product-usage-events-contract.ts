import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import {
  PRODUCT_USAGE_MAX_BATCH_EVENTS,
  PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE,
  PRODUCT_USAGE_MAX_REQUEST_BYTES,
  PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE,
  PRODUCT_USAGE_MIN_COHORT_SIZE,
  PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
  buildProductUsageAnalytics,
  isProductUsageAnalyticsResponse,
  parseProductUsageAnalyticsResponse,
  productUsageEventBatchSchema,
  type ProductUsageBuildInput,
} from "@/lib/product-usage-contract";
import { buildProductUsageBrowserEvent } from "@/lib/product-usage-client";
import {
  ProductUsageAdmissionGate,
  parseProductUsageAggregate,
} from "@/lib/server/product-usage-analytics";

const root = process.cwd();
const NOW = "2026-10-03T00:00:00.000Z";
const EVENT_ID = "8f6efc44-9848-4adf-9713-a9e743f89e92";
const SESSION_ID = "2e646f40-24b2-4af8-900d-0e4de629f0a6";
const JOURNEY_ID = "d5a3347d-70c5-48a3-8941-2e9f20d7556c";

type UsageClient = typeof import("@/lib/product-usage-client");
type FixtureResponder = (endpoint: string, init: RequestInit) => Promise<Response>;

function runtimeSubject<T>(code: string, globals: Record<string, unknown>) {
  const subject = { exports: {} };
  const sandbox: Record<string, unknown> = { exports: subject.exports, module: subject, ...globals };
  runInNewContext(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  return { api: subject.exports as T, sandbox };
}

function clientFixture(code: string, respond: FixtureResponder, local: {
  browser?: boolean; hidden?: boolean; offline?: boolean; token?: string | null;
} = {}) {
  const state = {
    visibility: { visibilityState: local.hidden ? "hidden" : "visible" },
    navigator: { onLine: !local.offline },
    nowMs: 100_000,
    storageReads: 0, storageWrites: 0, uuidCalls: 0,
    requests: [] as Array<{ endpoint: string; init: RequestInit }>,
    timers: new Map<number, () => void>(), timerDelays: [] as number[],
  };
  let timerId = 0;
  const storage = new Map<string, string>();
  const token = local.token === undefined ? "fixture-browser-token" : local.token;
  class FixtureDate extends Date { static now() { return state.nowMs; } }
  const { api } = runtimeSubject<UsageClient>(code, {
    window: local.browser === false ? undefined : {},
    document: state.visibility, navigator: state.navigator, Date: FixtureDate,
    AbortController,
    setTimeout: (callback: () => void, delay: number) => {
      timerId += 1;
      state.timerDelays.push(delay);
      state.timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => { state.timers.delete(id); },
    localStorage: { getItem: () => token },
    sessionStorage: {
      getItem: (key: string) => { state.storageReads += 1; return storage.get(key) || null; },
      setItem: (key: string, value: string) => { state.storageWrites += 1; storage.set(key, value); },
    },
    crypto: { randomUUID: () => {
      state.uuidCalls += 1;
      return `00000000-0000-4000-8000-${String(state.uuidCalls).padStart(12, "0")}`;
    } },
    fetch: async (endpoint: string, init: RequestInit) => {
      state.requests.push({ endpoint, init });
      return respond(endpoint, init);
    },
  });
  return { api, state, expireTimers: () => {
    const callbacks = [...state.timers.values()];
    state.timers.clear();
    for (const callback of callbacks) callback();
  } };
}

async function verifyCollectionPolicyBehavior(clientCode: string, routeCode: string, event: unknown) {
  let cases = 0;
  const input = { eventType: "page_view", featureKey: "agent_chat", pageKey: "home" } as const;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const enabledResponder: FixtureResponder = async (_endpoint, init) => init.method === "GET"
    ? json({ collectionEnabled: true })
    : json({ ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount: JSON.parse(String(init.body)).events.length }, 202);
  const noEventsBuilt = (state: ReturnType<typeof clientFixture>["state"]) => {
    assert.equal(state.uuidCalls, 0, "POLICY_MUST_PRECEDE_UUID_GENERATION");
    assert.equal(state.storageReads, 0, "POLICY_MUST_PRECEDE_SESSION_OR_SEQUENCE_READ");
    assert.equal(state.storageWrites, 0, "POLICY_MUST_PRECEDE_SESSION_OR_SEQUENCE_WRITE");
    assert.equal(state.requests.some(request => request.init.method === "POST"), false);
  };

  for (const fixture of [
    { local: { browser: false }, inputs: [input], code: "BROWSER_REQUIRED" },
    { local: {}, inputs: [], code: "NO_EVENTS" },
    { local: { hidden: true }, inputs: [input], code: "PAGE_HIDDEN" },
    { local: { offline: true }, inputs: [input], code: "OFFLINE" },
    { local: { token: null }, inputs: [input], code: "UNAUTHENTICATED" },
  ]) {
    const subject = clientFixture(clientCode, enabledResponder, fixture.local);
    const result = await subject.api.recordProductUsageEvents(fixture.inputs);
    assert.equal(result.status, "skipped");
    assert.equal(result.code, fixture.code);
    assert.equal(subject.state.requests.length, 0, "LOCAL_SKIP_MUST_NOT_FETCH_POLICY");
    noEventsBuilt(subject.state);
    cases += 1;
  }
  const disabled = clientFixture(clientCode, async () => json({ collectionEnabled: false }));
  const disabledResult = await disabled.api.recordProductUsageEvent(input);
  assert.equal(disabledResult.status, "skipped");
  assert.equal(disabledResult.code, "COLLECTION_DISABLED");
  assert.equal(disabledResult.receivedCount, 0);
  noEventsBuilt(disabled.state);
  assert.equal(new Headers(disabled.state.requests[0].init.headers).has("authorization"), false);
  assert.equal(disabled.state.requests[0].init.cache, "no-store");
  assert.equal(disabled.state.requests[0].init.credentials, "same-origin");
  await disabled.api.recordProductUsageEvent(input);
  disabled.state.nowMs += 59_999;
  await disabled.api.recordProductUsageEvent(input);
  assert.equal(disabled.state.requests.length, 1, "FALSE_POLICY_CACHE_MUST_LAST_LESS_THAN_SIXTY_SECONDS");
  disabled.state.nowMs += 1;
  await disabled.api.recordProductUsageEvent(input);
  assert.equal(disabled.state.requests.length, 2, "FALSE_POLICY_CACHE_MUST_EXPIRE_AT_SIXTY_SECONDS");
  await disabled.api.recordProductUsageEvent(input, { endpoint: "/fixture/other-policy" });
  assert.equal(disabled.state.requests.length, 3, "POLICY_CACHE_MUST_BE_KEYED_BY_ENDPOINT");
  cases += 1;

  const unknownResponses: Array<() => Promise<Response>> = [
    async () => json({ collectionEnabled: false }, 503),
    async () => json({ collectionEnabled: "true" }),
    async () => json({ collectionEnabled: 1 }),
    async () => json({}), async () => json([]), async () => json(null),
    async () => new Response("not-json", { status: 200 }),
    async () => { throw new Error("fixture network failure"); },
  ];
  for (const respond of unknownResponses) {
    const subject = clientFixture(clientCode, respond);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await subject.api.recordProductUsageEvent(input);
      assert.equal(result.status, "unavailable");
      assert.equal(result.code, "COLLECTION_STATUS_UNKNOWN");
      assert.equal(result.receivedCount, 0);
    }
    assert.equal(subject.state.requests.length, 2, "UNKNOWN_POLICY_MUST_NOT_BE_CACHED_AS_DISABLED");
    noEventsBuilt(subject.state);
    cases += 1;
  }

  let releasePolicy: ((response: Response) => void) | undefined;
  const shared = clientFixture(clientCode, async (_endpoint, init) => init.method === "GET"
    ? new Promise<Response>(resolve => { releasePolicy = resolve; })
    : json({ ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount: 1 }, 202));
  const controller = new AbortController();
  const cancelled = shared.api.recordProductUsageEvent(input, { signal: controller.signal });
  const survivor = shared.api.recordProductUsageEvent(input);
  assert.equal(shared.state.requests.length, 1, "CONCURRENT_CALLERS_MUST_SHARE_ONE_POLICY_GET");
  assert.notEqual(shared.state.requests[0].init.signal, controller.signal, "FIRST_CALLER_MUST_NOT_OWN_SHARED_GET_ABORT");
  controller.abort();
  assert.equal(shared.state.requests[0].init.signal?.aborted, false, "CALLER_ABORT_MUST_NOT_CANCEL_SHARED_POLICY_GET");
  assert(releasePolicy);
  releasePolicy(json({ collectionEnabled: true }));
  assert.equal((await cancelled).code, "ABORTED");
  assert.equal((await survivor).status, "accepted");
  assert.equal(shared.state.requests.filter(request => request.init.method === "POST").length, 1);
  const getCount = shared.state.requests.filter(request => request.init.method === "GET").length;
  await shared.api.recordProductUsageEvent(input);
  assert.equal(shared.state.requests.filter(request => request.init.method === "GET").length, getCount,
    "TRUE_POLICY_CACHE_MUST_BE_REUSED");
  shared.state.nowMs += 60_000;
  const refreshed = shared.api.recordProductUsageEvent(input);
  assert(releasePolicy);
  releasePolicy(json({ collectionEnabled: true }));
  assert.equal((await refreshed).status, "accepted");
  assert.equal(shared.state.requests.filter(request => request.init.method === "GET").length, getCount + 1);
  assert.equal(shared.state.timers.size, 0, "COMPLETED_GET_MUST_CLEAR_ITS_DEADLINE");
  cases += 1;

  for (const phase of ["headers", "body"] as const) {
    let getCalls = 0;
    let bodyStarted = false;
    let releaseHeaders: ((response: Response) => void) | undefined;
    let releaseBody: ((value: unknown) => void) | undefined;
    const subject = clientFixture(clientCode, async (_endpoint, init) => {
      if (init.method !== "GET") return json({ ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount: 1 }, 202);
      getCalls += 1;
      if (getCalls > 1) return json({ collectionEnabled: true });
      if (phase === "headers") return new Promise<Response>(resolve => { releaseHeaders = resolve; });
      const response = json({});
      response.json = () => {
        bodyStarted = true;
        return new Promise<unknown>(resolve => { releaseBody = resolve; });
      };
      return response;
    });
    const first = subject.api.recordProductUsageEvent(input);
    const second = subject.api.recordProductUsageEvent(input);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(subject.state.requests.length, 1, "STALLED_GET_MUST_STILL_BE_SINGLE_FLIGHT");
    if (phase === "body") assert.equal(bodyStarted, true, "BODY_DEADLINE_CASE_MUST_REACH_JSON_READ");
    assert.deepEqual(subject.state.timerDelays, [5_000], "POLICY_GET_MUST_HAVE_ITS_OWN_FIVE_SECOND_DEADLINE");
    subject.state.nowMs += 5_000;
    subject.expireTimers();
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.status, "unavailable");
      assert.equal(result.code, "COLLECTION_STATUS_UNKNOWN");
      assert.equal(result.receivedCount, 0);
    }
    noEventsBuilt(subject.state);
    assert.equal(subject.state.requests[0].init.signal?.aborted, true);
    assert.equal(subject.state.timers.size, 0);
    assert.equal((await subject.api.recordProductUsageEvent(input)).status, "accepted");
    assert.equal(getCalls, 2, "TIMEOUT_MUST_RELEASE_SINGLE_FLIGHT_WITHOUT_CACHING_UNKNOWN");
    if (releaseHeaders) releaseHeaders(json({ collectionEnabled: false }));
    if (releaseBody) releaseBody({ collectionEnabled: false });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal((await subject.api.recordProductUsageEvent(input)).status, "accepted",
      "LATE_TIMED_OUT_REPLY_MUST_NOT_REPLACE_THE_NEW_POLICY_CACHE");
    assert.equal(getCalls, 2);
    assert.equal(subject.state.timers.size, 0);
    cases += 1;
  }

  for (const change of ["hidden", "offline"] as const) {
    let release: ((response: Response) => void) | undefined;
    const subject = clientFixture(clientCode, async () => new Promise<Response>(resolve => { release = resolve; }));
    const pending = subject.api.recordProductUsageEvent(input);
    if (change === "hidden") subject.state.visibility.visibilityState = "hidden";
    else subject.state.navigator.onLine = false;
    assert(release);
    release(json({ collectionEnabled: true }));
    assert.equal((await pending).code, change === "hidden" ? "PAGE_HIDDEN" : "OFFLINE");
    noEventsBuilt(subject.state);
    cases += 1;
  }

  for (const fixture of [
    { status: 200, body: { ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount: 1 } },
    { status: 202, body: { code: "PRODUCT_USAGE_ACCEPTED", receivedCount: 1 } },
    { status: 202, body: { ok: true, code: "OTHER", receivedCount: 1 } },
    { status: 202, body: { ok: true, code: "PRODUCT_USAGE_ACCEPTED" } },
    ...[-1, 0, 0.5, 2, "1"].map(receivedCount => ({ status: 202, body: { ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount } })),
    { status: 202, body: null },
  ]) {
    const subject = clientFixture(clientCode, async (_endpoint, init) => init.method === "GET"
      ? json({ collectionEnabled: true }) : json(fixture.body, fixture.status));
    const result = await subject.api.recordProductUsageEvent(input);
    assert.equal(result.status, "unavailable", "MALFORMED_2XX_MUST_NOT_MEAN_COLLECTION_ACCEPTED");
    assert.equal(result.code, "PRODUCT_USAGE_RESPONSE_INVALID");
    assert.equal(result.receivedCount, 0);
    cases += 1;
  }

  function serverFixture(policyBasisCode: string, noticeVersion: string, storageMissing = false) {
    const counters = { auth: 0, jwt: 0, db: 0, persisted: 0 };
    const { api, sandbox } = runtimeSubject<{ GET: () => Promise<Response>; POST: (request: Request) => Promise<Response> }>(routeCode, {
      URL, TextEncoder, Date, process: { env: { PRODUCT_USAGE_POLICY_BASIS_CODE: policyBasisCode, PRODUCT_USAGE_NOTICE_VERSION: noticeVersion } },
      require: (name: string) => {
        if (name === "node:crypto") return { createHash, createHmac };
        if (name === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => json(body, init?.status || 200) } };
        if (name === "@/lib/auth") return {
          getTokenFromHeaders: () => { counters.auth += 1; return "fixture-token"; },
          authorizeToken: async () => { counters.auth += 1; return { ok: true, actor: { userId: "fixture-user" } }; },
          getJwtSecretString: () => { counters.jwt += 1; return "fixture-only-not-a-production-secret"; },
        };
        if (name === "@/lib/operation-flight-recorder") return { readFlightRuntimeIdentity: () => ({ sourceVersion: "fixture", buildId: "fixture" }) };
        if (name === "@/lib/product-usage-contract") return {
          PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE, PRODUCT_USAGE_MAX_REQUEST_BYTES,
          PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE, productUsageEventBatchSchema,
        };
        if (name === "@/storage/database/supabase-client") return { getSupabaseAdminClient: () => {
          counters.db += 1;
          return { from: (table: string) => {
            assert.equal(table, "product_usage_events");
            return { upsert: async (rows: unknown[], options: { ignoreDuplicates?: boolean }) => {
              assert.equal(options.ignoreDuplicates, true);
              if (!storageMissing) counters.persisted += rows.length;
              return { error: storageMissing ? { code: "PGRST205" } : null };
            } };
          } };
        } };
        throw new Error(`UNMOCKED_POLICY_DEPENDENCY:${name}`);
      },
    });
    return { api, sandbox, counters };
  }
  for (const [basis, notice, expected] of [
    ["", "", false], ["aa", "abc", false], ["abc", "aa", false],
    ["a".repeat(81), "abc", false], ["abc", "a".repeat(65), false],
    ["invalid space", "abc", false], ["abc", "invalid space", false],
    ["abc", "abc", true], ["a".repeat(80), "a".repeat(64), true],
  ] as const) {
    const subject = serverFixture(basis, notice);
    const response = await subject.api.GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { collectionEnabled: expected });
    assert.match(response.headers.get("cache-control") || "", /no-store/u);
    assert.equal(subject.counters.auth + subject.counters.jwt + subject.counters.db, 0,
      "POLICY_GET_MUST_NOT_READ_AUTH_JWT_OR_DATABASE");
    assert.equal(subject.sandbox.__agentHubProductUsageIngestRateBucketsV1, undefined,
      "POLICY_GET_MUST_NOT_WRITE_INGEST_RATE_LIMITS");
    cases += 1;
  }
  const request = (withOrigin = true) => {
    const req = new Request("http://fixture.test/api/product-usage/events", { method: "POST", body: JSON.stringify({ events: [event] }),
      headers: { "content-type": "application/json", ...(withOrigin ? { origin: "http://fixture.test", "sec-fetch-site": "same-origin" } : {}) } });
    return Object.assign(req, { nextUrl: new URL(req.url) });
  };
  for (const fixture of [
    { policy: false, missing: false, status: 503, code: "PRODUCT_USAGE_POLICY_NOT_CONFIGURED", rows: 0 },
    { policy: true, missing: true, status: 503, code: "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED", rows: 0 },
    { policy: true, missing: false, status: 202, code: "PRODUCT_USAGE_ACCEPTED", rows: 1 },
  ]) {
    const subject = serverFixture(fixture.policy ? "abc" : "", fixture.policy ? "abc" : "", fixture.missing);
    const response = await subject.api.POST(request());
    const body = await response.json();
    assert.equal(response.status, fixture.status);
    assert.equal(body.code, fixture.code);
    assert.equal(body.receivedCount, fixture.rows);
    assert.equal(subject.counters.persisted, fixture.rows);
    assert.match(response.headers.get("cache-control") || "", /no-store/u);
    cases += 1;
  }
  const crossOrigin = serverFixture("abc", "abc");
  assert.equal((await crossOrigin.api.POST(request(false))).status, 403);
  assert.equal(crossOrigin.counters.auth + crossOrigin.counters.db, 0);
  cases += 1;
  return cases;
}

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

function unavailableBuildInput(): ProductUsageBuildInput {
  return {
    now: NOW,
    aggregate: {
      state: "unavailable",
      latestRecordAt: null,
      eventCount: null,
      instrumentationStartedAt: null,
      metrics: null,
      retention: [],
      featureAdoption: [],
      valuePath: [],
      errorCode: "PRODUCT_USAGE_FACT_SOURCE_NOT_DEPLOYED",
    },
    fallback: {
      state: "available",
      rows: [
        { id: "flight-1", pseudonymousUserRef: "usr_aaaaaaaaaaaa", outcome: "success", occurredAt: "2026-10-02T23:00:00.000Z" },
        { id: "flight-2", pseudonymousUserRef: "usr_bbbbbbbbbbbb", outcome: "error", occurredAt: "2026-10-02T23:30:00.000Z" },
      ],
      rowLimit: 500,
      truncated: false,
      errorCode: null,
    },
  };
}

async function verifyAdmissionGate(): Promise<void> {
  const gate = new ProductUsageAdmissionGate(PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS);
  let finishFirst: ((value: string) => void) | undefined;
  const first = gate.run("fixture-admin", () => new Promise<string>((resolve) => { finishFirst = resolve; }), 100_000);
  await Promise.resolve();
  const concurrent = await gate.run("fixture-admin", async () => "unexpected", 100_000);
  assert.equal(concurrent.allowed, false, "PRODUCT_USAGE_SINGLE_FLIGHT_MUST_REJECT_CONCURRENT_READ");
  if (!concurrent.allowed) assert.equal(concurrent.reason, "single_flight");
  assert(finishFirst, "PRODUCT_USAGE_FIXTURE_RELEASE_MISSING");
  finishFirst("first");
  assert.equal((await first).allowed, true);
  const early = await gate.run("fixture-admin", async () => "unexpected", 159_999);
  assert.equal(early.allowed, false, "PRODUCT_USAGE_MINIMUM_INTERVAL_MUST_REJECT_EARLY_READ");
  const released = await gate.run("fixture-admin", async () => "released", 160_000);
  assert.equal(released.allowed, true, "PRODUCT_USAGE_READ_MUST_RELEASE_AT_SIXTY_SECONDS");
}

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("UNMOCKED_PRODUCT_USAGE_NETWORK_FORBIDDEN"); };
  const event = buildProductUsageBrowserEvent({
    eventType: "workflow_started",
    featureKey: "agent_chat",
    journeyId: JOURNEY_ID,
    entryPoint: "direct",
  }, {
    id: EVENT_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    occurredAt: NOW,
  });
  const validBatch = productUsageEventBatchSchema.safeParse({ events: [event] });
  assert.equal(validBatch.success, true, "PRODUCT_USAGE_VALID_EVENT_REJECTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: [{ ...event, journey_id: null }],
  }).success, false, "PRODUCT_USAGE_WORKFLOW_WITHOUT_JOURNEY_ACCEPTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: [{ ...event, prompt: "sensitive content" }],
  }).success, false, "PRODUCT_USAGE_GENERIC_CONTENT_FIELD_ACCEPTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: [{
      ...event,
      event_type: "session_heartbeat",
      journey_id: null,
      page_key: "home",
    }],
  }).success, true, "PRODUCT_USAGE_HEARTBEAT_REJECTED");
  assert.equal(productUsageEventBatchSchema.safeParse({
    events: Array.from({ length: PRODUCT_USAGE_MAX_BATCH_EVENTS + 1 }, (_, index) => ({
      ...event,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  }).success, false, "PRODUCT_USAGE_OVERSIZED_BATCH_ACCEPTED");

  const unavailable = buildProductUsageAnalytics(unavailableBuildInput());
  assert.equal(unavailable.availability, "partial");
  assert.equal(unavailable.sourceMode, "operation_flight_events_limited_fallback");
  assert.equal(unavailable.metrics.dau.value, null, "FLIGHT_EVENTS_MUST_NOT_BECOME_DAU");
  assert.equal(unavailable.metrics.activation.value, null, "FLIGHT_EVENTS_MUST_NOT_BECOME_ACTIVATION");
  assert.equal(unavailable.retention.every((point) => point.rate === null), true, "FLIGHT_EVENTS_MUST_NOT_BECOME_RETENTION");
  assert.equal(unavailable.featureAdoption.length, 0, "FLIGHT_EVENTS_MUST_NOT_BECOME_ADOPTION");
  assert.equal(unavailable.valuePath.length, 0, "FLIGHT_EVENTS_MUST_NOT_BECOME_VALUE_PATH");
  assert.equal(unavailable.fallbackSignal.eventCount, 2);
  assert.equal(unavailable.fallbackSignal.pseudonymousUserCount, null, "SMALL_FALLBACK_COHORT_MUST_BE_SUPPRESSED");
  assert.equal(unavailable.privacy.minimumCohortSize, PRODUCT_USAGE_MIN_COHORT_SIZE);
  assert.equal(unavailable.privacy.directIdentifiersIncluded, false);
  assert.equal(unavailable.privacy.promptOrContentIncluded, false);

  const parsedResponseFixture = parseProductUsageAnalyticsResponse(unavailable);
  assert(parsedResponseFixture, "PRODUCT_USAGE_VALID_ANALYTICS_RESPONSE_REJECTED");
  assert.equal(parsedResponseFixture.refresh.rateLimit.scope, "process-local-admin");
  assert.equal(parsedResponseFixture.metrics.dau.value, null);
  assert.equal(parsedResponseFixture.privacy.ipIncluded, false);
  assert.equal(isProductUsageAnalyticsResponse(unavailable), true, "PRODUCT_USAGE_VALID_TYPE_GUARD_REJECTED");

  const malformedResponseFixtures: Array<{ name: string; value: unknown }> = [
    {
      name: "missing nested refresh rate limit",
      value: { ...unavailable, refresh: { ...unavailable.refresh, rateLimit: undefined } },
    },
    {
      name: "invalid nested refresh timestamp",
      value: { ...unavailable, refresh: { ...unavailable.refresh, nextRefreshAt: "later" } },
    },
    {
      name: "freshness label is missing",
      value: { ...unavailable, freshness: { ...unavailable.freshness, label: undefined } },
    },
    {
      name: "missing metric definition",
      value: {
        ...unavailable,
        metrics: {
          ...unavailable.metrics,
          dau: { ...unavailable.metrics.dau, definition: undefined },
        },
      },
    },
    {
      name: "wrong activation unit",
      value: {
        ...unavailable,
        metrics: {
          ...unavailable.metrics,
          activation: { ...unavailable.metrics.activation, unit: "users" },
        },
      },
    },
    {
      name: "privacy flag claims raw IP is included",
      value: { ...unavailable, privacy: { ...unavailable.privacy, ipIncluded: true } },
    },
    {
      name: "privacy-suppressed adoption leaks cohort values",
      value: {
        ...unavailable,
        featureAdoption: [{
          featureKey: "agent_chat",
          label: "智能体对话",
          state: "partial",
          activeUsers: 3,
          monthlyActiveUsers: null,
          adoptionRate: null,
          workflowCompletedUsers: null,
          reasonCode: "SMALL_COHORT_SUPPRESSED",
          privacySuppressed: true,
        }],
      },
    },
    {
      name: "retention contains an unsupported day",
      value: {
        ...unavailable,
        retention: [{
          ...unavailable.retention[0],
          day: 14,
        }],
      },
    },
    {
      name: "value path conversion exceeds one",
      value: {
        ...unavailable,
        valuePath: [{
          key: "active",
          label: "产生合规行为",
          state: "available",
          users: 6,
          conversionFromPrevious: 1.2,
          reasonCode: null,
          privacySuppressed: false,
        }],
      },
    },
    {
      name: "duplicate source evidence",
      value: { ...unavailable, sourceStates: [unavailable.sourceStates[0], unavailable.sourceStates[0]] },
    },
    {
      name: "source evidence is missing detail",
      value: {
        ...unavailable,
        sourceStates: [
          { ...unavailable.sourceStates[0], detail: undefined },
          unavailable.sourceStates[1],
        ],
      },
    },
    {
      name: "unavailable fallback leaks event count",
      value: {
        ...unavailable,
        fallbackSignal: {
          ...unavailable.fallbackSignal,
          state: "unavailable",
          eventCount: 2,
        },
      },
    },
    {
      name: "unexpected nested privacy field",
      value: { ...unavailable, privacy: { ...unavailable.privacy, rawIp: "127.0.0.1" } },
    },
    {
      name: "read budget accepts a negative row limit",
      value: { ...unavailable, readBudget: { ...unavailable.readBudget, fallbackRowLimit: -1 } },
    },
  ];
  for (const fixture of malformedResponseFixtures) {
    assert.equal(
      parseProductUsageAnalyticsResponse(fixture.value),
      null,
      `PRODUCT_USAGE_MALFORMED_RESPONSE_ACCEPTED:${fixture.name}`,
    );
    assert.equal(
      isProductUsageAnalyticsResponse(fixture.value),
      false,
      `PRODUCT_USAGE_MALFORMED_TYPE_GUARD_ACCEPTED:${fixture.name}`,
    );
  }

  const parsed = parseProductUsageAggregate({
    instrumentation: {
      eventCount: 24,
      startedAt: "2026-09-01T00:00:00.000Z",
      latestRecordAt: "2026-10-02T23:55:00.000Z",
    },
    metrics: {
      dau: { state: "available", value: 6 },
      wau: { state: "available", value: 10 },
      mau: { state: "available", value: 12 },
      activation: { state: "available", value: 0.5, numerator: 5, denominator: 10 },
    },
    retention: [{ day: 1, state: "available", retainedUsers: 3, eligibleUsers: 6, rate: 0.5 }],
    featureAdoption: [{ featureKey: "agent_chat", state: "available", activeUsers: 3, monthlyActiveUsers: 12, adoptionRate: 0.25, workflowCompletedUsers: 2 }],
    valuePath: [{ key: "active", state: "available", users: 6, conversionFromPrevious: 1 }],
  });
  assert.equal(parsed.metrics?.dau.value, 6);
  assert.equal(parsed.retention[0].privacySuppressed, true, "SMALL_RETENTION_NUMERATOR_MUST_BE_SUPPRESSED");
  assert.equal(parsed.retention[0].rate, null);
  assert.equal(parsed.featureAdoption[0].privacySuppressed, true, "SMALL_FEATURE_COHORT_MUST_BE_SUPPRESSED");

  await verifyAdmissionGate();

  const [
    contractSource,
    clientSource,
    serverSource,
    ingestRoute,
    adminRoute,
    governanceSource,
    panelSource,
    panelStyles,
    globalRecorder,
    diagnosticSource,
    designSql,
    operationRecorder,
    designDoc,
  ] = await Promise.all([
    source("src/lib/product-usage-contract.ts"),
    source("src/lib/product-usage-client.ts"),
    source("src/lib/server/product-usage-analytics.ts"),
    source("src/app/api/product-usage/events/route.ts"),
    source("src/app/api/admin/product-usage/route.ts"),
    source("src/lib/admin-governance.ts"),
    source("src/components/admin/product-usage-panel.tsx"),
    source("src/components/admin/product-usage-panel.module.css"),
    source("src/components/diagnostic-sentry.tsx"),
    source("src/lib/diagnostic-sentry.ts"),
    source("supabase/design-only/20261003_product_usage_events.sql"),
    source("src/lib/operation-flight-recorder.ts"),
    source("docs/产品使用数据闭环设计-2026-10-03.md"),
  ]);
  const collectionPolicyBehaviorCases = await verifyCollectionPolicyBehavior(clientSource, ingestRoute, event);

  for (const required of [
    "PRODUCT_USAGE_EVENT_TYPES",
    '"page_view"',
    '"session_heartbeat"',
    '"feature_open"',
    '"workflow_started"',
    '"workflow_completed"',
    '"workflow_failed"',
    '"value_milestone"',
    ".strict()",
    "PRODUCT_USAGE_MAX_BATCH_EVENTS",
    "productUsageAnalyticsResponseSchema",
    "parseProductUsageAnalyticsResponse",
  ]) assert(contractSource.includes(required), `PRODUCT_USAGE_CONTRACT_BOUNDARY_MISSING:${required}`);
  assert.doesNotMatch(contractSource, /\bmetadata\s*:/u, "PRODUCT_USAGE_GENERIC_METADATA_BAG_MUST_NOT_EXIST");

  for (const required of [
    'endpoint ?? "/api/product-usage/events"',
    'credentials: "same-origin"',
    'document.visibilityState === "hidden"',
    "navigator.onLine === false",
    "buildProductUsageBrowserEvent",
  ]) assert(clientSource.includes(required), `PRODUCT_USAGE_CLIENT_BOUNDARY_MISSING:${required}`);

  for (const required of [
    "read_admin_product_usage_snapshot_v1",
    '.from("operation_flight_events")',
    '.select("id,user_id,outcome,occurred_at")',
    `.limit(FALLBACK_ROW_LIMIT + 1)`,
    "AbortSignal.timeout(QUERY_TIMEOUT_MS)",
    "__agentHubProductUsageAnalyticsCacheV1",
    "__agentHubProductUsageReadInFlightV1",
    "ProductUsageAdmissionGate",
  ]) assert(serverSource.includes(required), `PRODUCT_USAGE_READ_MODEL_BOUNDARY_MISSING:${required}`);
  assert.doesNotMatch(serverSource, /operation_flight_events[\s\S]{0,400}(?:dau|activation|retention|adoption)/iu, "FLIGHT_FALLBACK_MUST_NOT_FEED_PRODUCT_KPIS");

  for (const required of [
    "sameOrigin(request)",
    "process.env.BASE_URL",
    "process.env.PRODUCTION_SITE_URL",
    "parsedRequestOrigin(request.headers.get(\"origin\"))",
    "parsedConfiguredOrigin(value)",
    "sameLoopbackOrigin(suppliedOrigin, allowedOrigin)",
    'fetchSite !== "same-origin"',
    "authorizeToken(token)",
    "PRODUCT_USAGE_MAX_REQUEST_BYTES",
    "PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE",
    "PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE",
    "productUsageEventBatchSchema.safeParse",
    "createHmac",
    'from("product_usage_events")',
    'ignoreDuplicates: true',
    "PRODUCT_USAGE_POLICY_BASIS_CODE",
    "PRODUCT_USAGE_NOTICE_VERSION",
    "PRODUCT_USAGE_POLICY_NOT_CONFIGURED",
    "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED",
    "storageMissing ? 503",
    'policyMissing || code === "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED" ? 503',
  ]) assert(ingestRoute.includes(required), `PRODUCT_USAGE_INGEST_GUARD_MISSING:${required}`);
  assert.doesNotMatch(ingestRoute, /headers\.get\(["']host["']\)/u, "PRODUCT_USAGE_INGEST_MUST_NOT_TRUST_HOST_HEADER");
  assert.doesNotMatch(ingestRoute, /headers\.get\(["']user-agent|x-forwarded-for|\b(?:ip_address|email|prompt|material_url)\s*:/iu, "PRODUCT_USAGE_INGEST_MUST_NOT_READ_SENSITIVE_FIELDS");

  for (const required of [
    'authorizeAdminCapability(request, "members.view"',
    "private, no-store",
    "status: 429",
    "Retry-After",
    "PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS",
  ]) assert(adminRoute.includes(required), `PRODUCT_USAGE_ADMIN_API_GUARD_MISSING:${required}`);
  assert(governanceSource.includes('pathname === "/api/admin/product-usage"'), "PRODUCT_USAGE_ADMIN_PROXY_RULE_MISSING");
  assert(governanceSource.includes('pathname === "/api/admin/external-site-monitor"'), "CONCURRENT_EXTERNAL_MONITOR_RULE_LOST");

  for (const required of [
    'variant?: "admin" | "command_center"',
    'variant === "command_center"',
    "document.visibilityState",
    "navigator.onLine",
    "AbortController",
    "window.setTimeout",
    "事实源未接入",
    "不能用于计算 DAU",
    "不替代产品分析",
    'data-testid="product-usage-panel"',
    "data-snapshot-state=",
    "data-availability=",
    "data-source-mode=",
    "data-freshness=",
    "data-window-hours=",
    "data-schema-version=",
  ]) assert(panelSource.includes(required), `PRODUCT_USAGE_PANEL_BOUNDARY_MISSING:${required}`);
  assert.doesNotMatch(panelSource, /setInterval/u, "PRODUCT_USAGE_PANEL_MUST_NOT_POLL_WITH_SET_INTERVAL");
  const fontSizes = [...panelStyles.matchAll(/font-size:\s*(\d+)px/gu)].map((match) => Number(match[1]));
  assert(fontSizes.length > 0 && fontSizes.every((size) => size >= 12), "PRODUCT_USAGE_PANEL_TEXT_BELOW_TWELVE_PIXELS");
  for (const required of [
    ".commandCenter",
    "--pu-bg: #f3f4ef",
    "--pu-panel: #fffefa",
    "--pu-text: #17201d",
    "color-scheme: light",
    "prefers-reduced-motion",
    "panelEnter",
  ]) {
    assert(panelStyles.includes(required), `PRODUCT_USAGE_COMMAND_CENTER_STYLE_MISSING:${required}`);
  }

  for (const required of [
    'eventType: "page_view"',
    'eventType: "session_heartbeat"',
    "PRODUCT_USAGE_HEARTBEAT_MS",
    "window.setTimeout",
    "visibilitychange",
  ]) assert(globalRecorder.includes(required), `PRODUCT_USAGE_GLOBAL_TRIGGER_MISSING:${required}`);
  assert.doesNotMatch(globalRecorder, /setInterval/u, "PRODUCT_USAGE_HEARTBEAT_MUST_BE_ONE_SHOT_TIMEOUT");
  for (const required of [
    "productUsageFeatureForApi",
    'return "agent_chat"',
    'eventType: "workflow_started"',
    'eventType: "workflow_completed"',
    'eventType: "workflow_failed"',
  ]) assert(diagnosticSource.includes(required), `PRODUCT_USAGE_VALUE_ACTION_TRIGGER_MISSING:${required}`);

  for (const required of [
    "DESIGN ONLY",
    "DO NOT APPLY",
    "product_usage_events",
    "product_usage_daily_user_facts",
    "product_usage_user_lifecycle",
    "session_hmac",
    "journey_hmac",
    "policy_basis_code",
    "notice_version",
    "retained_until",
    "read_admin_product_usage_snapshot_v1",
    "greatest(5, p_min_cohort_size)",
    "REVOKE ALL",
    "service_role",
  ]) assert(designSql.includes(required), `PRODUCT_USAGE_DESIGN_FIELD_MISSING:${required}`);
  assert.doesNotMatch(designSql, /^\s*(?:raw_ip|ip_address|user_agent|email|prompt|content|material_url)\s+/imu, "PRODUCT_USAGE_DESIGN_MUST_NOT_DECLARE_SENSITIVE_COLUMNS");

  assert(operationRecorder.includes("operation_flight_events"));
  assert(operationRecorder.includes("domain"));
  assert(operationRecorder.includes("outcome"));
  assert.doesNotMatch(operationRecorder, /retention|featureAdoption|valuePath/u, "OPERATION_FLIGHT_RECORDER_MUST_REMAIN_OPERATIONAL_ONLY");
  assert(designDoc.includes("操作事实不等于产品分析"));
  assert(designDoc.includes("尚未应用"));

  console.log(JSON.stringify({
    ok: true,
    checks: {
      strictAllowlist: true,
      sameOriginAndAuthenticatedIngest: true,
      serverAttributedUser: true,
      sessionAndJourneyHmac: true,
      noSensitivePayloadFields: true,
      dedupeAndRateLimit: true,
      policyFailClosed: true,
      collectionPolicyBehaviorCases,
      policyGetReadOnly: true,
      policyGateBeforeIdentifierWrites: true,
      collectionStatusCacheTtlMs: 60_000,
      collectionStatusDeadlineMs: 5_000,
      collectionStatusDeadlineCoversHeadersAndBody: true,
      sharedPolicyGetIndependentOfCallerAbort: true,
      strictAcceptedPostResponse: true,
      durableSchemaDesignOnly: true,
      migrationApplied: false,
      flightFallbackOperationalOnly: true,
      missingFactsNotZero: true,
      deepResponseValidation: true,
      malformed200Rejected: malformedResponseFixtures.length,
      minimumCohortSize: PRODUCT_USAGE_MIN_COHORT_SIZE,
      boundedAdminRead: true,
      cacheAndSingleFlight: true,
      minimumIntervalMs: PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
      noStoreAdminApi: true,
      globalPageViewAndHeartbeatMounted: true,
      realChatWorkflowTriggerMounted: true,
      hiddenAndOfflinePause: true,
      commandCenterSoftWhiteVariant: true,
      minimumVisibleFontPx: Math.min(...fontSizes),
      productionWrites: 0,
      providerCalls: 0,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
