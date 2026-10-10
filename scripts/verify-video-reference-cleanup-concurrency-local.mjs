#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const CONFIRM = "--execute-disposable-db-probe";
assert.deepEqual(process.argv.slice(2), [CONFIRM], `EXPLICIT_DISPOSABLE_DB_CONFIRMATION_REQUIRED:${CONFIRM}`);
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");

const probeDatabase = `zimeiti_video_ref_probe_${randomBytes(6).toString("hex")}`;
assert.match(probeDatabase, /^zimeiti_video_ref_probe_[a-f0-9]{12}$/u);
const migration = await readFile("supabase/migrations/20261010135000_video_reference_asset_cleanup_outbox.sql", "utf8");
const rollback = await readFile("supabase/rollbacks/20261010135000_video_reference_asset_cleanup_outbox.rollback.sql", "utf8");
const baseConnection = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: runtime.postgresPassword,
  connectionTimeoutMillis: 10_000,
  query_timeout: 10_000,
};
const admin = new pg.Client({ ...baseConnection, database: "postgres", application_name: "video-reference-concurrency-admin" });
let reservationConnection;
let cleanupConnection;
let observerConnection;

const waitForBlocked = async (promiseState, label) => {
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(promiseState.settled, false, `${label}_MUST_WAIT_ON_SHARED_GUARD_LOCK`);
};

const waitForRelationLock = async (client, pid, relation, mode, granted, label) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const row = (await client.query(`select lock_state.granted
      from pg_locks lock_state
      join pg_class relation_state on relation_state.oid=lock_state.relation
      join pg_namespace namespace_state on namespace_state.oid=relation_state.relnamespace
     where lock_state.pid=$1 and namespace_state.nspname='public'
       and relation_state.relname=$2 and lock_state.mode=$3
     order by lock_state.granted desc limit 1`, [pid, relation, mode])).rows[0];
    if (row?.granted === granted) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`${label}_LOCK_STATE_NOT_OBSERVED`);
};

const snapshot = assetRef => JSON.stringify({
  schema: "video_generation_request_snapshot.v1",
  referenceAssets: [{ role: "first_frame", index: 0, ref: assetRef }],
});

async function registerFixture(client, suffix) {
  const assetRef = `object://tencent_cos/video-inputs%2F${suffix}.png`;
  const fileId = `file-${suffix}`;
  const userId = `user-${suffix}`;
  const key = `video-inputs/${suffix}.png`;
  const uploadSession = `video_ref_${suffix}_1234567890`;
  await client.query(`insert into public.user_files(
    id,user_id,storage_key,storage_provider,file_name,file_category,source,meta
  ) values($1,$2,$3,'tencent_cos',$4,'image','video-page-reference',$5::jsonb)`,
  [fileId, userId, key, `${suffix}.png`, JSON.stringify({ videoPageUploadSession: uploadSession })]);
  const result = (await client.query(`select public.register_video_reference_asset_guard_v1(
    $1,$2,$3,'tencent_cos',$4,'video-page-reference','image',$5
  ) result`, [assetRef, fileId, key, userId, uploadSession])).rows[0].result;
  assert.equal(result.state, "available");
  return { assetRef, fileId, userId, key, uploadSession };
}

async function begin(client) {
  await client.query("begin");
  await client.query("set local lock_timeout='3s'");
  await client.query("set local statement_timeout='5s'");
}

