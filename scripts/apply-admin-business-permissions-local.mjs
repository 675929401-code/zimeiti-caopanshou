#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001010000";
const NAME = "admin_business_permissions";
const FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-member-permissions"), "LOCAL_MEMBER_PERMISSION_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /COMMIT\s*;\s*$/u);
assert.match(normalized, /admin_default/u);
assert.match(normalized, /users_admin_member_permission_seed/u);
assert.doesNotMatch(normalized, /DELETE\s+FROM\s+public\.member_permission/u);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-admin-business-permissions",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-business-permissions:20261001010000',0))");
  const prior = await client.query("SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-member-permissions"],
    );
    action = "applied";
  }
  const coverage = (await client.query(
    `SELECT
       count(*) FILTER (WHERE u.role='admin')::integer AS admins,
       count(*) FILTER (WHERE u.role='admin' AND a.user_id IS NOT NULL)::integer AS admin_assignments,
       count(*) FILTER (
         WHERE u.role='admin' AND a.checksum=public.member_permission_checksum(
           a.user_id,a.feature_navigation_keys,a.agent_navigation_keys,a.revision
         )
       )::integer AS valid_admin_assignments
     FROM public.users u
     LEFT JOIN public.member_permission_assignments a ON a.user_id=u.id`,
  )).rows[0];
  assert.equal(Number(coverage.admin_assignments), Number(coverage.admins), "ADMIN_PERMISSION_COVERAGE_REQUIRED");
  assert.equal(Number(coverage.valid_admin_assignments), Number(coverage.admins), "ADMIN_PERMISSION_INTEGRITY_REQUIRED");
  const functionSource = (await client.query(
    "SELECT pg_get_functiondef('public.set_member_permissions_atomic(text,text,jsonb,jsonb,integer,text,text,text,integer)'::regprocedure) AS source",
  )).rows[0]?.source || "";
  assert.doesNotMatch(functionSource, /MEMBER_PERMISSION_ADMIN_TARGET_FORBIDDEN/u, "ADMIN_TARGET_GUARD_STILL_ACTIVE");
  await client.query("COMMIT");
  console.log(JSON.stringify({ passed: true, migration: FILE, hash, action, coverage, productionWrites: 0 }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
