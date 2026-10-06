#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

async function read(file) {
  return fs.readFile(path.resolve(file), "utf8");
}

const [
  adminPage,
  usersRoute,
  camiRoute,
  userCamiRoute,
  rewardRoute,
  creditRoute,
  cashRoute,
  notificationRoute,
  offlineRoute,
  reconciliationRoute,
  lifecycleRoute,
  freeCanvasPage,
  toolsCanvasPage,
  adminCanvasRoute,
  memberMigration,
  offlineMigration,
  guardMigration,
  immutableMigration,
  invitationRecipientMigration,
  packageMigration,
  camiPackageMigration,
  rewardBodyMigration,
  packageRoute,
  packageAssignmentRoute,
  invitationPanel,
  packageDialog,
  packageManager,
  packageAutomationMigration,
  packageAutomationRoute,
  trialPlanAdminRoute,
  retiredTrialActivation,
  accountNotificationCenter,
  announcementPopup,
  adminReauth,
  verifyPasswordRoute,
] = await Promise.all([
  read("src/app/admin/page.tsx"),
  read("src/app/api/admin/users/route.ts"),
  read("src/app/api/admin/cami/route.ts"),
  read("src/app/api/cami/route.ts"),
  read("src/app/api/admin/invitations/rewards/route.ts"),
  read("src/app/api/admin/credits/route.ts"),
  read("src/app/api/admin/cash/route.ts"),
  read("src/app/api/admin/notifications/send/route.ts"),
  read("src/app/api/admin/offline-payments/route.ts"),
  read("src/app/api/admin/reconciliation/recharges/route.ts"),
  read("src/app/api/admin/users/lifecycle/route.ts"),
  read("src/app/free-canvas/page.tsx"),
  read("src/app/tools/canvas/page.tsx"),
  read("src/app/api/admin/canvas-prompt-presets/route.ts"),
  read("supabase/migrations/20260930221000_member_activation_cami_invitation_rewards.sql"),
  read("supabase/migrations/20260930225500_offline_payment_receipts.sql"),
  read("supabase/migrations/20260930232000_offline_payment_duplicate_membership_guard.sql"),
  read("supabase/migrations/20260930232500_offline_payment_receipt_immutability.sql"),
  read("supabase/migrations/20261001062000_invitation_recipient_gift_split.sql"),
  read("supabase/migrations/20261001063000_member_package_templates.sql"),
  read("supabase/migrations/20261001113000_cami_package_profile_snapshots.sql"),
  read("supabase/migrations/20261001114500_invitation_reward_custom_notification_body.sql"),
  read("src/app/api/admin/member-packages/route.ts"),
  read("src/app/api/admin/member-packages/assign/route.ts"),
  read("src/components/admin/invitation-attribution-panel.tsx"),
  read("src/components/admin/member-package-assignment-dialog.tsx"),
  read("src/components/admin/member-package-template-manager.tsx"),
  read("supabase/migrations/20261001070000_invited_registration_package_toggle.sql"),
  read("src/app/api/admin/member-packages/automation/route.ts"),
  read("src/app/api/admin/trial-plans/route.ts"),
  read("src/app/api/trial-plans/activate/route.ts"),
  read("src/components/account-notification-center.tsx"),
  read("src/components/announcement-popup.tsx"),
  read("src/lib/admin-user-delete-reauth.ts"),
  read("src/app/api/auth/verify-password/route.ts"),
]);

const checks = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
}

check("admin business hubs", /tabs: \["users", "invitations", "benefit-packages", "trial-plans", "cami", "login-logs"\]/u.test(adminPage)
  && /tabs: \["credits", "offline-payments", "billing-audit", "payment"\]/u.test(adminPage)
  && /tabs: \["security", "guard-logs"\]/u.test(adminPage));
check("offline payment workspace is contextual", /data-testid="offline-payments-workspace"/u.test(adminPage)
  && /补录线下收款并激活/u.test(adminPage)
  && /只保存交易流水号和付款方脱敏尾号/u.test(adminPage));
check("generic profile API cannot activate", /MEMBER_ACTIVATION_REQUIRES_EVIDENCE/u.test(usersRoute)
  && /线下收款.*会员卡/u.test(usersRoute));
check("offline API is admin-only and idempotent", /withAdminAuth/u.test(offlineRoute)
  && /Idempotency-Key/u.test(adminPage)
  && /record_offline_payment_and_activate_member_atomic/u.test(offlineRoute)
  && /void_offline_payment_receipt_atomic/u.test(offlineRoute));
check("active member duplicate blocked", /target\.member_status === "active"/u.test(offlineRoute)
  && /offline_payment_confirmed_tuition_user_unique/u.test(guardMigration));
check("financial evidence immutable", /OFFLINE_PAYMENT_RECEIPT_IMMUTABLE/u.test(immutableMigration)
  && /OFFLINE_PAYMENT_RECEIPT_DELETE_FORBIDDEN/u.test(immutableMigration)
  && /REVOKE INSERT, UPDATE, DELETE/u.test(immutableMigration));
