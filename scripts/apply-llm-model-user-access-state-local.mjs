#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001014000";
const NAME = "llm_model_user_access_activation_state";
const FILE = VERSION + "_" + NAME + ".sql";
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");
assert.notEqual(dryRun, execute, "CHOOSE_EXACTLY_ONE_OF_DRY_RUN_OR_EXECUTE");
assert.ok(process.argv.includes("--confirm-local-llm-user-access"), "LOCAL_LLM_USER_ACCESS_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /ALTER COLUMN user_access TYPE character varying\(32\)/u);
assert.match(normalized, /COMMIT\s*;\s*$/u);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-llm-user-access-state",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('llm-user-access-state:20261001014000',0))");
  const prior = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      "INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) "
      + "VALUES($1,$2,$3,$4,$5,now())",
      [VERSION, NAME, [FILE], hash, "codex-local-llm-user-access-state"],
    );
    action = "applied";
  }
  const identity = (await client.query(
    "SELECT data_type, character_maximum_length, column_default "
    + "FROM information_schema.columns "
    + "WHERE table_schema='public' AND table_name='llm_models' AND column_name='user_access'",
  )).rows[0];
  assert.equal(identity?.data_type, "character varying");
  assert.equal(Number(identity?.character_maximum_length), 32);
  assert.match(String(identity?.column_default || ""), /available/u);
  if (dryRun) await client.query("ROLLBACK");
  else await client.query("COMMIT");
  console.log(JSON.stringify({
    passed: true,
    mode: dryRun ? "transactional_dry_run" : "execute",
    migration: FILE,
    hash,
    action: dryRun && action === "applied" ? "validated_then_rolled_back" : action,
    column: { dataType: identity.data_type, maximumLength: Number(identity.character_maximum_length) },
    productionWrites: 0,
    committedDatabaseWrites: dryRun ? 0 : action === "applied" ? 1 : 0,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
