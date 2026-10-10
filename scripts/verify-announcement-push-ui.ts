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
const dialog = source("src/components/ui/dialog.tsx");
const dialogTheme = source("src/app/dialog-theme.css");

assert.match(popup, /const INBOX_ENDPOINT = "\/api\/announcements\/inbox"/);
assert.match(popup, /\/api\/announcements\/\$\{encodeURIComponent\(announcement\.id\)\}\/read/);
assert.match(popup, /JSON\.stringify\(\{ revision \}\)/);
assert.match(popup, /const POLL_INTERVAL_MS = 15_000/);
assert.match(popup, /window\.setInterval\(poll, POLL_INTERVAL_MS\)/);
assert.match(popup, /document\.addEventListener\("visibilitychange"/);
assert.match(popup, /window\.addEventListener\("focus"/);
assert.match(popup, /new BroadcastChannel\(BROADCAST_CHANNEL\)/);
assert.doesNotMatch(popup, /announcement_session_dismissals|SESSION_DISMISSALS_KEY|rememberDismissed/);
assert.match(popup, /data-testid="announcement-mark-read"/);
assert.match(popup, /知道了/);
assert.doesNotMatch(popup, /aria-label="稍后查看"/, "未读右下角通知不得提供绕过已读写入的关闭按钮");
assert.doesNotMatch(popup, /全部标为已读|markAllRead|markingAll/);
assert.match(popup, /w-\[min\(920px,calc\(100vw-80px\)\)\]/);
assert.doesNotMatch(popup, /announcement_delivery_state_v2|LocalDeliveryState/);
const closeReader = popup.match(
  /const closeReader = useCallback\(\(\) => \{([\s\S]*?)\r?\n  \}, \[[^\]\r\n]*\]\);/,
)?.[1] || "";
assert.ok(closeReader, "closeReader implementation should remain inspectable");
assert.doesNotMatch(closeReader, /require_ack|pendingAcknowledgement/, "关闭详情不得被强制确认拦截");
assert.match(closeReader, /queueToast\(preservedOnlineToast \|\| unreadForToast\)/, "关闭长文阅读器后未读公告必须进入共享右下角提醒队列");
assert.doesNotMatch(closeReader, /markRead|\/read/, "closing must not persist a read receipt");
assert.match(popup, /const acknowledgeToast = async[\s\S]*?await markRead\(announcement\)[\s\S]*?setActionError/u, "知道了必须等待账号级已读写入，失败时保留错误");
assert.match(popup, /if \(allowAutoOpen && backlogLoad && !readerOpenRef\.current\)[\s\S]*?openReader\(candidate\.id, \{ automatic: true \}\)/u, "登录时积压未读公告必须打开大窗");
assert.match(popup, /else if \(allowAutoOpen && newlyPushed\)[\s\S]*?queueToast\(newlyPushed\)/u, "在线新增公告必须进入共享小窗队列");
assert.match(popup, /currentAppToastOwner\(\) === "announcement"/u, "公告小窗必须持有唯一共享展示位");
assert.match(popup, /<Dialog open=\{readerOpen\}[\s\S]*?onOpenChange=\{\(open\) => \{ if \(!open\) closeReader\(\); \}\}/u, "Escape 和遮罩关闭必须统一走 closeReader");

const accountCenter = source("src/components/account-notification-center.tsx");
assert.match(accountCenter, /grid max-h-\[min\(640px,calc\(100vh-96px\)\)\][\s\S]*?grid-rows-\[auto_minmax\(0,1fr\)_auto\]/u, "账号长文详情必须限制桌面端高度并固定头尾层级");
assert.match(accountCenter, /platform-message-body min-h-0 overflow-y-auto overscroll-contain/u, "账号长文必须在正文区内滚动");
assert.match(accountCenter, /sessionStorage\.getItem\(DELIVERY_SESSION_KEY\)/u, "账号通知必须区分登录积压与在线新增");
assert.doesNotMatch(accountCenter, /sessionStorage\.setItem\([^\n]*(?:is_read|read_at)/u, "账号通知不得用会话存储伪造已读回执");
assert.match(accountCenter, /currentAppToastOwner\(\) === "account"/u, "账号小窗必须持有唯一共享展示位");

assert.match(layout, /import \{ AnnouncementPopup \} from "@\/components\/announcement-popup"/);
assert.match(layout, /<AnnouncementPopup \/>/);
assert.match(layout, /import "\.\/dialog-theme\.css"/);
assert.match(dialog, /<DialogPortal data-slot="dialog-portal">[\s\S]*?<DialogOverlay \/>/u, "公告和通知必须通过 Radix Portal 渲染到顶层");
assert.match(dialogTheme, /html\[data-theme="lattice"\][\s\S]*?--dialog-shell:[\s\S]*?--dialog-raised:/u, "深空晶必须有分层弹层表面");
assert.match(dialogTheme, /html\[data-theme="crystal-aurora"\][\s\S]*?--dialog-shell:[\s\S]*?--dialog-raised:/u, "黑曜霓彩必须有分层弹层表面");
assert.match(dialogTheme, /\.announcement-reader-body,[\s\S]*?\.platform-message-body[\s\S]*?background: var\(--dialog-body\)/u);
assert.match(dialogTheme, /\.announcement-reader-panel,[\s\S]*?\.platform-message-panel[\s\S]*?background: var\(--dialog-raised\)/u);
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
assert.match(admin, /未读公告会持续停留在右下角；关闭详情后仍返回提醒，只有点击“知道了”且账号回执保存成功后才消失/);
assert.match(admin, /<option value="all">全部有效账号<\/option>/);
assert.doesNotMatch(admin, /重复提醒间隔（小时）|最多自动展示次数|要求明确确认|所有访客与用户/);

console.log("announcement push UI verification passed");
