#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const VERSION = "20261010130000";
const NAME = "image_generation_request_snapshot_v2";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const OWNER_ALIGNMENT_VERSION = "20261010131000";
const OWNER_ALIGNMENT_NAME = "image_security_definer_owner_alignment";
const OWNER_ALIGNMENT_FILE = `${OWNER_ALIGNMENT_VERSION}_${OWNER_ALIGNMENT_NAME}.sql`;
const PROVIDER_RECEIPTS_VERSION = "20261010133000";
const PROVIDER_RECEIPTS_NAME = "image_provider_dispatch_receipts";
const PROVIDER_RECEIPTS_FILE = `${PROVIDER_RECEIPTS_VERSION}_${PROVIDER_RECEIPTS_NAME}.sql`;
const APPLY = process.argv.includes("--apply");
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

if (APPLY) {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(
    process.argv.includes("--confirm-local-image-snapshot-v2-only"),
    "LOCAL_IMAGE_SNAPSHOT_V2_CONFIRMATION_REQUIRED",
  );
}

function transactionBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^begin\s*;/iu, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /commit\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^begin\s*;/iu, "").replace(/commit\s*;\s*$/iu, "").trim();
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
const migrationHash = digest(migrationSource);
const migrationBody = transactionBody(migrationSource);
const ownerAlignmentSource = await fs.readFile(
  path.resolve("supabase/migrations", OWNER_ALIGNMENT_FILE),
  "utf8",
);
const ownerAlignmentHash = digest(ownerAlignmentSource);
const providerReceiptsSource = await fs.readFile(
  path.resolve("supabase/migrations", PROVIDER_RECEIPTS_FILE),
  "utf8",
);
const providerReceiptsHash = digest(providerReceiptsSource);

function migrationFunctionBody(source, functionName) {
  const marker = `create or replace function public.${functionName}(`;
  const start = source.toLowerCase().indexOf(marker);
  assert.ok(start >= 0, `MIGRATION_FUNCTION_REQUIRED:${functionName}`);
  const bodyMarker = "as $$";
  const bodyStartMarker = source.toLowerCase().indexOf(bodyMarker, start);
  assert.ok(bodyStartMarker >= 0, `MIGRATION_FUNCTION_BODY_REQUIRED:${functionName}`);
  const bodyStart = bodyStartMarker + bodyMarker.length;
  const bodyEnd = source.indexOf("$$;", bodyStart);
  assert.ok(bodyEnd >= 0, `MIGRATION_FUNCTION_BODY_END_REQUIRED:${functionName}`);
  return source.slice(bodyStart, bodyEnd);
}

function normalizeFunctionBody(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").trim();
}

function functionBodySemanticHash(value) {
  return digest(normalizeFunctionBody(value));
}

const expectedV2ReconciliationBody = migrationFunctionBody(
  migrationSource,
  "reconcile_stale_image_generation_request_atomic",
);
const expectedReceiptAwareWrapperBody = migrationFunctionBody(
  providerReceiptsSource,
  "reconcile_stale_image_generation_request_atomic",
);
const expectedV2ReconciliationBodyHash = functionBodySemanticHash(expectedV2ReconciliationBody);
const expectedReceiptAwareWrapperBodyHash = functionBodySemanticHash(expectedReceiptAwareWrapperBody);

for (const token of [
  "image_generation_request_snapshot.v1",
  "image_generation_request_snapshot.v2",
  "'0.5K'",
  "'3K'",
  "payloadFingerprint",
  "effectivePrompt",
  "providerProtocol",
  "outputPixelSize",
  "imageCount",
  "referenceUsage",
  "reconcile_stale_image_generation_request_atomic",
  "notify pgrst, 'reload schema'",
]) {
  assert.ok(migrationSource.includes(token), `MIGRATION_CONTRACT_TOKEN_REQUIRED:${token}`);
}
assert.match(migrationSource, /set local lock_timeout\s*=\s*'10s'/iu, "LOCK_TIMEOUT_REQUIRED");

