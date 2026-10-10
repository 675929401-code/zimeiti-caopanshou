#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const VERSION = "20261010133000";
const NAME = "image_provider_dispatch_receipts";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.rollback.sql`;
const APPLY = process.argv.includes("--apply");
const PROBE_ROLLBACK = process.argv.includes("--probe-rollback");
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const FUNCTIONS = [
  { signature: "public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)", serviceRole: true },
  { signature: "public.reconcile_stale_image_generation_request_atomic(text,text,integer)", serviceRole: true },
  { signature: "public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb)", serviceRole: true },
  { signature: "public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)", serviceRole: true },
  { signature: "public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)", serviceRole: false },
];

assert.equal(APPLY && PROBE_ROLLBACK, false, "CHOOSE_APPLY_OR_PROBE_ROLLBACK");
if (APPLY || PROBE_ROLLBACK) {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(process.argv.includes("--confirm-local-image-provider-receipts-only"), "LOCAL_IMAGE_PROVIDER_RECEIPT_CONFIRMATION_REQUIRED");
}

function transactionBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^begin\s*;/iu, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /commit\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^begin\s*;/iu, "").replace(/commit\s*;\s*$/iu, "").trim();
}

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const canonicalField = (name, value) => `${name}=${value === undefined ? "" : String(value)}`;
const receiptCanonical = value => value.schema === "image_provider_dispatch_receipt.v1"
  ? [
      canonicalField("schema", value.schema), canonicalField("receiptId", value.receiptId),
      canonicalField("recordedAt", value.recordedAt), canonicalField("providerProtocol", value.providerProtocol),
      canonicalField("endpointOriginSha256", value.endpointOriginSha256),
      canonicalField("requestContentType", value.requestContentType),
      canonicalField("actualPayloadSha256", value.actualPayloadSha256),
      canonicalField("actualPayloadBytes", value.actualPayloadBytes),
      canonicalField("idempotencyKeySha256", value.idempotencyKeySha256),
      canonicalField("requestProjection.userPromptSha256", value.requestProjection?.userPromptSha256),
      canonicalField("requestProjection.effectivePromptSha256", value.requestProjection?.effectivePromptSha256),
      canonicalField("requestProjection.modelIdSha256", value.requestProjection?.modelIdSha256),
      canonicalField("requestProjection.aspectRatio", value.requestProjection?.aspectRatio),
      canonicalField("requestProjection.resolution", value.requestProjection?.resolution),
      canonicalField("requestProjection.imageCount", value.requestProjection?.imageCount),
      canonicalField("requestProjection.referenceCount", value.requestProjection?.referenceCount),
    ].join("\n")
  : [
      canonicalField("schema", value.schema), canonicalField("receiptId", value.receiptId),
      canonicalField("dispatchReceiptSha256", value.dispatchReceiptSha256),
      canonicalField("recordedAt", value.recordedAt), canonicalField("providerProtocol", value.providerProtocol),
      canonicalField("transportState", value.transportState), canonicalField("responseStatus", value.responseStatus),
      canonicalField("responseContentType", value.responseContentType),
      canonicalField("responseBodySha256", value.responseBodySha256),
      canonicalField("responseBodyBytes", value.responseBodyBytes),
      canonicalField("providerAcknowledgementSha256", value.providerAcknowledgementSha256),
      canonicalField("providerAcknowledgementField", value.providerAcknowledgementField),
    ].join("\n");
const withHash = value => ({ ...value, receiptSha256: digest(receiptCanonical(value)) });

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(typeof runtime.postgresPassword, "string", "LOCAL_POSTGRES_PASSWORD_REQUIRED");
assert.ok(runtime.postgresPassword.length >= 16, "LOCAL_POSTGRES_PASSWORD_INVALID");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = digest(migrationSource);
const migrationBody = transactionBody(migrationSource);
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");
const rollbackHash = digest(rollbackSource);
const rollbackBody = transactionBody(rollbackSource);
for (const token of [
  "provider_dispatch_receipt", "provider_submission_receipt", "provider_evidence_present",
  "security definer", "set search_path = public, pg_temp", "service_role", "for update",
  ...FUNCTIONS.map(item => item.signature),
]) assert.ok(migrationSource.toLowerCase().includes(token.toLowerCase()), `MIGRATION_TOKEN_REQUIRED:${token}`);
for (const token of ["forward_repair", "provider_dispatch_receipt", "provider_submission_receipt", "service_role", "has_function_privilege"]) {
  assert.ok(rollbackSource.toLowerCase().includes(token.toLowerCase()), `ROLLBACK_TOKEN_REQUIRED:${token}`);
}
assert.doesNotMatch(rollbackSource, /drop\s+(?:column|function|table)|delete\s+from\s+supabase_migrations/iu, "ROLLBACK_MUST_PRESERVE_PROVIDER_EVIDENCE");

const client = new Client({
  ...runtime.ownerConnection,
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-image-provider-receipts",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

async function liveProjection() {
  const tableOwner = String((await client.query(
    "select pg_get_userbyid(relowner) as owner from pg_class where oid='public.image_generation_requests'::regclass",
  )).rows[0]?.owner || "");
  const columns = (await client.query(
    `select attname from pg_attribute where attrelid='public.image_generation_requests'::regclass
      and attname in ('provider_dispatch_receipt','provider_submission_receipt') and not attisdropped order by attname`,
  )).rows.map(row => String(row.attname));
  const constraint = (await client.query(
    "select convalidated from pg_constraint where conrelid='public.image_generation_requests'::regclass and conname='image_generation_requests_provider_receipt_order'",
  )).rows[0];
  const functions = [];
  for (const expected of FUNCTIONS) {
    const row = (await client.query(
      `select pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,p.proconfig,
              pg_get_functiondef(p.oid) as definition,
              to_jsonb(array(select coalesce(pg_get_userbyid(acl.grantee),'PUBLIC')
                from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                where acl.privilege_type='EXECUTE' order by 1)) as execute_grantees
         from pg_proc p where p.oid=to_regprocedure($1)`,
      [expected.signature],
    )).rows[0];
    const privileges = row ? (await client.query(
      `select has_function_privilege('anon',$1,'execute') as anon_execute,
              has_function_privilege('authenticated',$1,'execute') as authenticated_execute,
              has_function_privilege('service_role',$1,'execute') as service_execute`,
      [expected.signature],
    )).rows[0] : {};
    const unauthorized = row ? (await client.query(
      `select rolname from pg_roles
        where not rolsuper and rolname not in ($2,'service_role')
          and has_function_privilege(oid,to_regprocedure($1),'execute') order by rolname`,
      [expected.signature, tableOwner],
    )).rows.map(item => String(item.rolname)) : [];
    functions.push({
      ...expected,
      exists: Boolean(row),
      owner: String(row?.owner || ""),
      securityDefiner: row?.security_definer === true,
      searchPath: Array.isArray(row?.proconfig) ? row.proconfig.map(String) : [],
      executeGrantees: Array.isArray(row?.execute_grantees) ? row.execute_grantees.map(String) : [],
      receiptAware: expected.signature.includes("reconcile_stale_image_generation_request_atomic")
        ? String(row?.definition || "").includes("provider_evidence_present") : true,
      contractBodyReady: expected.signature.includes("record_image_provider_dispatch_receipt_atomic")
        ? String(row?.definition || "").toUpperCase().includes("IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID")
          && String(row?.definition || "").toUpperCase().includes("FOR UPDATE")
          && String(row?.definition || "").includes("requestProjection.referenceCount=")
        : expected.signature.includes("record_image_provider_submission_receipt_atomic")
          ? String(row?.definition || "").toUpperCase().includes("IMAGE_PROVIDER_SUBMISSION_RECEIPT_INVALID")
            && String(row?.definition || "").toUpperCase().includes("FOR UPDATE")
            && String(row?.definition || "").includes("providerAcknowledgementField=")
          : true,
      privileges: {
        anonExecute: privileges?.anon_execute === true,
        authenticatedExecute: privileges?.authenticated_execute === true,
        serviceExecute: privileges?.service_execute === true,
        unauthorizedRoles: unauthorized,
      },
    });
  }
  return { tableOwner, columns, receiptOrderConstraintValidated: constraint?.convalidated === true, functions };
}

function isReady(live) {
  if (!live?.tableOwner
    || JSON.stringify(live.columns) !== JSON.stringify(["provider_dispatch_receipt", "provider_submission_receipt"])
    || live.receiptOrderConstraintValidated !== true
    || live.functions?.length !== FUNCTIONS.length) return false;
  return live.functions.every(item => {
    const expectedGrantees = item.serviceRole ? [live.tableOwner, "service_role"].sort() : [live.tableOwner];
    return item.exists
      && item.owner === live.tableOwner
      && item.securityDefiner === true
      && item.searchPath.length === 1
      && item.searchPath[0] === "search_path=public, pg_temp"
      && JSON.stringify([...item.executeGrantees].sort()) === JSON.stringify(expectedGrantees)
      && item.privileges.anonExecute === false
      && item.privileges.authenticatedExecute === false
      && item.privileges.serviceExecute === item.serviceRole
      && item.privileges.unauthorizedRoles.length === 0
      && item.receiptAware
      && item.contractBodyReady;
  });
}

async function runSavepointProbe() {
  const nonce = crypto.randomBytes(12).toString("hex");
  const recordId = digest(`receipt-probe-record:${nonce}`);
  const userId = `receipt-probe-user-${nonce}`;
  const userHash = digest(userId);
  const idempotencyKey = `receipt_probe_${nonce}`;
  const traceId = `receipt_trace_${nonce}`;
  const payloadFingerprint = digest(`receipt-probe-payload:${nonce}`);
  const promptHash = digest("receipt-probe-prompt");
  const snapshot = {
    schema: "image_generation_request_snapshot.v2", surface: "image-workbench", prompt: "receipt probe",
    publicModelId: "receipt-probe-model", modelName: "receipt probe model", mode: "text-to-image",
    aspectRatio: "16:9", resolution: "1K", referenceAssetRefs: [], quotedPriceYuan: 0,
    billingExempt: true, style: "", effectivePrompt: "receipt probe", providerProtocol: "images_generations",
    outputPixelSize: "1024x576", imageCount: 1, referenceUsage: "general", payloadFingerprint,
  };
  await client.query("savepoint image_provider_receipt_probe");
  const claim = (await client.query(
    "select public.claim_image_generation_request_v2($1,$2,$3,$4,$5,$6,$7::jsonb) as result",
    [recordId, userId, userHash, idempotencyKey, traceId, payloadFingerprint, snapshot],
  )).rows[0]?.result;
  assert.equal(claim?.created, true, "PROBE_CLAIM_REQUIRED");
  const dispatch = withHash({
    schema: "image_provider_dispatch_receipt.v1", receiptId: `dispatch_${nonce}`, recordedAt: new Date().toISOString(),
    providerProtocol: "images_generations", endpointOriginSha256: digest("https://provider.invalid"),
    requestContentType: "application/json", actualPayloadSha256: digest("wire-body"), actualPayloadBytes: 9,
    idempotencyKeySha256: digest(idempotencyKey),
    requestProjection: { userPromptSha256: promptHash, effectivePromptSha256: promptHash,
      modelIdSha256: digest("receipt-probe-model"), aspectRatio: "16:9", resolution: "1K", imageCount: 1, referenceCount: 0 },
  });
  const dispatchResult = (await client.query(
    "select public.record_image_provider_dispatch_receipt_atomic($1,$2,$3,$4,$5::jsonb) as result",
    [recordId, userId, traceId, payloadFingerprint, dispatch],
  )).rows[0]?.result;
  assert.equal(dispatchResult?.record?.provider_dispatch_receipt?.receiptSha256, dispatch.receiptSha256, "PROBE_DISPATCH_RECEIPT_REQUIRED");
  await client.query("savepoint image_provider_dispatch_hash_tamper");
  try {
    const tamperedDispatch = {
      ...dispatch,
      requestProjection: { ...dispatch.requestProjection, aspectRatio: "1:1" },
    };
    await client.query(
      "select public.record_image_provider_dispatch_receipt_atomic($1,$2,$3,$4,$5::jsonb)",
      [recordId, userId, traceId, payloadFingerprint, tamperedDispatch],
    );
    assert.fail("PROBE_TAMPERED_DISPATCH_HASH_MUST_FAIL");
  } catch (error) {
    assert.equal(error?.code, "22023", "PROBE_TAMPERED_DISPATCH_HASH_ERROR_REQUIRED");
  } finally {
    await client.query("rollback to savepoint image_provider_dispatch_hash_tamper");
    await client.query("release savepoint image_provider_dispatch_hash_tamper");
  }
  const submission = withHash({
    schema: "image_provider_submission_receipt.v1", receiptId: `submission_${nonce}`,
    dispatchReceiptSha256: dispatch.receiptSha256, recordedAt: new Date().toISOString(),
    providerProtocol: "images_generations", transportState: "response_received", responseStatus: 200,
    responseContentType: "application/json", responseBodySha256: digest("provider-response"), responseBodyBytes: 17,
    providerAcknowledgementSha256: digest("provider-task-id"), providerAcknowledgementField: "task_id",
  });
  const submissionResult = (await client.query(
    "select public.record_image_provider_submission_receipt_atomic($1,$2,$3,$4,$5,$6::jsonb) as result",
    [recordId, userId, traceId, payloadFingerprint, dispatch.receiptSha256, submission],
  )).rows[0]?.result;
  assert.equal(submissionResult?.record?.provider_submission_receipt?.receiptSha256, submission.receiptSha256, "PROBE_SUBMISSION_RECEIPT_REQUIRED");
  await client.query("savepoint image_provider_submission_hash_tamper");
  try {
    await client.query(
      "select public.record_image_provider_submission_receipt_atomic($1,$2,$3,$4,$5,$6::jsonb)",
      [recordId, userId, traceId, payloadFingerprint, dispatch.receiptSha256, { ...submission, responseContentType: "text/plain" }],
    );
    assert.fail("PROBE_TAMPERED_SUBMISSION_HASH_MUST_FAIL");
  } catch (error) {
    assert.equal(error?.code, "22023", "PROBE_TAMPERED_SUBMISSION_HASH_ERROR_REQUIRED");
  } finally {
    await client.query("rollback to savepoint image_provider_submission_hash_tamper");
    await client.query("release savepoint image_provider_submission_hash_tamper");
  }
  await client.query("update public.image_generation_requests set updated_at=clock_timestamp()-interval '20 minutes' where record_id=$1", [recordId]);
  const reconcile = (await client.query(
    "select public.reconcile_stale_image_generation_request_atomic($1,$2,600) as result", [recordId, userId],
  )).rows[0]?.result;
  assert.equal(reconcile?.reconciled, false, "PROBE_RECEIPT_MUST_BLOCK_STALE_RECONCILIATION");
  assert.equal(reconcile?.reason, "provider_evidence_present", "PROBE_RECEIPT_RECONCILIATION_REASON_INVALID");
  await client.query("rollback to savepoint image_provider_receipt_probe");
  return {
    claimCreated: true, dispatchRecorded: true, submissionRecorded: true,
    dispatchFullHashTamperRejected: true, submissionFullHashTamperRejected: true,
    staleReconciliationBlocked: true,
  };
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "select current_user,current_database() as database_name,inet_server_addr()::text as server_address,inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.current_user, "postgres", "LOCAL_MIGRATION_ROLE_REQUIRED");
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1", "LIVE_DATABASE_HOST_MISMATCH");

  const prior = await client.query(
    "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1", [VERSION],
  );
  const before = await liveProjection();
  if (!APPLY && !PROBE_ROLLBACK) {
    const report = {
      passed: true, mode: "read-only-check", checkedAt: new Date().toISOString(), target: "127.0.0.1:54322/zimeiti_local",
      migration: MIGRATION_FILE, migrationHash, ledgerPresent: prior.rowCount === 1,
      rollback: ROLLBACK_FILE, rollbackHash,
      ledgerHashMatches: prior.rowCount === 1 && String(prior.rows[0]?.hash || "") === migrationHash,
      live: before, ready: prior.rowCount === 1 && String(prior.rows[0]?.hash || "") === migrationHash && isReady(before),
      writes: 0, providerCalls: 0, billingOperations: 0, credentialsPrinted: false,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 2;
  } else {
    await client.query("begin");
    transactionOpen = true;
    await client.query("select pg_advisory_xact_lock(hashtextextended('image-provider-receipts:20261010133000',0))");
    if (PROBE_ROLLBACK) {
      await client.query(migrationBody);
      const live = await liveProjection();
      assert.equal(isReady(live), true, "PROBE_LIVE_PROVIDER_RECEIPT_CONTRACT_INVALID");
      const probe = await runSavepointProbe();
      await client.query("savepoint image_provider_receipt_rollback_acl_probe");
      await client.query("grant execute on function public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb) to authenticated");
      let unsafeRollbackRejected = false;
      try {
        await client.query(rollbackBody);
      } catch (error) {
        unsafeRollbackRejected = /IMAGE_PROVIDER_RECEIPT_SECURITY_ALIGNMENT_REQUIRED|IMAGE_PROVIDER_RECEIPT_EFFECTIVE_EXECUTE_ACL_INVALID/u
          .test(error instanceof Error ? error.message : String(error));
      }
      await client.query("rollback to savepoint image_provider_receipt_rollback_acl_probe");
      assert.equal(unsafeRollbackRejected, true, "ROLLBACK_GUARD_MUST_REJECT_UNAUTHORIZED_EXECUTE_ACL");
      await client.query(rollbackBody);
      const afterRollbackGuard = await liveProjection();
      assert.equal(isReady(afterRollbackGuard), true, "ROLLBACK_GUARD_MUST_PRESERVE_PROVIDER_RECEIPT_CONTRACT");
      await client.query("rollback");
      transactionOpen = false;
      console.log(JSON.stringify({
        passed: true, mode: "transaction-rollback-probe", checkedAt: new Date().toISOString(),
        target: "127.0.0.1:54322/zimeiti_local", migration: MIGRATION_FILE, migrationHash,
        rollback: ROLLBACK_FILE, rollbackHash, live, probe,
        rollbackGuardRejectedUnauthorizedAcl: true, rollbackGuardPreservedLiveContract: true,
        durableWrites: 0, ledgerWrites: 0, providerCalls: 0, billingOperations: 0, credentialsPrinted: false,
      }, null, 2));
    } else {
      const lockedPrior = await client.query(
        "select version,name,hash from supabase_migrations.schema_migrations where version::text=$1 for update", [VERSION],
      );
      let action = "already_applied";
      if (lockedPrior.rowCount) {
        assert.equal(String(lockedPrior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
        if (!isReady(await liveProjection())) {
          await client.query(migrationBody);
          action = "reapplied_after_verified_drift";
        }
      } else {
        await client.query(migrationBody);
        await client.query(
          `insert into supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
           values($1,$2,$3,$4,$5,now())`,
          [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-image-provider-receipts"],
        );
        action = "applied";
      }
      const after = await liveProjection();
      assert.equal(isReady(after), true, "LIVE_IMAGE_PROVIDER_RECEIPT_CONTRACT_INVALID");
      await client.query("commit");
      transactionOpen = false;
      const checkedAt = new Date().toISOString();
      const evidenceDir = path.resolve(".codex-evidence", "image-provider-receipts");
      const evidenceName = `${checkedAt.replace(/[:.]/gu, "-")}-${action}-${migrationHash.slice(0, 12)}-${crypto.randomBytes(4).toString("hex")}.json`;
      const report = {
        passed: true, mode: "local-transactional-apply", checkedAt, target: "127.0.0.1:54322/zimeiti_local",
        action, migration: MIGRATION_FILE, migrationHash, before, after,
        rollback: ROLLBACK_FILE, rollbackHash,
        dataRowsChanged: 0, providerCalls: 0, billingOperations: 0, productionWrites: 0,
        credentialsPrinted: false, evidenceFile: path.join(evidenceDir, evidenceName),
      };
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, evidenceName), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      console.log(JSON.stringify(report, null, 2));
    }
  }
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
