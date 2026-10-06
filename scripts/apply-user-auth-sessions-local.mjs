#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260927103000";
const NAME = "user_auth_sessions_two_device_limit";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-auth-sessions"), "LOCAL_AUTH_SESSION_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-auth-session-migration",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260927103000]);
  const ledger = await client.query(
    "SELECT version, hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (ledger.rowCount) {
    assert.equal(String(ledger.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(migrationBody(source));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [MIGRATION_FILE], hash, "codex-local-auth-sessions"],
    );
    action = "applied";
  }

  const table = await client.query("SELECT to_regclass('public.user_auth_sessions')::text AS name");
  assert.equal(table.rows[0]?.name, "user_auth_sessions", "AUTH_SESSION_TABLE_MISSING");
  const functions = await client.query(
    `SELECT proname, prosecdef FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public' AND proname=ANY($1::text[]) ORDER BY proname`,
    [["issue_user_auth_session", "revoke_user_auth_session", "revoke_sessions_on_legacy_session_clear"]],
  );
  assert.equal(functions.rowCount, 3, "AUTH_SESSION_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "AUTH_SESSION_FUNCTION_NOT_SECURITY_DEFINER");
  const trigger = await client.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='users_legacy_session_authority' AND NOT tgisinternal",
  );
  assert.equal(trigger.rowCount, 1, "AUTH_SESSION_TRIGGER_MISSING");

  await client.query("COMMIT");
  transactionOpen = false;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationHash: hash,
    action,
    providerRequests: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "auth-two-session");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
