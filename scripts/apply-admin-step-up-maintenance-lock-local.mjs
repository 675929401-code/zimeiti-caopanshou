#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261005183000";
const NAME = "admin_step_up_maintenance_lock";
const FILE = `${VERSION}_${NAME}.sql`;
const CACHE_VERSION = "20261005183500";
const CACHE_NAME = "admin_step_up_maintenance_lock_schema_cache";
const CACHE_FILE = `${CACHE_VERSION}_${CACHE_NAME}.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");

assert.notEqual(dryRun, execute, "CHOOSE_EXACTLY_ONE_OF_DRY_RUN_OR_EXECUTE");
assert.ok(process.argv.includes("--confirm-local-admin-maintenance-lock"), "LOCAL_ADMIN_MAINTENANCE_LOCK_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.admin_step_up_maintenance_lock/u, "MAINTENANCE_TABLE_REQUIRED");
assert.match(normalized, /read_admin_step_up_session\([\s\S]*'admin\.accounts\.manage'/u, "DATABASE_STEP_UP_PROOF_REQUIRED");
assert.match(normalized, /v_duration < 1 OR v_duration > 30/u, "THIRTY_MINUTE_LIMIT_REQUIRED");
assert.match(normalized, /admin_step_up_maintenance_(?:enable|disable)/u, "AUDIT_ACTIONS_REQUIRED");
assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");
const cacheSource = await fs.readFile(path.resolve("supabase/migrations", CACHE_FILE), "utf8");
const cacheNormalized = cacheSource.replace(/^\uFEFF/u, "").trim();
assert.match(cacheNormalized, /^BEGIN\s*;/u, "SCHEMA_CACHE_MIGRATION_BEGIN_REQUIRED");
assert.match(cacheNormalized, /NOTIFY pgrst, 'reload schema'/u, "POSTGREST_SCHEMA_CACHE_RELOAD_REQUIRED");
assert.match(cacheNormalized, /COMMIT\s*;\s*$/u, "SCHEMA_CACHE_MIGRATION_COMMIT_REQUIRED");
const cacheBody = cacheNormalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const cacheHash = crypto.createHash("sha256").update(cacheSource).digest("hex");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-admin-maintenance-lock",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
try {
  const identity = (await client.query(
    "SELECT host(inet_server_addr()) AS server_address, inet_server_port() AS server_port, current_database() AS database_name",
  )).rows[0];
  assert.equal(identity.server_address, "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");

  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-step-up-maintenance-lock:20261005183000',0))");
  const prior = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1 FOR UPDATE",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-admin-maintenance-lock"],
    );
    action = "applied";
  }

  const cachePrior = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1 FOR UPDATE",
    [CACHE_VERSION],
  );
  let cacheAction = "already_applied";
  if (cachePrior.rowCount) {
    assert.equal(String(cachePrior.rows[0].hash || ""), cacheHash, "SCHEMA_CACHE_MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(cacheBody);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [CACHE_VERSION, CACHE_NAME, [CACHE_FILE], cacheHash, "codex-local-admin-maintenance-lock"],
    );
    cacheAction = "applied";
  }

  const state = (await client.query("SELECT public.read_admin_step_up_maintenance_lock() AS state")).rows[0]?.state;
  assert.equal(state?.status, "ready", "MAINTENANCE_STATE_READY_REQUIRED");
  assert.equal(state?.enabled, false, "MAINTENANCE_DEFAULT_OFF_REQUIRED");
  assert.equal(Number(state?.max_duration_minutes), 30, "MAINTENANCE_MAX_DURATION_REQUIRED");
  const functionDefinition = String((await client.query(
    "SELECT pg_get_functiondef('public.set_admin_step_up_maintenance_lock(text,boolean,text,integer,integer,text,text,text,text,text,text)'::regprocedure) AS definition",
  )).rows[0]?.definition || "");
  assert.match(functionDefinition, /read_admin_step_up_session/u, "MAINTENANCE_STEP_UP_PROOF_FUNCTION_REQUIRED");
  assert.match(functionDefinition, /admin_step_up_maintenance_enable/u, "MAINTENANCE_ENABLE_AUDIT_REQUIRED");

  if (dryRun) await client.query("ROLLBACK");
  else await client.query("COMMIT");
  console.log(JSON.stringify({
    passed: true,
    mode: dryRun ? "transactional_dry_run" : "execute",
    target: "127.0.0.1:54322/zimeiti_local",
    migrations: [
      { file: FILE, hash, action: dryRun && action === "applied" ? "validated_then_rolled_back" : action },
      { file: CACHE_FILE, hash: cacheHash, action: dryRun && cacheAction === "applied" ? "validated_then_rolled_back" : cacheAction },
    ],
    defaultEnabled: state.enabled,
    maxDurationMinutes: state.max_duration_minutes,
    productionWrites: 0,
    committedDatabaseWrites: dryRun ? 0 : [action, cacheAction].filter((value) => value === "applied").length,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
