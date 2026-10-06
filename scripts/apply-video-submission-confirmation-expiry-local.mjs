#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { LOCAL_PREVIEW_RUNTIME_FILE } from "./start-local-data-preview.mjs";

const VERSION = "20260922015000";
const MIGRATION_FILE = `${VERSION}_video_submission_confirmation_expiry.sql`;
const FUNCTION_SIGNATURE = "public.expire_video_submission_confirmations_atomic(text,integer)";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^-- Close orphaned video submissions[\s\S]*\nBEGIN\s*;/u);
  assert.match(normalized, /COMMIT\s*;\s*$/u);
  assert.match(normalized, /VIDEO_SUBMISSION_CONFIRMATION_EXPIRED/u);
  assert.match(normalized, /FOR UPDATE OF t SKIP LOCKED/u);
  assert.match(normalized, /GRANT EXECUTE[\s\S]*TO service_role/u);
  assert.doesNotMatch(normalized, /DROP\s+|TRUNCATE\s+|DELETE\s+FROM/iu);
  return normalized.replace(/^[\s\S]*?\nBEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-reconciliation-only"), "LOCAL_RECONCILIATION_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.host, "127.0.0.1");
assert.equal(Number(runtime.databasePort), 54322);
assert.equal(runtime.databaseName, "zimeiti_local");

const connection = new URL("postgresql://postgres@127.0.0.1:54322/zimeiti_local");
connection.password = encodeURIComponent(runtime.postgresPassword);
const sql = await readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const body = migrationBody(sql);
const migrationHash = sha256(sql);
const evidenceDir = path.resolve(".codex-evidence/unified-billing-local-20260922/video-submission-expiry");
await mkdir(evidenceDir, { recursive: true });
const db = new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
await db.connect();
let transactionOpen = false;
try {
  const before = await db.query("SELECT to_regprocedure($1)::text AS signature", [FUNCTION_SIGNATURE]);
  await db.query("BEGIN"); transactionOpen = true;
  await db.query("SELECT pg_advisory_xact_lock($1)", ["260922015000"]);
  const prior = await db.query("SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  if (prior.rowCount) assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  else {
    await db.query(body);
    await db.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
      VALUES($1,$2,$3,$4,$5,now())`, [VERSION, "video_submission_confirmation_expiry", [MIGRATION_FILE], migrationHash, "codex-local-video-reconciliation"]);
  }
  const definition = String((await db.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [FUNCTION_SIGNATURE])).rows[0]?.definition || "");
  assert.match(definition, /VIDEO_SUBMISSION_CONFIRMATION_EXPIRED/u);
  assert.match(definition, /wallet_operations/u);
  assert.match(definition, /autodl_h3_jobs/u);
  const ledger = (await db.query("SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION])).rows[0];
  assert.equal(String(ledger.hash), migrationHash);
  await db.query("COMMIT"); transactionOpen = false;
  await db.query("NOTIFY pgrst, 'reload schema'");
  const report = {
    ok: true,
    localRuntimeOnly: true,
    migration: MIGRATION_FILE,
    migrationHash,
    functionExistedBefore: Boolean(before.rows[0]?.signature),
    functionDefinitionHash: sha256(definition),
    confirmationTimeoutSeconds: 1800,
    postgrestSchemaReloadRequested: true,
    providerRequests: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
    ledger,
  };
  const reportPath = path.join(evidenceDir, "summary.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} catch (error) {
  if (transactionOpen) await db.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await db.end();
}
