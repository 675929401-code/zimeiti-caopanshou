#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260925054500";
const NAME = "platform_configuration_versioning";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-platform-config"), "LOCAL_PLATFORM_CONFIG_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
assert.match(source, /CREATE TABLE IF NOT EXISTS public\.model_pool_config_releases/u);
assert.match(source, /CREATE TABLE IF NOT EXISTS public\.workspace_model_config_releases/u);
assert.match(source, /CREATE TABLE IF NOT EXISTS public\.platform_model_credential_bindings/u);
assert.match(source, /REVOKE ALL ON public\.platform_model_credential_bindings FROM PUBLIC, anon, authenticated/u);
assert.match(source, /CREATE OR REPLACE FUNCTION public\.publish_platform_configuration_release_atomic/u);
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-platform-configuration-versioning",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration-versioning:20260925054500',0))");
  const prior = await client.query("SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(source);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-platform-configuration"],
    );
    action = "applied";
  }
  const identity = (await client.query(
    `SELECT
       to_regclass('public.model_pool_config_releases') IS NOT NULL AS pool,
       to_regclass('public.workspace_model_config_releases') IS NOT NULL AS workspace,
       to_regclass('public.platform_model_credential_bindings') IS NOT NULL AS bindings,
       to_regprocedure('public.create_platform_configuration_candidate_atomic(text,uuid,jsonb,text,jsonb,text,text,uuid,uuid)') IS NOT NULL AS candidate_rpc,
       to_regprocedure('public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text)') IS NOT NULL AS publish_rpc`,
  )).rows[0];
  assert.deepEqual(identity, { pool: true, workspace: true, bindings: true, candidate_rpc: true, publish_rpc: true });
  await client.query("COMMIT");
  console.log(JSON.stringify({
    passed: true,
    migration: FILE,
    hash,
    action,
    identity,
    credentialValuesPrinted: false,
    productionWrites: 0,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
