#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.resolve(root, relative), "utf8").replace(/^\uFEFF/u, "");

const popupRoute = read("src/app/api/popup-pushes/route.ts");
const popupDomain = read("src/lib/popup-push-domain.ts");
const trialDialog = read("src/components/trial-plan-dialog.tsx");
const announcementsRoute = read("src/app/api/announcements/route.ts");
const notificationsRoute = read("src/app/api/notifications/route.ts");
const adminPanel = read("src/components/admin/announcement-admin-panel.tsx");
const queue = read("src/lib/client-dialog-queue.ts");
const announcementPopup = read("src/components/announcement-popup.tsx");
const accountCenter = read("src/components/account-notification-center.tsx");
const manualNotificationRoute = read("src/app/api/admin/notifications/send/route.ts");

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
}

check(
  "popup:stable-response-envelope",
  popupRoute.includes("{ success: true, popups }")
    && popupRoute.includes("{ success: false, popups: [], error:"),
  "configured, empty and failure responses expose an explicit success state",
);
check(
  "popup:dismiss-behavior-normalized",
  popupRoute.includes("normalizePopupDismissBehavior(p.dismiss_behavior)")
    && ["session", "persistent", "always"].every((value) => popupDomain.includes(`\"${value}\"`)),
  "legacy free-form values are reduced to the three client behaviors",
);
check(
  "trial:configuration-is-authoritative",
  trialDialog.includes("response.ok && payload.success === true")
    && trialDialog.includes('setResolution("empty")')
    && trialDialog.includes('resolution === "loading"')
    && trialDialog.includes('resolution === "empty"'),
  "the dialog waits for configuration and closes when no eligible popup exists",
);
check(
  "trial:dismiss-rules",
  trialDialog.includes("trial_popup_persistent_dismissals_v1")
    && trialDialog.includes('config.dismiss_behavior === "persistent"')
    && trialDialog.includes('config.dismiss_behavior === "always"')
    && trialDialog.includes('sessionStorage.removeItem("trial_dialog_dismissed")'),
  "session, persistent dismissal and every-entry behavior have executable paths",
);
check(
  "announcement:capability-step-up",
  announcementsRoute.includes('authorizeAdminCapability(request, "announcements.manage"')
    && announcementsRoute.includes("requireStepUp: true"),
  "announcement writes use the centralized capability and step-up gate",
);
check(
  "announcement:business-audit",
  announcementsRoute.includes("appendAdminGovernanceAudit")
    && announcementsRoute.includes('result: "success"')
    && announcementsRoute.includes('"failure"')
    && announcementsRoute.includes('action: `announcement_${action}`')
    && ["ANNOUNCEMENT_CREATE_SUCCEEDED", "ANNOUNCEMENT_UPDATE_SUCCEEDED", "ANNOUNCEMENT_DELETE_SUCCEEDED"].every((value) => announcementsRoute.includes(value)),
  "announcement writes append success and failure governance results",
);
check(
  "video-notification:capability-step-up",
  notificationsRoute.includes('authorizeAdminCapability(request, "announcements.manage"')
    && notificationsRoute.includes("requireStepUp: true"),
  "video banner writes use the announcements capability and step-up gate",
);
check(
  "video-notification:business-audit",
  notificationsRoute.includes('action: "video_notification_save"')
    && notificationsRoute.includes('"NOTIFICATION_SAVE_SUCCEEDED"')
    && notificationsRoute.includes('"NOTIFICATION_SAVE_FAILED"'),
  "video banner save outcomes are audited without storing message content",
);
check(
  "video-notification:private-raw-and-visible-failure",
  notificationsRoute.includes('if (raw)')
    && notificationsRoute.includes('authorizeAdminCapability(request, "announcements.manage"')
    && notificationsRoute.includes('{ success: false, notifications: [], error: "视频通知暂时无法读取" }')
    && notificationsRoute.includes('{ status: 503 }'),
  "disabled drafts require administrator permission and read failures cannot masquerade as an empty list",
);
check(
  "manual-account-notification:step-up-idempotency-audit",
  manualNotificationRoute.includes('authorizeAdminCapability(request, "announcements.manage"')
    && manualNotificationRoute.includes("requireStepUp: true")
    && manualNotificationRoute.includes("enqueueUserNotificationOnce")
    && manualNotificationRoute.includes("appendAdminGovernanceAudit")
    && manualNotificationRoute.includes("MANUAL_NOTIFICATION_ENQUEUED"),
  "manual account notifications require the capability, step-up, idempotent enqueue and durable business-result audit",
);
check(
  "delivery-status:unavailable-not-zero",
  adminPanel.includes('availability: "ready" | "unavailable"')
    && adminPanel.includes("unavailableDeliveryStatus")
    && adminPanel.includes("投递统计不可用：")
    && adminPanel.includes('deliveryStatsUnavailable ? "--"'),
  "status fetch failures are surfaced as unavailable instead of synthetic zeroes",
);
check(
  "dialog-queue:priority-order",
  [
    'security: 0',
    '"forced-logout": 0',
    "account: 1",
    "announcementUrgent: 2",
    "announcement: 3",
    "trial: 4",
  ].every((fragment) => queue.includes(fragment))
    && queue.includes("priority >= previousPriority")
    && queue.includes("return false"),
  "P0 through P4 ordering is explicit and lower-priority claims are rejected",
);
check(
  "dialog-queue:callers-honor-rejection",
  accountCenter.includes('if (!claimAppDialog("account"))')
    && announcementPopup.includes('if (!claimAppDialog("announcement", priority))')
    && announcementPopup.includes("APP_DIALOG_PRIORITY.announcementUrgent"),
  "account and announcement surfaces defer when a higher-priority dialog owns the surface",
);

const failed = checks.filter((item) => !item.passed);
const report = {
  passed: failed.length === 0,
  summary: { passed: checks.length - failed.length, total: checks.length },
  failed,
  checks,
  databaseWrites: 0,
  productionWrites: 0,
};
console.log(JSON.stringify(report, null, 2));
assert.equal(failed.length, 0, "NOTIFICATION_GOVERNANCE_CONTRACT_FAILED");
