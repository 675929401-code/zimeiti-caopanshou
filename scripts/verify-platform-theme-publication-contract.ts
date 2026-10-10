import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  modeForTheme,
  normalizeThemeModePreference,
} from "../src/lib/themes";

const read = (path: string) => readFileSync(path, "utf8");
const appearance = read("src/lib/server/platform-appearance.ts");
const appearanceRoute = read("src/app/api/settings/appearance/route.ts");
const adminRoute = read("src/app/api/settings/admin/route.ts");
const adminPage = read("src/app/admin/page.tsx");
const cache = read("src/lib/client-bootstrap-cache.ts");
const context = read("src/contexts/app-context.tsx");
const themeInit = read("src/components/theme-init.tsx");
const publishScript = read("scripts/publish-soft-white-theme-local.mjs");
const governanceAuthority = read("src/lib/server/admin-governance-authority.ts");

assert.equal(DEFAULT_THEME, "soft-white");
assert.equal(DEFAULT_MODE_PREFERENCE, "light");
assert.equal(modeForTheme("soft-white"), "light");
assert.equal(normalizeThemeModePreference("light"), "light");

assert.match(appearance, /PLATFORM_APPEARANCE_SETTING_KEYS/u);
assert.match(appearance, /source: "safe_default"[\s\S]*authoritative: false/u);
assert.match(appearance, /source: "platform_settings"[\s\S]*authoritative: true/u);
assert.doesNotMatch(appearance, /readPublishedPlatformBranding/u);

assert.match(appearanceRoute, /dynamic = "force-dynamic"/u);
assert.match(appearanceRoute, /revalidate = 0/u);
assert.match(appearanceRoute, /no-store, max-age=0, must-revalidate/u);
assert.match(appearanceRoute, /readPublicPlatformAppearance/u);

assert.match(cache, /getClientBootstrapAppearance/u);
assert.match(cache, /fetch\("\/api\/settings\/appearance", \{ cache: "no-store"/u);
assert.match(cache, /invalidateClientBootstrapAppearance/u);
assert.match(context, /getClientBootstrapAppearance\(\{ force \}\)/u);
assert.match(context, /getClientBootstrapAppearance\(\{ force: true \}\)/u);
assert.match(context, /handleThemeUpdate[\s\S]{0,240}fetchTheme\(true\)/u);
assert.doesNotMatch(context, /invalidateClientBootstrapAppearance/u);
assert.doesNotMatch(context, /getClientBootstrapSettings/u);
assert.match(themeInit, /getClientBootstrapAppearance/u);
assert.doesNotMatch(themeInit, /invalidateClientBootstrapAppearance/u);

assert.match(adminRoute, /PLATFORM_SETTINGS_READBACK_MISMATCH/u);
assert.match(adminRoute, /select\("setting_key,setting_value,updated_at"\)/u);
assert.match(adminRoute, /settings,[\s\S]{0,80}publishedAt/u);
assert.match(adminRoute, /private, no-store, max-age=0, must-revalidate/u);

assert.match(governanceAuthority, /request\.cookies\.get\(ADMIN_STEP_UP_COOKIE\)\?\.value/u);
assert.match(governanceAuthority, /request\.headers\.get\("x-admin-step-up"\)/u);
assert.match(publishScript, /unlockResponse\.headers/u);
assert.match(publishScript, /getSetCookie/u);
assert.match(publishScript, /get\("set-cookie"\)/u);
assert.match(publishScript, /LOCAL_ADMIN_STEP_UP_COOKIE_REQUIRED/u);
assert.equal(
  publishScript.match(/"x-admin-step-up": stepUpToken/gu)?.length,
  2,
  "local publisher must forward the in-memory step-up credential to publish and revoke requests",
);
assert.doesNotMatch(publishScript, /console\.(?:log|error|warn)\([^\n]*stepUpToken/u);
assert.doesNotMatch(publishScript, /writeFile|appendFile|LOCAL_ADMIN_STEP_UP_PASSWORD\s*=/u);

assert.match(adminPage, /fetch\("\/api\/settings\/appearance", \{ headers: authHeaders, cache: "no-store" \}\)/u);
assert.match(adminPage, /useState<string \| null>\(null\)/u, "未读回权威配置前不得把安全兜底冒充已发布主题");
assert.match(adminPage, /if \(data\.authority\?\.authoritative === true\)[\s\S]*setPushedPlatformTheme/u);
assert.match(adminPage, /if \(!canManageBrandSettings\)[\s\S]*setUnlockDialogRequested\(true\)/u);
assert.match(adminPage, /"Idempotency-Key": crypto\.randomUUID\(\)/u);
assert.match(adminPage, /publicAppearance\.authority\?\.authoritative !== true/u);
assert.match(adminPage, /receiptTheme !== theme \|\| receiptMode !== themeMode/u);
assert.equal(
  adminPage.match(/invalidateClientBootstrapAppearance\(\);\s*window\.dispatchEvent\(new Event\("theme-updated"\)\);/gu)?.length,
  2,
  "主题发布的两条保存路径都必须先失效一次缓存再广播，监听器不得重复失效请求",
);
assert.match(adminPage, /“\$\{themeName\}”已发布并通过全站读回校验/u);
assert.match(adminPage, /后台始终保持柔光白；这里发布的是用户前台默认主题/u);
assert.match(adminPage, /发布直接写入运行配置并完成公共启动接口读回校验，不需要重新部署代码/u);

console.log(JSON.stringify({
  status: "PASS",
  defaultTheme: DEFAULT_THEME,
  publishedMode: DEFAULT_MODE_PREFERENCE,
  publicBootstrap: "/api/settings/appearance",
  databaseReads: 0,
  databaseWrites: 0,
  deploymentWrites: 0,
}, null, 2));
