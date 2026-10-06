#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pg from "pg";

const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));

assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-platform-brand-readonly-audit",
  connectionTimeoutMillis: 10_000,
  query_timeout: 20_000,
});

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  const ledger = (await client.query(
    "SELECT version::text AS version, name, hash, applied_at FROM supabase_migrations.schema_migrations WHERE version::text='20261002120000'",
  )).rows[0] || null;
  const state = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname LIKE 'platform_brand_%' AND c.relkind='r') AS table_count,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname LIKE 'platform_brand_%' AND c.relkind='r' AND c.relrowsecurity) AS rls_table_count,
      (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname = ANY($1::text[])) AS rpc_count,
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
  await client.query("ROLLBACK");

  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: "local-read-only",
    identity: {
      database: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: Number(identity.server_port),
    },
    migration: ledger,
    controlPlane: {
      tableCount: state.table_count,
      rlsTableCount: state.rls_table_count,
      rpcCount: state.rpc_count,
      revisionCount: state.revision_count,
      assetCount: state.asset_count,
      eventCount: state.event_count,
      publicSource: state.published ? "published" : "legacy-fallback",
    },
    writes: 0,
  }, null, 2));
} finally {
  await client.end();
}
