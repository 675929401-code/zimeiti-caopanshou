#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001013000";
const NAME = "llm_model_validation_activation_gate";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");
assert.notEqual(dryRun, execute, "CHOOSE_EXACTLY_ONE_OF_DRY_RUN_OR_EXECUTE");
assert.ok(process.argv.includes("--confirm-local-llm-validation-gate"), "LOCAL_LLM_VALIDATION_GATE_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /CREATE TABLE IF NOT EXISTS public\.llm_model_validation_evidence/u);
assert.match(normalized, /project_model_pool_configuration_atomic_before_llm_gate/u);
assert.match(normalized, /credential|api_key/iu);
assert.match(normalized, /COMMIT\s*;\s*$/u);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-llm-validation-gate",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('llm-model-validation-gate:20261001013000',0))");
  const prior = await client.query("SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-llm-validation-gate"],
    );
    action = "applied";
  }
  const identity = (await client.query(
    `SELECT
       to_regclass('public.llm_model_validation_evidence') IS NOT NULL AS evidence_table,
       to_regprocedure('public.project_model_pool_configuration_atomic(jsonb)') IS NOT NULL AS projection_rpc,
       to_regprocedure('public.project_model_pool_configuration_atomic_before_llm_gate(jsonb)') IS NOT NULL AS preserved_projection`,
  )).rows[0];
  assert.deepEqual(identity, { evidence_table: true, projection_rpc: true, preserved_projection: true });
  if (dryRun) await client.query("ROLLBACK");
  else await client.query("COMMIT");
  console.log(JSON.stringify({
    passed: true,
    mode: dryRun ? "transactional_dry_run" : "execute",
    migration: FILE,
    hash,
    action: dryRun && action === "applied" ? "validated_then_rolled_back" : action,
    identity,
    credentialValuesPrinted: false,
    productionWrites: 0,
    committedDatabaseWrites: dryRun ? 0 : action === "applied" ? 1 : 0,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
