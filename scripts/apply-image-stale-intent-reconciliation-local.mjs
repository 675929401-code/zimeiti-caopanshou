#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260926090000";
const MIGRATION_FILE = `${VERSION}_image_stale_intent_reconciliation.sql`;
const FUNCTION_SIGNATURE = "public.reconcile_stale_image_generation_request_atomic(text,text,integer)";
const TARGET_TRACE_ID = "sbw-image-6732dc1a-eaa9-4287-9dce-3bab23781459";
const TARGET_RECORD_ID = "2d837bd99c48976904e0101736967383b26e9e780565041d61130fc62a93dac2";
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  assert.match(normalized, /CREATE OR REPLACE FUNCTION public\.reconcile_stale_image_generation_request_atomic/u);
  assert.doesNotMatch(normalized, /TRUNCATE\s+|DELETE\s+FROM|ALTER\s+TABLE/iu, "MIGRATION_SCOPE_REJECTED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

async function snapshot(client) {
  const request = (await client.query(`
    SELECT record_id::text,user_id::text,client_idempotency_key,client_trace_id,payload_fingerprint,
           state,response,delivery_state,delivery_asset_id::text,request_snapshot,created_at,updated_at
    FROM public.image_generation_requests WHERE record_id=$1 AND client_trace_id=$2
  `, [TARGET_RECORD_ID, TARGET_TRACE_ID])).rows[0];
  assert.ok(request, "TARGET_IMAGE_REQUEST_NOT_FOUND");
  const billingKey = `image:h3_${sha256(`${request.user_id}:${request.client_idempotency_key}`).slice(0, 48)}`;
  const [operations, balance] = await Promise.all([
    client.query(`SELECT id::text,operation_kind,idempotency_key,status,amount::text,balance_before::text,balance_after::text
      FROM public.wallet_operations WHERE user_id=$1 AND idempotency_key IN ($2,$3) ORDER BY id`,
    [request.user_id, billingKey, `${billingKey}:release`]),
    client.query("SELECT cash_balance::text FROM public.users WHERE id=$1", [request.user_id]),
  ]);
  return { request, billingKey, operations: operations.rows, balance: balance.rows[0]?.cash_balance ?? null };
}

async function main() {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(process.argv.includes("--confirm-local-image-stale-reconciliation"), "LOCAL_RECONCILIATION_CONFIRMATION_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const sql = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
  const body = migrationBody(sql);
  const migrationHash = sha256(sql);
  const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-image-stale-reconciliation", query_timeout: 30_000 });
  await client.connect();
  let transactionOpen = false;
  try {
    const identity = (await client.query("SELECT current_database() AS database_name,inet_server_addr()::text AS server_address,inet_server_port() AS server_port")).rows[0];
    assert.equal(identity.database_name, "zimeiti_local");
    const before = await snapshot(client);
    const alreadyReconciled = before.request.state === "failed_unknown"
      && before.request.response?.source === "platform"
      && before.request.response?.code === "IMAGE_PLATFORM_REQUEST_INTERRUPTED";
    if (!alreadyReconciled) {
      assert.ok(["intent", "failed_unknown"].includes(before.request.state));
      assert.equal(before.request.response, null);
      assert.equal(before.request.delivery_state, "held");
      assert.equal(before.request.delivery_asset_id, null);
      assert.ok(Date.now() - Date.parse(before.request.updated_at) >= 600_000, "TARGET_IMAGE_REQUEST_NOT_STALE");
    }

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [260926090000]);
    const prior = await client.query("SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
    } else {
      await client.query(body);
      await client.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
        VALUES($1,$2,$3,$4,$5,now())`, [VERSION, "image_stale_intent_reconciliation", [MIGRATION_FILE], migrationHash, "codex-local-image-reconciliation"]);
    }
    const definition = String((await client.query(`SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`)).rows[0]?.definition || "");
    assert.match(definition, /apply_wallet_operation_atomic/u);
    assert.match(definition, /IMAGE_PLATFORM_REQUEST_INTERRUPTED/u);
    const result = (await client.query("SELECT public.reconcile_stale_image_generation_request_atomic($1,$2,$3) AS value",
      [TARGET_RECORD_ID, before.request.user_id, 600])).rows[0]?.value;
    assert.ok(result && typeof result === "object", "RECONCILIATION_RESULT_INVALID");
    await client.query("COMMIT");
    transactionOpen = false;

    const after = await snapshot(client);
    assert.equal(after.request.state, "failed_unknown");
    assert.equal(after.request.response?.schema, "image_request_rejection.v1");
    assert.equal(after.request.response?.payloadFingerprint, before.request.payload_fingerprint);
    assert.equal(after.request.response?.source, "platform");
    assert.equal(after.request.response?.code, "IMAGE_PLATFORM_REQUEST_INTERRUPTED");
    assert.equal(after.request.delivery_state, "held");
    assert.equal(after.request.delivery_asset_id, null);
    const charge = after.operations.filter((row) => row.operation_kind === "cash_charge" && row.idempotency_key === after.billingKey);
    const refunds = after.operations.filter((row) => row.operation_kind === "cash_refund" && row.idempotency_key === `${after.billingKey}:release`);
    assert.equal(charge.length, 1);
    assert.equal(charge[0].status, "completed");
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].status, "completed");
    assert.equal(Number(refunds[0].amount), Number(charge[0].amount));
    const balanceDelta = Number((Number(after.balance) - Number(before.balance)).toFixed(6));
    assert.equal(balanceDelta, alreadyReconciled ? 0 : Number(charge[0].amount));

    const report = {
      passed: true,
      localDatabaseOnly: true,
      database: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: identity.server_port,
      migration: MIGRATION_FILE,
      migrationHash,
      targetTraceId: TARGET_TRACE_ID,
      targetRecordId: TARGET_RECORD_ID,
      stateBefore: before.request.state,
      stateAfter: after.request.state,
      terminalCode: after.request.response.code,
      chargeOperationCount: charge.length,
      refundOperationCount: refunds.length,
      refundedAmount: Number(refunds[0].amount),
      balanceDelta,
      assetCreated: false,
      providerRequests: 0,
      credentialsPrinted: false,
    };
    const reportPath = path.resolve(".codex-evidence/_safe-canary/stale-image-reconciliation.json");
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error), providerRequests: 0, credentialsPrinted: false }));
  process.exitCode = 1;
});
