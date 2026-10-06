#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const version = "20261001133000";
const name = "invitation_security_guard";
const file = `${version}_${name}.sql`;
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function bodyOf(source) {
  const normalized = source.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-invitation-security"), "LOCAL_INVITATION_SECURITY_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", file), "utf8");
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-invitation-security-migration",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
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

  await client.query("BEGIN");
  open = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [261001133000]);
  const prior = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [version],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, `MIGRATION_LEDGER_HASH_CONFLICT:${file}`);
  } else {
    await client.query(bodyOf(source));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [version, name, [file], hash, "codex-local-invitation-security"],
    );
    action = "applied";
  }

  const schema = (await client.query(
    `SELECT
       to_regclass('public.invitation_security_policies')::text AS policy_table,
       to_regclass('public.invitation_risk_reviews')::text AS review_table,
       to_regclass('public.invitation_records_registration_ip_idx')::text AS ip_index,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='invitation_records'
           AND column_name='automatic_trial_eligible'
       ) AS risk_columns`,
  )).rows[0];
  assert.equal(schema.policy_table, "invitation_security_policies");
  assert.equal(schema.review_table, "invitation_risk_reviews");
  assert.equal(schema.ip_index, "invitation_records_registration_ip_idx");
  assert.equal(schema.risk_columns, true);

  const functions = await client.query(
    `SELECT proname,prosecdef
       FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
      WHERE pg_namespace.nspname='public'
        AND proname=ANY($1::text[])`,
    [[
      "set_invitation_security_policy_atomic",
      "get_invitation_code_quota",
      "create_one_time_invitation_code",
      "register_invited_user_secure_atomic",
      "review_invitation_risk_atomic",
    ]],
  );
  assert.equal(functions.rowCount, 5, "INVITATION_SECURITY_FUNCTIONS_REQUIRED");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "SECURITY_DEFINER_REQUIRED");

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  open = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: { file, hash, action },
    schema,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "invitation-security-guard");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (open) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
