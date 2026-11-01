import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ADMIN_THEME_OPTIONS,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  USER_APPEARANCE_PREFERENCE_TTL_MS,
  USER_THEME_OPTIONS,
  normalizeTheme,
  normalizeThemeModePreference,
  resolveRenderedTheme,
  resolveThemeModeForTheme,
} from "../src/lib/themes";
import { evaluateUserAppearanceLease } from "../src/lib/user-appearance-preference-contract";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relativePath: string) => readFileSync(`${projectRoot}/${relativePath}`, "utf8");

const expectedThemes = [
  ["lattice", "深空晶"],
  ["soft-white", "柔光白"],
  ["crystal-aurora", "黑曜霓彩"],
] as const;

assert.deepEqual(
  ADMIN_THEME_OPTIONS.map(({ id, name }) => [id, name]),
  expectedThemes,
  "后台主题必须保留稳定 key，并使用三个三字中文显示名",
);
assert.deepEqual(
  USER_THEME_OPTIONS.map(({ id, label }) => [id, label]),
  expectedThemes,
  "用户主题与后台主题必须共享同一 key/名称合同",
);
for (const [, displayName] of expectedThemes) {
  assert.match(displayName, /^\p{Script=Han}{3,4}$/u, `${displayName} 必须是稳定的中文产品名称`);
}

assert.equal(DEFAULT_THEME, "soft-white", "未配置平台主题时必须回退到柔光白");
assert.equal(DEFAULT_MODE_PREFERENCE, "light", "未配置平台模式时必须保持柔光白浅色");
assert.equal(USER_APPEARANCE_PREFERENCE_TTL_MS, 7 * 24 * 60 * 60 * 1000, "用户外观租约必须恰好七天");
assert.equal(normalizeTheme("stellar-blue"), "soft-white", "已移除的极光蓝必须回退到柔光白");
assert.equal(normalizeThemeModePreference("system"), "system");
assert.equal(normalizeThemeModePreference("light"), "light", "显式浅色发布值必须稳定保留");
assert.equal(normalizeThemeModePreference("dark"), "dark", "显式深色发布值必须稳定保留");

assert.equal(resolveThemeModeForTheme("lattice", "system", false), "dark");
assert.equal(resolveThemeModeForTheme("lattice", "system", true), "dark");
assert.equal(resolveThemeModeForTheme("soft-white", "system", true), "light", "柔光白不能被系统夜间切成深色");
assert.equal(resolveThemeModeForTheme("crystal-aurora", "system", true), "dark", "黑曜霓彩必须保持黑曜底座与青绿到曜蓝的固定深色视觉");
assert.equal(resolveRenderedTheme("lattice", "system", "light"), "lattice", "深空晶选择必须始终渲染深空晶");
assert.equal(resolveRenderedTheme("lattice", "system", "dark"), "lattice", "深空晶选择必须始终渲染深空晶");
assert.equal(resolveRenderedTheme("crystal-aurora", "system", "dark"), "crystal-aurora");
assert.equal(resolveRenderedTheme("crystal-aurora", "system", "light"), "crystal-aurora", "黑曜霓彩选择必须始终渲染黑曜霓彩");
assert.equal(resolveRenderedTheme("soft-white", "system", "dark"), "soft-white", "柔光白必须始终保持白色");

const leaseNow = new Date("2026-09-29T08:00:00.000Z");
const activeLease = {
  user_id: "user-1",
  theme_key: "lattice",
  mode_preference: "dark",
  ip_hash: "a".repeat(64),
  expires_at: "2026-10-06T08:00:00.000Z",
  updated_at: "2026-09-29T08:00:00.000Z",
};
assert.deepEqual(evaluateUserAppearanceLease(activeLease, "a".repeat(64), leaseNow), {
  status: "active",
  theme: "lattice",
  modePreference: "dark",
  expiresAt: "2026-10-06T08:00:00.000Z",
});
assert.equal(
  evaluateUserAppearanceLease({ ...activeLease, expires_at: leaseNow.toISOString() }, "a".repeat(64), leaseNow).status,
  "expired",
  "到期边界必须立即恢复平台默认",
);
assert.equal(
  evaluateUserAppearanceLease(activeLease, "b".repeat(64), leaseNow).status,
  "ip_changed",
  "IP 指纹变化必须立即恢复平台默认",
);
assert.equal(
  evaluateUserAppearanceLease({ ...activeLease, theme_key: "retired-theme" }, "a".repeat(64), leaseNow).status,
  "none",
  "未知稳定 key 不得被恢复",
);

