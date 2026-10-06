import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const [themes, switcher, popup, landing, darkNight, softWhite, lattice] = await Promise.all([
  read("src/lib/themes.ts"),
  read("src/components/user-theme-switcher.tsx"),
  read("src/components/announcement-popup.tsx"),
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
assert.match(themes, /id: "crystal-aurora", label: "暗夜黑"/);
assert.match(themes, /id: "lattice", label: "深空晶"/);
assert.match(themes, /id: "soft-white", label: "柔光白"/);
assert.match(themes, /墨绿石墨底、橙金重点与薄荷状态光/);
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
assert.match(popup, /标记已阅读/);
assert.match(popup, /关闭不会记为已读/);
assert.match(popup, /width: "min\(1120px, calc\(100vw - 96px\)\)"/);
assert.match(popup, /height: "min\(680px, calc\(100vh - 120px\)\)"/);
assert.match(popup, /selectIndex\(selectedIndex \+ 1\)/);
assert.match(popup, /selectIndex\(selectedIndex - 1\)/);
assert.doesNotMatch(popup, /data-testid="announcement-latest"/);

assert.match(landing, /themeId === "soft-white"/);
assert.match(landing, /themeId === "lattice"/);
assert.match(landing, /themeId === "crystal-aurora"/);
assert.match(darkNight, /暗夜黑 \/ crystal-aurora/);
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
    "session dismissal remains separate from account read state",
    "rectangular 1120x680 reader sizing",
    "theme display order lattice -> soft-white -> crystal-aurora",
    "stable internal key with renamed 暗夜黑 label",
    "three fixed Chinese themes without a separate mode switch",
    "graphite-forest dark palette and reduced-motion guard",
    "lattice and soft-white scope protection",
  ],
}, null, 2));
