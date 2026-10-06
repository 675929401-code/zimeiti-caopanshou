import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { LOCAL_PREVIEW_RUNTIME_FILE } from "./start-local-data-preview.mjs";

const VERSION = "20260922012000";
const MIGRATION_FILE = `${VERSION}_autodl_h3_profit_billing_alignment.sql`;
const FUNCTION_SIGNATURE = "public.autodl_h3_finalize_video(uuid,text,text,text,text,text,text,bigint,text,numeric,numeric,bigint)";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^-- Preserve unified H3 billing[\s\S]*\nBEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.match(normalized, /CREATE OR REPLACE FUNCTION autodl_h3_finalize_video\(/u);
  assert.match(normalized, /profit, is_admin, billing_exempt, record_type/u);
  assert.match(normalized, /round\(\(p_price_yuan - p_cost_price\)::numeric, 12\)/u);
  assert.doesNotMatch(normalized, /DROP\s+|TRUNCATE\s+|DELETE\s+FROM|ALTER\s+TABLE/iu, "MIGRATION_SCOPE_REJECTED");
  return normalized
    .replace(/^[\s\S]*?\nBEGIN\s*;/u, "")
    .replace(/COMMIT\s*;\s*$/u, "")
    .trim();
}

async function main() {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(process.argv.includes("--confirm-local-function-only"), "LOCAL_FUNCTION_CONFIRMATION_REQUIRED");

  const runtime = JSON.parse((await readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_RUNTIME_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_RUNTIME_DATABASE_NAME_REQUIRED");
  assert.equal(typeof runtime.postgresPassword, "string", "LOCAL_POSTGRES_PASSWORD_REQUIRED");
  assert.ok(runtime.postgresPassword && !/[\r\n\0]/u.test(runtime.postgresPassword), "LOCAL_POSTGRES_PASSWORD_INVALID");
  const connection = new URL("postgresql://postgres@127.0.0.1:54322/zimeiti_local");
  connection.password = encodeURIComponent(runtime.postgresPassword);
  assert.equal(connection.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(connection.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(connection.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
  const sql = await readFile(migrationPath, "utf8");
  const body = migrationBody(sql);
  const migrationHash = sha256(sql);
  const evidenceDir = path.resolve(".codex-evidence/unified-billing-local-20260922/h3-profit-alignment");
  await mkdir(evidenceDir, { recursive: true });

  const client = new pg.Client({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  let transactionOpen = false;
  try {
    const identity = (await client.query(
      "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
    )).rows[0];
    assert.equal(identity.database_name, "zimeiti_local");
    assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");
    assert.equal(Number(identity.server_port), 54322);

    const beforeDefinition = String((await client.query(
      `SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`,
    )).rows[0]?.definition || "");
    assert.ok(beforeDefinition, "H3_FINALIZER_SNAPSHOT_MISSING");
    await writeFile(path.join(evidenceDir, "autodl_h3_finalize_video.before.sql"), beforeDefinition, "utf8");

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", ["260922012000"]);
    const prior = await client.query(
      "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [VERSION],
    );
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
    } else {
      await client.query(body);
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [VERSION, "autodl_h3_profit_billing_alignment", [MIGRATION_FILE], migrationHash, "codex-local-h3-profit-alignment"],
      );
    }

    const afterDefinition = String((await client.query(
      `SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`,
    )).rows[0]?.definition || "");
    assert.match(afterDefinition, /profit, is_admin, billing_exempt, record_type/u);
    assert.match(afterDefinition, /round\(\(p_price_yuan - p_cost_price\)::numeric, 12\)/u);
    assert.match(afterDefinition, /COALESCE\(v_user\.role, 'student'\) = 'admin', false, 'video'/u);

    const ledger = (await client.query(
      "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [VERSION],
    )).rows[0];
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
      profitPersistencePresent: true,
      adminBillingExemptionPresent: false,
      ledger: {
        version: String(ledger.version),
        name: ledger.name,
        hash: ledger.hash,
        appliedBy: ledger.applied_by,
        appliedAt: ledger.applied_at,
      },
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
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    providerRequests: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }));
  process.exitCode = 1;
});
