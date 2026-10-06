#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002160000";
const MIGRATION_FILE = `${VERSION}_security_case_control_plane.sql`;
const ROLLBACK_FILE = `${VERSION}_security_case_control_plane.rollback.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_LOCAL_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-security-case-control-plane"),
  "LOCAL_SECURITY_CASE_CONFIRMATION_REQUIRED",
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
const fingerprint = crypto.createHash("sha256").update(`security-case-local-probe:${suffix}`).digest("hex");
const differentFingerprint = crypto.createHash("sha256").update(`security-case-source-duplicate:${suffix}`).digest("hex");
const actorA = `local-security-actor-a-${suffix}`;
const actorB = `local-security-actor-b-${suffix}`;

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-security-case-control-plane",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

const tables = [
  "security_cases",
  "security_case_events",
  "security_case_links",
  "security_case_actions",
  "security_case_audit",
];

async function relationCount() {
  return Number((await client.query(
    `SELECT count(*)::integer AS count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`,
    [tables],
  )).rows[0]?.count || 0);
}

async function assertSourceSchema() {
  const required = {
    security_events: ["id", "event_type", "risk_level", "ip_hash", "user_id", "path", "method", "blocked", "source", "created_at"],
    prompt_guard_logs: ["id", "user_id", "agent_name", "agent_source", "risk_level", "reason", "blocked_at"],
    login_logs: ["id", "user_id", "status", "fail_reason", "login_method", "created_at"],
    operation_flight_events: ["id", "trace_id", "user_id", "source", "domain", "operation", "phase", "outcome", "route", "error_code", "error_fingerprint", "occurred_at"],
    user_auth_sessions: ["session_id", "user_id", "revoked_at", "expires_at"],
    users: ["id", "role", "status", "is_active"],
  };
  const rows = (await client.query(
    `SELECT table_name,column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [Object.keys(required)],
  )).rows;
  const actual = new Map();
  for (const row of rows) {
    const columns = actual.get(row.table_name) || new Set();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }
  for (const [table, columns] of Object.entries(required)) {
    assert.ok(actual.has(table), `SOURCE_TABLE_REQUIRED:${table}`);
    for (const column of columns) assert.ok(actual.get(table).has(column), `SOURCE_COLUMN_REQUIRED:${table}.${column}`);
  }
  return Object.keys(required).length;
}

