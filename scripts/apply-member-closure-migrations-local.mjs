#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const migrations = [
  ["20260930130000", "invited_registration_session_authority"],
  ["20260930131500", "wallet_notification_delivery"],
  ["20260930132500", "invited_registration_trigger_compat"],
];
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function bodyOf(source) {
  const normalized = source.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-member-closure"), "LOCAL_MEMBER_CLOSURE_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const sources = [];
for (const [version, name] of migrations) {
  const file = `${version}_${name}.sql`;
  const source = await fs.readFile(path.resolve("supabase/migrations", file), "utf8");
  sources.push({ version, name, file, source, hash: crypto.createHash("sha256").update(source).digest("hex") });
}

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-member-closure-migrations",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});
await client.connect();
let open = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");

  const before = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.invitation_records) AS invitation_records,
       (SELECT count(*)::integer FROM public.user_notifications) AS user_notifications,
       (SELECT count(*)::integer FROM public.user_auth_sessions WHERE revoked_at IS NULL) AS active_sessions`,
  )).rows[0];

  await client.query("BEGIN");
  open = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260930131500]);
  const actions = [];
  for (const migration of sources) {
    const prior = await client.query(
      "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [migration.version],
    );
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), migration.hash, `MIGRATION_LEDGER_HASH_CONFLICT:${migration.file}`);
      actions.push({ file: migration.file, action: "already_applied", hash: migration.hash });
      continue;
    }
    await client.query(bodyOf(migration.source));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [migration.version, migration.name, [migration.file], migration.hash, "codex-local-member-closure"],
    );
    actions.push({ file: migration.file, action: "applied", hash: migration.hash });
  }

  const columns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='invitation_records'
       AND column_name=ANY($1::text[])`,
    [["invitation_code_id", "invitation_code_snapshot"]],
  );
  assert.equal(columns.rowCount, 2, "INVITATION_ATTRIBUTION_COLUMNS_MISSING");
  const functions = await client.query(
    `SELECT proname, prosecdef FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
     WHERE pg_namespace.nspname='public'
       AND proname=ANY($1::text[])`,
    [["register_invited_user_atomic", "enqueue_user_notification_once"]],
  );
  assert.equal(functions.rowCount, 2, "MEMBER_CLOSURE_FUNCTIONS_MISSING");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "MEMBER_CLOSURE_FUNCTION_SECURITY_DEFINER_REQUIRED");
  const dedupeIndex = await client.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='user_notifications_dedupe_key_unique'",
  );
  assert.equal(dedupeIndex.rowCount, 1, "USER_NOTIFICATION_DEDUPE_INDEX_MISSING");
  const sessionAuthority = await client.query(
    `SELECT
       to_regclass('public.user_auth_sessions')::text AS table_name,
       has_table_privilege('service_role', 'public.user_auth_sessions', 'SELECT,INSERT,UPDATE,DELETE') AS service_role_access`,
  );
  assert.equal(sessionAuthority.rows[0]?.table_name, "user_auth_sessions", "USER_AUTH_SESSIONS_TABLE_MISSING");
  assert.equal(sessionAuthority.rows[0]?.service_role_access, true, "USER_AUTH_SESSIONS_SERVICE_ROLE_ACCESS_MISSING");

  // Applied migrations already notify PostgREST, but an already-applied local
  // ledger run must also repair a stale cache after the database stack restarts.
  await client.query("NOTIFY pgrst, 'reload schema'");

  await client.query("COMMIT");
  open = false;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    actions,
    before,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidence = path.resolve(".codex-evidence/member-closure");
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (open) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
