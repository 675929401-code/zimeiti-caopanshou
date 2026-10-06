#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261006113000";
const NAME = "image_async_protocol_binding";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidencePath = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/image-async-protocol-migration-local.json",
);

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-only"), "LOCAL_ONLY_CONFIRMATION_REQUIRED");

const sql = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = sql.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /COMMIT\s*;\s*$/u);
assert.doesNotMatch(normalized, /TRUNCATE\s+|DELETE\s+FROM|DROP\s+TABLE/iu);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const migrationHash = crypto.createHash("sha256").update(sql).digest("hex");

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(runtime.ownerConnection?.port, 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-image-async-protocol-binding",
  query_timeout: 120_000,
});
await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name,inet_server_addr()::text AS server_address,inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.match(identity.server_address, /^127\.0\.0\.1(?:\/32)?$/u);
  assert.equal(Number(identity.server_port), 54322);

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [261006113000]);
  const prior = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let applied = false;
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], migrationHash, "codex-local-image-async-protocol"],
    );
    applied = true;
  }
  await client.query("COMMIT");
  transactionOpen = false;

  const functionDefinition = String((await client.query(
    `SELECT pg_get_functiondef('public.project_model_pool_configuration_atomic(jsonb)'::regprocedure) AS definition`,
  )).rows[0]?.definition || "");
  assert.match(functionDefinition, /images_generations_async/u, "ASYNC_IMAGE_PROTOCOL_NOT_ADMITTED");
  assert.match(functionDefinition, /secure_skill_images_async/u, "SECURE_SKILL_ASYNC_ALIAS_NOT_ADMITTED");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    localDatabaseOnly: true,
    target: `${identity.server_address}:${identity.server_port}/${identity.database_name}`,
    migration: FILE,
    migrationHash,
    applied,
    providerRequests: 0,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, evidencePath: path.relative(process.cwd(), evidencePath).replaceAll("\\", "/") }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
