#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261006014500";
const NAME = "llm_endpoint_normalized_activation_projection";
const FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");
assert.notEqual(dryRun, execute, "CHOOSE_EXACTLY_ONE_OF_DRY_RUN_OR_EXECUTE");
assert.ok(process.argv.includes("--confirm-local-llm-endpoint-projection"), "LOCAL_LLM_ENDPOINT_PROJECTION_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
assert.ok(normalized.includes("deductDeepThink}', '')::numeric"), "FRACTIONAL_NUMERIC_CAST_MUST_SURVIVE");
assert.equal((normalized.match(/regexp_replace\(coalesce\([^\n]+\), '\/\+\$', ''\)/gu) || []).length, 3, "THREE_ENDPOINT_NORMALIZATIONS_REQUIRED");
assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");
const database = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-llm-endpoint-normalized-projection",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await database.connect();
try {
  await database.query("BEGIN");
  await database.query("SELECT pg_advisory_xact_lock(hashtextextended('llm-endpoint-normalized-projection:20261006014500',0))");
  const prior = await database.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await database.query(body);
    await database.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-llm-endpoint-normalized-projection"],
    );
    action = "applied";
  }
  const definition = String((await database.query(
    "SELECT pg_get_functiondef('public.project_model_pool_configuration_atomic(jsonb)'::regprocedure) AS definition",
  )).rows[0]?.definition || "");
  assert.ok(definition.includes("deductDeepThink}', '')::numeric"), "LIVE_FRACTIONAL_NUMERIC_CAST_REQUIRED");
  assert.equal((definition.match(/regexp_replace\(coalesce\([^\n]+\), '\/\+\$', ''\)/gu) || []).length, 3, "LIVE_ENDPOINT_NORMALIZATIONS_REQUIRED");
  if (dryRun) await database.query("ROLLBACK");
  else await database.query("COMMIT");
  console.log(JSON.stringify({
    passed: true,
    mode: dryRun ? "transactional_dry_run" : "execute",
    migration: FILE,
    hash,
    action: dryRun && action === "applied" ? "validated_then_rolled_back" : action,
    endpointComparisonsNormalized: 3,
    productionWrites: 0,
    committedDatabaseWrites: dryRun ? 0 : action === "applied" ? 1 : 0,
  }, null, 2));
} catch (error) {
  await database.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await database.end();
}
