#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import pg from "pg";
import ts from "typescript";

const VERSION = "20261002223000";
const MIGRATION_FILE = `${VERSION}_announcement_event_integrity.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const nativeRequire = createRequire(import.meta.url);

const executeDatabaseFixtures = process.argv.includes("--execute");
if (executeDatabaseFixtures) {
  assert.ok(!process.argv.includes("--zero-network"), "EXECUTE_AND_ZERO_NETWORK_ARE_EXCLUSIVE");
  assert.ok(
    process.argv.includes("--confirm-local-announcement-event-integrity"),
    "LOCAL_ANNOUNCEMENT_EVENT_CONFIRMATION_REQUIRED",
  );
}

const routeSource = fsSync.readFileSync("src/app/api/announcements/events/route.ts", "utf8");
const componentSource = fsSync.readFileSync("src/components/announcement-popup.tsx", "utf8");
const deliveryServerSource = fsSync.readFileSync("src/lib/announcement-delivery-server.ts", "utf8");
const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");

assert.match(routeSource, /authorizeToken\(token\)/u, "AUTHORITATIVE_TOKEN_AUTH_REQUIRED");
assert.match(routeSource, /p_user_id:\s*authorization\.actor\.userId/u, "ACTOR_BOUND_USER_ID_REQUIRED");
assert.match(routeSource, /record_announcement_delivery_event/u, "EVENT_RPC_REQUIRED");
assert.doesNotMatch(routeSource, /platform_settings|ANNOUNCEMENT_ANALYTICS_KEY/u, "LEGACY_JSON_WRITE_FORBIDDEN");
assert.doesNotMatch(routeSource, /success:\s*true,\s*recorded:\s*false/u, "FAKE_SUCCESS_FORBIDDEN");
assert.match(componentSource, /Authorization:\s*`Bearer \$\{token\}`/u, "CLIENT_AUTHORIZATION_REQUIRED");
assert.match(componentSource, /pushRevision:\s*revision/u, "CLIENT_PUSH_REVISION_REQUIRED");
assert.match(componentSource, /eventKey:\s*announcementEventKey/u, "CLIENT_STABLE_EVENT_KEY_REQUIRED");
assert.match(componentSource, /announcement:\$\{announcement\.id\}:r\$\{pushRevisionOf\(announcement\)\}:\$\{event\}:v1/u);
assert.match(deliveryServerSource, /ANNOUNCEMENT_READ_RECEIPT_REQUIRED/u, "READ_EVENT_FAILURE_MAPPING_REQUIRED");
assert.match(migrationSource, /UNIQUE \(announcement_id, revision, user_id, event_type\)/u);
assert.match(migrationSource, /legacyAnalyticsMerged', false/u);
assert.match(migrationSource, /unifiedMessagingBridge', 'foundation_only_not_connected'/u);
assert.doesNotMatch(
  migrationSource,
  /(?:FROM|INTO|UPDATE)\s+public\.platform_settings/iu,
  "LEGACY_JSON_DATABASE_WRITE_FORBIDDEN",
);

const routeState = {
  authorization: { ok: true, actor: { userId: "fixture-user", role: "student" } },
  authorizationCalls: 0,
  rpcCalls: [],
  rpcResult: {
    data: {
      success: true,
      recorded: true,
      alreadyRecorded: false,
      announcementId: "00000000-0000-0000-0000-000000000001",
      revision: 2,
      event: "impression",
    },
    error: null,
  },
};

function loadRouteFixture(file) {
  const loaded = { exports: {} };
  const compiled = ts.transpileModule(fsSync.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: loaded.exports,
    module: loaded,
    require(name) {
      if (name === "next/server") {
        return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      }
      if (name === "@/lib/auth") {
        return {
          getTokenFromHeaders(headers) {
            const value = headers.get("authorization");
            return value?.startsWith("Bearer ") ? value.slice(7) : null;
          },
          async authorizeToken() {
            routeState.authorizationCalls += 1;
            return routeState.authorization;
          },
        };
      }
      if (name === "@/lib/announcement-delivery-server") {
        return {
          ANNOUNCEMENT_PRIVATE_HEADERS: { "Cache-Control": "private, no-store" },
          requiredPositiveInteger(value) {
            const parsed = typeof value === "number" ? value : Number(value);
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
          },
          announcementBackendError(_error, fallback) {
            return Response.json(
              { error: fallback, code: "ANNOUNCEMENT_BACKEND_UNAVAILABLE" },
              { status: 503 },
            );
          },
        };
      }
      if (name === "@/storage/database/supabase-client") {
        return {
          getSupabaseAdminClient() {
            return {
              async rpc(rpcName, args) {
                routeState.rpcCalls.push({ rpcName, args });
                return routeState.rpcResult;
              },
            };
          },
        };
      }
      return nativeRequire(name);
    },
    Request,
    Response,
    Headers,
    console,
    Set,
    Number,
    Object,
    Array,
    Error,
  });
  return loaded.exports;
}

const route = loadRouteFixture("src/app/api/announcements/events/route.ts");
const fixtureAnnouncementId = "00000000-0000-0000-0000-000000000001";
const fixtureBody = {
  id: fixtureAnnouncementId,
  event: "impression",
  pushRevision: 2,
  eventKey: `announcement:${fixtureAnnouncementId}:r2:impression:v1`,
};
function routeRequest(token, body = fixtureBody) {
  return new Request("http://fixture.invalid/api/announcements/events", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
function resetRouteState() {
  routeState.authorization = { ok: true, actor: { userId: "fixture-user", role: "student" } };
  routeState.authorizationCalls = 0;
  routeState.rpcCalls = [];
  routeState.rpcResult = {
    data: { success: true, recorded: true, alreadyRecorded: false },
    error: null,
  };
}

resetRouteState();
const anonymousRouteResponse = await route.POST(routeRequest(null));
assert.equal(anonymousRouteResponse.status, 401, "ANONYMOUS_ROUTE_MUST_BE_DENIED");
assert.equal(routeState.authorizationCalls, 0);
assert.equal(routeState.rpcCalls.length, 0);

resetRouteState();
routeState.authorization = {
  ok: false,
  status: 503,
  code: "AUTH_AUTHORITY_UNAVAILABLE",
  error: "authority unavailable",
};
const unavailableAuthorityResponse = await route.POST(routeRequest("fixture-token"));
assert.equal(unavailableAuthorityResponse.status, 503, "AUTHORITY_FAILURE_MUST_FAIL_CLOSED");
assert.equal(routeState.rpcCalls.length, 0);

resetRouteState();
const invalidRouteResponse = await route.POST(routeRequest("fixture-token", {
  id: fixtureAnnouncementId,
  event: "impression",
}));
assert.equal(invalidRouteResponse.status, 400, "REVISION_AND_EVENT_KEY_REQUIRED");
assert.equal(routeState.rpcCalls.length, 0);

resetRouteState();
const acceptedRouteResponse = await route.POST(routeRequest("fixture-token"));
assert.equal(acceptedRouteResponse.status, 200);
assert.equal(routeState.rpcCalls.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(routeState.rpcCalls[0])), {
  rpcName: "record_announcement_delivery_event",
  args: {
    p_announcement_id: fixtureAnnouncementId,
    p_user_id: "fixture-user",
    p_revision: 2,
    p_event_type: "impression",
    p_event_key: fixtureBody.eventKey,
  },
});

resetRouteState();
routeState.rpcResult = { data: null, error: { code: "P0001", message: "ANNOUNCEMENT_NOT_TARGETED" } };
const failedWriteResponse = await route.POST(routeRequest("fixture-token"));
assert.equal(failedWriteResponse.status, 503, "DATABASE_FAILURE_MUST_NOT_RETURN_SUCCESS");
assert.notEqual((await failedWriteResponse.json()).success, true);

if (!executeDatabaseFixtures) {
  console.log(JSON.stringify({
    passed: true,
    stage: "L1",
    routeScenarios: 5,
    databaseIntegration: "not_executed",
    networkCalls: 0,
    databaseWrites: 0,
    providerCalls: 0,
    paidCalls: 0,
  }));
} else {
const fixtureTargetUserId = process.env.LOCAL_ANNOUNCEMENT_FIXTURE_TARGET_USER_ID?.trim();
const fixtureNonTargetUserId = process.env.LOCAL_ANNOUNCEMENT_FIXTURE_NON_TARGET_USER_ID?.trim();
assert.ok(fixtureTargetUserId && fixtureNonTargetUserId, "EXPLICIT_DISPOSABLE_FIXTURE_USERS_REQUIRED");
assert.notEqual(fixtureTargetUserId, fixtureNonTargetUserId, "DISTINCT_FIXTURE_USERS_REQUIRED");
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "LOCAL_REST_TARGET_REQUIRED");

function newClient(applicationName) {
  return new pg.Client({
    ...runtime.ownerConnection,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
}

const control = newClient("codex-local-announcement-event-integrity-verification");
const suffix = crypto.randomUUID().replace(/-/gu, "").slice(0, 12);
const announcementId = `event-fixture-${suffix}`;
const eventKey = (event) => `announcement:${announcementId}:r1:${event}:v1`;
let setupCommitted = false;
let targetUserId;
let nonTargetUserId;

async function rpcOnNewConnection(event) {
  const client = newClient(`codex-announcement-event-race-${event}`);
  await client.connect();
  try {
    return (await client.query(
      "SELECT public.record_announcement_delivery_event($1,$2,$3,$4,$5) AS receipt",
      [announcementId, targetUserId, 1, event, eventKey(event)],
    )).rows[0].receipt;
  } finally {
    await client.end();
  }
}

async function expectRpcFailure(params, pattern, label) {
  let error;
  try {
    await control.query(
      "SELECT public.record_announcement_delivery_event($1,$2,$3,$4,$5) AS receipt",
      params,
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}_MUST_FAIL`);
  assert.match(String(error.message || ""), pattern, label);
}

