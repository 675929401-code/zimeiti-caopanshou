#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002190000";
const MIGRATION_FILE = `${VERSION}_security_event_reliability.sql`;
const ROLLBACK_FILE = `${VERSION}_security_event_reliability.rollback.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_LOCAL_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-security-event-reliability"),
  "LOCAL_SECURITY_EVENT_RELIABILITY_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");

function transactionBody(source, label) {
  const normalized = source.replace(/^\uFEFF/u, "");
  const withoutBegin = normalized.replace(/^BEGIN;\s*/u, "");
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/u, "");
  assert.notEqual(withoutBegin, normalized, `${label}_BEGIN_REQUIRED`);
  assert.notEqual(withoutCommit, withoutBegin, `${label}_COMMIT_REQUIRED`);
  return withoutCommit;
}

const migrationBody = transactionBody(migrationSource, "MIGRATION");
const rollbackBody = transactionBody(rollbackSource, "ROLLBACK");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const rollbackHash = crypto.createHash("sha256").update(rollbackSource).digest("hex");
const suffix = crypto.randomUUID().replace(/-/gu, "").slice(0, 16);
const hash64 = (label) => crypto.createHash("sha256").update(`${label}:${suffix}`).digest("hex");
const ipHash = hash64("ip").slice(0, 32);
const actorHash = hash64("actor").slice(0, 32);
const uaHash = hash64("user-agent").slice(0, 32);

const tables = [
  "security_event_retention_policies",
  "security_event_outbox",
  "security_event_delivery_attempts",
  "security_event_dead_letters",
  "security_rate_limit_windows",
  "security_ip_risk_state",
];
const securityEventColumns = [
  "reliable_ingest_id",
  "event_fingerprint",
  "occurrence_count",
  "first_observed_at",
  "last_observed_at",
  "privacy_version",
  "retention_until",
];

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-security-event-reliability",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

async function relationCount() {
  return Number((await client.query(
    `SELECT count(*)::integer AS count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`,
    [tables],
  )).rows[0]?.count || 0);
}

async function reliabilityColumnCount() {
  return Number((await client.query(
    `SELECT count(*)::integer AS count
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='security_events' AND column_name=ANY($1::text[])`,
    [securityEventColumns],
  )).rows[0]?.count || 0);
}

async function expectDatabaseFailure(label, sql, params, predicate) {
  const savepoint = `expected_${label}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let matched = false;
  let observed = null;
  try {
    await client.query(sql, params);
  } catch (error) {
    observed = { code: error?.code || null, message: String(error?.message || "") };
    matched = predicate(error);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.equal(matched, true, `${label.toUpperCase()}_REJECTION_REQUIRED:${JSON.stringify(observed)}`);
  return observed;
}

async function enqueue({ key, fingerprint, risk = "medium", details = "Masked local reliability probe", pathValue = "/api/local-probe" }) {
  return (await client.query(
    `SELECT public.enqueue_security_event_atomic(
       $1,$2,date_trunc('minute',clock_timestamp()),'api_abuse',$3,$4,$5,$6,$7,'POST',$8,true,'api_direct',clock_timestamp()
     ) AS receipt`,
    [key, fingerprint, risk, ipHash, actorHash, uaHash, pathValue, details],
  )).rows[0].receipt;
}

