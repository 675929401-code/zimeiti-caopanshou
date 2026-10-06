#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261003091500";
const NAME = "admin_wallet_member_dependency";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const apply = process.argv.includes("--apply");

if (apply) {
  assert.ok(
    process.argv.includes("--confirm-local-admin-wallet-member-dependency"),
    "LOCAL_ADMIN_WALLET_MEMBER_DEPENDENCY_CONFIRMATION_REQUIRED",
  );
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-admin-wallet-member-dependency",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(identity.server_address, "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-wallet-member-dependency:20261003091500',0))");
  const prior = await client.query(
    "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1 FOR UPDATE",
    [VERSION],
  );
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    action = apply ? "applied" : "validated_then_rolled_back";
  }

  const dependency = (await client.query(
    "SELECT dependency_keys FROM public.admin_permission_catalog WHERE permission_key='wallet.adjust' AND is_active=true",
  )).rows[0]?.dependency_keys;
  assert.deepEqual(dependency, ["members.view", "billing.view"], "WALLET_MEMBER_AND_BILLING_DEPENDENCIES_REQUIRED");

  const normalizedKeys = (await client.query(
    "SELECT public.normalize_delegable_admin_permission_keys('[\"wallet.adjust\"]'::jsonb) AS keys",
  )).rows[0]?.keys;
  assert.deepEqual(normalizedKeys, ["members.view", "billing.view", "wallet.adjust"], "WALLET_DEPENDENCY_CLOSURE_REQUIRED");

  const health = (await client.query("SELECT public.admin_governance_health() AS health")).rows[0]?.health;
  assert.equal(health?.healthy, true, "ADMIN_GOVERNANCE_HEALTH_REQUIRED");
  assert.equal(Number(health?.noncanonical_profile_count || 0), 0, "NONCANONICAL_PROFILE_FORBIDDEN");
  assert.equal(Number(health?.catalog_invalid_dependency_count || 0), 0, "INVALID_PERMISSION_DEPENDENCY_FORBIDDEN");
  assert.equal(Number(health?.catalog_cycle_count || 0), 0, "PERMISSION_DEPENDENCY_CYCLE_FORBIDDEN");

  if (apply && !prior.rowCount) {
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-admin-wallet-member-dependency"],
    );
  }
  if (apply) {
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  transactionOpen = false;

  console.log(JSON.stringify({
    passed: true,
    migration: FILE,
    hash,
    action,
    localDatabase: `${identity.database_name}@${identity.server_address}:${identity.server_port}`,
    dependency,
    normalizedKeys,
    health,
    productionWrites: 0,
  }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
