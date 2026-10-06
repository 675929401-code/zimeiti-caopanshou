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
  application_name: "codex-unified-messaging-readonly-audit",
  connectionTimeoutMillis: 10_000,
  query_timeout: 20_000,
});

const legacyTables = ["announcements", "user_notifications", "popup_pushes", "platform_settings"];
const newTables = [
  "message_templates",
  "message_surface_policies",
  "message_campaigns",
  "message_campaign_runs",
  "message_deliveries",
  "message_events",
  "message_outbox",
  "message_dead_letters",
];
const migrationVersions = ["20260929093000", "20260930131500", "20261002150000"];
const functionNames = [
  "mark_announcement_read",
  "repush_announcement_atomic",
  "get_announcement_delivery_status",
  "enqueue_user_notification_once",
  "enqueue_message_outbox_atomic",
  "claim_message_outbox_batch",
  "settle_message_outbox_attempt",
  "get_unified_messaging_status",
];

async function tableState(table) {
  const relation = await client.query("SELECT to_regclass($1) AS relation", [`public.${table}`]);
  const exists = Boolean(relation.rows[0]?.relation);
  if (!exists) return { table, exists, rowCount: null, columns: [] };
  const [countResult, columnsResult] = await Promise.all([
    client.query(`SELECT count(*)::bigint AS count FROM public.${table}`),
    client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [table],
    ),
  ]);
  return {
    table,
    exists,
    rowCount: Number(countResult.rows[0]?.count || 0),
    columns: columnsResult.rows.map((row) => row.column_name),
  };
}

let connected = false;
try {
  await client.connect();
  connected = true;
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, pg_is_in_recovery() AS in_recovery",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  await client.query("BEGIN READ ONLY");
  const tables = [];
  for (const table of [...legacyTables, ...newTables]) {
    tables.push(await tableState(table));
  }
  const functions = await client.query(
    `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=ANY($1::text[])
     ORDER BY p.proname, arguments`,
    [functionNames],
  );
  const migrations = await client.query(
    `SELECT version::text AS version, hash
     FROM supabase_migrations.schema_migrations
     WHERE version::text=ANY($1::text[])
     ORDER BY version`,
    [migrationVersions],
  );
  const videoNotificationSetting = await client.query(
    `SELECT count(*)::integer AS count
     FROM public.platform_settings
     WHERE setting_key='video_notifications'`,
  );
  await client.query("ROLLBACK");

  const report = {
    schemaVersion: 1,
    mode: "local-read-only",
    identity: {
      database: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: Number(identity.server_port),
      inRecovery: identity.in_recovery === true,
    },
    migrations: migrationVersions.map((version) => {
      const found = migrations.rows.find((row) => row.version === version);
      return { version, applied: Boolean(found), hash: found?.hash || null };
    }),
    tables,
    functions: functions.rows,
    videoNotificationSettingRows: Number(videoNotificationSetting.rows[0]?.count || 0),
    writes: 0,
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schemaVersion: 1,
    mode: "local-read-only",
    reachable: false,
    error: error instanceof Error ? error.message : "LOCAL_DATABASE_AUDIT_FAILED",
    writes: 0,
  }, null, 2));
  process.exitCode = 2;
} finally {
  if (connected) await client.end();
}