async function claim(worker) {
  return (await client.query(
    "SELECT id::text,lease_token::text,attempt_count,status FROM public.claim_security_event_outbox_batch($1,1,30)",
    [worker],
  )).rows[0] || null;
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name,inet_server_addr()::text AS server_address,inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
  assert.equal(
    Number((await client.query(
      "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema='public' AND table_name='security_events'",
    )).rows[0].count),
    1,
    "SOURCE_SECURITY_EVENTS_REQUIRED",
  );
  assert.equal(
    Number((await client.query(
      "SELECT count(*)::integer AS count FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [VERSION],
    )).rows[0].count),
    0,
    "SECURITY_EVENT_RELIABILITY_MIGRATION_ALREADY_APPLIED",
  );
  assert.equal(await relationCount(), 0, "SECURITY_EVENT_RELIABILITY_SCHEMA_ALREADY_PRESENT");
  assert.equal(await reliabilityColumnCount(), 0, "SECURITY_EVENT_RELIABILITY_COLUMNS_ALREADY_PRESENT");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('security-event-reliability:20261002190000:local-probe',0))",
  );
  await client.query(migrationBody);

  const structure = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])) AS table_count,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) AND c.relrowsecurity) AS rls_count,
      (SELECT count(*)::integer FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[])) AS policy_count,
      has_table_privilege('anon','public.security_event_outbox','SELECT') AS anon_select,
      has_table_privilege('authenticated','public.security_event_outbox','SELECT') AS authenticated_select,
      has_table_privilege('service_role','public.security_event_outbox','SELECT') AS service_select,
      has_table_privilege('service_role','public.security_event_outbox','INSERT') AS service_insert,
      has_function_privilege('anon','public.enqueue_security_event_atomic(text,text,timestamptz,text,text,text,text,text,text,text,text,boolean,text,timestamptz)','EXECUTE') AS anon_enqueue,
      has_function_privilege('service_role','public.enqueue_security_event_atomic(text,text,timestamptz,text,text,text,text,text,text,text,text,boolean,text,timestamptz)','EXECUTE') AS service_enqueue,
      has_function_privilege('authenticated','public.consume_security_rate_limit_atomic(text,text,integer,integer,integer)','EXECUTE') AS authenticated_rate,
      has_function_privilege('service_role','public.consume_security_rate_limit_atomic(text,text,integer,integer,integer)','EXECUTE') AS service_rate
  `, [tables])).rows[0];
  assert.deepEqual(structure, {
    table_count: 6,
    rls_count: 6,
    policy_count: 0,
    anon_select: false,
    authenticated_select: false,
    service_select: true,
    service_insert: false,
    anon_enqueue: false,
    service_enqueue: true,
    authenticated_rate: false,
    service_rate: true,
  });
  assert.equal(await reliabilityColumnCount(), 7, "SECURITY_EVENT_RELIABILITY_COLUMNS_REQUIRED");
  assert.deepEqual(
    (await client.query(
      "SELECT risk_level,retention_days,policy_version FROM public.security_event_retention_policies ORDER BY risk_level",
    )).rows,
    [
      { risk_level: "critical", retention_days: 365, policy_version: 1 },
      { risk_level: "high", retention_days: 180, policy_version: 1 },
      { risk_level: "low", retention_days: 30, policy_version: 1 },
      { risk_level: "medium", retention_days: 90, policy_version: 1 },
    ],
  );

  await client.query("SAVEPOINT functional_fixture_scope");
  const firstKey = hash64("first-key");
  const firstFingerprint = hash64("first-fingerprint");
  const first = await enqueue({ key: firstKey, fingerprint: firstFingerprint });
  assert.equal(first.success, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.durable, true);

  const repeatedKey = await enqueue({ key: firstKey, fingerprint: firstFingerprint });
  assert.equal(repeatedKey.success, true);
  assert.equal(repeatedKey.duplicate, true);
  assert.equal(repeatedKey.outboxId, first.outboxId);
  assert.equal(repeatedKey.observationCount, 2);

  const repeatedFingerprint = await enqueue({ key: hash64("semantic-key"), fingerprint: firstFingerprint });
  assert.equal(repeatedFingerprint.success, true);
  assert.equal(repeatedFingerprint.duplicate, true);
  assert.equal(repeatedFingerprint.outboxId, first.outboxId);
  assert.equal(repeatedFingerprint.observationCount, 3);

  const conflict = await enqueue({ key: firstKey, fingerprint: hash64("conflicting-fingerprint") });
  assert.equal(conflict.success, false);
  assert.equal(conflict.code, "SECURITY_EVENT_IDEMPOTENCY_CONFLICT");

  const unsafe = await enqueue({
    key: hash64("unsafe-key"),
    fingerprint: hash64("unsafe-fingerprint"),
    details: "password=must-never-persist",
  });
  assert.equal(unsafe.success, false);
  assert.equal(unsafe.code, "SECURITY_EVENT_INPUT_INVALID");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const row = await claim(`failure-worker-${attempt}`);
    assert.ok(row, `FAILURE_CLAIM_${attempt}_REQUIRED`);
    assert.equal(row.id, first.outboxId);
    assert.equal(Number(row.attempt_count), attempt);
    const settled = (await client.query(
      "SELECT public.settle_security_event_outbox_attempt($1,$2,false,'INJECTED_FAILURE','Injected masked failure',0) AS receipt",
      [row.id, row.lease_token],
    )).rows[0].receipt;
    assert.equal(settled.success, true);
    assert.equal(settled.status, attempt < 5 ? "retry" : "dead_letter");
  }
  assert.equal(await claim("after-dead-letter"), null, "DEAD_LETTER_MUST_NOT_BE_RECLAIMED");

  const failedState = (await client.query(`
    SELECT
      (SELECT status FROM public.security_event_outbox WHERE id=$1) AS status,
      (SELECT attempt_count FROM public.security_event_outbox WHERE id=$1) AS attempt_count,
      (SELECT count(*)::integer FROM public.security_event_delivery_attempts WHERE outbox_id=$1) AS attempts,
      (SELECT count(*)::integer FROM public.security_event_delivery_attempts WHERE outbox_id=$1 AND outcome='retry') AS retries,
      (SELECT count(*)::integer FROM public.security_event_dead_letters WHERE outbox_id=$1) AS dead_letters,
      (SELECT count(*)::integer FROM public.security_events WHERE reliable_ingest_id=$1) AS materialized
  `, [first.outboxId])).rows[0];
  assert.deepEqual(failedState, {
    status: "dead_letter",
    attempt_count: 5,
    attempts: 5,
    retries: 4,
    dead_letters: 1,
    materialized: 0,
  });

  const immutableAttemptFailure = await expectDatabaseFailure(
    "immutable_attempt",
    "UPDATE public.security_event_delivery_attempts SET error_summary='tampered' WHERE outbox_id=$1",
    [first.outboxId],
    (error) => error?.code === "55000" && /SECURITY_RELIABILITY_EVIDENCE_IMMUTABLE/u.test(String(error?.message || "")),
  );
  const immutableDeadLetterFailure = await expectDatabaseFailure(
    "immutable_dead_letter",
    "UPDATE public.security_event_dead_letters SET reason_summary='tampered' WHERE outbox_id=$1",
    [first.outboxId],
    (error) => error?.code === "55000" && /SECURITY_RELIABILITY_EVIDENCE_IMMUTABLE/u.test(String(error?.message || "")),
  );
  const directWriteFailure = await expectDatabaseFailure(
    "direct_outbox_write",
    "UPDATE public.security_event_outbox SET observation_count=99 WHERE id=$1",
    [first.outboxId],
    (error) => error?.code === "42501" && /SECURITY_RELIABILITY_DIRECT_WRITE_FORBIDDEN/u.test(String(error?.message || "")),
  );

  const materialKey = hash64("material-key");
  const materialFingerprint = hash64("material-fingerprint");
  const materialEnqueue = await enqueue({
    key: materialKey,
    fingerprint: materialFingerprint,
    risk: "critical",
    pathValue: "/api/reliable/:id",
    details: "Masked critical probe",
  });
  assert.equal(materialEnqueue.success, true);
  const materialClaim = await claim("material-worker");
  assert.ok(materialClaim, "MATERIALIZATION_CLAIM_REQUIRED");
  assert.equal(materialClaim.id, materialEnqueue.outboxId);
  const materialized = (await client.query(
    "SELECT public.settle_security_event_outbox_attempt($1,$2,true,NULL,NULL,30) AS receipt",
    [materialClaim.id, materialClaim.lease_token],
  )).rows[0].receipt;
  assert.equal(materialized.success, true);
  assert.equal(materialized.status, "materialized");

  const materialRepeat = await enqueue({ key: materialKey, fingerprint: materialFingerprint, risk: "critical" });
  assert.equal(materialRepeat.success, true);
  assert.equal(materialRepeat.duplicate, true);
  assert.equal(materialRepeat.observationCount, 2);

  const materializedRow = (await client.query(`
    SELECT event_type,risk_level,ip_address,ip_hash,user_id,username,display_name,phone,user_agent,
           path,method,details,raw_data,occurrence_count,privacy_version,
           (retention_until>first_observed_at) AS retention_valid
      FROM public.security_events WHERE reliable_ingest_id=$1
  `, [materialEnqueue.outboxId])).rows[0];
  assert.deepEqual(materializedRow, {
    event_type: "api_abuse",
    risk_level: "critical",
    ip_address: null,
    ip_hash: ipHash,
    user_id: null,
    username: null,
    display_name: null,
    phone: null,
    user_agent: `hash:${uaHash}`,
    path: "/api/reliable/:id",
    method: "POST",
    details: "Masked critical probe",
    raw_data: null,
    occurrence_count: 2,
    privacy_version: "masked-v1",
    retention_valid: true,
  });

  for (const index of [2, 3]) {
    const risk = await enqueue({
      key: hash64(`critical-key-${index}`),
      fingerprint: hash64(`critical-fingerprint-${index}`),
      risk: "critical",
      details: `Masked critical probe ${index}`,
    });
    assert.equal(risk.success, true);
  }
  const ipRisk = (await client.query(
    "SELECT critical_count,high_count,(banned_until>clock_timestamp()) AS banned,reason_code FROM public.security_ip_risk_state WHERE ip_hash=$1",
    [ipHash],
  )).rows[0];
  assert.deepEqual(ipRisk, {
    critical_count: 3,
    high_count: 0,
    banned: true,
    reason_code: "CRITICAL_THRESHOLD",
  });

  const rateScope = hash64("shared-rate-scope");
  const rateResults = [];
  for (let call = 1; call <= 3; call += 1) {
    rateResults.push((await client.query(
      "SELECT public.consume_security_rate_limit_atomic($1,'internal-security-event',60,2,1) AS receipt",
      [rateScope],
    )).rows[0].receipt);
  }
  assert.deepEqual(rateResults.map((receipt) => ({ allowed: receipt.allowed, count: receipt.count })), [
    { allowed: true, count: 1 },
    { allowed: true, count: 2 },
    { allowed: false, count: 3 },
  ]);

  const status = (await client.query("SELECT public.get_security_event_reliability_status() AS status")).rows[0].status;
  assert.deepEqual({
    success: status.success,
    scope: status.scope,
    producerDeliveryDurable: status.producerDeliveryDurable,
    preReceiverLossObservable: status.preReceiverLossObservable,
    receiverInlineDrainEnabled: status.receiverInlineDrainEnabled,
    retryWorkerScheduled: status.retryWorkerScheduled,
    retentionPolicyConfigured: status.retentionPolicyConfigured,
    retentionPurgeExecutorAvailable: status.retentionPurgeExecutorAvailable,
    acceptedUnique: Number(status.acceptedUnique),
    acceptedObservations: Number(status.acceptedObservations),
    materializedUnique: Number(status.materializedUnique),
    materializedObservations: Number(status.materializedObservations),
    pendingUnique: Number(status.pendingUnique),
    deadLetterUnique: Number(status.deadLetterUnique),
    knownLostObservations: Number(status.knownLostObservations),
    retryAttempts: Number(status.retryAttempts),
    sharedRateScopes: Number(status.sharedRateScopes),
    sharedIpRiskStates: Number(status.sharedIpRiskStates),
    activeIpBans: Number(status.activeIpBans),
  }, {
    success: true,
    scope: "receiver_after_authentication",
    producerDeliveryDurable: false,
    preReceiverLossObservable: false,
    receiverInlineDrainEnabled: true,
    retryWorkerScheduled: false,
    retentionPolicyConfigured: true,
    retentionPurgeExecutorAvailable: false,
    acceptedUnique: 4,
    acceptedObservations: 7,
    materializedUnique: 1,
    materializedObservations: 2,
    pendingUnique: 2,
    deadLetterUnique: 1,
    knownLostObservations: 3,
    retryAttempts: 4,
    sharedRateScopes: 1,
    sharedIpRiskStates: 1,
    activeIpBans: 1,
  });

  const rollbackGuardFailure = await expectDatabaseFailure(
    "rollback_guard",
    rollbackBody,
    [],
    (error) => error?.code === "55000" && /SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_OUTBOX/u.test(String(error?.message || "")),
  );

  await client.query("ROLLBACK TO SAVEPOINT functional_fixture_scope");
  await client.query("RELEASE SAVEPOINT functional_fixture_scope");
  const empty = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM public.security_event_outbox) AS outbox,
      (SELECT count(*)::integer FROM public.security_event_delivery_attempts) AS attempts,
      (SELECT count(*)::integer FROM public.security_event_dead_letters) AS dead_letters,
      (SELECT count(*)::integer FROM public.security_rate_limit_windows) AS rate_windows,
      (SELECT count(*)::integer FROM public.security_ip_risk_state) AS ip_risk,
      (SELECT count(*)::integer FROM public.security_events WHERE reliable_ingest_id IS NOT NULL) AS materialized
  `)).rows[0];
  assert.deepEqual(empty, {
    outbox: 0,
    attempts: 0,
    dead_letters: 0,
    rate_windows: 0,
    ip_risk: 0,
    materialized: 0,
  });

  await client.query(rollbackBody);
  assert.equal(await relationCount(), 0, "ROLLBACK_MUST_REMOVE_RELIABILITY_SCHEMA");
  assert.equal(await reliabilityColumnCount(), 0, "ROLLBACK_MUST_REMOVE_SECURITY_EVENT_COLUMNS");
  assert.equal(
    (await client.query(
      "SELECT to_regprocedure('public.enqueue_security_event_atomic(text,text,timestamptz,text,text,text,text,text,text,text,text,boolean,text,timestamptz)') AS function_name",
    )).rows[0].function_name,
    null,
    "ROLLBACK_MUST_REMOVE_ENQUEUE_FUNCTION",
  );

  await client.query("ROLLBACK");
  transactionOpen = false;
  assert.equal(await relationCount(), 0, "OUTER_ROLLBACK_MUST_LEAVE_NO_SCHEMA");
  assert.equal(await reliabilityColumnCount(), 0, "OUTER_ROLLBACK_MUST_LEAVE_NO_COLUMNS");
  assert.equal(
    Number((await client.query(
      "SELECT count(*)::integer AS count FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [VERSION],
    )).rows[0].count),
    0,
    "MIGRATION_LEDGER_MUST_REMAIN_UNCHANGED",
  );

  console.log(JSON.stringify({
    passed: true,
    mode: "strict-local-outer-transaction",
    target: "127.0.0.1:54322/zimeiti_local",
    migration: { file: MIGRATION_FILE, sha256: migrationHash },
    rollback: { file: ROLLBACK_FILE, sha256: rollbackHash },
    checks: {
      tables: 6,
      rlsEnabled: true,
      clientPrivilegesRevoked: true,
      idempotencyKeyDedupe: true,
      fingerprintBucketDedupe: true,
      idempotencyConflictRejected: true,
      sensitiveInputRejectedByDatabase: true,
      failureAttemptsInjected: 5,
      retriesObserved: 4,
      deadLettersObserved: 1,
      immutableAttempts: immutableAttemptFailure.code,
      immutableDeadLetters: immutableDeadLetterFailure.code,
      directWritesBlocked: directWriteFailure.code,
      maskedMaterialization: true,
      sharedRateCalls: 3,
      sharedIpRiskThreshold: 3,
      rollbackGuard: rollbackGuardFailure.code,
    },
    persisted: false,
    persistentFixtures: 0,
    productionWrites: 0,
    paidCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
