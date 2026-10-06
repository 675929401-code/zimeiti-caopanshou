#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261003090000";
const NAME = "admin_permission_catalog_v2";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const apply = process.argv.includes("--apply");

if (apply) {
  assert.ok(
    process.argv.includes("--confirm-local-admin-permission-v2"),
    "LOCAL_ADMIN_PERMISSION_V2_CONFIRMATION_REQUIRED",
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
  application_name: "codex-local-admin-permission-v2",
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
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-permission-catalog-v2:20261003090000',0))");
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

  const catalog = (await client.query(`
    SELECT count(*)::integer AS active_count,
           count(*) FILTER (WHERE is_delegable=false)::integer AS nondelegable_count
    FROM public.admin_permission_catalog
    WHERE is_active=true
  `)).rows[0];
  assert.equal(catalog.active_count, 30, "ACTIVE_PERMISSION_CATALOG_MUST_BE_30");
  assert.equal(catalog.nondelegable_count, 1, "ONLY_OWNER_PERMISSION_MUST_BE_NONDELEGABLE");

  const normalize = async (keys) => (await client.query(
    "SELECT public.normalize_delegable_admin_permission_keys($1::jsonb) AS keys",
    [JSON.stringify(keys)],
  )).rows[0]?.keys;
  assert.deepEqual(
    await normalize(["admin.accounts.manage", "payment.settings.manage"]),
    ["billing.view", "payment.settings.manage"],
    "OWNER_STRIP_AND_PAYMENT_DEPENDENCY_REQUIRED",
  );
  assert.deepEqual(
    await normalize(["prompts.edit"]),
    ["agents.view", "prompts.view", "prompts.edit"],
    "PROMPT_DEPENDENCY_CLOSURE_REQUIRED",
  );
  assert.deepEqual(
    await normalize(["white_label.manage"]),
    ["brand.settings.manage", "white_label.manage"],
    "WHITE_LABEL_DEPENDENCY_CLOSURE_REQUIRED",
  );

  const rpcNames = [
    "set_admin_access_profile_atomic",
    "create_admin_account_atomic",
    "promote_existing_member_to_admin_atomic",
    "read_admin_access_snapshot",
  ];
  const functionDefinitions = (await client.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname = ANY($1::text[])
  `, [rpcNames])).rows;
  assert.equal(functionDefinitions.length, rpcNames.length, "ADMIN_PERMISSION_RPC_SET_INCOMPLETE");
  for (const definition of functionDefinitions) {
    assert.match(definition.source, /normalize_delegable_admin_permission_keys/u, `${definition.proname}:DELEGABLE_NORMALIZER_REQUIRED`);
  }

  const superUserId = (await client.query(
    "SELECT user_id FROM public.admin_access_profiles WHERE admin_level='super_admin' AND is_active=true LIMIT 1",
  )).rows[0]?.user_id;
  assert.ok(superUserId, "ACTIVE_SUPER_ADMIN_REQUIRED");
  const superSnapshot = (await client.query(
    "SELECT public.read_admin_access_snapshot($1) AS snapshot",
    [superUserId],
  )).rows[0]?.snapshot;
  assert.equal(superSnapshot?.authority_status, "ready", "SUPER_ADMIN_SNAPSHOT_NOT_READY");
  assert.equal(superSnapshot?.permission_keys?.length, 30, "SUPER_ADMIN_PERMISSION_CATALOG_INCOMPLETE");

  const health = (await client.query("SELECT public.admin_governance_health() AS health")).rows[0]?.health;
  assert.equal(health?.healthy, true, "ADMIN_GOVERNANCE_HEALTH_REQUIRED");
  assert.equal(Number(health?.noncanonical_profile_count || 0), 0, "NONCANONICAL_PROFILE_FORBIDDEN");
  assert.equal(Number(health?.catalog_invalid_dependency_count || 0), 0, "INVALID_PERMISSION_DEPENDENCY_FORBIDDEN");
  assert.equal(Number(health?.catalog_cycle_count || 0), 0, "PERMISSION_DEPENDENCY_CYCLE_FORBIDDEN");

  await client.query("SAVEPOINT permission_contract_probe");
  let profileContractRejected = false;
  try {
    await client.query("SELECT set_config('app.admin_governance_write','on',true)");
    await client.query(
      "UPDATE public.admin_access_profiles SET admin_level='admin', permission_keys='[\"admin.accounts.manage\"]'::jsonb WHERE user_id=$1",
      [superUserId],
    );
  } catch (error) {
    profileContractRejected = String(error?.message || "").includes("ADMIN_PERMISSION_CONTRACT_VIOLATION");
  }
  await client.query("ROLLBACK TO SAVEPOINT permission_contract_probe");
  assert.equal(profileContractRejected, true, "DATABASE_OWNER_PERMISSION_GUARD_REQUIRED");

  await client.query("SAVEPOINT catalog_contract_probe");
  let catalogContractRejected = false;
  try {
    await client.query(`
      UPDATE public.admin_permission_catalog
      SET dependency_keys='["admin.accounts.manage"]'::jsonb
      WHERE permission_key='brand.settings.manage'
    `);
    await client.query("SET CONSTRAINTS admin_permission_catalog_contract_guard IMMEDIATE");
  } catch (error) {
    catalogContractRejected = String(error?.message || "").includes("ADMIN_PERMISSION_CATALOG_INVALID");
  }
  await client.query("ROLLBACK TO SAVEPOINT catalog_contract_probe");
  assert.equal(catalogContractRejected, true, "DATABASE_CATALOG_DEPENDENCY_GUARD_REQUIRED");

  if (apply && !prior.rowCount) {
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-admin-permission-v2"],
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
    catalog,
    health,
    productionWrites: 0,
  }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
