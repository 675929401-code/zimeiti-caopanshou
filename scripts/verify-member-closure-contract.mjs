#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const checks = [];

function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}

const registrationRoute = read("src/app/api/auth/register/route.ts");
const registrationMigration = read("supabase/migrations/20260930130000_invited_registration_session_authority.sql");
const triggerCompatMigration = read("supabase/migrations/20260930132500_invited_registration_trigger_compat.sql");
const notificationMigration = read("supabase/migrations/20260930131500_wallet_notification_delivery.sql");
const accountNotifications = read("src/components/account-notification-center.tsx");
const announcementPopup = read("src/components/announcement-popup.tsx");
const dialogQueue = read("src/lib/client-dialog-queue.ts");
const creditsRoute = read("src/app/api/admin/credits/route.ts");
const cashRoute = read("src/app/api/admin/cash/route.ts");
const userNotificationsRoute = read("src/app/api/notifications/user/route.ts");
const adminUsersRoute = read("src/app/api/admin/users/route.ts");
const adminLoginLogsRoute = read("src/app/api/admin/login-logs/route.ts");
const profilePage = read("src/app/profile/page.tsx");
const appPage = read("src/app/page.tsx");

check("registration uses atomic invited RPC", registrationRoute.includes("register_invited_user_atomic"));
check("registration confirms authoritative session", registrationRoute.includes("issueUserAuthSession"));
check("registration audit does not copy invitation secret", !/details:[^\n]+invitationCode/u.test(registrationRoute));
check("registration keeps exact invitation attribution", registrationMigration.includes("invitation_code_snapshot"));
check("registration writes first session", registrationMigration.includes("user_auth_sessions"));
check(
  "registration is compatible with legacy session trigger",
  /IF NOT EXISTS \([\s\S]*?FROM public\.user_auth_sessions[\s\S]*?INSERT INTO public\.user_auth_sessions/u.test(triggerCompatMigration),
);
check("notification delivery has durable dedupe index", notificationMigration.includes("user_notifications_dedupe_key_unique"));
check("notification delivery RPC is server only", /REVOKE ALL ON FUNCTION public\.enqueue_user_notification_once[\s\S]*?FROM PUBLIC, anon, authenticated/u.test(notificationMigration));
check("credit gift enqueues notification", creditsRoute.includes("enqueueUserNotificationOnce"));
check("credit committed-pending outcome is explicit", creditsRoute.includes("committed_notification_pending"));
check("cash gift enqueues notification", cashRoute.includes("enqueueUserNotificationOnce"));
check("cash committed-pending outcome is explicit", cashRoute.includes("committed_notification_pending"));
check("user notification list has success contract", userNotificationsRoute.includes("success: true"));
check("user notification read is owner scoped", /eq\("user_id", userId\)[\s\S]*?eq\("is_read", false\)/u.test(userNotificationsRoute));
check("admin user timestamp stays ISO", adminUsersRoute.includes("lastActive: u.last_sign_in_at || ''"));
check("login today window uses Beijing day", adminLoginLogsRoute.includes("beijingCalendarDayWindowStart"));
check("profile supports direct notification tab", /tab === ["']notifications["']/u.test(profilePage));

check("offline unread opens full account dialog", /firstLoad && unread\.length > 0[\s\S]*?openDialog\(unread\[0\]\.id\)/u.test(accountNotifications));
check("online account push uses compact toast", /newlyArrived[\s\S]*?setToastId/u.test(accountNotifications));
check("account toast desktop proportion", accountNotifications.includes("min-h-[190px] w-[340px]"));
check("offline unread announcement opens full reader", /firstLoad[\s\S]*?openReader\(candidate\.id\)/u.test(announcementPopup));
check("online announcement push uses compact toast", /newlyPushed[\s\S]*?setOnlineToastKey/u.test(announcementPopup));
check("announcement toast desktop proportion", announcementPopup.includes("min-h-[190px] w-[340px]"));
check("full dialogs share one queue owner", dialogQueue.includes("data-app-dialog-owner"));
check("account participates in dialog queue", accountNotifications.includes("claimAppDialog(\"account\")"));
check("announcement participates in dialog queue", announcementPopup.includes("claimAppDialog(\"announcement\")"));
check("trial dialog waits behind unread messages", appPage.includes("deferredTrialDialogRef") && appPage.includes("claimAppDialog(\"trial\")"));

const evidence = {
  verifier: "member-closure-contract",
  checkedAt: new Date().toISOString(),
  passed: true,
  checkCount: checks.length,
  checks,
  databaseWrites: 0,
  productionWrites: 0,
  paidModelCalls: 0,
};
const evidenceDir = path.join(root, ".codex-evidence", "member-closure");
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, "contract.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
