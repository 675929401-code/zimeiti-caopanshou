#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { LOCAL_PREVIEW_RUNTIME_FILE } from "./start-local-data-preview.mjs";

const VERSION = "20260922014000";
const MIGRATION_FILE = `${VERSION}_image_validation_uuid_billing_alignment.sql`;
const FUNCTION_SIGNATURE = "public.publish_image_model_validation(text,text,text,text,boolean,boolean,text,text,bigint,text,jsonb)";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^-- Normalize UUID-backed billing identities[\s\S]*\nBEGIN\s*;/u);
  assert.match(normalized, /COMMIT\s*;\s*$/u);
  assert.match(normalized, /WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key/u);
  assert.match(normalized, /WHERE user_id::text=p_user_id AND task_id=v_billing_key/u);
  assert.match(normalized, /WHERE user_id::text=p_user_id AND reference_id=v_billing_key/u);
  assert.doesNotMatch(normalized, /DROP\s+|TRUNCATE\s+|DELETE\s+FROM|ALTER\s+TABLE/iu);
  return normalized.replace(/^[\s\S]*?\nBEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

const runtime = JSON.parse((await readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-function-only"), "LOCAL_FUNCTION_CONFIRMATION_REQUIRED");
assert.equal(runtime.localOnly, true);
assert.equal(runtime.host, "127.0.0.1");
assert.equal(Number(runtime.databasePort), 54322);
assert.equal(runtime.databaseName, "zimeiti_local");
const connection = new URL("postgresql://postgres@127.0.0.1:54322/zimeiti_local");
connection.password = encodeURIComponent(runtime.postgresPassword);
const sql = await readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const body = migrationBody(sql);
const migrationHash = sha256(sql);
const evidenceDir = path.resolve(".codex-evidence/unified-billing-local-20260922/image-validation-uuid-alignment");
await mkdir(evidenceDir, { recursive: true });
const db = new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
await db.connect();
let transactionOpen = false;
try {
  const beforeDefinition = String((await db.query(`SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`)).rows[0]?.definition || "");
  assert.ok(beforeDefinition);
  await writeFile(path.join(evidenceDir, "publish_image_model_validation.before.sql"), beforeDefinition, "utf8");
  await db.query("BEGIN"); transactionOpen = true;
  await db.query("SELECT pg_advisory_xact_lock($1)", ["260922014000"]);
  const prior = await db.query("SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  if (prior.rowCount) assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  else {
    await db.query(body);
    await db.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
      VALUES($1,$2,$3,$4,$5,now())`, [VERSION, "image_validation_uuid_billing_alignment", [MIGRATION_FILE], migrationHash, "codex-local-image-validation-uuid"]);
  }
  const afterDefinition = String((await db.query(`SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`)).rows[0]?.definition || "");
  assert.match(afterDefinition, /user_id::text\s*=\s*p_user_id/u);
  const ledger = (await db.query("SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION])).rows[0];
  assert.equal(String(ledger.hash), migrationHash);
  await db.query("COMMIT"); transactionOpen = false;
  const report = {
    ok: true,
    localRuntimeOnly: true,
    migration: MIGRATION_FILE,
    migrationHash,
    changedObject: FUNCTION_SIGNATURE,
    beforeDefinitionHash: sha256(beforeDefinition),
    afterDefinitionHash: sha256(afterDefinition),
    uuidBillingIdentityNormalized: true,
    ledger,
    providerRequests: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
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
