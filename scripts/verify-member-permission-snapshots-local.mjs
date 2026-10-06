#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pg from "pg";

const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-member-permissions",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
await client.connect();
try {
  const admin = (await client.query(
    "SELECT id FROM public.users WHERE role='admin' AND coalesce(is_active,true) AND coalesce(status,'active')='active' ORDER BY created_at LIMIT 1",
  )).rows[0];
  const member = (await client.query(
    `SELECT u.id,a.feature_navigation_keys,a.agent_navigation_keys,a.revision,a.checksum
     FROM public.users u JOIN public.member_permission_assignments a ON a.user_id=u.id
     WHERE u.role<>'admin' ORDER BY u.created_at LIMIT 1`,
  )).rows[0];
  assert.ok(admin?.id && member?.id, "ADMIN_AND_MEMBER_FIXTURES_REQUIRED");

  const baselineCounts = (await client.query(
    "SELECT (SELECT count(*) FROM public.member_permission_events) AS events, (SELECT count(*) FROM public.member_permission_assignments) AS assignments",
  )).rows[0];
  const baselineFeatures = member.feature_navigation_keys;
  const changedFeatures = baselineFeatures.includes("commerce_agent")
    ? baselineFeatures.filter((key) => key !== "commerce_agent")
    : [...baselineFeatures, "commerce_agent"];
  const requestKey = `verify-member-permission-${Date.now()}`;

  await client.query("BEGIN");
  const receipt = (await client.query(
    `SELECT public.set_member_permissions_atomic(
       $1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,NULL,NULL
     ) AS receipt`,
    [admin.id, member.id, JSON.stringify(changedFeatures), JSON.stringify(member.agent_navigation_keys), member.revision, requestKey, "本地事务回滚验收"],
  )).rows[0].receipt;
  assert.equal(receipt.success, true, "ATOMIC_SAVE_FAILED");
  assert.equal(receipt.already_applied, false, "FIRST_SAVE_MUST_APPLY");
  assert.equal(Number(receipt.revision), Number(member.revision) + 1, "REVISION_NOT_INCREMENTED");

  const snapshot = (await client.query(
    "SELECT public.read_member_permission_snapshot($1) AS snapshot",
    [member.id],
  )).rows[0].snapshot;
  assert.equal(snapshot.authority_status, "ready", "SNAPSHOT_NOT_READY");
  assert.equal(snapshot.integrity_valid, true, "SNAPSHOT_INTEGRITY_INVALID");
  assert.deepEqual(snapshot.feature_navigation_keys, changedFeatures, "FEATURE_KEYS_NOT_PERSISTED");

  const duplicate = (await client.query(
    `SELECT public.set_member_permissions_atomic(
       $1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,NULL,NULL
     ) AS receipt`,
    [admin.id, member.id, JSON.stringify(changedFeatures), JSON.stringify(member.agent_navigation_keys), member.revision, requestKey, "本地事务回滚验收"],
  )).rows[0].receipt;
  assert.equal(duplicate.success, true, "IDEMPOTENT_REPLAY_FAILED");
  assert.equal(duplicate.already_applied, true, "IDEMPOTENT_REPLAY_NOT_REUSED");

  const stale = (await client.query(
    `SELECT public.set_member_permissions_atomic(
       $1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,NULL,NULL
     ) AS receipt`,
    [admin.id, member.id, JSON.stringify(baselineFeatures), JSON.stringify(member.agent_navigation_keys), member.revision, `${requestKey}-stale`, "旧版本覆盖测试"],
  )).rows[0].receipt;
  assert.equal(stale.code, "MEMBER_PERMISSION_REVISION_CONFLICT", "STALE_WRITE_NOT_REJECTED");
  await client.query("ROLLBACK");

  await client.query("BEGIN");
  await client.query("SAVEPOINT direct_write_guard");
  let directWriteCode = "";
  try {
    await client.query("UPDATE public.member_permission_assignments SET reason='bypass' WHERE user_id=$1", [member.id]);
  } catch (error) {
    directWriteCode = error.code;
    await client.query("ROLLBACK TO SAVEPOINT direct_write_guard");
  }
  assert.equal(directWriteCode, "42501", "DIRECT_ASSIGNMENT_WRITE_NOT_BLOCKED");
  await client.query("ROLLBACK");

  const afterMember = (await client.query(
    "SELECT feature_navigation_keys,agent_navigation_keys,revision,checksum FROM public.member_permission_assignments WHERE user_id=$1",
    [member.id],
  )).rows[0];
  const afterCounts = (await client.query(
    "SELECT (SELECT count(*) FROM public.member_permission_events) AS events, (SELECT count(*) FROM public.member_permission_assignments) AS assignments",
  )).rows[0];
  assert.deepEqual(afterMember, {
    feature_navigation_keys: member.feature_navigation_keys,
    agent_navigation_keys: member.agent_navigation_keys,
    revision: member.revision,
    checksum: member.checksum,
  }, "ROLLBACK_DID_NOT_RESTORE_PERMISSION_SNAPSHOT");
  assert.deepEqual(afterCounts, baselineCounts, "VERIFY_MUST_NOT_PERSIST_BUSINESS_WRITES");

  console.log(JSON.stringify({
    passed: true,
    checks: {
      atomicSave: true,
      integrityRead: true,
      idempotentReplay: true,
      staleWriteRejected: true,
      directWriteRejected: true,
      transactionRolledBack: true,
    },
    productionWrites: 0,
    localPersistentBusinessWrites: 0,
  }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}

