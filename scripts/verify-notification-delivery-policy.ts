import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const account = readFileSync("src/components/account-notification-center.tsx", "utf8");
const announcement = readFileSync("src/components/announcement-popup.tsx", "utf8");

let checks = 0;
const match = (source: string, pattern: RegExp, message: string) => {
  assert.match(source, pattern, message);
  checks += 1;
};
const noMatch = (source: string, pattern: RegExp, message: string) => {
  assert.doesNotMatch(source, pattern, message);
  checks += 1;
};

for (const [name, source] of [["account", account], ["announcement", announcement]] as const) {
  match(source, /const sessionIdentity =/u, `${name}: SESSION_IDENTITY_REQUIRED`);
  match(source, /sessionStorage\.getItem\(DELIVERY_SESSION_KEY\)/u, `${name}: SESSION_STORAGE_READ_REQUIRED`);
  match(source, /sessionStorage\.setItem\(DELIVERY_SESSION_KEY/u, `${name}: SESSION_STORAGE_WRITE_REQUIRED`);
  match(source, /known(?:Ids|DeliveryKeys)/u, `${name}: KNOWN_DELIVERIES_REQUIRED`);
  match(source, /APP_DIALOG_CLAIMED_EVENT/u, `${name}: DIALOG_QUEUE_CLAIM_EVENT_REQUIRED`);
  match(source, /APP_DIALOG_RELEASED_EVENT/u, `${name}: DIALOG_QUEUE_RELEASE_EVENT_REQUIRED`);
  match(source, /currentAppDialogOwner\(\)/u, `${name}: DIALOG_QUEUE_OWNER_GUARD_REQUIRED`);
  match(source, /APP_TOAST_CLAIMED_EVENT/u, `${name}: TOAST_QUEUE_CLAIM_EVENT_REQUIRED`);
  match(source, /APP_TOAST_RELEASED_EVENT/u, `${name}: TOAST_QUEUE_RELEASE_EVENT_REQUIRED`);
  match(source, /currentAppToastOwner\(\)/u, `${name}: TOAST_QUEUE_OWNER_GUARD_REQUIRED`);
  match(source, /sessionStorage\.removeItem\(DELIVERY_SESSION_KEY\)/u, `${name}: EXPLICIT_LOGOUT_MUST_RESET_DELIVERY_SESSION`);
  match(source, /上一条/u, `${name}: PREVIOUS_NAVIGATION_REQUIRED`);
  match(source, /下一条/u, `${name}: NEXT_NAVIGATION_REQUIRED`);
}

match(account, /backlogLoad && unreadItems\.length > 0[\s\S]*?openDialog\(unreadItems\[0\]\.id\)/u, "account: BACKLOG_MUST_OPEN_READER");
match(account, /else if \(newlyArrived\)[\s\S]*?queueToast\(newlyArrived\.id\)/u, "account: ONLINE_DELIVERY_MUST_USE_TOAST");
match(account, /unreadItems\.length > 0 && !toastIdRef\.current[\s\S]*?queueToast\(unreadItems\[0\]\.id\)/u, "account: REFRESHED_UNREAD_MUST_KEEP_REMINDER");
match(account, /onClick=\{\(\) => openDialog\(toastItem\.id\)\}/u, "account: TOAST_DETAILS_MUST_KEEP_ID");
match(account, /const nextUnread = \[[\s\S]*?\.find\(\(item\) => !item\.is_read\)/u, "account: ACK_SUCCESS_MUST_ADVANCE_TO_UNREAD");
match(account, /receipt\?\.success !== true[\s\S]*?receipt\.status !== "read"[\s\S]*?receipt\.notificationId !== notification\.id/u, "account: ACK_MUST_VALIDATE_BUSINESS_RECEIPT");
const accountClose = account.slice(account.indexOf("const closeDialog"), account.indexOf("const headers"));
noMatch(accountClose, /markRead|method:\s*"PUT"/u, "account: CLOSE_MUST_NOT_MARK_READ");

match(announcement, /backlogLoad && !readerOpenRef\.current[\s\S]*?openReader\(candidate\.id, \{ automatic: true \}\)/u, "announcement: BACKLOG_MUST_OPEN_READER");
match(announcement, /else if \(allowAutoOpen && newlyPushed\)[\s\S]*?queueToast\(newlyPushed\)/u, "announcement: ONLINE_DELIVERY_MUST_USE_TOAST");
match(announcement, /!readerOpenRef\.current && !onlineToastKeyRef\.current[\s\S]*?queueToast\(items\.find/u, "announcement: REFRESHED_UNREAD_MUST_KEEP_REMINDER");
match(announcement, /onClick=\{\(\) => openReader\(onlineToastAnnouncement\.id\)\}/u, "announcement: TOAST_DETAILS_MUST_KEEP_ID");
match(announcement, /const nextUnread = \[[\s\S]*?\.find\(\(announcement\) => !isRead\(announcement\)\)/u, "announcement: ACK_SUCCESS_MUST_ADVANCE_TO_UNREAD");
match(announcement, /APP_DIALOG_PRIORITY\.announcementUrgent[\s\S]*?APP_DIALOG_PRIORITY\.announcement/u, "announcement: PRIORITY_POLICY_REQUIRED");
match(announcement, /receipt\?\.success !== true[\s\S]*?receipt\.announcementId !== announcement\.id[\s\S]*?receipt\.revision !== revision[\s\S]*?receipt\.status !== "read"/u, "announcement: ACK_MUST_VALIDATE_BUSINESS_RECEIPT");
const announcementClose = announcement.slice(announcement.indexOf("const closeReader"), announcement.indexOf("const markSelectedRead"));
noMatch(announcementClose, /markRead|\/read/u, "announcement: CLOSE_MUST_NOT_MARK_READ");

console.log(JSON.stringify({
  ok: true,
  checks,
  networkCalls: 0,
  businessWrites: 0,
  productionWrites: 0,
}, null, 2));
