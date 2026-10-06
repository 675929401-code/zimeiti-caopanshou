#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const version = "20261001043000";
const name = "one_time_invitation_codes";
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
assert.ok(process.argv.includes("--confirm-local-one-time-invitation"), "LOCAL_ONE_TIME_INVITATION_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", file), "utf8");
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-one-time-invitation-migration",
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
       count(*)::integer AS total_codes,
       count(*) FILTER (WHERE is_used IS FALSE)::integer AS open_codes,
       count(*) FILTER (WHERE is_permanent IS TRUE)::integer AS permanent_codes
     FROM public.invitation_codes`,
  )).rows[0];

  await client.query("BEGIN");
  open = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [261001043000]);
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
      [version, name, [file], hash, "codex-local-one-time-invitation"],
    );
    action = "applied";
  }

  const schema = (await client.query(
    `SELECT column_default,is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='invitation_codes' AND column_name='is_permanent'`,
  )).rows[0];
  assert.match(String(schema.column_default), /false/u, "ONE_TIME_DEFAULT_FALSE_REQUIRED");
  assert.equal(schema.is_nullable, "NO", "ONE_TIME_NOT_NULL_REQUIRED");

  const functions = await client.query(
    `SELECT proname,prosecdef
       FROM pg_proc JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
      WHERE pg_namespace.nspname='public'
        AND proname=ANY($1::text[])`,
    [["create_one_time_invitation_code", "register_invited_user_atomic"]],
  );
  assert.equal(functions.rowCount, 2, "ONE_TIME_FUNCTIONS_REQUIRED");
  assert.ok(functions.rows.every((row) => row.prosecdef === true), "SECURITY_DEFINER_REQUIRED");

  const invariant = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.invitation_codes WHERE is_permanent IS TRUE) AS permanent_codes,
       (SELECT count(*)::integer FROM (
          SELECT user_id FROM public.invitation_codes WHERE is_used IS FALSE GROUP BY user_id HAVING count(*) > 1
        ) duplicate_open) AS duplicate_open_owners,
       to_regclass('public.invitation_codes_one_open_per_user')::text AS open_index`,
  )).rows[0];
  assert.equal(Number(invariant.permanent_codes), 0, "PERMANENT_CODES_MUST_BE_ZERO");
  assert.equal(Number(invariant.duplicate_open_owners), 0, "ONE_OPEN_CODE_PER_OWNER_REQUIRED");
  assert.equal(invariant.open_index, "invitation_codes_one_open_per_user", "OPEN_CODE_UNIQUE_INDEX_REQUIRED");

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  open = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: { file, hash, action },
    before,
    after: invariant,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "one-time-invitation");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (open) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
