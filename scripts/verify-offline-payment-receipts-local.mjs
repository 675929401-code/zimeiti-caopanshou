#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-offline-payment-receipts",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});
const runId = crypto.randomUUID();
const ids = {
  admin: crypto.randomUUID(),
  inviter: crypto.randomUUID(),
  invitee: crypto.randomUUID(),
  otherUser: crypto.randomUUID(),
};
const usernames = Object.fromEntries(Object.keys(ids).map((key) => [key, `r604_offline_${key}_${runId.slice(0, 8)}`]));
const paidAt = new Date(Date.now() - 60_000).toISOString();
const reference = `WX${runId.replaceAll("-", "").slice(0, 22).toUpperCase()}`;

function resultOf(queryResult) {
  const value = queryResult.rows[0]?.result;
  assert.ok(value && typeof value === "object", "RPC_RECEIPT_REQUIRED");
  return value;
}

await client.connect();
let transactionOpen = false;
try {
  const before = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.users) AS users,
       (SELECT count(*)::integer FROM public.offline_payment_receipts) AS receipts,
       (SELECT count(*)::integer FROM public.member_activation_events) AS activation_events,
       (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations,
       (SELECT count(*)::integer FROM public.user_notifications) AS notifications`,
  )).rows[0];

  await client.query("BEGIN");
  transactionOpen = true;
  for (const [key, id] of Object.entries(ids)) {
    await client.query(
      `INSERT INTO public.users
       (id,username,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,allowed_categories,created_at,updated_at)
       VALUES($1,$2,'transaction-only-hash',$3,$4,0,0,true,'active','inactive','[]'::jsonb,now(),now())`,
      [id, usernames[key], `R604 offline ${key}`, key === "admin" ? "admin" : "student"],
    );
  }
  const invitationRecordId = (await client.query(
    `INSERT INTO public.invitation_records(inviter_id,invitee_id,invitee_activated,invited_at,reward_sent)
     VALUES($1::uuid,$2::uuid,false,now(),false) RETURNING id`,
    [ids.inviter, ids.invitee],
  )).rows[0].id;
  const beforeAction = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=ANY($1::text[])) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=ANY($2::uuid[])) AS notification_count`,
    [[ids.inviter, ids.invitee], [ids.inviter, ids.invitee]],
  )).rows[0];

  const args = [
    ids.admin,
    ids.invitee,
    "wechat",
    "membership_tuition",
    3980,
    paidAt,
    reference,
    "****2468",
    "微信转账人工核对",
    `offline-payment:${runId}`,
  ];
  const created = resultOf(await client.query(
    "SELECT public.record_offline_payment_and_activate_member_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
    args,
  ));
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.already_recorded, false);
  assert.equal(created.member_activated, true);

  const retry = resultOf(await client.query(
    "SELECT public.record_offline_payment_and_activate_member_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
    args,
  ));
  assert.equal(retry.success, true);
  assert.equal(retry.already_recorded, true);
  assert.equal(retry.receipt_id, created.receipt_id);

  const conflict = resultOf(await client.query(
    "SELECT public.record_offline_payment_and_activate_member_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
    [ids.admin, ids.otherUser, "wechat", "membership_tuition", 3980, paidAt, reference, "****2468", "重复流水不得入账", `offline-payment-conflict:${runId}`],
  ));
  assert.equal(conflict.success, false);
  assert.equal(conflict.code, "OFFLINE_PAYMENT_REFERENCE_EXISTS");

  const state = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.offline_payment_receipts WHERE id=$1::uuid) AS receipt_count,
       (SELECT status FROM public.offline_payment_receipts WHERE id=$1::uuid) AS receipt_status,
       (SELECT member_status FROM public.users WHERE id=$2) AS member_status,
       (SELECT activation_method FROM public.invitation_records WHERE id=$3) AS activation_method,
       (SELECT activation_fee FROM public.invitation_records WHERE id=$3) AS activation_fee,
       (SELECT eligibility_at IS NOT NULL FROM public.invitation_reward_grants WHERE invitation_record_id=$3 AND reward_stage='activation') AS reward_eligible,
       (SELECT count(*)::integer FROM public.invitation_reward_grants WHERE invitation_record_id=$3 AND status='sent') AS sent_rewards,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=ANY($4::text[])) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=ANY($5::uuid[])) AS notification_count`,
    [created.receipt_id, ids.invitee, invitationRecordId, [ids.inviter, ids.invitee], [ids.inviter, ids.invitee]],
  )).rows[0];
  assert.equal(state.receipt_count, 1, "EXACTLY_ONE_RECEIPT_REQUIRED");
  assert.equal(state.receipt_status, "confirmed");
  assert.equal(state.member_status, "active");
  assert.equal(state.activation_method, "admin_manual");
  assert.equal(Number(state.activation_fee), 3980);
  assert.equal(state.reward_eligible, true, "ACTIVATION_REWARD_MAY_BECOME_ELIGIBLE");
  assert.equal(state.sent_rewards, 0, "OFFLINE_PAYMENT_MUST_NOT_AUTO_SEND_REWARD");
  assert.equal(state.wallet_count, beforeAction.wallet_count, "OFFLINE_PAYMENT_MUST_NOT_MUTATE_WALLET");
  assert.equal(state.notification_count, beforeAction.notification_count, "OFFLINE_PAYMENT_MUST_NOT_AUTO_NOTIFY_REWARD");

  await client.query("SAVEPOINT immutable_update_check");
  let immutableUpdateBlocked = false;
  try {
    await client.query("UPDATE public.offline_payment_receipts SET note='试图覆盖原始财务证据' WHERE id=$1::uuid", [created.receipt_id]);
  } catch (error) {
    immutableUpdateBlocked = String(error.message || "").includes("OFFLINE_PAYMENT_RECEIPT_IMMUTABLE");
    await client.query("ROLLBACK TO SAVEPOINT immutable_update_check");
  }
  assert.equal(immutableUpdateBlocked, true, "FINANCIAL_EVIDENCE_UPDATE_MUST_BE_BLOCKED");
  await client.query("RELEASE SAVEPOINT immutable_update_check");

  await client.query("SAVEPOINT immutable_delete_check");
  let immutableDeleteBlocked = false;
  try {
    await client.query("DELETE FROM public.offline_payment_receipts WHERE id=$1::uuid", [created.receipt_id]);
  } catch (error) {
    immutableDeleteBlocked = String(error.message || "").includes("OFFLINE_PAYMENT_RECEIPT_DELETE_FORBIDDEN");
    await client.query("ROLLBACK TO SAVEPOINT immutable_delete_check");
  }
  assert.equal(immutableDeleteBlocked, true, "FINANCIAL_EVIDENCE_DELETE_MUST_BE_BLOCKED");
  await client.query("RELEASE SAVEPOINT immutable_delete_check");

  const voidArgs = [ids.admin, created.receipt_id, "管理员复核发现转账归属错误", `void-offline-payment:${runId}`];
  const voided = resultOf(await client.query(
    "SELECT public.void_offline_payment_receipt_atomic($1,$2,$3,$4) AS result",
    voidArgs,
  ));
  assert.equal(voided.success, true);
  assert.equal(voided.already_voided, false);
  assert.equal(voided.requires_membership_review, true);
  const voidRetry = resultOf(await client.query(
    "SELECT public.void_offline_payment_receipt_atomic($1,$2,$3,$4) AS result",
    voidArgs,
  ));
  assert.equal(voidRetry.success, true);
  assert.equal(voidRetry.already_voided, true);
  const afterVoid = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.offline_payment_receipts WHERE id=$1::uuid) AS receipt_count,
       (SELECT status FROM public.offline_payment_receipts WHERE id=$1::uuid) AS receipt_status,
       (SELECT void_reason FROM public.offline_payment_receipts WHERE id=$1::uuid) AS void_reason,
       (SELECT member_status FROM public.users WHERE id=$2) AS member_status`,
    [created.receipt_id, ids.invitee],
  )).rows[0];
  assert.equal(afterVoid.receipt_count, 1, "VOID_MUST_NOT_DELETE_RECEIPT");
  assert.equal(afterVoid.receipt_status, "voided");
  assert.equal(afterVoid.void_reason, "管理员复核发现转账归属错误");
  assert.equal(afterVoid.member_status, "active", "VOID_REQUIRES_SEPARATE_MEMBERSHIP_REVIEW");

  await client.query("ROLLBACK");
  transactionOpen = false;
  const after = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.users) AS users,
       (SELECT count(*)::integer FROM public.offline_payment_receipts) AS receipts,
       (SELECT count(*)::integer FROM public.member_activation_events) AS activation_events,
       (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations,
       (SELECT count(*)::integer FROM public.user_notifications) AS notifications`,
  )).rows[0];
  assert.deepEqual(after, before, "TRANSACTION_FIXTURES_MUST_ROLL_BACK");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    assertions: {
      receiptAndActivationAtomic: true,
      exactRetryIdempotent: true,
      duplicateTransferRejected: true,
      invitationRewardNotAutomaticallySent: true,
      walletNotAutomaticallyMutated: true,
      voidPreservesAuditReceipt: true,
      voidRequiresSeparateMembershipReview: true,
      evidenceUpdateBlockedByDatabase: true,
      evidenceDeleteBlockedByDatabase: true,
      transactionFixturesRolledBack: true,
    },
    productionWrites: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "member-activation-workflow");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "offline-payment-database-flow.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