check("offline payment activates atomically without reward", /set_member_activation_state_atomic/u.test(offlineMigration)
  && !/send_invitation_reward_atomic/u.test(offlineMigration)
  && !/enqueue_user_notification_once/u.test(offlineMigration));
check("three invitation recipient stages", /reward_stage IN \('registration', 'invitee_welcome', 'activation'\)/u.test(invitationRecipientMigration)
  && /\(NEW\.id, 'registration'/u.test(memberMigration)
  && /'invitee_welcome', NEW\.invitee_id/u.test(invitationRecipientMigration)
  && /'activation', NEW\.inviter_id/u.test(invitationRecipientMigration)
  && /v_expected_recipient := CASE WHEN v_stage = 'invitee_welcome' THEN v_record\.invitee_id ELSE v_record\.inviter_id END/u.test(invitationRecipientMigration)
  && /save_invitation_reward_decision_atomic/u.test(rewardRoute)
  && /send_invitation_reward_atomic/u.test(rewardRoute));
check("member package assignment is atomic and recipient safe", /CREATE OR REPLACE FUNCTION public\.assign_member_package_atomic/u.test(packageMigration)
  && /set_member_permissions_atomic/u.test(packageMigration)
  && /set_member_activation_state_atomic/u.test(packageMigration)
  && /apply_wallet_operation_atomic/u.test(packageMigration)
  && /enqueue_user_notification_once/u.test(packageMigration)
  && /v_record\.invitee_id::text <> p_user_id/u.test(packageMigration)
  && /invitationRecordId: recordId \|\| null/u.test(packageDialog)
  && /assign_member_package_atomic/u.test(packageAssignmentRoute));
check("package templates are versioned and fail closed", /member_permission_resources/u.test(packageMigration)
  && /is_selectable/u.test(packageMigration)
  && /create_member_package_profile_version_atomic/u.test(packageRoute)
  && /newResourcesDefaultClosed: true/u.test(packageRoute)
  && /新增能力默认关闭/u.test(packageManager)
  && /保存为新版本/u.test(packageManager));
check("administrator can create and manually assign custom packages", /custom_\$\{crypto\.randomUUID/u.test(packageManager)
  && /data-testid="create-member-package-template"/u.test(packageManager)
  && /创建自定义套餐/u.test(packageManager)
  && /赠送积分/u.test(packageManager)
  && /赠送现金（元）/u.test(packageManager)
  && /模板只是起点/u.test(packageDialog)
  && /确认正式开通并通知/u.test(packageDialog));
check("gift benefits and trial catalog remain separate", /key: "benefit-packages", label: "权益与礼包"/u.test(adminPage)
  && /key: "trial-plans", label: "试用套餐"/u.test(adminPage)
  && /trial-plan-separation-note/u.test(adminPage)
  && /searchParams\.get\('id'\)/u.test(trialPlanAdminRoute)
  && /不发起支付/u.test(packageManager));
check("invited registration package uses one controllable switch", /automation_key = 'invited_registration_welcome'/u.test(packageAutomationMigration)
  && /profile_key text NOT NULL DEFAULT 'trial_member' CHECK \(profile_key = 'trial_member'\)/u.test(packageAutomationMigration)
  && /CREATE TRIGGER zz_invitation_records_auto_welcome_package/u.test(packageAutomationMigration)
  && /assign_member_package_atomic/u.test(packageAutomationMigration)
  && /auto-invited-welcome:/u.test(packageAutomationMigration)
  && /formalAndVipRemainManual: true/u.test(packageAutomationRoute)
  && /inviterRewardsRemainManual: true/u.test(packageAutomationRoute)
  && /data-testid="toggle-invited-registration-package"/u.test(packageManager)
  && /只有这一枚开关/u.test(packageManager)
  && /新人体验包由一枚开关决定/u.test(invitationPanel));
check("invited registration automation remains fail closed", /PACKAGE_AUTOMATION_PERMISSION_SNAPSHOT_MISSING/u.test(packageAutomationMigration)
  && /status text NOT NULL CHECK \(status IN \('sent', 'failed'\)\)/u.test(packageAutomationMigration)
  && /failuresRemainManuallyAssignable: true/u.test(packageAutomationRoute)
  && /futureInvitedRegistrationsOnly: true/u.test(packageAutomationRoute)
  && /新人体验包模板不可用，自动派发已保持关闭/u.test(packageAutomationRoute));
check("invitation UI separates newcomer and inviter actions", /给新人选套餐/u.test(invitationPanel)
  && /发给邀请人/u.test(invitationPanel)
  && /正式会员奖励/u.test(invitationPanel)
  && /member-package-assign/u.test(packageDialog));
check("invitation rewards have two editable live templates", /id: "concise", label: "简洁到账"/u.test(invitationPanel)
  && /id: "thanks", label: "感谢邀请"/u.test(invitationPanel)
  && /invitation-reward-template-\$\{template\.id\}/u.test(invitationPanel)
  && /invitation-reward-message-template/u.test(invitationPanel)
  && /invitation-reward-message-preview/u.test(invitationPanel)
  && /\{\{积分\}\}/u.test(invitationPanel)
  && /\{\{现金\}\}/u.test(invitationPanel)
  && /WHEN nullif\(btrim\(v_grant\.note\)/u.test(rewardBodyMigration));
check("permission quick profiles are limited to three business packages", /MEMBER_PERMISSION_QUICK_PROFILE_KEYS = \["trial_member", "formal_member", "super_vip"\]/u.test(adminPage)
  && /体验包/u.test(adminPage)
  && /正式会员/u.test(adminPage)
  && /超级 VIP/u.test(adminPage)
  && /member-permission-profile-\$\{profile\.key\}/u.test(adminPage));
check("activation paths distinguish direct package trial and card redemption", /member-activation-paths/u.test(adminPage)
  && /member-package-activation-rules/u.test(packageDialog)
  && /体验包仅进入试用/u.test(packageDialog)
  && /激活卡需学员兑换后才激活/u.test(adminPage));
check("legacy trial self activation is retired", /TRIAL_SELF_ACTIVATION_RETIRED/u.test(retiredTrialActivation)
  && !/\.from\(["']users["']\)/u.test(retiredTrialActivation));
check("account and announcement notifications share one visible queue", /toastItem && !dialogOpen && !currentAppDialogOwner\(\)/u.test(accountNotificationCenter)
  && /onlineToastAnnouncement && !readerOpen && !currentAppDialogOwner\(\)/u.test(announcementPopup)
  && /APP_DIALOG_CLAIMED_EVENT/u.test(accountNotificationCenter)
  && /APP_DIALOG_RELEASED_EVENT/u.test(accountNotificationCenter)
  && /refreshDialogQueueState\(\(revision\) => revision \+ 1\)/u.test(accountNotificationCenter)
  && /APP_DIALOG_CLAIMED_EVENT/u.test(announcementPopup)
  && /APP_DIALOG_RELEASED_EVENT/u.test(announcementPopup)
  && /refreshDialogQueueState\(\(revision\) => revision \+ 1\)/u.test(announcementPopup));
check("card assignment and redemption atomic", /assign_cami_to_user_atomic/u.test(camiRoute)
  && /redeem_cami_membership_atomic/u.test(userCamiRoute)
  && /profileKey/u.test(camiRoute)
  && /feature_navigation_keys/u.test(camiRoute)
  && /set_member_permissions_atomic/u.test(camiPackageMigration)
  && /set_member_activation_state_atomic/u.test(camiPackageMigration)
  && /member_package_assignments/u.test(camiPackageMigration)
  && /CAMI_ASSIGNMENT_PENDING_EXISTS/u.test(camiPackageMigration));
check("card push requires reauthentication and explicit confirmation", /ADMIN_CAMI_ASSIGNMENT_REAUTH_HEADER/u.test(camiRoute)
  && /verifyAdminCamiAssignmentReauth/u.test(camiRoute)
  && /admin_cami_assignment/u.test(adminReauth)
  && /admin_cami_assignment/u.test(verifyPasswordRoute)
  && /cami-assignment-admin-password/u.test(adminPage)
  && /cami-assignment-confirmed/u.test(adminPage)
  && /cami-assignment-submit/u.test(adminPage));
check("card push shows member context and one-click redemption", /cami-assignment-member-context/u.test(adminPage)
  && /cami-trial-delivery-state/u.test(adminPage)
  && /confirmedOfflinePayment/u.test(adminPage)
  && /pendingCards/u.test(adminPage)
  && /notification-cami-redeem-link/u.test(accountNotificationCenter)
  && /去个人中心一键兑换/u.test(accountNotificationCenter));
check("wallet notifications require explicit opt-in", /notifyUser === true/u.test(creditRoute)
  && /notifyUser === true/u.test(cashRoute)
  && /默认不通知/u.test(adminPage));
check("generic notification cannot forge protected gifts", /cami/u.test(notificationRoute)
  && /invitation_reward/u.test(notificationRoute));
check("reconciliation includes offline receipts", /offline_payment_receipts/u.test(reconciliationRoute)
  && /offlineConfirmedAmount/u.test(reconciliationRoute)
  && /线下收款凭证ID/u.test(reconciliationRoute));
check("member lifecycle includes finance evidence", /offline_payment/u.test(lifecycleRoute)
  && /offlinePaymentCount/u.test(lifecycleRoute));
check("main free canvas routes retired", /redirect\("\/storyboard-workbench\?legacy=/u.test(freeCanvasPage)
  && /redirect\("\/storyboard-workbench\?legacy=/u.test(toolsCanvasPage)
  && /status: 410/u.test(adminCanvasRoute));
check("admin navigation has no canvas prompt tab", !/key: "canvas-prompts"/u.test(adminPage)
  && !/label: "画布提示词"/u.test(adminPage));

const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  assertionCount: checks.length,
  checks,
  excluded: ["commerce", "manju-workbench"],
  productionWrites: 0,
};
const evidenceDir = path.resolve(".codex-evidence", "member-activation-workflow");
await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(path.join(evidenceDir, "admin-contract.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
