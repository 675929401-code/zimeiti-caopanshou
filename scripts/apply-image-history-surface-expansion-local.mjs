#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260929153000";
const NAME = "image_history_surface_expansion";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--apply"), "APPLY_OPERATION_REQUIRED");
assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-image-history-surface-only"),
  "LOCAL_IMAGE_HISTORY_SURFACE_CONFIRMATION_REQUIRED",
);

function transactionBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^begin\s*;/iu, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /commit\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^begin\s*;/iu, "").replace(/commit\s*;\s*$/iu, "").trim();
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(typeof runtime.postgresPassword, "string", "LOCAL_POSTGRES_PASSWORD_REQUIRED");
assert.ok(runtime.postgresPassword.length >= 16, "LOCAL_POSTGRES_PASSWORD_INVALID");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const migrationSource = await fs.readFile(migrationPath, "utf8");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const migrationBody = transactionBody(migrationSource);
for (const surface of ["'free-canvas'", "'short-drama-film-studio'", "'other'"]) {
  assert.ok(migrationSource.includes(surface), `MIGRATION_SURFACE_REQUIRED:${surface}`);
}
assert.match(migrationSource, /set local lock_timeout\s*=\s*'10s'/iu, "LOCK_TIMEOUT_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  // This migration replaces a function owned by the local bootstrap postgres
  // role. The ordinary app owner intentionally cannot alter it.
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-image-history-surface-expansion",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "select current_user, current_database() as database_name, inet_server_addr()::text as server_address, inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.equal(identity.current_user, "postgres", "LOCAL_MIGRATION_ROLE_REQUIRED");
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );

  await client.query("begin");
  transactionOpen = true;
  await client.query("select pg_advisory_xact_lock(hashtextextended('image-history-surface-expansion:20260929153000',0))");
  const ledgerTable = await client.query(
    "select to_regclass('supabase_migrations.schema_migrations')::text as name",
  );
  assert.equal(ledgerTable.rows[0]?.name, "supabase_migrations.schema_migrations", "MIGRATION_LEDGER_REQUIRED");
  const prior = await client.query(
    "select version,hash from supabase_migrations.schema_migrations where version::text=$1",
    [VERSION],
  );
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(migrationBody);
    await client.query(
      `insert into supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       values($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-image-history-surface"],
    );
  }

  const definition = (await client.query(
    `select pg_get_functiondef('public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)'::regprocedure) as definition`,
  )).rows[0]?.definition || "";
  for (const surface of ["'free-canvas'", "'short-drama-film-studio'", "'other'"]) {
    assert.ok(definition.includes(surface), `LIVE_FUNCTION_SURFACE_REQUIRED:${surface}`);
  }
  const privileges = (await client.query(
    `select
       has_function_privilege('anon','public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)','execute') as anon_execute,
       has_function_privilege('authenticated','public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)','execute') as authenticated_execute,
       has_function_privilege('service_role','public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)','execute') as service_execute`,
  )).rows[0];
  assert.equal(privileges.anon_execute, false, "ANON_EXECUTE_FORBIDDEN");
  assert.equal(privileges.authenticated_execute, false, "AUTHENTICATED_EXECUTE_FORBIDDEN");
  assert.equal(privileges.service_execute, true, "SERVICE_EXECUTE_REQUIRED");

  await client.query("commit");
  transactionOpen = false;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    action: prior.rowCount ? "already_applied" : "applied",
    migration: MIGRATION_FILE,
    migrationHash,
    allowedSurfaces: ["free-canvas", "short-drama-film-studio", "other"],
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "image-history-surface-expansion");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "apply.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