await control.connect();
let databaseReport;
let persistentStateAfterCleanup;
try {
  const identity = (await control.query(
    "SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.deepEqual(identity, {
    database_name: "zimeiti_local",
    server_address: "127.0.0.1",
    server_port: 54322,
  });
  const ledger = (await control.query(
    "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  )).rows[0];
  assert.ok(ledger, "ANNOUNCEMENT_EVENT_MIGRATION_LEDGER_REQUIRED");
  assert.equal(ledger.hash, migrationHash, "ANNOUNCEMENT_EVENT_MIGRATION_HASH_MISMATCH");

  const users = (await control.query(
    `SELECT id
       FROM public.users
      WHERE is_active IS TRUE
        AND coalesce(status, 'active') = 'active'
        AND id::text = ANY($1::text[])
      ORDER BY id`,
    [[fixtureTargetUserId, fixtureNonTargetUserId]],
  )).rows;
  assert.equal(users.length, 2, "TWO_ACTIVE_LOCAL_USERS_REQUIRED");
  targetUserId = fixtureTargetUserId;
  nonTargetUserId = fixtureNonTargetUserId;

  await control.query("BEGIN");
  await control.query(
    `INSERT INTO public.announcements (
       id, title, content, is_active, status, target_audience,
       target_user_ids, push_revision, first_published_at, last_pushed_at
     ) VALUES ($1,$2,$3,true,'published','selected',$4::jsonb,1,clock_timestamp(),clock_timestamp())`,
    [
      announcementId,
      "公告事件完整性本地回滚夹具",
      "只用于本地并发、鉴权和受众验证；验证后删除。",
      JSON.stringify([targetUserId]),
    ],
  );
  await control.query("COMMIT");
  setupCommitted = true;

  await expectRpcFailure(
    [announcementId, nonTargetUserId, 1, "impression", eventKey("impression")],
    /ANNOUNCEMENT_NOT_TARGETED/u,
    "NON_TARGET_USER",
  );
  await expectRpcFailure(
    [announcementId, targetUserId, 2, "impression", `announcement:${announcementId}:r2:impression:v1`],
    /ANNOUNCEMENT_REVISION_CONFLICT/u,
    "STALE_REVISION",
  );
  await expectRpcFailure(
    [announcementId, targetUserId, 1, "impression", `unstable-${suffix}`],
    /ANNOUNCEMENT_EVENT_KEY_INVALID/u,
    "UNSTABLE_EVENT_KEY",
  );
  await expectRpcFailure(
    [announcementId, targetUserId, 1, "read", eventKey("read")],
    /ANNOUNCEMENT_READ_RECEIPT_REQUIRED/u,
    "READ_WITHOUT_RECEIPT",
  );

  const raceReceipts = await Promise.all(
    Array.from({ length: 12 }, () => rpcOnNewConnection("impression")),
  );
  assert.equal(raceReceipts.filter((receipt) => receipt.recorded === true).length, 1, "ONE_RACE_WINNER_REQUIRED");
  assert.equal(raceReceipts.filter((receipt) => receipt.alreadyRecorded === true).length, 11, "RACE_RETRIES_MUST_DEDUPE");
  assert.equal(new Set(raceReceipts.map((receipt) => receipt.eventId)).size, 1, "RACE_EVENT_ID_MUST_BE_STABLE");

  const repeated = await rpcOnNewConnection("impression");
  assert.equal(repeated.recorded, false);
  assert.equal(repeated.alreadyRecorded, true);

  const readReceipt = (await control.query(
    "SELECT public.mark_announcement_read($1,$2,$3) AS receipt",
    [announcementId, targetUserId, 1],
  )).rows[0].receipt;
  assert.equal(readReceipt.success, true);
  const readEvent = await rpcOnNewConnection("read");
  assert.equal(readEvent.recorded, true);

  const otherEvents = await Promise.all([
    rpcOnNewConnection("click"),
    rpcOnNewConnection("close"),
    rpcOnNewConnection("remind_later"),
  ]);
  assert.ok(otherEvents.every((receipt) => receipt.recorded === true));

  const rows = await control.query(
    `SELECT event_type,count(*)::integer AS count
       FROM public.announcement_delivery_events
      WHERE announcement_id=$1 AND revision=1
      GROUP BY event_type
      ORDER BY event_type`,
    [announcementId],
  );
  assert.deepEqual(
    Object.fromEntries(rows.rows.map((row) => [row.event_type, row.count])),
    { click: 1, close: 1, impression: 1, read: 1, remind_later: 1 },
  );

  const totals = (await control.query(
    "SELECT public.get_announcement_event_totals($1,$2) AS totals",
    [announcementId, 1],
  )).rows[0].totals;
  assert.deepEqual(totals.counts, {
    impression: 1,
    read: 1,
    click: 1,
    close: 1,
    remind_later: 1,
  });
  assert.equal(totals.semantics, "unique_account_per_revision_event_v1");
  assert.equal(totals.legacyAnalyticsMerged, false);
  assert.equal(totals.unifiedMessagingBridge, "foundation_only_not_connected");

  const serviceResponse = await fetch(
    `${runtime.supabaseUrl}/rest/v1/rpc/record_announcement_delivery_event`,
    {
      method: "POST",
      headers: {
        apikey: runtime.serviceRoleKey,
        Authorization: `Bearer ${runtime.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_announcement_id: announcementId,
        p_user_id: targetUserId,
        p_revision: 1,
        p_event_type: "impression",
        p_event_key: eventKey("impression"),
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const serviceBody = await serviceResponse.json();
  assert.equal(serviceResponse.status, 200, "SERVICE_ROLE_POSTGREST_RPC_REQUIRED");
  assert.equal(serviceBody.success, true);
  assert.equal(serviceBody.recorded, false);
  assert.equal(serviceBody.alreadyRecorded, true);

  const anonResponse = await fetch(
    `${runtime.supabaseUrl}/rest/v1/rpc/record_announcement_delivery_event`,
    {
      method: "POST",
      headers: {
        apikey: runtime.anonKey,
        Authorization: `Bearer ${runtime.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_announcement_id: announcementId,
        p_user_id: targetUserId,
        p_revision: 1,
        p_event_type: "click",
        p_event_key: eventKey("click"),
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  await anonResponse.arrayBuffer();
  assert.ok([401, 403, 404].includes(anonResponse.status), `ANON_RPC_NOT_DENIED:${anonResponse.status}`);

  databaseReport = {
    identity,
    ledger: {
      version: String(ledger.version),
      name: ledger.name,
      hash: ledger.hash,
      appliedBy: ledger.applied_by,
      appliedAt: ledger.applied_at,
    },
    concurrentAttempts: raceReceipts.length,
    concurrentInserted: 1,
    concurrentDeduplicated: 11,
    stableEventIds: 1,
    nonTargetRejected: true,
    staleRevisionRejected: true,
    unstableEventKeyRejected: true,
    readWithoutReceiptRejected: true,
    aggregate: totals,
    servicePostgrestStatus: serviceResponse.status,
    anonPostgrestStatus: anonResponse.status,
  };
} finally {
  if (setupCommitted) {
    await control.query("BEGIN").catch(() => undefined);
    try {
      await control.query(
        "DELETE FROM public.announcement_delivery_events WHERE announcement_id=$1",
        [announcementId],
      );
      await control.query("DELETE FROM public.announcements WHERE id=$1", [announcementId]);
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } else {
    await control.query("ROLLBACK").catch(() => undefined);
  }
  const residue = (await control.query(
    `SELECT
       (SELECT count(*)::integer FROM public.announcements WHERE id=$1) AS announcements,
       (SELECT count(*)::integer FROM public.announcement_push_runs WHERE announcement_id=$1) AS push_runs,
       (SELECT count(*)::integer FROM public.announcement_user_reads WHERE announcement_id=$1) AS reads,
       (SELECT count(*)::integer FROM public.announcement_delivery_events WHERE announcement_id=$1) AS events`,
    [announcementId],
  )).rows[0];
  assert.deepEqual(residue, { announcements: 0, push_runs: 0, reads: 0, events: 0 }, "FIXTURE_ROLLBACK_REQUIRED");
  persistentStateAfterCleanup = (await control.query(
    `SELECT
       (SELECT count(*)::integer FROM public.announcements) AS announcements,
       (SELECT count(*)::integer FROM public.announcement_push_runs) AS push_runs,
       (SELECT count(*)::integer FROM public.announcement_user_reads) AS reads,
       (SELECT count(*)::integer FROM public.announcement_delivery_events) AS events,
       (SELECT count(*)::integer FROM public.platform_settings WHERE setting_key='announcement_analytics_v2') AS legacy_analytics_rows,
       (SELECT count(*)::integer FROM public.message_campaigns) AS unified_campaigns,
       (SELECT count(*)::integer FROM public.message_deliveries) AS unified_deliveries,
       (SELECT count(*)::integer FROM public.message_events) AS unified_events,
       (SELECT count(*)::integer FROM public.message_outbox) AS unified_outbox`,
  )).rows[0];
  await control.end();
}

const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  migration: MIGRATION_FILE,
  migrationHash,
  route: {
    anonymousDenied: true,
    authorityUnavailableFailsClosed: true,
    revisionAndEventKeyRequired: true,
    actorUserIdBoundServerSide: true,
    databaseFailureReturnsFailure: true,
  },
  database: databaseReport,
  persistentStateAfterCleanup,
  eventSemantics: "unique account + announcement + push revision + event type",
  fixtureResidue: 0,
  providerCalls: 0,
  paidCalls: 0,
  productionWrites: 0,
  buildStarted: false,
  serverStarted: false,
};
const evidenceDir = path.resolve(".codex-evidence", "announcement-event-integrity");
await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(path.join(evidenceDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
}
