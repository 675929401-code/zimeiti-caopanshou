#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const sessionCompat = process.argv.includes("--session-compat");
const version = sessionCompat ? "20261001134000" : "20261001133500";
const name = sessionCompat ? "secure_invited_registration_session_compat" : "invitation_owner_membership_guard";
const file = `${version}_${name}.sql`;
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const bodyOf = (source) => source.replace(/^\uFEFF/u, "").trim()
  .replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes(sessionCompat ? "--confirm-local-session-compat" : "--confirm-local-invitation-owner"),
  sessionCompat ? "LOCAL_SESSION_COMPAT_CONFIRMATION_REQUIRED" : "LOCAL_INVITATION_OWNER_CONFIRMATION_REQUIRED",
);
const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
const source = await fs.readFile(path.resolve("supabase/migrations", file), "utf8");
assert.match(source.replace(/^\uFEFF/u, "").trim(), /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
assert.match(source.replace(/^\uFEFF/u, "").trim(), /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-local-invitation-owner-guard", query_timeout: 45_000 });
await client.connect();
let open = false;
try {
  const identity = (await client.query("SELECT current_database() database_name,inet_server_port() server_port")).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  await client.query("BEGIN");
  open = true;
  const prior = await client.query("SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [version]);
  let action = "already_applied";
  if (prior.rowCount) assert.equal(String(prior.rows[0].hash || ""), hash, `MIGRATION_LEDGER_HASH_CONFLICT:${file}`);
  else {
    await client.query(bodyOf(source));
    await client.query(
      "INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) VALUES($1,$2,$3,$4,$5,now())",
      [version, name, [file], hash, "codex-local-invitation-owner-guard"],
    );
    action = "applied";
  }
  const guard = sessionCompat
    ? (await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
         WHERE pg_namespace.nspname='public' AND proname='register_invited_user_secure_atomic'
           AND pg_get_functiondef(pg_proc.oid) LIKE '%IF NOT EXISTS (%user_auth_sessions%'
       ) AS session_compat_exists`,
    )).rows[0]
    : (await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgname='invitation_codes_owner_eligible_on_consume' AND NOT tgisinternal
       ) AS trigger_exists`,
    )).rows[0];
  assert.equal(
    sessionCompat ? guard.session_compat_exists : guard.trigger_exists,
    true,
    sessionCompat ? "SECURE_SESSION_COMPAT_REQUIRED" : "OWNER_ELIGIBILITY_TRIGGER_REQUIRED",
  );
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  open = false;
  const report = { passed: true, checkedAt: new Date().toISOString(), target: "127.0.0.1:54322/zimeiti_local", migration: { file, hash, action }, guard, productionWrites: 0 };
  const evidenceDir = path.resolve(".codex-evidence", "invitation-security-guard");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, sessionCompat ? "secure-session-compat.json" : "owner-membership-guard.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (open) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