const client = new Client({
  ...runtime.ownerConnection,
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-image-request-snapshot-v2",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

function supportsV2StaleReconciliation(
  publicBody,
  helperBody,
  directBodyHash = expectedV2ReconciliationBodyHash,
  wrapperBodyHash = expectedReceiptAwareWrapperBodyHash,
) {
  const publicBodyHash = functionBodySemanticHash(publicBody);
  const helperBodyHash = helperBody ? functionBodySemanticHash(helperBody) : null;
  return publicBodyHash === directBodyHash
    || (
      publicBodyHash === wrapperBodyHash
      && helperBodyHash === directBodyHash
    );
}

function snapshotApplyDecision({
  snapshotLedgerPresent,
  snapshotLedgerHashMatches,
  providerReceiptsLedgerPresent,
  providerReceiptsLedgerHashMatches,
  snapshotReady,
}) {
  if (snapshotLedgerPresent && !snapshotLedgerHashMatches) {
    throw new Error("MIGRATION_LEDGER_HASH_CONFLICT");
  }
  if (providerReceiptsLedgerPresent && !providerReceiptsLedgerHashMatches) {
    throw new Error("PROVIDER_RECEIPTS_LEDGER_HASH_CONFLICT");
  }
  if (providerReceiptsLedgerPresent && !snapshotLedgerPresent) {
    throw new Error("IMAGE_SNAPSHOT_V2_BASE_LEDGER_MISSING_AFTER_1330");
  }
  if (snapshotLedgerPresent && !snapshotReady) {
    throw new Error(providerReceiptsLedgerPresent
      ? "IMAGE_SNAPSHOT_V2_FORWARD_REPAIR_REQUIRED_AFTER_1330"
      : "IMAGE_SNAPSHOT_V2_FORWARD_REPAIR_REQUIRED");
  }
  return snapshotLedgerPresent ? "already_applied" : "apply";
}

async function liveProjection() {
  const tableOwner = String((await client.query(
    "select pg_get_userbyid(relowner) as owner from pg_class where oid='public.image_generation_requests'::regclass",
  )).rows[0]?.owner || "");
  const definition = String((await client.query(
    `select pg_get_functiondef(
       'public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)'::regprocedure
     ) as definition`,
  )).rows[0]?.definition || "");
  const reconciliationDefinition = String((await client.query(
    `select pg_get_functiondef(
       'public.reconcile_stale_image_generation_request_atomic(text,text,integer)'::regprocedure
     ) as definition`,
  )).rows[0]?.definition || "");
  const reconciliationHelperDefinition = String((await client.query(
    `select coalesce(pg_get_functiondef(
       to_regprocedure('public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)')
     ), '') as definition`,
  )).rows[0]?.definition || "");
  const reconciliationBody = String((await client.query(
    `select prosrc as body
       from pg_proc
      where oid='public.reconcile_stale_image_generation_request_atomic(text,text,integer)'::regprocedure`,
  )).rows[0]?.body || "");
  const reconciliationHelperBody = String((await client.query(
    `select coalesce((
       select prosrc from pg_proc
        where oid=to_regprocedure(
          'public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)'
        )
     ), '') as body`,
  )).rows[0]?.body || "");
  const constraint = String((await client.query(
    `select pg_get_constraintdef(oid, true) as definition
       from pg_constraint
      where conrelid='public.image_generation_requests'::regclass
        and conname='image_generation_requests_snapshot_valid'`,
  )).rows[0]?.definition || "");
  const snapshotCounts = (await client.query(
    `select
       count(*) filter (where request_snapshot is null)::integer as null_count,
       count(*) filter (where request_snapshot->>'schema'='image_generation_request_snapshot.v1')::integer as v1_count,
       count(*) filter (where request_snapshot->>'schema'='image_generation_request_snapshot.v2')::integer as v2_count
       from public.image_generation_requests`,
  )).rows[0];
  const privileges = (await client.query(
    `select
       has_function_privilege('anon','public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)','execute') as anon_execute,
       has_function_privilege('authenticated','public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)','execute') as authenticated_execute,
       has_function_privilege('service_role','public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)','execute') as service_execute`,
  )).rows[0];
  const reconciliationPrivileges = (await client.query(
    `select
       has_function_privilege('anon','public.reconcile_stale_image_generation_request_atomic(text,text,integer)','execute') as anon_execute,
       has_function_privilege('authenticated','public.reconcile_stale_image_generation_request_atomic(text,text,integer)','execute') as authenticated_execute,
       has_function_privilege('service_role','public.reconcile_stale_image_generation_request_atomic(text,text,integer)','execute') as service_execute`,
  )).rows[0];
  const security = (await client.query(
    `select pg_get_userbyid(p.proowner) as owner,
            p.prosecdef as security_definer,
            p.proconfig,
            to_jsonb(array(
              select coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')
                from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
               where acl.privilege_type='EXECUTE'
               order by 1
            )) as execute_grantees
       from pg_proc p
      where p.oid='public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)'::regprocedure`,
  )).rows[0];
  const reconciliationSecurity = (await client.query(
    `select pg_get_userbyid(p.proowner) as owner,
            p.prosecdef as security_definer,
            p.proconfig,
            to_jsonb(array(
              select coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')
                from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
               where acl.privilege_type='EXECUTE'
               order by 1
            )) as execute_grantees
       from pg_proc p
      where p.oid='public.reconcile_stale_image_generation_request_atomic(text,text,integer)'::regprocedure`,
  )).rows[0];
  return {
    tableOwner,
    functionDefinitionSha256: digest(definition),
    reconciliationDefinitionSha256: digest(reconciliationDefinition),
    reconciliationHelperDefinitionSha256: reconciliationHelperDefinition
      ? digest(reconciliationHelperDefinition)
      : null,
    reconciliationBodySemanticSha256: functionBodySemanticHash(reconciliationBody),
    reconciliationHelperBodySemanticSha256: reconciliationHelperBody
      ? functionBodySemanticHash(reconciliationHelperBody)
      : null,
    expectedV2ReconciliationBodySemanticSha256: expectedV2ReconciliationBodyHash,
    expectedReceiptAwareWrapperBodySemanticSha256: expectedReceiptAwareWrapperBodyHash,
    constraintDefinitionSha256: digest(constraint),
    acceptsV2: definition.includes("image_generation_request_snapshot.v2")
      && constraint.includes("image_generation_request_snapshot.v2"),
    acceptsHalfK: definition.includes("'0.5K'"),
    accepts3K: definition.includes("'3K'"),
    validatesV2Integrity: [
      "style", "effectivePrompt", "providerProtocol", "outputPixelSize",
      "imageCount", "referenceUsage", "payloadFingerprint",
    ].every(token => definition.includes(token)),
    reconcilesV2: supportsV2StaleReconciliation(
      reconciliationBody,
      reconciliationHelperBody,
    ),
    snapshotCounts: {
      null: Number(snapshotCounts?.null_count || 0),
      v1: Number(snapshotCounts?.v1_count || 0),
      v2: Number(snapshotCounts?.v2_count || 0),
    },
    privileges: {
      anonExecute: Boolean(privileges?.anon_execute),
      authenticatedExecute: Boolean(privileges?.authenticated_execute),
      serviceExecute: Boolean(privileges?.service_execute),
    },
    reconciliationPrivileges: {
      anonExecute: Boolean(reconciliationPrivileges?.anon_execute),
      authenticatedExecute: Boolean(reconciliationPrivileges?.authenticated_execute),
      serviceExecute: Boolean(reconciliationPrivileges?.service_execute),
    },
    security: {
      owner: String(security?.owner || ""),
      securityDefiner: security?.security_definer === true,
      searchPath: Array.isArray(security?.proconfig) ? security.proconfig.map(String) : [],
      executeGrantees: Array.isArray(security?.execute_grantees) ? security.execute_grantees.map(String) : [],
    },
    reconciliationSecurity: {
      owner: String(reconciliationSecurity?.owner || ""),
      securityDefiner: reconciliationSecurity?.security_definer === true,
      searchPath: Array.isArray(reconciliationSecurity?.proconfig)
        ? reconciliationSecurity.proconfig.map(String)
        : [],
      executeGrantees: Array.isArray(reconciliationSecurity?.execute_grantees)
        ? reconciliationSecurity.execute_grantees.map(String)
        : [],
    },
  };
}

function privilegesReady(value) {
  return value?.anonExecute === false
    && value?.authenticatedExecute === false
    && value?.serviceExecute === true;
}

function snapshotMigrationSecurityReady(value, tableOwner) {
  const owner = String(value?.owner || "");
  const allowed = new Set([owner, "service_role"]);
  return Boolean(owner)
    && (owner === "postgres" || owner === tableOwner)
    && value?.securityDefiner === true
    && Array.isArray(value?.searchPath)
    && value.searchPath.length === 1
    && value.searchPath[0] === "search_path=public, pg_temp"
    && Array.isArray(value?.executeGrantees)
    && value.executeGrantees.includes("service_role")
    && value.executeGrantees.every(grantee => allowed.has(grantee));
}

function securityReady(value, tableOwner) {
  const allowed = new Set([String(tableOwner || ""), "service_role"]);
  return Boolean(tableOwner)
    && value?.owner === tableOwner
    && value?.securityDefiner === true
    && Array.isArray(value?.searchPath)
    && value.searchPath.length === 1
    && value.searchPath[0] === "search_path=public, pg_temp"
    && Array.isArray(value?.executeGrantees)
    && value.executeGrantees.includes("service_role")
    && value.executeGrantees.every(grantee => allowed.has(grantee));
}

function snapshotMigrationReady(live) {
  return live.acceptsV2
    && live.acceptsHalfK
    && live.accepts3K
    && live.validatesV2Integrity
    && live.reconcilesV2
    && privilegesReady(live.privileges)
    && privilegesReady(live.reconciliationPrivileges)
    && snapshotMigrationSecurityReady(live.security, live.tableOwner)
    && snapshotMigrationSecurityReady(live.reconciliationSecurity, live.tableOwner);
}

function finalCombinedReady(live) {
  return snapshotMigrationReady(live)
    && securityReady(live.security, live.tableOwner)
    && securityReady(live.reconciliationSecurity, live.tableOwner);
}

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

  const before = await liveProjection();
  const prior = await client.query(
    "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1",
    [VERSION],
  );
  const ownerAlignmentPrior = await client.query(
    "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1",
    [OWNER_ALIGNMENT_VERSION],
  );
  const providerReceiptsPrior = await client.query(
    "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1",
    [PROVIDER_RECEIPTS_VERSION],
  );

  if (!APPLY) {
    const ledgerHashMatches = prior.rowCount === 1
      && String(prior.rows[0]?.hash || "") === migrationHash;
    const ownerAlignmentLedgerHashMatches = ownerAlignmentPrior.rowCount === 1
      && String(ownerAlignmentPrior.rows[0]?.hash || "") === ownerAlignmentHash;
    const report = {
      passed: true,
      mode: "read-only-check",
      checkedAt: new Date().toISOString(),
      target: "127.0.0.1:54322/zimeiti_local",
      migration: MIGRATION_FILE,
      migrationHash,
      ledgerPresent: prior.rowCount === 1,
      ledgerHashMatches,
      ownerAlignment: {
        migration: OWNER_ALIGNMENT_FILE,
        migrationHash: ownerAlignmentHash,
        ledgerPresent: ownerAlignmentPrior.rowCount === 1,
        ledgerHashMatches: ownerAlignmentLedgerHashMatches,
      },
      providerReceipts: {
        migration: PROVIDER_RECEIPTS_FILE,
        migrationHash: providerReceiptsHash,
        ledgerPresent: providerReceiptsPrior.rowCount === 1,
        ledgerHashMatches: providerReceiptsPrior.rowCount === 1
          && String(providerReceiptsPrior.rows[0]?.hash || "") === providerReceiptsHash,
      },
      live: before,
      snapshotMigrationReady: snapshotMigrationReady(before),
      finalOwnerAlignmentReady: finalCombinedReady(before),
      ready: ledgerHashMatches
        && ownerAlignmentLedgerHashMatches
        && finalCombinedReady(before),
      writes: 0,
      providerCalls: 0,
      billingOperations: 0,
      credentialsPrinted: false,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 2;
  } else {
    await client.query("begin");
    transactionOpen = true;
    await client.query("select pg_advisory_xact_lock(hashtextextended('image-request-snapshot-v2:20261010130000',0))");

    const lockedPrior = await client.query(
      "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1 for update",
      [VERSION],
    );
    const lockedProviderReceiptsPrior = await client.query(
      "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1 for update",
      [PROVIDER_RECEIPTS_VERSION],
    );
    const liveBeforeLocked = await liveProjection();
    const applyDecision = snapshotApplyDecision({
      snapshotLedgerPresent: lockedPrior.rowCount === 1,
      snapshotLedgerHashMatches: lockedPrior.rowCount === 1
        && String(lockedPrior.rows[0]?.hash || "") === migrationHash,
      providerReceiptsLedgerPresent: lockedProviderReceiptsPrior.rowCount === 1,
      providerReceiptsLedgerHashMatches: lockedProviderReceiptsPrior.rowCount === 1
        && String(lockedProviderReceiptsPrior.rows[0]?.hash || "") === providerReceiptsHash,
      snapshotReady: snapshotMigrationReady(liveBeforeLocked),
    });
    if (applyDecision === "apply") {
      await client.query(migrationBody);
      await client.query(
        `insert into supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         values($1,$2,$3,$4,$5,now())`,
        [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-image-snapshot-v2"],
      );
    }
    const action = applyDecision === "apply" ? "applied" : applyDecision;

    const after = await liveProjection();
    assert.equal(after.acceptsV2, true, "LIVE_V2_CONTRACT_REQUIRED");
    assert.equal(after.acceptsHalfK, true, "LIVE_HALF_K_CONTRACT_REQUIRED");
    assert.equal(after.accepts3K, true, "LIVE_3K_CONTRACT_REQUIRED");
    assert.equal(after.validatesV2Integrity, true, "LIVE_V2_INTEGRITY_REQUIRED");
    assert.equal(after.reconcilesV2, true, "LIVE_V2_STALE_RECONCILIATION_REQUIRED");
    assert.deepEqual(after.privileges, {
      anonExecute: false,
      authenticatedExecute: false,
      serviceExecute: true,
    }, "LIVE_RPC_PRIVILEGES_CHANGED");
    assert.equal(
      snapshotMigrationSecurityReady(after.security, after.tableOwner),
      true,
      "LIVE_RPC_SECURITY_DEFINER_UNSAFE",
    );
    assert.deepEqual(after.reconciliationPrivileges, {
      anonExecute: false,
      authenticatedExecute: false,
      serviceExecute: true,
    }, "LIVE_RECONCILIATION_RPC_PRIVILEGES_CHANGED");
    assert.equal(
      snapshotMigrationSecurityReady(after.reconciliationSecurity, after.tableOwner),
      true,
      "LIVE_RECONCILIATION_RPC_EXECUTE_GRANTEES_UNSAFE",
    );

    const fingerprint = "a".repeat(64);
    const snapshot = {
      schema: "image_generation_request_snapshot.v2",
      surface: "other",
      prompt: "transactional database contract probe",
      publicModelId: "contract-probe",
      modelName: "Contract Probe",
      mode: "text-to-image",
      aspectRatio: "1:1",
      resolution: "0.5K",
      referenceAssetRefs: [],
      quotedPriceYuan: 0,
      billingExempt: true,
      style: "",
      effectivePrompt: "transactional database contract probe",
      providerProtocol: "chat_completions",
      outputPixelSize: "512x512",
      imageCount: 1,
      referenceUsage: "general",
      payloadFingerprint: fingerprint,
    };
    const suffix = crypto.randomBytes(12).toString("hex");
    const probeRecordId = `contract_probe_${suffix}`;
    const probeUserId = `contract_probe_user_${suffix}`;

    await client.query("savepoint valid_v2_probe");
    const validProbe = await client.query(
      `select public.claim_image_generation_request_v2($1,$2,$3,$4,$5,$6,$7::jsonb) as result`,
      [
        probeRecordId,
        probeUserId,
        digest(probeUserId),
        `contract_probe_key_${suffix}`,
        `contract_probe_trace_${suffix}`,
        fingerprint,
        JSON.stringify(snapshot),
      ],
    );
    assert.equal(validProbe.rows[0]?.result?.created, true, "VALID_V2_TRANSACTIONAL_PROBE_FAILED");
    await client.query(
      "update public.image_generation_requests set updated_at=clock_timestamp()-interval '601 seconds' where record_id=$1",
      [probeRecordId],
    );
    const staleProbe = (await client.query(
      "select public.reconcile_stale_image_generation_request_atomic($1,$2,$3) as result",
      [probeRecordId, probeUserId, 600],
    )).rows[0]?.result;
    assert.equal(staleProbe?.reconciled, true, "VALID_V2_STALE_RECONCILIATION_FAILED");
    assert.equal(staleProbe?.reason, "stale_interrupted", "VALID_V2_STALE_RECONCILIATION_REASON_INVALID");
    assert.equal(staleProbe?.refunded, false, "ZERO_PRICE_PROBE_MUST_NOT_CREATE_REFUND");
    assert.equal(staleProbe?.record?.state, "failed_unknown", "STALE_V2_PROBE_NOT_TERMINAL");
    assert.equal(
      staleProbe?.record?.response?.code,
      "IMAGE_PLATFORM_REQUEST_INTERRUPTED",
      "STALE_V2_PROBE_REJECTION_RECEIPT_INVALID",
    );
    await client.query("rollback to savepoint valid_v2_probe");
    await client.query("release savepoint valid_v2_probe");

    await client.query("savepoint invalid_v2_probe");
    let invalidRejected = false;
    try {
      await client.query(
        `select public.claim_image_generation_request_v2($1,$2,$3,$4,$5,$6,$7::jsonb) as result`,
        [
          `contract_invalid_probe_${suffix}`,
          `contract_invalid_user_${suffix}`,
          digest(`contract_invalid_user_${suffix}`),
          `contract_invalid_key_${suffix}`,
          `contract_invalid_trace_${suffix}`,
          "b".repeat(64),
          JSON.stringify(snapshot),
        ],
      );
    } catch (error) {
      invalidRejected = String(error?.message || "").includes("IMAGE_REQUEST_SNAPSHOT_INVALID");
      await client.query("rollback to savepoint invalid_v2_probe");
    }
    assert.equal(invalidRejected, true, "INVALID_V2_FINGERPRINT_MUST_FAIL_CLOSED");
    await client.query("release savepoint invalid_v2_probe");

    const afterProbe = await liveProjection();
    assert.deepEqual(afterProbe.snapshotCounts, before.snapshotCounts, "TRANSACTIONAL_PROBE_LEFT_DURABLE_ROWS");
    await client.query("commit");
    transactionOpen = false;

    const checkedAt = new Date().toISOString();
    const evidenceDir = path.resolve(".codex-evidence", "image-request-snapshot-v2");
    const evidenceName = `${checkedAt.replace(/[:.]/gu, "-")}-${action}-${migrationHash.slice(0, 12)}-${suffix.slice(0, 8)}.json`;
    const report = {
      passed: true,
      mode: "local-transactional-apply",
      checkedAt,
      target: "127.0.0.1:54322/zimeiti_local",
      action,
      migration: MIGRATION_FILE,
      migrationHash,
      before,
      after: afterProbe,
      snapshotMigrationReady: snapshotMigrationReady(afterProbe),
      finalOwnerAlignmentReady: finalCombinedReady(afterProbe),
      transactionalProbe: {
        validV2Accepted: true,
        staleV2Reconciled: true,
        staleV2Result: "failed_unknown/IMAGE_PLATFORM_REQUEST_INTERRUPTED",
        mismatchedFingerprintRejected: true,
        durableRowsCreated: 0,
        providerCalls: 0,
        billingOperations: 0,
      },
      productionWrites: 0,
      credentialsPrinted: false,
      evidenceFile: path.join(evidenceDir, evidenceName),
    };
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, evidenceName), `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
