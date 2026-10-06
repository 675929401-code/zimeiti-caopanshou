import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  LOCAL_PREVIEW_RUNTIME_FILE,
  validateLocalPreviewRuntime,
} from "./start-local-data-preview.mjs";

const MIGRATION_FILE = "20260921144000_image_validation_terminal_reconciliation.sql";
const VERSION = "20260921144000";
const ORIGINAL_RESULT = ".codex-evidence/gpt-image2-three-groups-live/2026-09-20T19-27-37-966Z/result.json";
const READONLY_EVIDENCE = ".codex-evidence/gpt-image2-three-groups-live/validation-reconciliation-readonly.json";
const TARGETS = [
  {
    modelId: "pending-cover-model-gpt-image-2-image-2-1k",
    errorPattern: /CANARY_FAILED_502:Unexpected token 'e'.*event: err/iu,
    rejectionCode: "IMAGE_UPSTREAM_TERMINAL_EVENT",
    httpStatus: null,
    reason: "旧版响应解析器收到结构化 SSE error 终态；已核验原请求无任务回执、资产和平台扣费。",
  },
  {
    modelId: "pending-cover-model-gpt-image-2-official",
    errorPattern: /CANARY_FAILED_502:.*503.*No available compatible accounts/iu,
    rejectionCode: "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE",
    httpStatus: 503,
    reason: "上游明确返回无兼容账户；已核验原请求无任务回执、资产和平台扣费。",
  },
];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  const begin = normalized.search(/\bBEGIN\s*;/iu);
  assert.ok(begin >= 0, "MIGRATION_BEGIN_REQUIRED");
  const transactional = normalized.slice(begin);
  assert.match(transactional, /^BEGIN\s*;/iu, "MIGRATION_BEGIN_REQUIRED");
  assert.match(transactional, /COMMIT\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return transactional.replace(/^BEGIN\s*;/iu, "").replace(/COMMIT\s*;\s*$/iu, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-reconciliation-no-provider"), "LOCAL_RECONCILIATION_CONFIRMATION_REQUIRED");

const runtime = JSON.parse(await readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
validateLocalPreviewRuntime(runtime);
const connection = runtime.ownerConnection;
assert.equal(connection.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
assert.equal(connection.port, 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(connection.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const migrationSql = await readFile(migrationPath, "utf8");
const migrationHash = sha256(migrationSql);
const originalResultRaw = await readFile(ORIGINAL_RESULT, "utf8");
const readonlyEvidenceRaw = await readFile(READONLY_EVIDENCE, "utf8");
const originalResult = JSON.parse(originalResultRaw);
const readonlyEvidence = JSON.parse(readonlyEvidenceRaw);
assert.equal(readonlyEvidence.localOnly, true, "READONLY_LOCAL_EVIDENCE_REQUIRED");
assert.equal(readonlyEvidence.databaseWrites, 0, "READONLY_EVIDENCE_MUST_NOT_WRITE");
assert.equal(readonlyEvidence.providerRequests, 0, "READONLY_EVIDENCE_MUST_NOT_CALL_PROVIDER");

for (const target of TARGETS) {
  const failure = originalResult.failures?.find((item) => item.id === target.modelId);
  assert.ok(failure && target.errorPattern.test(String(failure.error || "")), `ORIGINAL_TERMINAL_EVIDENCE_MISSING:${target.modelId}`);
  const model = readonlyEvidence.models?.find((item) => item.modelId === target.modelId);
  assert.equal(model?.attemptCount, 1, `SINGLE_ORIGINAL_ATTEMPT_REQUIRED:${target.modelId}`);
  const attempt = model.attempts[0];
  assert.equal(attempt.validationState, "unknown", `UNKNOWN_VALIDATION_REQUIRED:${target.modelId}`);
  assert.equal(attempt.requestState, "failed_unknown", `FAILED_UNKNOWN_REQUEST_REQUIRED:${target.modelId}`);
  assert.equal(attempt.identityMatches, true, `BOUND_IDENTITY_REQUIRED:${target.modelId}`);
  assert.equal(attempt.response.hasProviderCheckpoint, false, `PROVIDER_CHECKPOINT_FORBIDS_RECONCILIATION:${target.modelId}`);
  assert.equal(attempt.response.hasProviderResult, false, `PROVIDER_RESULT_FORBIDS_RECONCILIATION:${target.modelId}`);
  assert.equal(attempt.validationHasAsset, false, `VALIDATION_ASSET_FORBIDS_RECONCILIATION:${target.modelId}`);
  assert.equal(attempt.requestHasAsset, false, `REQUEST_ASSET_FORBIDS_RECONCILIATION:${target.modelId}`);
  assert.equal(Number(attempt.billing.operations), 0, `WALLET_OPERATION_FORBIDS_RECONCILIATION:${target.modelId}`);
  assert.equal(Number(attempt.billing.entries), 0, `WALLET_ENTRY_FORBIDS_RECONCILIATION:${target.modelId}`);
  assert.equal(Number(attempt.billing.cash_transactions), 0, `CASH_TRANSACTION_FORBIDS_RECONCILIATION:${target.modelId}`);
}

const evidenceDir = path.resolve(".codex-evidence/gpt-image2-three-groups-live/terminal-reconciliation");
await mkdir(evidenceDir, { recursive: true });
const client = new pg.Client({ ...connection, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
let transactionOpen = false;
try {
  await client.connect();
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  const previousOutcomeDefinition = String((await client.query(
    "SELECT pg_get_functiondef('public.record_image_model_validation_outcome(text,text,text,text,integer)'::regprocedure) AS definition",
  )).rows[0]?.definition || "");
  assert.ok(previousOutcomeDefinition, "PREVIOUS_OUTCOME_FUNCTION_REQUIRED");
  const backupPath = path.join(evidenceDir, "record_image_model_validation_outcome.before.sql");
  await writeFile(backupPath, previousOutcomeDefinition, "utf8");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", ["260921144000"]);
  const priorLedger = await client.query(
    "SELECT version, hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  if (priorLedger.rowCount) {
    assert.equal(String(priorLedger.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(migrationBody(migrationSql));
    await client.query(`
      INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
      VALUES($1,$2,$3,$4,$5,now())
    `, [VERSION, "image_validation_terminal_reconciliation", [MIGRATION_FILE], migrationHash, "codex-local-image-validation"]);
  }

  const reconciled = [];
  for (const target of TARGETS) {
    const row = (await client.query(`
      SELECT v.validation_id, v.user_id, v.updated_at::text AS validation_updated_at,
        r.updated_at::text AS request_updated_at
      FROM public.image_model_validations v
      JOIN public.image_generation_requests r ON r.record_id = v.image_record_id
      WHERE v.model_id = $1 AND v.state IN ('claimed','unknown')
      ORDER BY v.epoch DESC LIMIT 1
    `, [target.modelId])).rows[0];
    assert.ok(row, `UNRESOLVED_ATTEMPT_MISSING:${target.modelId}`);
    const result = (await client.query(`
      SELECT public.reconcile_image_model_validation_rejection($1,$2,$3,$4,$5,$6,$7,$8) AS result
    `, [
      row.validation_id,
      row.user_id,
      row.validation_updated_at,
      row.request_updated_at,
      target.rejectionCode,
      target.httpStatus,
      target.reason,
      `${ORIGINAL_RESULT}#${target.modelId};${READONLY_EVIDENCE}#${target.modelId}`,
    ])).rows[0].result;
    assert.equal(result?.record?.state, "rejected", `RECONCILIATION_NOT_REJECTED:${target.modelId}`);
    assert.ok(Number.isSafeInteger(Number(result?.auditId)), `RECONCILIATION_AUDIT_MISSING:${target.modelId}`);
    reconciled.push({ modelId: target.modelId, state: result.record.state, rejectionCode: target.rejectionCode, httpStatus: target.httpStatus, auditId: Number(result.auditId) });
  }

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const after = (await client.query(`
    SELECT v.model_id, v.state AS validation_state, v.rejection_code, v.rejection_http_status,
      r.state AS request_state, r.response->>'schema' AS response_schema,
      r.delivery_state, r.delivery_asset_id IS NOT NULL AS has_asset
    FROM public.image_model_validations v
    JOIN public.image_generation_requests r ON r.record_id = v.image_record_id
    WHERE v.model_id = ANY($1::text[]) ORDER BY v.model_id, v.epoch DESC
  `, [TARGETS.map((target) => target.modelId)])).rows;
  for (const row of after) {
    assert.equal(row.validation_state, "rejected");
    assert.equal(row.request_state, "failed_unknown");
    assert.equal(row.response_schema, "image_request_rejection.v1");
    assert.equal(row.has_asset, false);
  }
  const summary = {
    ok: true,
    localRuntimeOnly: true,
    migration: MIGRATION_FILE,
    migrationHash,
    originalEvidenceHash: sha256(originalResultRaw),
    readonlyEvidenceHash: sha256(readonlyEvidenceRaw),
    backupPath,
    backupHash: sha256(previousOutcomeDefinition),
    reconciled,
    after,
    databaseWrites: true,
    providerRequests: 0,
    paidGenerationRequests: 0,
    credentialsPrinted: false,
  };
  const output = path.join(evidenceDir, "summary.json");
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, output }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
