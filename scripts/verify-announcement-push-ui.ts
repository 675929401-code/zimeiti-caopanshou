import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function tsxFiles(directory: string): string[] {
  const absolute = join(root, directory);
  return readdirSync(absolute).flatMap((name) => {
    const path = join(absolute, name);
    if (statSync(path).isDirectory()) return tsxFiles(relative(root, path));
    return path.endsWith(".tsx") ? [relative(root, path)] : [];
  });
}

const popup = source("src/components/announcement-popup.tsx");
const admin = source("src/components/admin/announcement-admin-panel.tsx");
const layout = source("src/app/layout.tsx");
const home = source("src/app/page.tsx");
const sidebar = source("src/components/app-sidebar.tsx");

assert.match(popup, /const INBOX_ENDPOINT = "\/api\/announcements\/inbox"/);
assert.match(popup, /\/api\/announcements\/\$\{encodeURIComponent\(announcement\.id\)\}\/read/);
assert.match(popup, /JSON\.stringify\(\{ revision \}\)/);
assert.match(popup, /const POLL_INTERVAL_MS = 15_000/);
assert.match(popup, /window\.setInterval\(poll, POLL_INTERVAL_MS\)/);
assert.match(popup, /document\.addEventListener\("visibilitychange"/);
assert.match(popup, /window\.addEventListener\("focus"/);
assert.match(popup, /new BroadcastChannel\(BROADCAST_CHANNEL\)/);
assert.match(popup, /announcement_session_dismissals_v3/);
assert.match(popup, /sessionStorage\.removeItem\(SESSION_DISMISSALS_KEY\)/);
assert.match(popup, /data-testid="announcement-mark-read"/);
assert.match(popup, /标记已阅读/);
assert.doesNotMatch(popup, /全部标为已读|markAllRead|markingAll/);
assert.match(popup, /w-\[min\(1120px,calc\(100vw-96px\)\)\]/);
assert.doesNotMatch(popup, /announcement_delivery_state_v2|LocalDeliveryState/);
const closeReader = popup.match(
  /const closeReader = useCallback\(\(\) => \{([\s\S]*?)\r?\n  \}, \[[^\]\r\n]*\]\);/,
)?.[1] || "";
assert.ok(closeReader, "closeReader implementation should remain inspectable");
assert.match(closeReader, /announcement\.require_ack && !isRead\(announcement\)/, "required acknowledgements must still block closing");
assert.match(closeReader, /rememberDismissed\(deliveryKey\(announcement\)\)/, "closing may only dismiss unread announcements for the current session");
assert.doesNotMatch(closeReader, /markRead|\/read/, "closing must not persist a read receipt");

assert.match(layout, /import \{ AnnouncementPopup \} from "@\/components\/announcement-popup"/);
assert.match(layout, /<AnnouncementPopup \/>/);
assert.doesNotMatch(home, /AnnouncementPopup/);
assert.doesNotMatch(sidebar, /<AnnouncementPopup|import \{ AnnouncementPopup/);
assert.match(sidebar, /new Event\(accountNotificationUnread > 0 \? "open-account-notifications" : "open-announcements"\)/);
assert.match(sidebar, /new Event\("request-announcement-unread"\)/);

const popupMounts = tsxFiles("src")
  .map((path) => ({ path, contents: source(path) }))
  .filter(({ contents }) => contents.includes("<AnnouncementPopup"));
assert.deepEqual(popupMounts.map(({ path }) => path), ["src\\app\\layout.tsx"]);

assert.match(admin, /\/api\/admin\/announcements\/\$\{encodeURIComponent\(announcement\.id\)\}\/delivery-status/);
assert.match(admin, /\/api\/admin\/announcements\/\$\{encodeURIComponent\(item\.id\)\}\/push/);
assert.match(admin, /JSON\.stringify\(\{ expectedRevision: deliveryStatus\.revision \}\)/);
assert.match(admin, /当前推送版本/);
assert.match(admin, /最后推送/);
assert.match(admin, /目标用户/);
assert.match(admin, /已读率/);
assert.match(admin, /再次强推/);
assert.match(admin, /首次发布并推送/);
assert.match(admin, /所有公告均需点击“已阅读”；关闭仅在本次登录中收起，未读公告会在下次登录继续出现/);
assert.match(admin, /<option value="all">全部有效账号<\/option>/);
assert.doesNotMatch(admin, /重复提醒间隔（小时）|最多自动展示次数|要求明确确认|所有访客与用户/);

console.log("announcement push UI verification passed");