const preferenceStore = read("src/lib/server/user-appearance-preference.ts");
assert.match(preferenceStore, /createHmac\("sha256", secret\)/, "IP 必须使用带服务端密钥的 HMAC 指纹");
assert.match(preferenceStore, /appearance-ip:v1:/, "IP 指纹必须有独立用途域");
assert.match(preferenceStore, /expiresAt = new Date\(now\.getTime\(\) \+ USER_APPEARANCE_PREFERENCE_TTL_MS\)/);
assert.match(preferenceStore, /evaluateUserAppearanceLease\(row, fingerprintAppearanceRequestIP\(request\), now\)/, "读取时必须用当前 IP 指纹评估租约");
assert.doesNotMatch(preferenceStore, /(?:ip_address|plaintext_ip)\s*:/iu, "持久化对象不得包含明文 IP 字段");

const authMe = read("src/app/api/auth/me/route.ts");
assert.match(authMe, /readUserAppearancePreference\(user\.id, request as unknown as Request\)/);
assert.match(authMe, /themePreferenceStatus: appearance\.status/);
assert.match(authMe, /saveUserAppearancePreference\(/);
assert.match(authMe, /theme_preference,[\s\S]*theme_mode_preference/, "保存时必须把主题与模式作为同一合同处理");
assert.doesNotMatch(authMe, /ip_hash|ipHash|clientIP/, "用户接口不得返回或处理可见 IP/哈希字段");

for (const loginRoute of ["src/app/api/auth/login/route.ts", "src/app/api/auth/login-email/route.ts"]) {
  const source = read(loginRoute);
  assert.match(source, /readUserAppearancePreference\(user\.id, request as unknown as Request\)/, `${loginRoute} 必须只返回已验证租约`);
  assert.match(source, /themeModePreference: appearance\.preference\?\.modePreference \|\| null/);
  assert.doesNotMatch(source, /themePreference: user\.theme_preference/, `${loginRoute} 不得泄露未校验的历史主题列`);
}

const settingsRoute = read("src/app/api/settings/route.ts");
assert.match(settingsRoute, /theme: storedTheme \? normalizeTheme\(storedTheme\) : DEFAULT_THEME/);
assert.match(settingsRoute, /theme_mode: normalizeThemeModePreference\(storedMode\) \|\| DEFAULT_MODE_PREFERENCE/);

const appContext = read("src/contexts/app-context.tsx");
assert.match(appContext, /meData\.user\?\.themePreference/);
assert.match(appContext, /meData\.user\?\.themeModePreference/);
assert.match(appContext, /safeRemove\(STORAGE_KEYS\.USER_THEME_PREFERENCE\)/, "无有效服务端租约时必须清理本机用户主题");
assert.match(appContext, /safeRemove\(STORAGE_KEYS\.USER_THEME_MODE_PREFERENCE\)/, "无有效服务端租约时必须清理本机用户模式");
assert.match(appContext, /theme_preference: theme,[\s\S]*theme_mode_preference: modePreference/, "用户主题和模式必须一起保存");
assert.match(appContext, /invalidateClientBootstrapAppearance\(\)/, "平台默认改变后必须失效外观缓存");

const layout = read("src/app/layout.tsx");
assert.match(layout, /localStorage\.getItem\('platform_theme'\)/);
assert.match(layout, /localStorage\.getItem\('platform_theme_mode'\)/);
assert.match(layout, /await readPlatformAppearance\(\)/, "服务端首屏必须读取当前平台默认主题");
assert.match(layout, /export const dynamic = "force-dynamic"/, "平台默认主题不能被冻结在构建产物中");
assert.match(layout, /data-theme-selection=\{rootTheme\}/, "稳定主题选择与实际渲染主题必须分离");
assert.match(layout, /data-platform-theme-authoritative=\{platformAppearance\.authoritative/, "首屏必须标明平台默认值是否来自当前服务端");
assert.match(layout, /localStorage\.getItem\('user_theme_preference'\)/, "已验证个人偏好应参与 hydration 前防闪烁预览");
assert.match(layout, /hasValidatedUserAppearance = hasAuthSession[\s\S]*cachedUserTheme[\s\S]*cachedUserMode/, "个人预览必须同时受认证会话、主题和模式约束");
assert.match(layout, /selectedTheme = hasValidatedUserAppearance \? cachedUserTheme : platformTheme/, "无完整个人偏好时必须回到平台默认");
assert.match(layout, /lightThemes\.indexOf\(selectedTheme\) >= 0 \? 'light' : 'dark'/, "三主题必须使用各自固定明暗模式");
assert.match(layout, /renderedTheme = selectedTheme/, "主题选择必须与主页和登录实际渲染一一对应");

const platformAppearance = read("src/lib/server/platform-appearance.ts");
assert.match(platformAppearance, /PLATFORM_APPEARANCE_SETTING_KEYS/, "服务端首屏和公共外观接口必须共享同一字段白名单");
assert.match(platformAppearance, /normalizeTheme\(settings\.get\("theme"\)\)/);
assert.match(platformAppearance, /source: "safe_default"[\s\S]*authoritative: false/, "平台设置不可用时必须显式进入柔光白安全兜底状态");

const adminPage = read("src/app/admin/page.tsx");
assert.match(adminPage, /const s = \{[\s\S]*theme,[\s\S]*theme_mode: normalizePlatformThemeMode\(theme, sourceSettings\.theme_mode\)/, "后台保存载荷必须同时规范化平台默认主题和模式");
assert.match(adminPage, /JSON\.stringify\(\{ theme, theme_mode: themeMode \}\)/, "后台必须把平台主题和固定明暗模式放入同一发布请求");
assert.match(adminPage, /\/api\/settings\/appearance\?published_at=/, "后台发布后必须从公共外观接口读回验证");
assert.match(adminPage, /STORAGE_KEYS\.PLATFORM_THEME/);
assert.match(adminPage, /STORAGE_KEYS\.PLATFORM_THEME_MODE/);
assert.doesNotMatch(adminPage, /THEME_MODE_OPTIONS|默认明暗模式/, "后台不得再次暴露明暗模式开关");

const userThemeSwitcher = read("src/components/user-theme-switcher.tsx");
assert.doesNotMatch(userThemeSwitcher, /明暗模式|data-theme-mode-option|setThemeModePreference/, "用户主题菜单不得暴露明暗模式开关");
assert.doesNotMatch(userThemeSwitcher, /极光蓝|stellar-blue/, "用户主题菜单不得保留极光蓝");
assert.match(userThemeSwitcher, /if \(!state\.auth\.isAuthenticated\) return null/, "主题选择入口必须只对已登录用户显示");

const migration = read("supabase/migrations/20260929150000_user_appearance_preferences.sql");
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.user_appearance_preferences/);
assert.match(migration, /ip_hash character varying\(64\) NOT NULL/);
assert.match(migration, /ALTER TABLE public\.user_appearance_preferences ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON TABLE public\.user_appearance_preferences FROM anon, authenticated/);
assert.match(migration, /GRANT ALL ON TABLE public\.user_appearance_preferences TO service_role/);
assert.doesNotMatch(migration, /(?:ip_address|plaintext_ip)\s+(?:text|character)/iu, "迁移不得增加明文 IP 列");

const rollback = read("supabase/rollbacks/20260929150000_user_appearance_preferences.rollback.sql");
assert.match(rollback, /ROLLBACK_BLOCKED_USER_APPEARANCE_PREFERENCES_EXIST/, "回滚不得静默删除用户偏好");

const localMigrationRunner = read("scripts/apply-user-appearance-preferences-local.mjs");
assert.match(localMigrationRunner, /CHOOSE_EXACTLY_ONE_OPERATION/);
assert.match(localMigrationRunner, /--confirm-local-appearance-only/);
assert.match(localMigrationRunner, /--confirm-empty-preference-rollback/);
assert.match(localMigrationRunner, /runtime\.ownerConnection\?\.host, "127\.0\.0\.1"/);
assert.match(localMigrationRunner, /runtime\.ownerConnection\?\.port\), 54322/);
assert.match(localMigrationRunner, /runtime\.ownerConnection\?\.database, "zimeiti_local"/);
assert.match(localMigrationRunner, /PLAINTEXT_IP_COLUMN_FORBIDDEN/);
assert.match(localMigrationRunner, /productionWrites: 0/);

const baseline = read("deploy/local/task-baseline.sql");
assert.match(baseline, /CREATE TABLE public\."user_appearance_preferences"/);
assert.match(baseline, /ALTER TABLE public\."user_appearance_preferences" ENABLE ROW LEVEL SECURITY/);

const contract = JSON.parse(read("deploy/policies/database-contract.v1.json")) as {
  contractVersion: string;
  tables: Array<{ name: string; columns: string[] }>;
};
assert.ok(
  contract.contractVersion >= "20260929150000",
  "database contract must include the appearance migration or a later compatible contract",
);
const preferenceContract = contract.tables.find(({ name }) => name === "user_appearance_preferences");
assert.deepEqual(
  preferenceContract?.columns,
  ["user_id", "theme_key", "mode_preference", "ip_hash", "expires_at", "created_at", "updated_at"],
);

console.log(JSON.stringify({
  status: "PASS",
  themes: expectedThemes.map(([key, name]) => ({ key, name })),
  platformModes: [DEFAULT_MODE_PREFERENCE],
  userPreferenceTtlDays: USER_APPEARANCE_PREFERENCE_TTL_MS / 86_400_000,
  ipStorage: "hmac-sha256-only",
}, null, 2));
