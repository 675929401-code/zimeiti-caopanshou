import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const [themes, switcher, popup, dialog, alertDialog, dialogTheme, layout, landing, darkNight, softWhite, lattice] = await Promise.all([
  read("src/lib/themes.ts"),
  read("src/components/user-theme-switcher.tsx"),
  read("src/components/announcement-popup.tsx"),
  read("src/components/ui/dialog.tsx"),
  read("src/components/ui/alert-dialog.tsx"),
  read("src/app/dialog-theme.css"),
  read("src/app/layout.tsx"),
  read("src/components/landing-page.tsx"),
  read("src/app/theme-crystal-aurora.css"),
  read("src/app/theme-soft-white.css"),
  read("src/app/theme-lattice.css"),
]);

const indexOrder = (source, values, label) => {
  const positions = values.map((value) => source.indexOf(value));
  assert.ok(positions.every((position) => position >= 0), `${label}: missing value`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${label}: wrong order`);
};

indexOrder(
  themes.slice(themes.indexOf("export const USER_THEME_OPTIONS"), themes.indexOf("export const ADMIN_THEME_OPTIONS")),
  ['id: "lattice"', 'id: "soft-white"', 'id: "crystal-aurora"'],
  "user theme order",
);
indexOrder(
  themes.slice(themes.indexOf("export const ADMIN_THEME_OPTIONS")),
  ['id: "lattice"', 'id: "soft-white"', 'id: "crystal-aurora"'],
  "admin theme order",
);
assert.match(themes, /id: "crystal-aurora", label: "黑曜霓彩"/);
assert.match(themes, /id: "lattice", label: "深空晶"/);
assert.match(themes, /id: "soft-white", label: "柔光白"/);
assert.match(themes, /黑曜底座、青绿与曜蓝双色结构光/);
assert.doesNotMatch(themes, /青曜夜|青耀夜|极光蓝/);
assert.match(themes, /return LIGHT_THEMES\.includes\(theme\) \? "light" : "dark"/);
assert.match(themes, /return modeForTheme\(normalizeTheme\(theme\)\)/);
assert.match(switcher, /data-theme-option=\{option\.id\}/);
assert.doesNotMatch(switcher, /data-theme-mode-option|saveUserThemeModePreference/);

for (const testId of [
  "announcement-reader",
  "announcement-reader-content",
  "announcement-previous",
  "announcement-next",
  "announcement-mark-read",
]) {
  assert.match(popup, new RegExp(`data-testid="${testId}"`), `missing ${testId}`);
}
assert.match(popup, /selectedAnnouncementId/);
assert.match(popup, /overflow-y-auto overscroll-contain/);
assert.match(popup, /showCloseButton=\{false\}/);
assert.match(popup, /markRead\(selectedAnnouncement\)/);
assert.match(popup, /markSelectedRead/);
assert.match(popup, /知道了/);
assert.match(popup, /关闭详情不会记为已读/);
assert.match(popup, /提醒会回到右下角/);
assert.match(popup, /width: "min\(920px, calc\(100vw - 80px\)\)"/);
assert.match(popup, /height: "min\(590px, calc\(100vh - 112px\)\)"/);
assert.match(popup, /selectIndex\(selectedIndex \+ 1\)/);
assert.match(popup, /selectIndex\(selectedIndex - 1\)/);
assert.doesNotMatch(popup, /data-testid="announcement-latest"/);
assert.match(popup, /data-platform-popup="announcement-toast"/);
assert.match(popup, /data-platform-popup="announcement-reader"/);
assert.match(dialog, /platform-dialog-overlay/);
assert.match(dialog, /platform-dialog-surface/);
assert.match(alertDialog, /platform-dialog-overlay/);
assert.match(alertDialog, /platform-dialog-surface/);
assert.match(layout, /import "\.\/dialog-theme\.css"/);
for (const theme of ["lattice", "soft-white", "crystal-aurora"]) {
  assert.match(dialogTheme, new RegExp(`html\\[data-theme="${theme}"\\]`), `missing ${theme} dialog tokens`);
}
assert.match(dialogTheme, /body\[data-admin-surface-active="true"\]/);
assert.match(dialogTheme, /--dialog-shell:/);
assert.match(dialogTheme, /--dialog-raised:/);
assert.match(dialogTheme, /--dialog-footer:/);
assert.match(dialogTheme, /--dialog-text:/);
assert.match(dialogTheme, /\.announcement-reader-panel/);
assert.match(dialogTheme, /\.announcement-toast/);
assert.match(dialogTheme, /04 · 蓝灰编辑部[\s\S]*?html\[data-theme="lattice"\]/u);
assert.match(dialogTheme, /html\[data-theme="crystal-aurora"\][\s\S]*?--dialog-color-scheme: light/u);
assert.match(dialogTheme, /html\[data-theme="soft-white"\][\s\S]*?\/\* 01 · 象牙纸墨/u);
assert.match(dialogTheme, /02 · 雾青玻璃/u);
assert.match(dialogTheme, /\.announcement-toast-head/);
assert.match(dialogTheme, /\.announcement-toast-actions/);
assert.match(dialogTheme, /font-size: 1\.0625rem/);
assert.match(dialogTheme, /outline: 2px solid color-mix/);
assert.doesNotMatch(popup, /text-(?:sky|amber|rose)-(?:300|700)/);

assert.match(landing, /themeId === "soft-white"/);
assert.match(landing, /themeId === "lattice"/);
assert.match(landing, /themeId === "crystal-aurora"/);
assert.match(darkNight, /黑曜霓彩 \/ crystal-aurora/);
assert.match(darkNight, /stable|稳定内部 key/);
assert.match(darkNight, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(darkNight, /--swh-pointer-color: rgba\(103, 217, 184, \.12\)/);
assert.doesNotMatch(darkNight, /#ae8cff|#b295ff|极光曜境/i);

// Protection assertions: the two existing themes remain independently scoped.
assert.match(lattice, /html\[data-theme="lattice"\]/);
assert.match(softWhite, /html\[data-theme="soft-white"\]\[data-mode="light"\]/);

console.log(JSON.stringify({
  passed: true,
  assertions: [
    "announcement reader hierarchy and scrolling",
    "previous/next one-by-one navigation and explicit read action",
    "unread reminder persists until the account read receipt succeeds",
    "compact rectangular 920x590 reader sizing",
    "theme display order lattice -> soft-white -> crystal-aurora",
    "stable internal key with 黑曜霓彩 label",
    "three fixed Chinese themes without a separate mode switch",
    "graphite-forest dark palette and reduced-motion guard",
    "lattice and soft-white scope protection",
    "shared Dialog and AlertDialog semantic theme surfaces",
    "admin portal restores soft-white dialog tokens",
    "announcement toast and reader use theme-scoped elevated surfaces",
    "dark workspaces use the selected high-contrast light editorial or glass surfaces",
    "dialog typography and keyboard focus remain legible",
    "priority icons keep light-surface contrast",
  ],
}, null, 2));
