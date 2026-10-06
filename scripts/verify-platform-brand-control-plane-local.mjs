#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002120000";
const FILE = `${VERSION}_platform_brand_control_plane.sql`;
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "LOCAL_REST_TARGET_REQUIRED");
assert.ok(typeof runtime.serviceRoleKey === "string" && runtime.serviceRoleKey.length > 20, "LOCAL_SERVICE_ROLE_KEY_REQUIRED");
assert.ok(typeof runtime.anonKey === "string" && runtime.anonKey.length > 20, "LOCAL_ANON_KEY_REQUIRED");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const rollbackSource = await fs.readFile(
  path.resolve("supabase/rollbacks", `${VERSION}_platform_brand_control_plane.rollback.sql`),
  "utf8",
);
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-local-platform-brand-control-plane",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

await client.connect();
let database;
let rollbackRehearsal;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  assert.deepEqual(identity, {
    database_name: "zimeiti_local",
    server_address: "127.0.0.1",
    server_port: 54322,
  });

  const ledger = (await client.query(`
    SELECT version,name,hash,applied_by,applied_at
      FROM supabase_migrations.schema_migrations
     WHERE version::text=$1
  `, [VERSION])).rows[0];
  assert.ok(ledger, "PLATFORM_BRAND_MIGRATION_LEDGER_REQUIRED");
  assert.equal(ledger.hash, migrationHash, "PLATFORM_BRAND_MIGRATION_HASH_MISMATCH");

  const state = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname LIKE 'platform_brand_%' AND c.relkind='r') AS table_count,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname LIKE 'platform_brand_%' AND c.relkind='r' AND c.relrowsecurity) AS rls_table_count,
      (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname = ANY($1::text[])) AS rpc_count,
      (SELECT count(*)::integer FROM public.platform_brand_events
        WHERE request_key LIKE 'local-brand-probe-%') AS probe_event_count,
      (SELECT count(*)::integer FROM public.platform_brand_revisions) AS revision_count,
      (SELECT count(*)::integer FROM public.platform_brand_assets) AS asset_count,
      (SELECT count(*)::integer FROM public.platform_brand_events) AS event_count,
      public.read_published_platform_brand() AS published
  `, [[
    "save_platform_brand_draft_atomic",
    "publish_platform_brand_revision_atomic",
    "rollback_platform_brand_revision_atomic",
    "register_platform_brand_asset_atomic",
    "read_published_platform_brand",
    "read_published_platform_brand_asset",
  ]])).rows[0];
  assert.equal(state.table_count, 5, "PLATFORM_BRAND_TABLE_COUNT");
  assert.equal(state.rls_table_count, 5, "PLATFORM_BRAND_RLS_TABLE_COUNT");
  assert.equal(state.rpc_count, 6, "PLATFORM_BRAND_RPC_COUNT");
  assert.equal(state.probe_event_count, 0, "PLATFORM_BRAND_PROBE_RESIDUE");

  if (state.revision_count === 0 && state.asset_count === 0 && state.event_count === 0) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-brand-control-plane:rollback-rehearsal',0))");
      await client.query(rollbackSource);
      const removed = (await client.query(`
        SELECT to_regclass('public.platform_brand_profiles') IS NULL AS profiles_removed,
               to_regclass('public.platform_brand_revisions') IS NULL AS revisions_removed,
               to_regprocedure('public.read_published_platform_brand()') IS NULL AS public_rpc_removed
      `)).rows[0];
      assert.deepEqual(removed, {
        profiles_removed: true,
        revisions_removed: true,
        public_rpc_removed: true,
      });
      rollbackRehearsal = { passed: true, persisted: false, skipped: false };
    } finally {
      await client.query("ROLLBACK");
    }
    const restored = (await client.query(
      "SELECT to_regclass('public.platform_brand_profiles')::text AS profiles, to_regprocedure('public.read_published_platform_brand()')::text AS public_rpc",
    )).rows[0];
    assert.equal(restored.profiles, "platform_brand_profiles");
    assert.equal(restored.public_rpc, "read_published_platform_brand()");
  } else {
    rollbackRehearsal = {
      passed: true,
      persisted: false,
      skipped: true,
      reason: "protected_brand_data_present",
    };
  }

  database = {
    identity: {
      databaseName: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: identity.server_port,
    },
    ledger: {
      version: String(ledger.version),
      name: ledger.name,
      hash: ledger.hash,
      appliedBy: ledger.applied_by,
      appliedAt: ledger.applied_at,
    },
    tableCount: state.table_count,
    rlsTableCount: state.rls_table_count,
    rpcCount: state.rpc_count,
    probeEventCount: state.probe_event_count,
    revisionCount: state.revision_count,
    assetCount: state.asset_count,
    eventCount: state.event_count,
    publishedSource: state.published ? "published" : "legacy-fallback",
  };
} finally {
  await client.end();
}

async function callPublishedBrand(key) {
  return fetch(`${runtime.supabaseUrl}/rest/v1/rpc/read_published_platform_brand`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
}

const serviceResponse = await callPublishedBrand(runtime.serviceRoleKey);
const serviceBody = await serviceResponse.text();
assert.equal(serviceResponse.status, 200, `LOCAL_POSTGREST_SERVICE_RPC_FAILED:${serviceResponse.status}`);
const publicBrand = JSON.parse(serviceBody);

const anonResponse = await callPublishedBrand(runtime.anonKey);
await anonResponse.arrayBuffer();
assert.ok([401, 403].includes(anonResponse.status), `LOCAL_POSTGREST_ANON_RPC_NOT_DENIED:${anonResponse.status}`);

const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  target: "127.0.0.1:54322/zimeiti_local",
  migration: FILE,
  migrationHash,
  database,
  rollbackRehearsal,
  postgrest: {
    target: "http://127.0.0.1:54321",
    serviceRoleRpcStatus: serviceResponse.status,
    anonRpcStatus: anonResponse.status,
    publishedSource: publicBrand ? "published" : "legacy-fallback",
    credentialsPrinted: false,
  },
  productionWrites: 0,
  paidCalls: 0,
};
const evidenceDir = path.resolve(".codex-evidence", "platform-brand-control-plane");
await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(path.join(evidenceDir, "backend-verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
