#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const CONFIRM = "--execute-transaction-rollback-probe";
assert.deepEqual(process.argv.slice(2), [CONFIRM], `EXPLICIT_NON_PERSISTENT_PROBE_CONFIRMATION_REQUIRED:${CONFIRM}`);
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
const stripEnvelope = source => source
  .replace(/^\s*begin;\s*/iu, "")
  .replace(/\s*notify pgrst,\s*'reload schema';\s*/giu, "")
  .replace(/\s*commit;\s*$/iu, "");
const migrationSource = await readFile("supabase/migrations/20261010135000_video_reference_asset_cleanup_outbox.sql", "utf8");
const rollbackSource = await readFile("supabase/rollbacks/20261010135000_video_reference_asset_cleanup_outbox.rollback.sql", "utf8");
assert.equal((migrationSource.match(/lock table public\.video_tasks in access share mode;/gu) || []).length, 6,
  "EVERY_CLEANUP_ENTRYPOINT_MUST_JOIN_THE_VIDEO_TASKS_LOCK_BOUNDARY");
const rollbackVideoTasksLock = rollbackSource.indexOf("lock table public.video_tasks in access exclusive mode;");
const rollbackOutboxLock = rollbackSource.indexOf("lock table public.video_reference_asset_cleanup_outbox in access exclusive mode");
const rollbackSafetyCheck = rollbackSource.indexOf("VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL");
assert.ok(rollbackVideoTasksLock >= 0 && rollbackVideoTasksLock < rollbackOutboxLock
  && rollbackOutboxLock < rollbackSafetyCheck, "ROLLBACK_QUIESCE_LOCK_ORDER_REQUIRED");
const migration = stripEnvelope(migrationSource);
const rollback = stripEnvelope(rollbackSource);
const client = new pg.Client({ ...runtime.ownerConnection, user: "postgres", password: runtime.postgresPassword,
  application_name: "codex-video-reference-cleanup-rollback-probe", connectionTimeoutMillis: 10_000, query_timeout: 120_000 });
