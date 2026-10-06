#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260926094500";
const MIGRATION_FILE = `${VERSION}_storyboard_image_protocol_contracts.sql`;
const TARGET_IDS = [
  "pending-cover-model-1789087539302-c79bd2865ca4",
  "pending-cover-model-1789087566193-f4a5f4f1190f",
  "gemini-3-1-flash-image-chA",
  "gemini-3-0-pro-image-chA",
  "cover-model-seedream-5-pro",
];
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.doesNotMatch(normalized, /TRUNCATE\s+|DELETE\s+FROM|DROP\s+TABLE/iu, "MIGRATION_SCOPE_REJECTED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

function config(row) {
  return row.api_protocol_config && typeof row.api_protocol_config === "object" ? row.api_protocol_config : {};
}

async function readRows(client) {
  const result = await client.query(`SELECT id,provider,model_name,api_protocol_config
    FROM public.cover_models WHERE id=ANY($1::text[]) ORDER BY id`, [TARGET_IDS]);
  assert.equal(result.rowCount, TARGET_IDS.length, "TARGET_IMAGE_MODELS_MISSING");
  return result.rows;
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-storyboard-image-protocols"), "LOCAL_PROTOCOL_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
const sql = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const body = migrationBody(sql);
const migrationHash = sha256(sql);
const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-storyboard-image-protocol-contracts", query_timeout: 30_000 });
await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query("SELECT current_database() AS database_name,inet_server_addr()::text AS server_address,inet_server_port() AS server_port")).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  await readRows(client);
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260926094500]);
  const prior = await client.query("SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
      VALUES($1,$2,$3,$4,$5,now())`, [VERSION, "storyboard_image_protocol_contracts", [MIGRATION_FILE], migrationHash, "codex-local-storyboard-image-protocols"]);
  }
  await client.query("COMMIT");
  transactionOpen = false;

  const after = await readRows(client);
  const byId = new Map(after.map((row) => [row.id, row]));
  const fixed4k = config(byId.get("pending-cover-model-1789087566193-f4a5f4f1190f"));
  assert.deepEqual(fixed4k.resolution_options, ["4K"]);
  assert.equal(fixed4k.default_resolution, "4K");
  assert.equal(fixed4k.protocol, "images_generations");
  assert.equal(config(byId.get("pending-cover-model-1789087539302-c79bd2865ca4")).protocol, "images_generations");
  assert.equal(config(byId.get("gemini-3-1-flash-image-chA")).protocol, "chat_completions");
  assert.equal(config(byId.get("gemini-3-0-pro-image-chA")).protocol, "chat_completions");
  const seedream = config(byId.get("cover-model-seedream-5-pro"));
  assert.equal(seedream.protocol, "volcengine_images_v3");
  assert.deepEqual(seedream.resolution_options, ["2K"]);
  assert.deepEqual(seedream.result_delivery_hosts, ["ark-acg-cn-beijing.tos-cn-beijing.volces.com"]);

  console.log(JSON.stringify({
    passed: true,
    localDatabaseOnly: true,
    database: identity.database_name,
    serverAddress: identity.server_address,
    serverPort: identity.server_port,
    migration: MIGRATION_FILE,
    migrationHash,
    configuredModels: after.map((row) => ({
      id: row.id,
      provider: row.provider,
      modelName: row.model_name,
      protocol: config(row).protocol,
      resolutions: config(row).resolution_options,
    })),
    providerCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
