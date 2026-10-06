#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { LOCAL_PREVIEW_RUNTIME_FILE } from "./start-local-data-preview.mjs";

const VERSION = "20260922013000";
const MIGRATION_FILE = `${VERSION}_image_validation_normal_billing_alignment.sql`;
const FUNCTION_SIGNATURE = "public.publish_image_model_validation(text,text,text,text,boolean,boolean,text,text,bigint,text,jsonb)";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^-- Align image-model validation[\s\S]*\nBEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.publish_image_model_validation\(/u);
  assert.match(normalized, /v_operation public\.wallet_operations%ROWTYPE/u);
  assert.match(normalized, /v_revenue public\.revenue_records%ROWTYPE/u);
  assert.match(normalized, /v_cash public\.cash_transactions%ROWTYPE/u);
  assert.doesNotMatch(normalized, /DROP\s+|TRUNCATE\s+|DELETE\s+FROM|ALTER\s+TABLE/iu, "MIGRATION_SCOPE_REJECTED");
  return normalized.replace(/^[\s\S]*?\nBEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

async function main() {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(process.argv.includes("--confirm-local-function-only"), "LOCAL_FUNCTION_CONFIRMATION_REQUIRED");
  const runtime = JSON.parse((await readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_RUNTIME_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_RUNTIME_DATABASE_NAME_REQUIRED");
  const connection = new URL("postgresql://postgres@127.0.0.1:54322/zimeiti_local");
  connection.password = encodeURIComponent(runtime.postgresPassword);

  const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
  const sql = await readFile(migrationPath, "utf8");
  const body = migrationBody(sql);
  const migrationHash = sha256(sql);
  const evidenceDir = path.resolve(".codex-evidence/unified-billing-local-20260922/image-validation-billing-alignment");
  await mkdir(evidenceDir, { recursive: true });
  const client = new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await client.connect();
  let transactionOpen = false;
  try {
    const identity = (await client.query("SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port")).rows[0];
    assert.equal(identity.database_name, "zimeiti_local");
    assert.equal(Number(identity.server_port), 54322);
    const beforeDefinition = String((await client.query(`SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`)).rows[0]?.definition || "");
    assert.ok(beforeDefinition, "IMAGE_PUBLICATION_FUNCTION_MISSING");
    await writeFile(path.join(evidenceDir, "publish_image_model_validation.before.sql"), beforeDefinition, "utf8");

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", ["260922013000"]);
    const prior = await client.query("SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
    } else {
      await client.query(body);
      await client.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
        VALUES($1,$2,$3,$4,$5,now())`, [VERSION, "image_validation_normal_billing_alignment", [MIGRATION_FILE], migrationHash, "codex-local-image-validation-billing"]);
    }
    const afterDefinition = String((await client.query(`SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`)).rows[0]?.definition || "");
    assert.match(afterDefinition, /v_operation public\.wallet_operations%ROWTYPE/u);
    assert.match(afterDefinition, /v_revenue public\.revenue_records%ROWTYPE/u);
    assert.match(afterDefinition, /v_cash public\.cash_transactions%ROWTYPE/u);
    assert.match(afterDefinition, /billingExemptionReason',''\)<>'none'/u);
    const ledger = (await client.query("SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION])).rows[0];
    assert.equal(String(ledger.hash), migrationHash, "MIGRATION_LEDGER_WRITE_FAILED");
    await client.query("COMMIT");
    transactionOpen = false;

    const summary = {
      ok: true,
      localRuntimeOnly: true,
      database: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: identity.server_port,
      migration: MIGRATION_FILE,
      migrationHash,
      changedObject: FUNCTION_SIGNATURE,
      beforeDefinitionHash: sha256(beforeDefinition),
      afterDefinitionHash: sha256(afterDefinition),
      normalAdminBillingRequired: true,
      uniqueWalletLedgerRevenueCashEvidenceRequired: true,
      ledger,
      providerRequests: 0,
      paidModelCalls: 0,
      credentialsPrinted: false,
    };
    const summaryPath = path.join(evidenceDir, "summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), providerRequests: 0, paidModelCalls: 0, credentialsPrinted: false }));
  process.exitCode = 1;
});
