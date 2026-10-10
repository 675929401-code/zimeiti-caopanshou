#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const VERSION = "20261010134000";
const NAME = "video_provider_request_projection";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.rollback.sql`;
const TARGET = "127.0.0.1:54322/zimeiti_local";
const APPLY = process.argv.includes("--apply");
const PROBE_ROLLBACK = process.argv.includes("--probe-rollback");
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const SIGNATURES = [
  "public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb)",
  "public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)",
];

assert.equal(APPLY && PROBE_ROLLBACK, false, "CHOOSE_APPLY_OR_PROBE_ROLLBACK");
if (APPLY || PROBE_ROLLBACK) {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(process.argv.includes("--confirm-local-video-provider-projection-only"), "LOCAL_VIDEO_PROVIDER_PROJECTION_CONFIRMATION_REQUIRED");
}

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function transactionBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^begin\s*;/iu, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /commit\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^begin\s*;/iu, "").replace(/commit\s*;\s*$/iu, "").trim();
}

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = digest(migrationSource);
const migrationBody = transactionBody(migrationSource);
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");
const rollbackHash = digest(rollbackSource);
const rollbackBody = transactionBody(rollbackSource);
for (const token of [
  "wireBodySha256", "effectivePromptSha256", "dispatchReceiptSha256", "dispatchWireBodySha256s",
  "endpointPath", "attemptOrdinal", "dispatchIdentitySha256", "dispatchAttemptCount",
  "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT", "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT",
  "security definer", "set search_path = public, pg_temp", "service_role", "for update", ...SIGNATURES,
]) assert.ok(migrationSource.toLowerCase().includes(token.toLowerCase()), `MIGRATION_TOKEN_REQUIRED:${token}`);
for (const token of [
  "attemptOrdinal", "dispatchIdentitySha256", "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT",
  "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT", "raise exception ''VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT''",
  "dispatchIdentitySha256s", "dispatchAttemptCount", "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH",
  "pg_roles", "has_function_privilege", "rolsuper", "VIDEO_PROVIDER_PROJECTION_ACL_REPAIR_REQUIRED",
]) assert.ok(rollbackSource.includes(token), `ROLLBACK_SEMANTIC_GUARD_TOKEN_REQUIRED:${token}`);

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(typeof runtime.postgresPassword, "string", "LOCAL_POSTGRES_PASSWORD_REQUIRED");
assert.ok(runtime.postgresPassword.length >= 16, "LOCAL_POSTGRES_PASSWORD_INVALID");

const client = new Client({
  ...runtime.ownerConnection,
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-video-provider-request-projection",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

async function liveProjection() {
  const tableOwner = String((await client.query(
    "select pg_get_userbyid(relowner) as owner from pg_class where oid='public.video_tasks'::regclass",
  )).rows[0]?.owner || "");
  const columns = (await client.query(
    `select column_name,data_type from information_schema.columns
      where table_schema='public' and table_name='video_tasks'
        and column_name in ('provider_dispatch_receipt','provider_submission_receipt') order by column_name`,
  )).rows.map(row => ({ name: String(row.column_name), type: String(row.data_type) }));
  const constraints = (await client.query(
    `select conname,convalidated,pg_get_constraintdef(oid,true) as definition
       from pg_constraint where conrelid='public.video_tasks'::regclass
        and conname in ('video_tasks_provider_dispatch_receipt_check','video_tasks_provider_submission_receipt_check')
       order by conname`,
  )).rows.map(row => ({ name: String(row.conname), validated: row.convalidated === true, definition: String(row.definition || "") }));
  const functions = [];
  for (const signature of SIGNATURES) {
    const row = (await client.query(
      `select pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,p.proconfig,
              pg_get_functiondef(p.oid) as definition,
              to_jsonb(array(select coalesce(pg_get_userbyid(acl.grantee),'PUBLIC')
                from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                where acl.privilege_type='EXECUTE' order by 1)) as execute_grantees,
              has_function_privilege('anon',p.oid,'execute') as anon_execute,
              has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
              has_function_privilege('service_role',p.oid,'execute') as service_execute
         from pg_proc p where p.oid=to_regprocedure($1)`,
      [signature],
    )).rows[0];
    const unauthorized = row ? (await client.query(
      `select rolname from pg_roles
        where not rolsuper and rolname not in ($2,'service_role')
          and has_function_privilege(oid,to_regprocedure($1),'execute') order by rolname`,
      [signature, tableOwner],
    )).rows.map(item => String(item.rolname)) : [];
    const definition = String(row?.definition || "");
    const dispatch = signature.includes("dispatch");
    const semanticTokens = dispatch
      ? ["schemaVersion", "wireBodySha256", "endpointPath", "attemptOrdinal", "dispatchIdentitySha256", "requestProjection", "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT", "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT", "VIDEO_PROVIDER_DISPATCH_RECEIPT_V2_INVALID"]
      : ["dispatchReceiptSha256", "dispatchWireBodySha256s", "dispatchIdentitySha256s", "dispatchAttemptCount", "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_DISPATCH"];
    functions.push({
      signature,
      exists: Boolean(row),
      definitionSha256: definition ? digest(definition) : null,
      semanticsReady: semanticTokens.every(token => definition.includes(token)),
      owner: String(row?.owner || ""),
      securityDefiner: row?.security_definer === true,
      searchPath: Array.isArray(row?.proconfig) ? row.proconfig.map(String) : [],
      executeGrantees: Array.isArray(row?.execute_grantees) ? row.execute_grantees.map(String) : [],
      privileges: {
        anonExecute: row?.anon_execute === true,
        authenticatedExecute: row?.authenticated_execute === true,
        serviceExecute: row?.service_execute === true,
        unauthorizedRoles: unauthorized,
      },
    });
  }
  return { tableOwner, columns, constraints, functions };
}

function isReady(live) {
  const columnsReady = JSON.stringify(live.columns) === JSON.stringify([
    { name: "provider_dispatch_receipt", type: "jsonb" },
    { name: "provider_submission_receipt", type: "jsonb" },
  ]);
  const constraintsReady = live.constraints.length === 2 && live.constraints.every(item => item.validated
    && item.definition.includes("schemaVersion") && item.definition.includes("32768"));
  return Boolean(live.tableOwner) && columnsReady && constraintsReady
    && live.functions.length === SIGNATURES.length && live.functions.every(item =>
    item.exists && item.semanticsReady && item.owner === live.tableOwner && item.securityDefiner
    && item.searchPath.length === 1 && item.searchPath[0] === "search_path=public, pg_temp"
    && item.privileges.anonExecute === false && item.privileges.authenticatedExecute === false
    && item.privileges.serviceExecute === true && item.privileges.unauthorizedRoles.length === 0
    && JSON.stringify([...item.executeGrantees].sort()) === JSON.stringify([live.tableOwner, "service_role"].sort()),
  );
}

async function verifyIdentity() {
  const identity = (await client.query(
    "select current_user,current_database() as database_name,inet_server_addr()::text as server_address,inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.current_user, "postgres", "LOCAL_MIGRATION_ROLE_REQUIRED");
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1", "LIVE_DATABASE_HOST_MISMATCH");
}

await client.connect();
let transactionOpen = false;
try {
  await verifyIdentity();
  const prior = await client.query(
    "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1",
    [VERSION],
  );
  const before = await liveProjection();
  if (!APPLY && !PROBE_ROLLBACK) {
    const ledgerHashMatches = prior.rowCount === 1 && String(prior.rows[0]?.hash || "").toLowerCase() === migrationHash;
    const report = {
      passed: true, mode: "read-only-check", checkedAt: new Date().toISOString(), target: TARGET,
      migration: MIGRATION_FILE, migrationHash, rollback: ROLLBACK_FILE, rollbackHash,
      ledgerPresent: prior.rowCount === 1, ledgerHashMatches,
      live: before, ready: ledgerHashMatches && isReady(before), writes: 0, providerCalls: 0,
      billingOperations: 0, credentialsPrinted: false,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 2;
  } else {
    await client.query("begin");
    transactionOpen = true;
    await client.query("select pg_advisory_xact_lock(hashtextextended('video-provider-request-projection:20261010134000',0))");
    if (PROBE_ROLLBACK) {
      await client.query(migrationBody);
      const live = await liveProjection();
      assert.equal(isReady(live), true, "PROBE_LIVE_VIDEO_PROVIDER_PROJECTION_INVALID");
      await client.query(rollbackBody);
      await client.query("savepoint legacy_rollback_guard_probe");
      await client.query(`
        create or replace function public.record_video_provider_dispatch_receipt_atomic(
          p_task_id text,p_user_id text,p_request_fingerprint text,p_receipt jsonb
        ) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $legacy$
        begin
          perform 'wireBodySha256';
          return jsonb_build_object('dispatch_recorded', true);
        end
        $legacy$
      `);
      await assert.rejects(
        () => client.query(rollbackBody),
        /VIDEO_PROVIDER_PROJECTION_SEMANTIC_REPAIR_REQUIRED/u,
      );
      await client.query("rollback to savepoint legacy_rollback_guard_probe");
      await client.query("release savepoint legacy_rollback_guard_probe");
      const directProbeRole = "video_provider_acl_probe_grantee_1340";
      const inheritedProbeRole = "video_provider_acl_probe_member_1340";
      const existingProbeRoles = Number((await client.query(
        "select count(*)::int as count from pg_roles where rolname = any($1::text[])",
        [[directProbeRole, inheritedProbeRole]],
      )).rows[0]?.count || 0);
      assert.equal(existingProbeRoles, 0, "ACL_PROBE_ROLE_ALREADY_EXISTS");
      await client.query("savepoint inherited_acl_guard_probe");
      await client.query(`create role ${directProbeRole} nologin inherit`);
      await client.query(`create role ${inheritedProbeRole} nologin inherit`);
      await client.query(`grant ${directProbeRole} to ${inheritedProbeRole}`);
      await client.query(`grant execute on function ${SIGNATURES[0]} to ${directProbeRole}`);
      await assert.rejects(
        () => client.query(rollbackBody),
        error => {
          const message = String(error?.message || error);
          return message.includes("VIDEO_PROVIDER_PROJECTION_ACL_REPAIR_REQUIRED")
            && message.includes(directProbeRole)
            && message.includes(inheritedProbeRole);
        },
      );
      await client.query("rollback to savepoint inherited_acl_guard_probe");
      await client.query("release savepoint inherited_acl_guard_probe");
      await client.query("savepoint invalid_projection_probe");
      await assert.rejects(
        () => client.query(
          "select public.record_video_provider_dispatch_receipt_atomic($1,$2,$3,$4::jsonb)",
          ["missing-task", "missing-user", "a".repeat(64), { schemaVersion: 2, rawPrompt: "must reject before task lookup" }],
        ),
        /VIDEO_PROVIDER_DISPATCH_RECEIPT_V2_INVALID/u,
      );
      await client.query("rollback to savepoint invalid_projection_probe");
      await client.query("release savepoint invalid_projection_probe");
      const fixture = (await client.query(
        `select id::text as id,user_id::text as user_id,request_fingerprint,routing_snapshot_hash
           from public.video_tasks
          where request_fingerprint ~ '^[0-9a-f]{64}$'
            and routing_snapshot is not null
            and routing_snapshot_hash ~ '^[0-9a-f]{64}$'
          order by created_at desc limit 1 for update`,
      )).rows[0];
      assert.ok(fixture, "DUPLICATE_DISPATCH_PROBE_FIXTURE_REQUIRED");
      await client.query("savepoint duplicate_dispatch_probe");
      await client.query(
        `update public.video_tasks
            set status='pending',completed_at=null,provider_dispatch_started_at=null,
                provider_dispatch_receipt=null,provider_submission_receipt=null,
                provider_acknowledged_at=null,provider_reconciliation_state=null
          where id::text=$1`,
        [fixture.id],
      );
      const dispatchReceipt = {
        schemaVersion: 2,
        endpointHost: "provider.invalid",
        endpointPath: "/v1/videos",
        attemptOrdinal: 1,
        dispatchIdentitySha256: "b".repeat(64),
        submittedModel: "probe-model",
        submittedWorkflow: null,
        routingConfigVersion: fixture.routing_snapshot_hash,
        requestContentType: "application/json",
        wireBodySha256: "c".repeat(64),
        wireBodyBytes: 64,
        requestProjection: {
          effectivePromptSha256: "d".repeat(64), duration: 1, resolution: "480p", aspectRatio: "16:9",
          referenceImageCount: 0, referenceAudioCount: 0, generateAudioState: "provided_false",
        },
      };
      await client.query(
        "select public.record_video_provider_dispatch_receipt_atomic($1,$2,$3,$4::jsonb)",
        [fixture.id, fixture.user_id, fixture.request_fingerprint, dispatchReceipt],
      );
      await assert.rejects(
        () => client.query(
          "select public.record_video_provider_dispatch_receipt_atomic($1,$2,$3,$4::jsonb)",
          [fixture.id, fixture.user_id, fixture.request_fingerprint, {
            ...dispatchReceipt, attemptOrdinal: 2, dispatchIdentitySha256: "e".repeat(64),
          }],
        ),
        /VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT/u,
      );
      await client.query("rollback to savepoint duplicate_dispatch_probe");
      await client.query("release savepoint duplicate_dispatch_probe");
      await client.query("rollback");
      transactionOpen = false;
      console.log(JSON.stringify({
        passed: true, mode: "transaction-rollback-probe", checkedAt: new Date().toISOString(), target: TARGET,
        migration: MIGRATION_FILE, migrationHash, rollback: ROLLBACK_FILE, rollbackHash, live,
        rollbackAcceptsCurrentSemantics: true, rollbackRejectsLegacySilentDedupeSemantics: true,
        rollbackRejectsDirectAndInheritedExtraExecuteRoles: true,
        invalidRawReceiptRejected: true,
        duplicateWireBodyRpcRejected: true, duplicateSecondProviderCalls: 0,
        durableWrites: 0, ledgerWrites: 0, providerCalls: 0, billingOperations: 0, credentialsPrinted: false,
      }, null, 2));
    } else {
      const lockedPrior = await client.query(
        "select version,name,hash from supabase_migrations.schema_migrations where version::text=$1 for update",
        [VERSION],
      );
      let action = "already_applied";
      if (lockedPrior.rowCount) {
        assert.equal(String(lockedPrior.rows[0].hash || "").toLowerCase(), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
        if (!isReady(await liveProjection())) { await client.query(migrationBody); action = "reapplied_after_verified_drift"; }
      } else {
        await client.query(migrationBody);
        await client.query(
          `insert into supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
           values($1,$2,$3,$4,$5,now())`,
          [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-video-provider-request-projection"],
        );
        action = "applied";
      }
      const after = await liveProjection();
      assert.equal(isReady(after), true, "LIVE_VIDEO_PROVIDER_PROJECTION_INVALID");
      await client.query("commit");
      transactionOpen = false;
      console.log(JSON.stringify({
        passed: true, mode: "local-transactional-apply", checkedAt: new Date().toISOString(), target: TARGET,
        action, migration: MIGRATION_FILE, migrationHash, rollback: ROLLBACK_FILE, rollbackHash,
        before, after, dataRowsChanged: 0,
        providerCalls: 0, billingOperations: 0, productionWrites: 0, credentialsPrinted: false,
      }, null, 2));
    }
  }
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