async function expectDatabaseFailure(label, sql, params, predicate) {
  const savepoint = `expected_${label}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let matched = false;
  try {
    await client.query(sql, params);
  } catch (error) {
    matched = predicate(error);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert.equal(matched, true, `${label.toUpperCase()}_REJECTION_REQUIRED`);
}

async function loadActionTarget() {
  const session = (await client.query(`
    SELECT session_id::text AS target_ref,
           row_to_json(s)::text AS before_snapshot
      FROM public.user_auth_sessions s
     WHERE revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1
  `)).rows[0];
  if (session) {
    return {
      actionType: "revoke_session",
      targetType: "session",
      targetRef: session.target_ref,
      beforeSnapshot: session.before_snapshot,
      affectedRowsMax: 1,
    };
  }

  const user = (await client.query(`
    SELECT id::text AS target_ref,
           row_to_json(u)::text AS before_snapshot,
           1 + (SELECT count(*)::integer FROM public.user_auth_sessions s
                 WHERE s.user_id=u.id AND s.revoked_at IS NULL) AS affected_rows_max
      FROM public.users u
     WHERE coalesce(is_active, true) AND coalesce(status, 'active')='active' AND role <> 'admin'
     ORDER BY created_at DESC
     LIMIT 1
  `)).rows[0];
  assert.ok(user, "ACTIONABLE_LOCAL_SESSION_OR_USER_REQUIRED");
  return {
    actionType: "disable_user",
    targetType: "user",
    targetRef: user.target_ref,
    beforeSnapshot: user.before_snapshot,
    affectedRowsMax: Number(user.affected_rows_max),
  };
}

async function loadTargetSnapshot(target) {
  if (target.targetType === "session") {
    return (await client.query(
      "SELECT row_to_json(s)::text AS snapshot FROM public.user_auth_sessions s WHERE session_id::text=$1",
      [target.targetRef],
    )).rows[0]?.snapshot || null;
  }
  return (await client.query(
    "SELECT row_to_json(u)::text AS snapshot FROM public.users u WHERE id::text=$1",
    [target.targetRef],
  )).rows[0]?.snapshot || null;
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
  const sourceSchemaTables = await assertSourceSchema();

  const ledgerBefore = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledgerBefore.rowCount, 0, "SECURITY_CASE_MIGRATION_ALREADY_APPLIED");
  assert.equal(await relationCount(), 0, "SECURITY_CASE_SCHEMA_ALREADY_PRESENT");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('security-case-control-plane:20261002160000:local-probe',0))");
  await client.query(migrationBody);

  const structure = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])) AS table_count,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) AND c.relrowsecurity) AS rls_count,
      (SELECT count(*)::integer FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[])) AS policy_count,
      has_table_privilege('anon','public.security_cases','SELECT') AS anon_select,
      has_table_privilege('authenticated','public.security_cases','SELECT') AS authenticated_select,
      has_table_privilege('service_role','public.security_cases','SELECT') AS service_select,
      has_table_privilege('service_role','public.security_cases','INSERT') AS service_insert,
      has_function_privilege('anon','public.claim_security_case_atomic(uuid,bigint,text,text,text)','EXECUTE') AS anon_claim,
      has_function_privilege('service_role','public.claim_security_case_atomic(uuid,bigint,text,text,text)','EXECUTE') AS service_claim
  `, [tables])).rows[0];
  assert.deepEqual(structure, {
    table_count: 5,
    rls_count: 5,
    policy_count: 0,
    anon_select: false,
    authenticated_select: false,
    service_select: true,
    service_insert: false,
    anon_claim: false,
    service_claim: true,
  });

  await client.query("SAVEPOINT functional_fixture_scope");
  const first = (await client.query(
    `SELECT public.ingest_security_case_event_atomic(
       $1,'security_event',$2,'login_failed','medium',40,$3,$4,clock_timestamp(),$5,
       '{"sourceLabel":"local transaction probe","sourceTable":"security_events","blocked":true}'::jsonb,
       '[{"type":"route","ref":"/api/auth/login","label":"login route"}]'::jsonb,$6
     ) AS receipt`,
    [fingerprint, `security-event-${suffix}`, "Repeated authentication failure", "Bounded local evidence", actorA, `ingest:first:${suffix}`],
  )).rows[0].receipt;
  assert.equal(first.success, true);
  assert.equal(first.createdCase, true);
  assert.equal(first.eventCount, 1);
  assert.equal(first.revision, 1);
  const caseId = first.caseId;

  const merged = (await client.query(
    `SELECT public.ingest_security_case_event_atomic(
       $1,'prompt_guard_log',$2,'prompt_guard_blocked','high',70,$3,$4,clock_timestamp(),$5,
       '{"sourceLabel":"local transaction probe","sourceTable":"prompt_guard_logs","blocked":true}'::jsonb,
       '[]'::jsonb,$6
     ) AS receipt`,
    [fingerprint, `guard-event-${suffix}`, "Repeated authentication failure", "Second source, same fingerprint", actorA, `ingest:merged:${suffix}`],
  )).rows[0].receipt;
  assert.equal(merged.success, true);
  assert.equal(merged.createdCase, false);
  assert.equal(merged.caseId, caseId);
  assert.equal(merged.eventCount, 2);
  assert.equal(merged.revision, 2);
  assert.equal(merged.riskLevel, "high");

  const sourceDuplicate = (await client.query(
    `SELECT public.ingest_security_case_event_atomic(
       $1,'prompt_guard_log',$2,'different_payload','low',10,$3,$4,clock_timestamp(),$5,
       '{"sourceLabel":"duplicate source probe","sourceTable":"prompt_guard_logs","blocked":false}'::jsonb,
       '[]'::jsonb,$6
     ) AS receipt`,
    [differentFingerprint, `guard-event-${suffix}`, "Must not create a second case", "Same source identity", actorB, `ingest:duplicate:${suffix}`],
  )).rows[0].receipt;
  assert.equal(sourceDuplicate.success, true);
  assert.equal(sourceDuplicate.duplicate, true);
  assert.equal(sourceDuplicate.caseId, caseId);
  assert.equal(sourceDuplicate.eventCount, 2);
  assert.equal(sourceDuplicate.revision, 2);

  const triaged = (await client.query(
    "SELECT public.transition_security_case_atomic($1,2,'triaged',$2,$3,$4) AS receipt",
    [caseId, actorA, "Initial evidence reviewed", `transition:triaged:${suffix}`],
  )).rows[0].receipt;
  assert.equal(triaged.success, true);
  assert.equal(triaged.revision, 3);

  const contenders = (await client.query(
    `WITH first_contender AS MATERIALIZED (
       SELECT public.claim_security_case_atomic($1,3,$2,$3,$4) AS receipt
     )
     SELECT first_contender.receipt AS first_receipt,
            public.claim_security_case_atomic(
              $1,3,$5,$6 || ':' || coalesce(first_contender.receipt->>'status','unknown'),$7
            ) AS second_receipt
       FROM first_contender`,
    [
      caseId,
      actorA,
      "Primary responder claim",
      `claim:first:${suffix}`,
      actorB,
      "Competing responder claim",
      `claim:second:${suffix}`,
    ],
  )).rows[0];
  assert.equal(contenders.first_receipt.success, true);
  assert.equal(contenders.first_receipt.status, "assigned");
  assert.equal(contenders.first_receipt.assignedTo, actorA);
  assert.equal(contenders.second_receipt.success, false);
  assert.equal(contenders.second_receipt.code, "SECURITY_CASE_REVISION_CONFLICT");
  assert.equal(contenders.second_receipt.assignedTo, actorA);

  const target = await loadActionTarget();
  const linked = (await client.query(
    "SELECT public.link_security_case_entity_atomic($1,4,$2,$3,$4,$5,$6,$7) AS receipt",
    [caseId, target.targetType, target.targetRef, "exact action target", actorA, "Bind exact target before request", `link:target:${suffix}`],
  )).rows[0].receipt;
  assert.equal(linked.success, true);
  assert.equal(linked.duplicate, false);
  assert.equal(linked.revision, 5);

  await expectDatabaseFailure(
    "direct_case_write",
    "UPDATE public.security_cases SET summary='direct mutation' WHERE id=$1",
    [caseId],
    (error) => error?.code === "42501" && /SECURITY_CASE_DIRECT_WRITE_FORBIDDEN/u.test(String(error?.message || "")),
  );

  const impact = {
    schema: "security-case-impact/v1",
    actionType: target.actionType,
    targetType: target.targetType,
    targetRef: target.targetRef,
    targetExists: true,
    currentState: "active",
    affectedRowsMax: target.affectedRowsMax,
    reversible: true,
    executionSupported: false,
    executorStatus: "unavailable",
    notes: ["request can be cancelled before an executor exists", "phase one performs no target mutation"],
  };
  const requestKey = `action:request:${suffix}`;
  const requested = (await client.query(
    "SELECT public.request_security_case_action_atomic($1,5,$2,$3,$4,$5::jsonb,$6,$7,$8) AS receipt",
    [caseId, target.actionType, target.targetType, target.targetRef, JSON.stringify(impact), actorA, "Request review without execution", requestKey],
  )).rows[0].receipt;
  assert.equal(requested.success, true);
  assert.equal(requested.duplicate, false);
  assert.equal(requested.status, "pending_executor");
  assert.equal(requested.executionSupported, false);
  assert.equal(requested.executorStatus, "unavailable");
  assert.equal(requested.caseRevision, 6);

  const repeatedRequest = (await client.query(
    "SELECT public.request_security_case_action_atomic($1,5,$2,$3,$4,$5::jsonb,$6,$7,$8) AS receipt",
    [caseId, target.actionType, target.targetType, target.targetRef, JSON.stringify(impact), actorA, "Request review without execution", requestKey],
  )).rows[0].receipt;
  assert.equal(repeatedRequest.success, true);
  assert.equal(repeatedRequest.duplicate, true);
  assert.equal(repeatedRequest.actionId, requested.actionId);
  assert.equal(await loadTargetSnapshot(target), target.beforeSnapshot, "ACTION_REQUEST_MUST_NOT_MUTATE_TARGET");

  const wrongCase = crypto.randomUUID();
  const crossCaseCancel = (await client.query(
    "SELECT public.cancel_security_case_action_atomic($1,$2,1,$3,$4,$5) AS receipt",
    [requested.actionId, wrongCase, actorA, "Cross case attempt must fail", `action:cross-case:${suffix}`],
  )).rows[0].receipt;
  assert.equal(crossCaseCancel.success, false);
  assert.equal(crossCaseCancel.code, "SECURITY_CASE_ACTION_CASE_MISMATCH");

  const cancelKey = `action:cancel:${suffix}`;
  const cancelled = (await client.query(
    "SELECT public.cancel_security_case_action_atomic($1,$2,1,$3,$4,$5) AS receipt",
    [requested.actionId, caseId, actorA, "Cancel pending request", cancelKey],
  )).rows[0].receipt;
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.actionRevision, 2);
  assert.equal(cancelled.caseRevision, 7);

  const repeatedCancel = (await client.query(
    "SELECT public.cancel_security_case_action_atomic($1,$2,1,$3,$4,$5) AS receipt",
    [requested.actionId, caseId, actorA, "Cancel pending request", cancelKey],
  )).rows[0].receipt;
  assert.equal(repeatedCancel.success, true);
  assert.equal(repeatedCancel.duplicate, true);
  assert.equal(repeatedCancel.actionRevision, 2);
  assert.equal(await loadTargetSnapshot(target), target.beforeSnapshot, "ACTION_CANCEL_MUST_NOT_MUTATE_TARGET");

  await expectDatabaseFailure(
    "immutable_audit",
    "UPDATE public.security_case_audit SET reason='tampered' WHERE case_id=$1",
    [caseId],
    (error) => error?.code === "55000" && /SECURITY_CASE_AUDIT_IMMUTABLE/u.test(String(error?.message || "")),
  );
  await expectDatabaseFailure(
    "immutable_evidence",
    "UPDATE public.security_case_events SET summary='tampered' WHERE case_id=$1",
    [caseId],
    (error) => error?.code === "55000" && /SECURITY_CASE_EVIDENCE_IMMUTABLE/u.test(String(error?.message || "")),
  );

  const counts = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM public.security_cases) AS cases,
      (SELECT count(*)::integer FROM public.security_case_events) AS events,
      (SELECT count(*)::integer FROM public.security_case_links) AS links,
      (SELECT count(*)::integer FROM public.security_case_actions) AS actions,
      (SELECT count(*)::integer FROM public.security_case_audit) AS audit,
      (SELECT event_count FROM public.security_cases WHERE id=$1) AS event_count,
      (SELECT status FROM public.security_cases WHERE id=$1) AS case_status,
      (SELECT status FROM public.security_case_actions WHERE id=$2) AS action_status
  `, [caseId, requested.actionId])).rows[0];
  assert.deepEqual(counts, {
    cases: 1,
    events: 2,
    links: 2,
    actions: 1,
    audit: 8,
    event_count: 2,
    case_status: "mitigating",
    action_status: "cancelled",
  });

  await expectDatabaseFailure(
    "rollback_guard",
    rollbackBody,
    [],
    (error) => error?.code === "55000" && /SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_CASES/u.test(String(error?.message || "")),
  );

  await client.query("ROLLBACK TO SAVEPOINT functional_fixture_scope");
  await client.query("RELEASE SAVEPOINT functional_fixture_scope");
  assert.deepEqual((await client.query(`
    SELECT
      (SELECT count(*)::integer FROM public.security_cases) AS cases,
      (SELECT count(*)::integer FROM public.security_case_events) AS events,
      (SELECT count(*)::integer FROM public.security_case_links) AS links,
      (SELECT count(*)::integer FROM public.security_case_actions) AS actions,
      (SELECT count(*)::integer FROM public.security_case_audit) AS audit
  `)).rows[0], { cases: 0, events: 0, links: 0, actions: 0, audit: 0 });

  await client.query(rollbackBody);
  assert.equal(await relationCount(), 0, "ROLLBACK_MUST_REMOVE_SECURITY_CASE_SCHEMA");
  assert.equal(
    (await client.query("SELECT to_regprocedure('public.claim_security_case_atomic(uuid,bigint,text,text,text)') AS function_name")).rows[0].function_name,
    null,
    "ROLLBACK_MUST_REMOVE_SECURITY_CASE_FUNCTIONS",
  );

  await client.query("ROLLBACK");
  transactionOpen = false;
  assert.equal(await relationCount(), 0, "OUTER_ROLLBACK_MUST_LEAVE_NO_SCHEMA");
  assert.equal((await client.query(
    "SELECT count(*)::integer AS count FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  )).rows[0].count, 0, "MIGRATION_LEDGER_MUST_REMAIN_UNCHANGED");

  console.log(JSON.stringify({
    passed: true,
    mode: "strict-local-outer-transaction",
    target: "127.0.0.1:54322/zimeiti_local",
    migration: { file: MIGRATION_FILE, sha256: migrationHash },
    rollback: { file: ROLLBACK_FILE, sha256: rollbackHash },
    checks: {
      sourceSchemaTables,
      tables: 5,
      rlsEnabled: true,
      clientPrivilegesRevoked: true,
      sourceIdentityDedupe: true,
      fingerprintCaseMerge: true,
      casContenders: 2,
      casSingleWinner: true,
      exactTargetLinkRequired: true,
      pendingExecutorRequest: true,
      requestIdempotency: true,
      crossCaseCancelRejected: true,
      cancelIdempotency: true,
      immutableEvidence: true,
      immutableAudit: true,
      rollbackEvidenceGuard: true,
      targetMutations: 0,
    },
    actionTypeTested: target.actionType,
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
