#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261004100000";
const NAME = "video_task_cancellation_control";
const FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const apply = process.argv.includes("--apply");

if (apply) {
  assert.ok(
    process.argv.includes("--confirm-local-video-task-cancellation"),
    "LOCAL_VIDEO_TASK_CANCELLATION_CONFIRMATION_REQUIRED",
  );
}

function transactionBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  const executable = normalized.replace(/^(?:--[^\r\n]*(?:\r?\n|$)\s*)+/u, "");
  assert.match(executable, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(executable, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return executable.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const body = transactionBody(source);
const hash = crypto.createHash("sha256").update(source).digest("hex");
assert.match(source, /CREATE TABLE IF NOT EXISTS public\.video_task_cancel_intents/u);
assert.match(source, /guard_cancelled_video_client_request_trigger/u);
assert.match(source, /request_video_task_cancellation_atomic/u);
assert.match(source, /confirm_video_task_upstream_cancellation_atomic/u);

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-video-task-cancellation",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(identity.server_address, "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('video-task-cancellation:20261004100000',0))");
  const prior = await client.query(
    "SELECT version,name,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1 FOR UPDATE",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    action = apply ? "applied" : "validated_then_rolled_back";
  }

  const table = (await client.query(`
    SELECT c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='video_task_cancel_intents'
  `)).rows[0];
  assert.equal(table?.relrowsecurity, true, "VIDEO_CANCELLATION_RLS_REQUIRED");

  const trigger = (await client.query(`
    SELECT count(*)::integer AS trigger_count
      FROM pg_trigger
     WHERE tgrelid='public.video_tasks'::regclass
       AND tgname='guard_cancelled_video_client_request_trigger'
       AND NOT tgisinternal
  `)).rows[0];
  assert.equal(trigger?.trigger_count, 1, "VIDEO_CANCELLATION_GUARD_TRIGGER_REQUIRED");

  const privileges = (await client.query(`
    SELECT
      has_table_privilege('anon','public.video_task_cancel_intents','SELECT') AS anon_reads,
      has_table_privilege('authenticated','public.video_task_cancel_intents','SELECT') AS authenticated_reads,
      has_table_privilege('service_role','public.video_task_cancel_intents','SELECT') AS service_reads,
      has_function_privilege('anon','public.request_video_task_cancellation_atomic(text,text)','EXECUTE') AS anon_requests,
      has_function_privilege('authenticated','public.request_video_task_cancellation_atomic(text,text)','EXECUTE') AS authenticated_requests,
      has_function_privilege('service_role','public.request_video_task_cancellation_atomic(text,text)','EXECUTE') AS service_requests,
      has_function_privilege('service_role','public.confirm_video_task_upstream_cancellation_atomic(text,text,text,text)','EXECUTE') AS service_confirms
  `)).rows[0];
  assert.equal(privileges.anon_reads, false, "ANON_CANCELLATION_READ_FORBIDDEN");
  assert.equal(privileges.authenticated_reads, false, "AUTHENTICATED_CANCELLATION_READ_FORBIDDEN");
  assert.equal(privileges.service_reads, true, "SERVICE_CANCELLATION_READ_REQUIRED");
  assert.equal(privileges.anon_requests, false, "ANON_CANCELLATION_RPC_FORBIDDEN");
  assert.equal(privileges.authenticated_requests, false, "AUTHENTICATED_CANCELLATION_RPC_FORBIDDEN");
  assert.equal(privileges.service_requests, true, "SERVICE_CANCELLATION_RPC_REQUIRED");
  assert.equal(privileges.service_confirms, true, "SERVICE_CANCELLATION_CONFIRM_RPC_REQUIRED");

  await client.query("SAVEPOINT cancellation_probe");
  const probeUser = `codex-cancel-probe-${Date.now()}`;
  const probeRequest = `cancel-probe-${crypto.randomUUID()}`;
  const first = (await client.query(
    "SELECT public.request_video_task_cancellation_atomic($1,$2) AS result",
    [probeUser, probeRequest],
  )).rows[0]?.result;
  assert.equal(first?.status, "cancelled", "PRE_DISPATCH_CANCELLATION_REQUIRED");
  assert.equal(first?.task_found, false, "PRE_DISPATCH_TASK_MUST_BE_ABSENT");
  assert.equal(first?.upstream_required, false, "PRE_DISPATCH_UPSTREAM_MUST_NOT_BE_REQUIRED");
  assert.equal(first?.cancellation_state, "cancelled_before_dispatch", "PRE_DISPATCH_TOMBSTONE_REQUIRED");
  const second = (await client.query(
    "SELECT public.request_video_task_cancellation_atomic($1,$2) AS result",
    [probeUser, probeRequest],
  )).rows[0]?.result;
  assert.equal(second?.cancellation_state, "cancelled_before_dispatch", "CANCELLATION_IDEMPOTENCY_REQUIRED");
  await client.query("ROLLBACK TO SAVEPOINT cancellation_probe");

  if (apply && !prior.rowCount) {
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-video-task-cancellation"],
    );
  }
  if (apply) {
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    migration: FILE,
    hash,
    action,
    localDatabase: `${identity.database_name}@${identity.server_address}:${identity.server_port}`,
    assertions: 18,
    providerCalls: 0,
    paidCalls: 0,
    productionWrites: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "video-task-cancellation-local");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, apply ? "apply.json" : "migration-check.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