await client.connect();
let open = false;
try {
  const before = (await client.query("select to_regclass('public.video_reference_asset_cleanup_outbox')::text name")).rows[0]?.name || null;
  assert.equal(before, null, "PROBE_REQUIRES_MIGRATION_NOT_APPLIED");
  await client.query("begin"); open = true;
  await client.query(migration);
  assert.equal((await client.query("select to_regclass('public.video_reference_asset_cleanup_outbox') is not null present")).rows[0].present, true);
  assert.equal((await client.query(`select count(*)::integer count from public.video_reference_asset_cleanup_outbox`)).rows[0].count, 0,
    "MIGRATION_MUST_NOT_BACKFILL_EXISTING_ROWS");
  const authoritativeOwner = String((await client.query(
    "select pg_get_userbyid(relowner) owner from pg_class where oid='public.video_tasks'::regclass",
  )).rows[0].owner);
  for (const [signature, serviceCallable] of [
    ["public.guard_video_reference_assets_during_reservation_v1()", false],
    ["public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text)", true],
    ["public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text)", true],
    ["public.mark_video_reference_asset_object_deleted_v1(text,text)", true],
    ["public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text)", true],
    ["public.record_video_reference_asset_cleanup_failure_v1(text,text,text)", true],
  ]) {
    const security = (await client.query(`select pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
      has_function_privilege('service_role',p.oid,'execute') service_execute,
      has_function_privilege('anon',p.oid,'execute') anon_execute,
      has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
      array(select role_entry.rolname from pg_roles role_entry
        where role_entry.oid not in (p.proowner,to_regrole('service_role')) and not role_entry.rolsuper
          and has_function_privilege(role_entry.oid,p.oid,'execute')) unexpected_roles
      from pg_proc p where p.oid=to_regprocedure($1)`, [signature])).rows[0];
    assert.equal(security.owner, authoritativeOwner, `OWNER_MISMATCH:${signature}`);
    assert.equal(security.prosecdef, true, `SECURITY_DEFINER_REQUIRED:${signature}`);
    assert.deepEqual(security.proconfig, ["search_path=public, pg_temp"], `SEARCH_PATH_REQUIRED:${signature}`);
    assert.equal(security.service_execute, serviceCallable, `SERVICE_EXECUTE_MISMATCH:${signature}`);
    assert.equal(security.anon_execute, false, `ANON_EXECUTE_FORBIDDEN:${signature}`);
    assert.equal(security.authenticated_execute, false, `AUTHENTICATED_EXECUTE_FORBIDDEN:${signature}`);
    assert.ok(Array.isArray(security.unexpected_roles)
      ? security.unexpected_roles.length === 0
      : String(security.unexpected_roles || "") === "{}", `UNEXPECTED_EFFECTIVE_GRANTEES:${signature}`);
  }
  const fixtureRef = "object://tencent_cos/video-inputs%2Frollback-probe.png";
  const fixtureUserId = String((await client.query("select id::text id from public.users order by created_at limit 1")).rows[0]?.id || "");
  assert.ok(fixtureUserId, "LOCAL_FIXTURE_USER_REQUIRED");
  const fixtureFileId = String((await client.query(`insert into public.user_files(
    user_id,storage_key,storage_provider,file_name,file_category,file_size,content_type,source,meta
  ) values($1,'video-inputs/rollback-probe.png','tencent_cos','rollback-probe.png','image',1,'image/png',
    'video-page-reference',$2::jsonb) returning id::text id`, [fixtureUserId,
    JSON.stringify({ videoPageUploadSession: "video_ref_rollback_probe_123456" })])).rows[0].id);
  const registered = (await client.query(`select public.register_video_reference_asset_guard_v1(
    $1,$2,'video-inputs/rollback-probe.png','tencent_cos',$3,'video-page-reference','image','video_ref_rollback_probe_123456'
  ) result`, [fixtureRef, fixtureFileId, fixtureUserId])).rows[0].result;
  assert.equal(registered.state, "available");
  const registrationTime = (await client.query(`select registered_at,claimed_at from public.video_reference_asset_cleanup_outbox
    where asset_ref=$1`, [fixtureRef])).rows[0];
  assert.ok(registrationTime.registered_at, "REGISTRATION_TIMESTAMP_REQUIRED");
  assert.equal(registrationTime.claimed_at, null, "AVAILABLE_MUST_NOT_HAVE_CLAIM_TIMESTAMP");
  await client.query("create temporary table video_reference_guard_probe(request_snapshot jsonb)");
  await client.query(`create trigger video_reference_guard_probe_trigger before insert or update of request_snapshot
    on video_reference_guard_probe for each row execute function public.guard_video_reference_assets_during_reservation_v1()`);
  const snapshot = JSON.stringify({ referenceAssets: [{ role: "first_frame", index: 0, ref: fixtureRef }] });
  await client.query("insert into video_reference_guard_probe(request_snapshot) values($1::jsonb)", [snapshot]);
  const claimed = (await client.query(`select public.claim_video_reference_asset_cleanup_v1(
    $1,$2,'video-inputs/rollback-probe.png','tencent_cos',$3,'video-page-reference','image','video_ref_rollback_probe_123456'
  ) result`, [fixtureRef, fixtureFileId, fixtureUserId])).rows[0].result;
  assert.equal(claimed.state, "claimed");
  const claimTime = (await client.query(`select registered_at,claimed_at from public.video_reference_asset_cleanup_outbox
    where asset_ref=$1`, [fixtureRef])).rows[0];
  assert.ok(claimTime.claimed_at, "CLAIM_TIMESTAMP_REQUIRED");
  assert.ok(new Date(claimTime.claimed_at).getTime() >= new Date(claimTime.registered_at).getTime(),
    "CLAIM_TIMESTAMP_MUST_NOT_PRECEDE_REGISTRATION");
  await client.query("savepoint claimed_asset_reservation");
  let claimedBlocked = false;
  try {
    await client.query("insert into video_reference_guard_probe(request_snapshot) values($1::jsonb)", [snapshot]);
  } catch (error) {
    claimedBlocked = String(error?.message || "").includes("VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS");
    await client.query("rollback to savepoint claimed_asset_reservation");
  }
  await client.query("release savepoint claimed_asset_reservation");
  assert.equal(claimedBlocked, true, "CLAIMED_ASSET_RESERVATION_MUST_BE_BLOCKED");
  const unrelatedSnapshot = JSON.stringify({ referenceAssets: [{ role: "first_frame", index: 0,
    ref: "object://tencent_cos/unregistered%2Funrelated.png" }] });
  await client.query("insert into video_reference_guard_probe(request_snapshot) values($1::jsonb)", [unrelatedSnapshot]);
  const objectDeleted = (await client.query(
    "select public.mark_video_reference_asset_object_deleted_v1($1,$2) result", [fixtureRef, fixtureUserId],
  )).rows[0].result;
  assert.equal(objectDeleted.state, "object_deleted");
  assert.equal((await client.query("select exists(select 1 from public.user_files where id::text=$1) present", [fixtureFileId])).rows[0].present,
    true, "OBJECT_DELETED_METADATA_MUST_STILL_EXIST_BEFORE_FINALIZE");
  await client.query("savepoint unsafe_rollback");
  let unsafeRollbackBlocked = false;
  try {
    await client.query(rollback);
  } catch (error) {
    unsafeRollbackBlocked = String(error?.message || "").includes("VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL");
    await client.query("rollback to savepoint unsafe_rollback");
  }
  await client.query("release savepoint unsafe_rollback");
  assert.equal(unsafeRollbackBlocked, true, "OBJECT_DELETED_METADATA_PENDING_MUST_BLOCK_ROLLBACK");
  assert.equal((await client.query("select exists(select 1 from public.user_files where id::text=$1) present", [fixtureFileId])).rows[0].present,
    true, "BLOCKED_ROLLBACK_MUST_PRESERVE_METADATA");
  const completed = (await client.query(
    "select public.complete_video_reference_asset_cleanup_v1($1,$2,$3,$4,$5,$6) result",
    [fixtureRef, fixtureFileId, "video-inputs/rollback-probe.png", "tencent_cos", fixtureUserId, "video-page-reference"],
  )).rows[0].result;
  assert.equal(completed.state, "completed");
  assert.equal((await client.query("select exists(select 1 from public.user_files where id::text=$1) present", [fixtureFileId])).rows[0].present,
    false, "COMPLETED_CLEANUP_MUST_REMOVE_EXACT_METADATA");
  const completedAgain = (await client.query(
    "select public.complete_video_reference_asset_cleanup_v1($1,$2,$3,$4,$5,$6) result",
    [fixtureRef, fixtureFileId, "video-inputs/rollback-probe.png", "tencent_cos", fixtureUserId, "video-page-reference"],
  )).rows[0].result;
  assert.equal(completedAgain.state, "completed");
  await client.query("drop table video_reference_guard_probe");
  await client.query(rollback);
  assert.equal((await client.query("select to_regclass('public.video_reference_asset_cleanup_outbox') is null absent")).rows[0].absent, true);
  await client.query("rollback"); open = false;
  assert.equal((await client.query("select to_regclass('public.video_reference_asset_cleanup_outbox')::text name")).rows[0]?.name || null, before);
  console.log(JSON.stringify({ passed: true, persisted: false, target: "127.0.0.1:54322/zimeiti_local",
    checks: ["migration DDL", "zero-row migration", "dynamic owner and service-only function ACL",
      "fixed SECURITY DEFINER search_path", "unexpected effective grantees rejected", "registration and claim timestamps are distinct",
      "rollback quiesce lock order",
      "available guard allows reservation",
      "claimed guard blocks same asset", "unregistered object ref remains unaffected",
      "object_deleted with metadata blocks rollback", "object_deleted to completed retry is idempotent",
      "rollback DDL", "outer transaction rollback"] }, null, 2));
} finally {
  if (open) await client.query("rollback").catch(() => {});
  await client.end();
}
