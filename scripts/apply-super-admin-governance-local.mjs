#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const MIGRATIONS = [
  { version: "20261001221000", name: "super_admin_governance" },
  { version: "20261001224000", name: "existing_member_admin_promotion" },
].map((migration) => ({ ...migration, file: `${migration.version}_${migration.name}.sql` }));
const execute = process.argv.includes("--execute");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function bodyOf(source) {
  const normalized = source.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

if (execute) {
  assert.ok(process.argv.includes("--confirm-local-admin-governance"), "LOCAL_ADMIN_GOVERNANCE_CONFIRMATION_REQUIRED");
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrations = await Promise.all(MIGRATIONS.map(async (migration) => {
  const source = await fs.readFile(path.resolve("supabase/migrations", migration.file), "utf8");
  return { ...migration, source, hash: crypto.createHash("sha256").update(source).digest("hex") };
}));
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-super-admin-governance",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('super-admin-governance:migrations',0))");
  const migrationResults = [];
  for (const migration of migrations) {
    const prior = await client.query(
      "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [migration.version],
    );
    let action = execute ? "already_applied" : "checked";
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), migration.hash, `MIGRATION_LEDGER_HASH_CONFLICT:${migration.file}`);
    } else {
      await client.query(bodyOf(migration.source));
      if (execute) {
        await client.query(
          `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
           VALUES($1,$2,$3,$4,$5,now())`,
          [migration.version, migration.name, [migration.file], migration.hash, "codex-local-super-admin-governance"],
        );
        action = "applied";
      }
    }
    migrationResults.push({ file: migration.file, hash: migration.hash, action });
  }

  const schema = (await client.query(
    `SELECT
       to_regclass('public.admin_access_profiles')::text AS profile_table,
       to_regclass('public.admin_governance_audit')::text AS audit_table,
       to_regprocedure('public.read_admin_access_snapshot(text)')::text AS snapshot_function,
       to_regprocedure('public.admin_governance_health()')::text AS health_function,
       to_regprocedure('public.promote_existing_member_to_admin_atomic(text,text,jsonb,text)')::text AS promotion_function`,
  )).rows[0];
  assert.equal(schema.profile_table, "admin_access_profiles");
  assert.equal(schema.audit_table, "admin_governance_audit");
  assert.equal(schema.snapshot_function, "read_admin_access_snapshot(text)");
  assert.equal(schema.health_function, "admin_governance_health()");
  assert.equal(schema.promotion_function, "promote_existing_member_to_admin_atomic(text,text,jsonb,text)");

  const health = (await client.query("SELECT public.admin_governance_health() AS health")).rows[0].health;
  assert.equal(health.healthy, true, `ADMIN_GOVERNANCE_HEALTH_FAILED:${JSON.stringify(health)}`);
  assert.equal(Number(health.active_super_count), 1, "EXACTLY_ONE_SUPER_ADMIN_REQUIRED");

  if (execute) {
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    mode: execute ? "apply" : "check-rollback",
    migrations: migrationResults,
    schema,
    health,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "super-admin-governance");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, execute ? "migration-apply.json" : "migration-check.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