await admin.connect();
try {
  await admin.query(`create database "${probeDatabase}"`);
  const connect = application_name => new pg.Client({ ...baseConnection, database: probeDatabase, application_name });
  reservationConnection = connect("video-reference-reservation-connection");
  cleanupConnection = connect("video-reference-cleanup-connection");
  observerConnection = connect("video-reference-observer-connection");
  await Promise.all([reservationConnection.connect(), cleanupConnection.connect(), observerConnection.connect()]);

  await observerConnection.query(`
    create table public.user_files(
      id text primary key,user_id text not null,storage_key text not null,storage_provider text not null,
      file_name text not null,file_category text not null,source text,meta jsonb
    );
    create table public.video_tasks(
      id text primary key,user_id text not null,status text not null,request_snapshot jsonb
    );
  `);
  await observerConnection.query(migration);

  // Reservation-first: the request_snapshot trigger owns the guard row lock.
  // Cleanup must wait, then observe the committed active task and reject.
  const reservationFirst = await registerFixture(observerConnection, "reservation_first");
  await begin(reservationConnection);
  await reservationConnection.query(
    "insert into public.video_tasks(id,user_id,status,request_snapshot) values('task-reservation-first',$1,'pending',$2::jsonb)",
    [reservationFirst.userId, snapshot(reservationFirst.assetRef)],
  );
  await begin(cleanupConnection);
  const cleanupState = { settled: false };
  const cleanupStartedAt = Date.now();
  const cleanupAttempt = cleanupConnection.query(`select public.claim_video_reference_asset_cleanup_v1(
    $1,$2,$3,'tencent_cos',$4,'video-page-reference','image',$5
  ) result`, [reservationFirst.assetRef, reservationFirst.fileId, reservationFirst.key,
    reservationFirst.userId, reservationFirst.uploadSession])
    .then(result => ({ result }))
    .catch(error => ({ error }))
    .finally(() => { cleanupState.settled = true; });
  await waitForBlocked(cleanupState, "RESERVATION_FIRST_CLEANUP");
  await reservationConnection.query("commit");
  const cleanupOutcome = await cleanupAttempt;
  const cleanupWaitMs = Date.now() - cleanupStartedAt;
  assert.ok(cleanupOutcome.error, "RESERVATION_FIRST_CLEANUP_MUST_REJECT");
  assert.match(String(cleanupOutcome.error.message || ""), /VIDEO_REFERENCE_DELETE_ACTIVE_TASK/u);
  assert.doesNotMatch(String(cleanupOutcome.error.message || ""), /deadlock detected/iu);
  assert.ok(cleanupWaitMs >= 100 && cleanupWaitMs < 5000, "RESERVATION_FIRST_WAIT_MUST_BE_BOUNDED");
  await cleanupConnection.query("rollback");
  const reservationFirstState = (await observerConnection.query(
    "select state from public.video_reference_asset_cleanup_outbox where asset_ref=$1", [reservationFirst.assetRef],
  )).rows[0];
  assert.equal(reservationFirstState.state, "available");
  assert.equal((await observerConnection.query(
    "select count(*)::integer count from public.video_tasks where id='task-reservation-first'",
  )).rows[0].count, 1, "RESERVATION_FIRST_TASK_MUST_COMMIT_ONCE");

  // Cleanup-first: claim owns the same guard row lock. Reservation must wait,
  // then reject after claimed becomes visible; no task row may commit.
  const cleanupFirst = await registerFixture(observerConnection, "cleanup_first");
  await begin(cleanupConnection);
  const claim = (await cleanupConnection.query(`select public.claim_video_reference_asset_cleanup_v1(
    $1,$2,$3,'tencent_cos',$4,'video-page-reference','image',$5
  ) result`, [cleanupFirst.assetRef, cleanupFirst.fileId, cleanupFirst.key,
    cleanupFirst.userId, cleanupFirst.uploadSession])).rows[0].result;
  assert.equal(claim.state, "claimed");
  await begin(reservationConnection);
  const reservationState = { settled: false };
  const reservationStartedAt = Date.now();
  const reservationAttempt = reservationConnection.query(
    "insert into public.video_tasks(id,user_id,status,request_snapshot) values('task-cleanup-first',$1,'pending',$2::jsonb)",
    [cleanupFirst.userId, snapshot(cleanupFirst.assetRef)],
  ).then(result => ({ result })).catch(error => ({ error })).finally(() => { reservationState.settled = true; });
  await waitForBlocked(reservationState, "CLEANUP_FIRST_RESERVATION");
  await cleanupConnection.query("commit");
  const reservationOutcome = await reservationAttempt;
  const reservationWaitMs = Date.now() - reservationStartedAt;
  assert.ok(reservationOutcome.error, "CLEANUP_FIRST_RESERVATION_MUST_REJECT");
  assert.match(String(reservationOutcome.error.message || ""), /VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS/u);
  assert.doesNotMatch(String(reservationOutcome.error.message || ""), /deadlock detected/iu);
  assert.ok(reservationWaitMs >= 100 && reservationWaitMs < 5000, "CLEANUP_FIRST_WAIT_MUST_BE_BOUNDED");
  await reservationConnection.query("rollback");
  assert.equal((await observerConnection.query(
    "select count(*)::integer count from public.video_tasks where id='task-cleanup-first'",
  )).rows[0].count, 0, "CLEANUP_FIRST_MUST_NOT_COMMIT_TASK");
  const cleanupFirstState = (await observerConnection.query(
    "select state,claimed_at,registered_at from public.video_reference_asset_cleanup_outbox where asset_ref=$1", [cleanupFirst.assetRef],
  )).rows[0];
  assert.equal(cleanupFirstState.state, "claimed");
  assert.ok(cleanupFirstState.claimed_at);
  assert.ok(new Date(cleanupFirstState.claimed_at).getTime() >= new Date(cleanupFirstState.registered_at).getTime());

  await observerConnection.query("select public.mark_video_reference_asset_object_deleted_v1($1,$2)",
    [cleanupFirst.assetRef, cleanupFirst.userId]);
  await observerConnection.query("select public.complete_video_reference_asset_cleanup_v1($1,$2,$3,'tencent_cos',$4,'video-page-reference')",
    [cleanupFirst.assetRef, cleanupFirst.fileId, cleanupFirst.key, cleanupFirst.userId]);

  // Claim-first rollback: rollback must wait for the claim transaction, then
  // observe its committed nonterminal state and fail without dropping anything.
  const rollbackClaimFirst = await registerFixture(observerConnection, "rollback_claim_first");
  await begin(cleanupConnection);
  const claimFirst = (await cleanupConnection.query(`select public.claim_video_reference_asset_cleanup_v1(
    $1,$2,$3,'tencent_cos',$4,'video-page-reference','image',$5
  ) result`, [rollbackClaimFirst.assetRef, rollbackClaimFirst.fileId, rollbackClaimFirst.key,
    rollbackClaimFirst.userId, rollbackClaimFirst.uploadSession])).rows[0].result;
  assert.equal(claimFirst.state, "claimed");
  const rollbackPid = Number((await reservationConnection.query("select pg_backend_pid() pid")).rows[0].pid);
  const rollbackClaimFirstState = { settled: false };
  const rollbackClaimFirstStartedAt = Date.now();
  const rollbackClaimFirstAttempt = reservationConnection.query(rollback)
    .then(result => ({ result })).catch(error => ({ error }))
    .finally(() => { rollbackClaimFirstState.settled = true; });
  await waitForRelationLock(observerConnection, rollbackPid, "video_tasks", "AccessExclusiveLock", false,
    "CLAIM_FIRST_ROLLBACK");
  await waitForBlocked(rollbackClaimFirstState, "CLAIM_FIRST_ROLLBACK");
  await cleanupConnection.query("commit");
  const rollbackClaimFirstOutcome = await rollbackClaimFirstAttempt;
  const rollbackClaimFirstWaitMs = Date.now() - rollbackClaimFirstStartedAt;
  assert.ok(rollbackClaimFirstOutcome.error, "CLAIM_FIRST_ROLLBACK_MUST_FAIL_CLOSED");
  assert.match(String(rollbackClaimFirstOutcome.error.message || ""),
    /VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL/u);
  assert.doesNotMatch(String(rollbackClaimFirstOutcome.error.message || ""), /deadlock detected/iu);
  await reservationConnection.query("rollback");
  const preservedClaim = (await observerConnection.query(`select state from public.video_reference_asset_cleanup_outbox
    where asset_ref=$1`, [rollbackClaimFirst.assetRef])).rows[0];
  assert.equal(preservedClaim.state, "claimed", "CLAIM_FIRST_NONTERMINAL_MUST_SURVIVE_BLOCKED_ROLLBACK");
  assert.equal((await observerConnection.query("select exists(select 1 from public.user_files where id=$1) present",
    [rollbackClaimFirst.fileId])).rows[0].present, true, "CLAIM_FIRST_METADATA_MUST_SURVIVE");
  await observerConnection.query("select public.mark_video_reference_asset_object_deleted_v1($1,$2)",
    [rollbackClaimFirst.assetRef, rollbackClaimFirst.userId]);
  await observerConnection.query("select public.complete_video_reference_asset_cleanup_v1($1,$2,$3,'tencent_cos',$4,'video-page-reference')",
    [rollbackClaimFirst.assetRef, rollbackClaimFirst.fileId, rollbackClaimFirst.key, rollbackClaimFirst.userId]);

  // Rollback-first claim: hold one outbox row so the real rollback remains
  // between its two table locks. A new claim must wait at video_tasks, then
  // abort after rollback commits; it may never create a hidden nonterminal.
  const rollbackFirst = await registerFixture(observerConnection, "rollback_first_claim");
  await observerConnection.query("begin");
  await observerConnection.query("select 1 from public.video_reference_asset_cleanup_outbox where asset_ref=$1 for update",
    [rollbackFirst.assetRef]);
  const rollbackFirstState = { settled: false };
  const rollbackFirstStartedAt = Date.now();
  const rollbackFirstAttempt = reservationConnection.query(rollback)
    .then(result => ({ result })).catch(error => ({ error }))
    .finally(() => { rollbackFirstState.settled = true; });
  await waitForRelationLock(observerConnection, rollbackPid, "video_tasks", "AccessExclusiveLock", true,
    "ROLLBACK_FIRST_VIDEO_TASKS");
  await waitForRelationLock(observerConnection, rollbackPid, "video_reference_asset_cleanup_outbox",
    "AccessExclusiveLock", false, "ROLLBACK_FIRST_OUTBOX");
  await begin(cleanupConnection);
  const cleanupPid = Number((await cleanupConnection.query("select pg_backend_pid() pid")).rows[0].pid);
  const rollbackFirstClaimState = { settled: false };
  const rollbackFirstClaimAttempt = cleanupConnection.query(`select public.claim_video_reference_asset_cleanup_v1(
    $1,$2,$3,'tencent_cos',$4,'video-page-reference','image',$5
  ) result`, [rollbackFirst.assetRef, rollbackFirst.fileId, rollbackFirst.key,
    rollbackFirst.userId, rollbackFirst.uploadSession])
    .then(result => ({ result })).catch(error => ({ error }))
    .finally(() => { rollbackFirstClaimState.settled = true; });
  await waitForRelationLock(observerConnection, cleanupPid, "video_tasks", "AccessShareLock", false,
    "ROLLBACK_FIRST_CLAIM");
  await waitForBlocked(rollbackFirstClaimState, "ROLLBACK_FIRST_CLAIM");
  await observerConnection.query("commit");
  const rollbackFirstOutcome = await rollbackFirstAttempt;
  const rollbackFirstWaitMs = Date.now() - rollbackFirstStartedAt;
  assert.equal(rollbackFirstOutcome.error, undefined, "ROLLBACK_FIRST_MUST_COMMIT");
  const rollbackFirstClaimOutcome = await rollbackFirstClaimAttempt;
  assert.ok(rollbackFirstClaimOutcome.error, "ROLLBACK_FIRST_CLAIM_MUST_ABORT");
  assert.doesNotMatch(String(rollbackFirstClaimOutcome.error.message || ""), /deadlock detected/iu);
  const failedClaimCommit = await cleanupConnection.query("commit");
  assert.equal(failedClaimCommit.command, "ROLLBACK", "FAILED_CLAIM_TRANSACTION_MUST_NOT_COMMIT");
  assert.equal((await observerConnection.query(
    "select to_regclass('public.video_reference_asset_cleanup_outbox') is null absent",
  )).rows[0].absent, true, "ROLLBACK_FIRST_CONTROL_PLANE_MUST_BE_REMOVED");
  assert.equal((await observerConnection.query("select exists(select 1 from public.user_files where id=$1) present",
    [rollbackFirst.fileId])).rows[0].present, true, "ROLLBACK_FIRST_ABORTED_CLAIM_MUST_PRESERVE_METADATA");

  console.log(JSON.stringify({ passed: true, productDatabaseApplied: false, disposableDatabase: probeDatabase,
    reservationFirst: { cleanupWaited: true, cleanupRejected: "VIDEO_REFERENCE_DELETE_ACTIVE_TASK",
      taskCommittedOnce: true, waitMs: cleanupWaitMs },
    cleanupFirst: { reservationWaited: true, reservationRejected: "VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS",
      taskCommitted: false, waitMs: reservationWaitMs },
    rollbackClaimFirst: { rollbackWaited: true, rollbackRejected:
      "VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL", nonterminalPreserved: true,
      metadataPreserved: true, waitMs: rollbackClaimFirstWaitMs },
    rollbackFirstClaim: { claimWaited: true, rollbackCommitted: true, claimCommitted: false,
      metadataPreserved: true, waitMs: rollbackFirstWaitMs }, noDeadlock: true }, null, 2));
} finally {
  await Promise.all([reservationConnection, cleanupConnection, observerConnection]
    .filter(Boolean).map(client => client.end().catch(() => {})));
  await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [probeDatabase]).catch(() => {});
  await admin.query(`drop database if exists "${probeDatabase}"`).catch(() => {});
  await admin.end();
}
