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
  application_name: "codex-verify-member-activation-workflow",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});
const runId = crypto.randomUUID();
const ids = {
  admin: crypto.randomUUID(),
  inviter: crypto.randomUUID(),
  manualInvitee: crypto.randomUUID(),
  cardInvitee: crypto.randomUUID(),
  otherUser: crypto.randomUUID(),
};
const usernames = Object.fromEntries(Object.entries(ids).map(([key]) => [key, `r604_${key}_${runId.slice(0, 8)}`]));

function resultOf(queryResult) {
  const value = queryResult.rows[0]?.result;
  assert.ok(value && typeof value === "object", "RPC_RECEIPT_REQUIRED");
  return value;
}

await client.connect();
let transactionOpen = false;
try {
  await client.query("BEGIN");
  transactionOpen = true;
  for (const [key, id] of Object.entries(ids)) {
    await client.query(
      `INSERT INTO public.users
       (id,username,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,allowed_categories,created_at,updated_at)
       VALUES($1,$2,'transaction-only-hash',$3,$4,0,0,true,'active','inactive','[]'::jsonb,now(),now())`,
      [id, usernames[key], `R604 ${key}`, key === "admin" ? "admin" : "student"],
    );
  }

  const manualRecordId = (await client.query(
    `INSERT INTO public.invitation_records(inviter_id,invitee_id,invitee_activated,invited_at,reward_sent)
     VALUES($1::uuid,$2::uuid,false,now(),false) RETURNING id`,
    [ids.inviter, ids.manualInvitee],
  )).rows[0].id;
  const grantSeed = await client.query(
    `SELECT reward_stage,status,eligibility_at FROM public.invitation_reward_grants
     WHERE invitation_record_id=$1 ORDER BY reward_stage`,
    [manualRecordId],
  );
  assert.equal(grantSeed.rowCount, 3, "THREE_REWARD_STAGES_REQUIRED");
  assert.ok(grantSeed.rows.find((row) => row.reward_stage === "registration")?.eligibility_at, "REGISTRATION_STAGE_MUST_BE_ELIGIBLE");
  assert.ok(grantSeed.rows.find((row) => row.reward_stage === "invitee_welcome")?.eligibility_at, "INVITEE_WELCOME_STAGE_MUST_BE_ELIGIBLE");
  assert.equal(grantSeed.rows.find((row) => row.reward_stage === "activation")?.eligibility_at, null, "ACTIVATION_STAGE_MUST_WAIT");

  const beforeManual = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=ANY($1::text[])) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=ANY($2::uuid[])) AS notification_count`,
    [[ids.inviter, ids.manualInvitee], [ids.inviter, ids.manualInvitee]],
  )).rows[0];
  const activationArgs = [ids.admin, ids.manualInvitee, "active", "admin_manual", "offline-fee-r604", 3980, "线下学费已人工核对", `activate:${runId}`];
  const activation = resultOf(await client.query(
    "SELECT public.set_member_activation_state_atomic($1,$2,$3,$4,$5,$6,$7,$8) AS result",
    activationArgs,
  ));
  assert.equal(activation.success, true);
  assert.equal(activation.already_applied, false);
  const activationRetry = resultOf(await client.query(
    "SELECT public.set_member_activation_state_atomic($1,$2,$3,$4,$5,$6,$7,$8) AS result",
    activationArgs,
  ));
  assert.equal(activationRetry.success, true);
  assert.equal(activationRetry.already_applied, true);
  const activationConflict = resultOf(await client.query(
    "SELECT public.set_member_activation_state_atomic($1,$2,$3,$4,$5,$6,$7,$8) AS result",
    [ids.admin, ids.manualInvitee, "active", "admin_manual", "offline-fee-r604", 3000, "线下学费已人工核对", `activate:${runId}`],
  ));
  assert.equal(activationConflict.code, "MEMBER_ACTIVATION_IDEMPOTENCY_CONFLICT");
  const afterManual = (await client.query(
    `SELECT
       (SELECT member_status FROM public.users WHERE id=$1) AS member_status,
       (SELECT activation_method FROM public.invitation_records WHERE id=$2) AS activation_method,
       (SELECT activation_fee FROM public.invitation_records WHERE id=$2) AS activation_fee,
       (SELECT eligibility_at IS NOT NULL FROM public.invitation_reward_grants WHERE invitation_record_id=$2 AND reward_stage='activation') AS activation_eligible,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=ANY($3::text[])) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=ANY($4::uuid[])) AS notification_count`,
    [ids.manualInvitee, manualRecordId, [ids.inviter, ids.manualInvitee], [ids.inviter, ids.manualInvitee]],
  )).rows[0];
  assert.equal(afterManual.member_status, "active");
  assert.equal(afterManual.activation_method, "admin_manual");
  assert.equal(Number(afterManual.activation_fee), 3980);
  assert.equal(afterManual.activation_eligible, true);
  assert.equal(afterManual.wallet_count, beforeManual.wallet_count, "ACTIVATION_MUST_NOT_AUTO_REWARD");
  assert.equal(afterManual.notification_count, beforeManual.notification_count, "ACTIVATION_MUST_NOT_AUTO_NOTIFY_REWARD");

  const rewardMessage = "感谢您成功邀请新会员完成注册！本次奖励为 100 积分和 ¥5.00 现金，现已自动发放至您的账户。";
  const draft = resultOf(await client.query(
    "SELECT public.save_invitation_reward_decision_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
    [ids.admin, manualRecordId, "registration", 100, 5, rewardMessage, "draft"],
  ));
  assert.equal(draft.status, "draft");
  const beforeSend = (await client.query(
    `SELECT
       (SELECT credits FROM public.users WHERE id=$1) AS credits,
       (SELECT cash_balance FROM public.users WHERE id=$1) AS cash_balance,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid) AS notification_count`,
    [ids.inviter],
  )).rows[0];
  assert.equal(Number(beforeSend.credits), 0, "DRAFT_MUST_NOT_CREDIT");
  assert.equal(Number(beforeSend.cash_balance), 0, "DRAFT_MUST_NOT_CREDIT_CASH");
  const sent = resultOf(await client.query(
    "SELECT public.send_invitation_reward_atomic($1,$2,$3,$4) AS result",
    [ids.admin, manualRecordId, "registration", `reward-send:${runId}`],
  ));
  assert.equal(sent.success, true);
  assert.equal(sent.already_sent, false);
  const sentRetry = resultOf(await client.query(
    "SELECT public.send_invitation_reward_atomic($1,$2,$3,$4) AS result",
    [ids.admin, manualRecordId, "registration", `reward-send-retry:${runId}`],
  ));
  assert.equal(sentRetry.already_sent, true);
  const afterSend = (await client.query(
    `SELECT
       (SELECT credits FROM public.users WHERE id=$1) AS credits,
       (SELECT cash_balance FROM public.users WHERE id=$1) AS cash_balance,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid AND type='invitation_reward') AS notification_count,
       (SELECT content FROM public.user_notifications WHERE id=$2::uuid) AS notification_content`,
    [ids.inviter, sent.notification_id],
  )).rows[0];
  assert.equal(Number(afterSend.credits), 100);
  assert.equal(Number(afterSend.cash_balance), 5);
  assert.equal(Number(afterSend.wallet_count) - Number(beforeSend.wallet_count), 2, "REWARD_WALLET_EXACTLY_ONCE_REQUIRED");
  assert.equal(Number(afterSend.notification_count) - Number(beforeSend.notification_count), 1, "REWARD_NOTIFICATION_EXACTLY_ONCE_REQUIRED");
  assert.equal(afterSend.notification_content, rewardMessage, "EDITABLE_REWARD_TEMPLATE_MUST_BE_EXACT_NOTIFICATION_BODY");
  const skipped = resultOf(await client.query(
    "SELECT public.save_invitation_reward_decision_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
    [ids.admin, manualRecordId, "activation", 0, 0, "本次不发正式会员礼包", "skip"],
  ));
  assert.equal(skipped.status, "skipped");
  const welcomeSkipped = resultOf(await client.query(
    "SELECT public.save_invitation_reward_decision_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
    [ids.admin, manualRecordId, "invitee_welcome", 0, 0, "本次不发新人体验礼包", "skip"],
  ));
  assert.equal(welcomeSkipped.status, "skipped");
  const recordCompletion = await client.query("SELECT reward_sent FROM public.invitation_records WHERE id=$1", [manualRecordId]);
  assert.equal(recordCompletion.rows[0].reward_sent, true, "BOTH_ELIGIBLE_REWARD_STAGES_MUST_BE_DECIDED");

  const cardRecordId = (await client.query(
    `INSERT INTO public.invitation_records(inviter_id,invitee_id,invitee_activated,invited_at,reward_sent)
     VALUES($1::uuid,$2::uuid,false,now(),false) RETURNING id`,
    [ids.inviter, ids.cardInvitee],
  )).rows[0].id;
  const formalProfile = (await client.query(
    `SELECT profile_key,version,name,duration_days,credits,cash_amount,
            public.normalize_member_feature_keys(feature_navigation_keys) AS feature_navigation_keys,
            public.normalize_member_agent_keys(agent_navigation_keys) AS agent_navigation_keys
       FROM public.member_permission_profiles
      WHERE profile_key='formal_member' AND is_active AND is_selectable
      ORDER BY version DESC LIMIT 1`,
  )).rows[0];
  assert.ok(formalProfile, "ACTIVE_FORMAL_PACKAGE_PROFILE_REQUIRED");
  const cardCode = `R604${runId.replace(/-/g, "").slice(0, 16).toUpperCase()}`;
  const card = (await client.query(
    `INSERT INTO public.cami_codes(
       code,credits,cash_balance,duration_days,plan_name,is_used,batch_id,
       allowed_categories,feature_navigation_keys,profile_key,profile_version,created_by
     ) VALUES($1,$2,$3,$4,$5,false,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
     RETURNING id`,
    [
      cardCode,
      formalProfile.credits,
      formalProfile.cash_amount,
      formalProfile.duration_days,
      formalProfile.name,
      `r604-${runId}`,
      JSON.stringify(formalProfile.agent_navigation_keys),
      JSON.stringify(formalProfile.feature_navigation_keys),
      formalProfile.profile_key,
      formalProfile.version,
      ids.admin,
    ],
  )).rows[0];
  const cardBefore = (await client.query(
    `SELECT
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS wallet_count,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid) AS notification_count,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$2) AS inviter_wallet_count`,
    [ids.cardInvitee, ids.inviter],
  )).rows[0];
  const assigned = resultOf(await client.query(
    "SELECT public.assign_cami_to_user_atomic($1,$2,$3,$4) AS result",
    [ids.admin, card.id, ids.cardInvitee, `assign:${runId}`],
  ));
  assert.equal(assigned.success, true);
  const assignedRetry = resultOf(await client.query(
    "SELECT public.assign_cami_to_user_atomic($1,$2,$3,$4) AS result",
    [ids.admin, card.id, ids.cardInvitee, `assign:${runId}`],
  ));
  assert.equal(assignedRetry.already_assigned, true);
  const secondCard = (await client.query(
    `INSERT INTO public.cami_codes(
       code,credits,cash_balance,duration_days,plan_name,is_used,batch_id,
       allowed_categories,feature_navigation_keys,profile_key,profile_version,created_by
     ) VALUES($1,$2,$3,$4,$5,false,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
     RETURNING id`,
    [
      `${cardCode}B`, formalProfile.credits, formalProfile.cash_amount, formalProfile.duration_days,
      formalProfile.name, `r604-second-${runId}`, JSON.stringify(formalProfile.agent_navigation_keys),
      JSON.stringify(formalProfile.feature_navigation_keys), formalProfile.profile_key,
      formalProfile.version, ids.admin,
    ],
  )).rows[0];
  const duplicatePending = resultOf(await client.query(
    "SELECT public.assign_cami_to_user_atomic($1,$2,$3,$4) AS result",
    [ids.admin, secondCard.id, ids.cardInvitee, `assign-second:${runId}`],
  ));
  assert.equal(duplicatePending.code, "CAMI_ASSIGNMENT_PENDING_EXISTS", "SECOND_PENDING_CARD_MUST_BE_BLOCKED");
  const delivered = await client.query(
    "SELECT count(*)::integer AS count FROM public.user_notifications WHERE user_id=$1::uuid AND type='membership_card'",
    [ids.cardInvitee],
  );
  assert.equal(Number(delivered.rows[0].count) - Number(cardBefore.notification_count), 1, "CARD_DELIVERY_EXACTLY_ONCE_REQUIRED");
  const wrongUser = resultOf(await client.query(
    "SELECT public.redeem_cami_membership_atomic($1,$2,$3) AS result",
    [ids.otherUser, cardCode, `redeem-wrong:${runId}`],
  ));
  assert.equal(wrongUser.code, "CAMI_REDEEM_NOT_ASSIGNED_TO_USER");
  const redeemed = resultOf(await client.query(
    "SELECT public.redeem_cami_membership_atomic($1,$2,$3) AS result",
    [ids.cardInvitee, cardCode, `redeem:${runId}`],
  ));
  assert.equal(redeemed.success, true);
  assert.equal(redeemed.already_redeemed, false);
  const redeemedRetry = resultOf(await client.query(
    "SELECT public.redeem_cami_membership_atomic($1,$2,$3) AS result",
    [ids.cardInvitee, cardCode, `redeem:${runId}`],
  ));
  assert.equal(redeemedRetry.already_redeemed, true);
  const cardAfter = (await client.query(
    `SELECT
       (SELECT member_status FROM public.users WHERE id=$1) AS member_status,
       (SELECT credits FROM public.users WHERE id=$1) AS credits,
       (SELECT cash_balance FROM public.users WHERE id=$1) AS cash_balance,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS wallet_count,
       (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$7) AS inviter_wallet_count,
       (SELECT activation_method FROM public.invitation_records WHERE id=$2) AS activation_method,
       (SELECT eligibility_at IS NOT NULL FROM public.invitation_reward_grants WHERE invitation_record_id=$2 AND reward_stage='activation') AS activation_eligible,
       (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid AND type='member_package') AS redemption_notification_count,
       (SELECT package_assignment_id IS NOT NULL FROM public.cami_codes WHERE id=$3) AS card_has_package_receipt,
       (SELECT count(*)::integer FROM public.member_package_assignments WHERE id=$4::uuid AND user_id=$1 AND profile_key=$5 AND profile_version=$6) AS package_receipt_count,
       public.read_member_permission_snapshot($1) AS permission_snapshot`,
    [ids.cardInvitee, cardRecordId, card.id, redeemed.package_assignment_id, formalProfile.profile_key, formalProfile.version, ids.inviter],
  )).rows[0];
  assert.equal(cardAfter.member_status, "active");
  assert.equal(cardAfter.activation_method, "cami");
  assert.equal(cardAfter.activation_eligible, true);
  const expectedWalletOperations = Number(formalProfile.credits) > 0 && Number(formalProfile.cash_amount) > 0 ? 2 : (Number(formalProfile.credits) > 0 || Number(formalProfile.cash_amount) > 0 ? 1 : 0);
  assert.equal(Number(cardAfter.wallet_count) - Number(cardBefore.wallet_count), expectedWalletOperations, "PACKAGE_CARD_WALLET_OPERATIONS_MUST_MATCH_SNAPSHOT");
  assert.equal(Number(cardAfter.credits), Number(formalProfile.credits), "PACKAGE_CARD_CREDITS_MUST_MATCH_SNAPSHOT");
  assert.equal(Number(cardAfter.cash_balance), Number(formalProfile.cash_amount), "PACKAGE_CARD_CASH_MUST_MATCH_SNAPSHOT");
  assert.equal(Number(cardAfter.redemption_notification_count), 1, "PACKAGE_REDEMPTION_RECEIPT_NOTIFICATION_REQUIRED");
  assert.equal(cardAfter.card_has_package_receipt, true, "CARD_MUST_LINK_PACKAGE_RECEIPT");
  assert.equal(Number(cardAfter.package_receipt_count), 1, "IMMUTABLE_PACKAGE_ASSIGNMENT_RECEIPT_REQUIRED");
  assert.equal(Number(cardAfter.inviter_wallet_count), Number(cardBefore.inviter_wallet_count), "CARD_ACTIVATION_MUST_NOT_AUTO_PAY_INVITER_REWARD");
  assert.equal(cardAfter.permission_snapshot?.integrity_valid, true, "CARD_PERMISSION_SNAPSHOT_INTEGRITY_REQUIRED");
  assert.deepEqual(cardAfter.permission_snapshot?.feature_navigation_keys, formalProfile.feature_navigation_keys, "CARD_BUSINESS_FEATURES_MUST_MATCH_PACKAGE_SNAPSHOT");
  assert.deepEqual(cardAfter.permission_snapshot?.agent_navigation_keys, formalProfile.agent_navigation_keys, "CARD_AGENT_GRANTS_MUST_MATCH_PACKAGE_SNAPSHOT");

  await client.query("ROLLBACK");
  transactionOpen = false;
  const residue = await client.query("SELECT count(*)::integer AS count FROM public.users WHERE username LIKE $1", [`r604_%_${runId.slice(0, 8)}`]);
  assert.equal(Number(residue.rows[0].count), 0, "TRANSACTION_ONLY_FIXTURES_MUST_ROLL_BACK");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    assertions: {
      manualActivationNoAutoReward: true,
      registrationAndActivationRewardsIndependent: true,
      manualRewardExactlyOnce: true,
      cardAssignmentExactlyOnce: true,
      duplicatePendingCardBlocked: true,
      assignedCardCannotBeStolen: true,
      cardActivationNoAutoReward: true,
      cardPermissionSnapshotSynchronized: true,
      cardWalletBenefitsMatchPackage: true,
      cardPackageReceiptLinked: true,
      rewardTemplateIsExactNotificationBody: true,
      transactionFixturesRolledBack: true,
    },
    productionWrites: 0,
    durableFixtureWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "member-activation-workflow");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "database-flow.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
