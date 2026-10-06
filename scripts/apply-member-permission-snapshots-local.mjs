#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001003000";
const NAME = "member_permission_snapshots";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-member-permissions"), "LOCAL_MEMBER_PERMISSION_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const source = await fs.readFile(migrationPath, "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.member_permission_assignments/u);
assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.member_permission_events/u);
assert.match(normalized, /set_member_permissions_atomic/u);
assert.match(normalized, /MEMBER_PERMISSION_DIRECT_WRITE_FORBIDDEN/u);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const migrationHash = crypto.createHash("sha256").update(source).digest("hex");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-member-permission-snapshots",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");

  const before = (await client.query("SELECT count(*)::integer AS users FROM public.users")).rows[0];
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('member-permission-snapshots:20261001003000',0))");
  assert.equal((await client.query("SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name")).rows[0]?.name, "supabase_migrations.schema_migrations", "MIGRATION_LEDGER_REQUIRED");
  const prior = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-member-permissions"],
    );
    action = "applied";
  }

  const schema = (await client.query(
    `SELECT
       to_regclass('public.member_permission_profiles')::text AS profiles,
       to_regclass('public.member_permission_assignments')::text AS assignments,
       to_regclass('public.member_permission_events')::text AS events`,
  )).rows[0];
  assert.equal(schema.profiles, "member_permission_profiles", "PERMISSION_PROFILES_MISSING");
  assert.equal(schema.assignments, "member_permission_assignments", "PERMISSION_ASSIGNMENTS_MISSING");
  assert.equal(schema.events, "member_permission_events", "PERMISSION_EVENTS_MISSING");
  const functions = await client.query(
    `SELECT proname,prosecdef FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public' AND proname=ANY($1::text[])`,
    [["read_member_permission_snapshot", "set_member_permissions_atomic", "sync_member_permission_from_user"]],
  );
  assert.equal(functions.rowCount, 3, "PERMISSION_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "PERMISSION_SECURITY_DEFINER_REQUIRED");
  const counts = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.users WHERE role <> 'admin') AS ordinary_users,
       (SELECT count(*)::integer FROM public.member_permission_assignments) AS assignments,
       (SELECT count(*)::integer FROM public.member_permission_profiles WHERE is_active) AS profiles,
       (SELECT count(*)::integer FROM public.member_permission_assignments a
          WHERE a.checksum = public.member_permission_checksum(a.user_id,a.feature_navigation_keys,a.agent_navigation_keys,a.revision)) AS valid_checksums`,
  )).rows[0];
  assert.equal(Number(counts.assignments), Number(counts.ordinary_users), "ORDINARY_USER_SNAPSHOT_COVERAGE_REQUIRED");
  assert.equal(Number(counts.valid_checksums), Number(counts.assignments), "PERMISSION_CHECKSUMS_INVALID");
  assert.ok(Number(counts.profiles) >= 3, "PERMISSION_PROFILES_REQUIRED");
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationHash,
    action,
    before,
    counts,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "member-permission-snapshots");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

