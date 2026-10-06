import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const layout = readFileSync(`${projectRoot}/src/app/layout.tsx`, "utf8");
const themes = readFileSync(`${projectRoot}/src/lib/themes.ts`, "utf8");
const switcher = readFileSync(`${projectRoot}/src/components/user-theme-switcher.tsx`, "utf8");
const appContext = readFileSync(`${projectRoot}/src/contexts/app-context.tsx`, "utf8");

assert.match(
  layout,
  /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/,
  "平台默认主题来自当前数据库，根布局必须动态读取",
);
assert.doesNotMatch(
  layout,
  /export\s+const\s+revalidate\s*=\s*0/,
  "根布局不得用 revalidate=0 等价恢复全站动态化",
);

const cleanerStart = layout.indexOf("var artifactSelector=");
const cleanerEnd = layout.indexOf("})();`", cleanerStart);
assert.ok(cleanerStart >= 0 && cleanerEnd > cleanerStart, "必须保留独立的 Coze 沙箱兼容清理器");
const cleaner = layout.slice(cleanerStart, cleanerEnd);
const runtimeCleaner = cleaner.replaceAll("\\\\", "\\");
assert.doesNotThrow(
  () => new Script(`(function(){\n${runtimeCleaner}\n})();`),
  "Coze 沙箱内联脚本必须保持可解析",
);

for (const marker of ["page-editor-general-web", "coze-space", "coze-webapp"]) {
  assert.ok(cleaner.includes(marker), `沙箱清理器必须保留 ${marker} 兼容目标`);
}

assert.match(cleaner, /window\.self!==window\.top/, "清理器必须先确认页面处于 iframe 沙箱");
assert.match(cleaner, /hasCozeSignal/, "清理器必须识别已知 Coze 注入标记");
assert.match(cleaner, /hasCozeReferrer/, "清理器必须识别 Coze 沙箱来源");
assert.match(cleaner, /hasCozeHost/, "清理器必须兼容 Coze 沙箱自身域名");
assert.match(cleaner, /lf-cdn\.coze\.cn/, "清理器必须识别现有 Coze CDN 注入信号");

const sandboxGate = cleaner.indexOf("if(!inSandboxFrame||(!hasCozeSignal&&!hasCozeReferrer&&!hasCozeHost))return;");
const observerStart = cleaner.indexOf("new MutationObserver(function(mutations)");
assert.ok(sandboxGate >= 0 && observerStart > sandboxGate, "MutationObserver 只能在实际 Coze iframe 沙箱门禁后创建");

const observerEnd = cleaner.indexOf("mo.observe(document.documentElement", observerStart);
assert.ok(observerEnd > observerStart, "必须能隔离检查沙箱 MutationObserver 回调");
const observerCallback = cleaner.slice(observerStart, observerEnd);
assert.match(observerCallback, /mutation\.addedNodes\.forEach/, "childList 变更必须只遍历新增节点");
assert.match(observerCallback, /inspectAddedNode\(node\)/, "新增节点必须走局部检查");
assert.match(observerCallback, /inspectChangedNode\(mutation\.target\)/, "属性变更必须只检查 mutation.target");
assert.doesNotMatch(observerCallback, /document\.querySelectorAll/, "Observer 回调不得重新全量扫描 document");
assert.doesNotMatch(observerCallback, /inspectExisting\(/, "Observer 回调不得触发初始全量扫描");
assert.equal(
  cleaner.match(/inspectExisting\(\)/g)?.length,
  2,
  "全量 document 检查只能出现于函数定义和一次初始化调用",
);
assert.match(
  cleaner,
  /mo\.observe\(document\.documentElement,\{childList:true,subtree:true\}\)/,
  "documentElement 只能负责监听新增节点",
);
assert.doesNotMatch(
  cleaner,
  /mo\.observe\(document\.documentElement,\{[^}]*attributes:true/,
  "不得继续监听整棵 document 子树的属性变化",
);
assert.match(
  cleaner,
  /mo\.observe\(el,\{attributes:true,attributeFilter:\['style'\]\}\)/,
  "style 监听必须只登记 body 与应用根节点",
);

assert.match(cleaner, /scheduleIdleDisconnect\(\)/, "沙箱清理器必须支持安静窗口提前断开");
assert.match(cleaner, /idleTimer=window\.setTimeout\(stopObserver,500\)/, "DOMContentLoaded 后应尽快断开观察器");
assert.match(cleaner, /maxTimer=window\.setTimeout\(stopObserver,3000\)/, "观察器必须有短时硬上限");
assert.match(cleaner, /mo\.disconnect\(\)/, "清理器必须显式断开 MutationObserver");
assert.doesNotMatch(cleaner, /8000/, "不得恢复固定监听 8 秒的旧实现");

for (const importedContract of [
  "DEFAULT_MODE_PREFERENCE",
  "DEFAULT_THEME",
  "THEME_MODE_PREFERENCES",
  "VALID_THEMES",
  "resolveRenderedTheme",
  "resolveThemeModeForTheme",
]) {
  assert.match(layout, new RegExp(`\\b${importedContract}\\b`), `根布局必须使用主题注册表契约 ${importedContract}`);
}
assert.match(layout, /const platformAppearance = await readPlatformAppearance\(\)/, "根布局必须读取当前平台外观");
assert.match(layout, /const rootMode = resolveThemeModeForTheme\(rootTheme, rootModePreference, true\)/, "根主题必须通过主题感知模式解析器派生");
assert.match(layout, /const rootRenderedTheme = resolveRenderedTheme\(rootTheme, rootModePreference, rootMode\)/, "根节点必须区分选择主题和实际渲染主题");
assert.match(layout, /data-theme-selection=\{rootTheme\}/, "html 必须输出稳定选择主题 key");
assert.match(layout, /data-theme=\{rootRenderedTheme\}/, "html 必须输出实际渲染主题");
assert.match(layout, /data-mode-preference=\{rootModePreference\}/, "html 必须输出独立 data-mode-preference");
assert.match(layout, /data-mode=\{rootMode\}/, "html 必须继续输出 data-mode");
assert.match(layout, /const SERIALIZED_VALID_THEMES = JSON\.stringify\(VALID_THEMES\)/, "客户端主题白名单必须来自注册表");
assert.match(layout, /const SERIALIZED_MODE_PREFERENCES = JSON\.stringify\(THEME_MODE_PREFERENCES\)/, "客户端模式白名单必须来自注册表");
assert.match(layout, /localStorage\.getItem\('platform_theme'\)/, "hydration 前只能读取最近一次已验证的平台主题");
assert.match(layout, /localStorage\.getItem\('platform_theme_mode'\)/, "hydration 前只能读取最近一次已验证的平台模式");
assert.match(layout, /localStorage\.getItem\('user_theme_preference'\)/, "登录态已验证偏好必须参与首屏防闪烁");
assert.match(layout, /localStorage\.getItem\('user_theme_mode_preference'\)/, "登录态主题合同必须同时验证兼容模式值");
assert.match(layout, /lightThemes\.indexOf\(selectedTheme\) >= 0 \? 'light' : 'dark'/, "三套主题必须使用固定明暗模式");
assert.match(layout, /renderedTheme = selectedTheme/, "主页、登录和应用必须渲染同一个主题 key");
assert.match(layout, /setAttribute\('data-mode-preference', selectedModePreference\)/, "客户端必须在 hydration 前发布模式偏好");
assert.doesNotMatch(layout, /theme-stellar-blue/, "已下线的极光蓝不得重新进入根布局");
assert.match(layout, /<ThemeInit \/>/, "必须保留 ThemeInit 颜色设置同步链路");

for (const theme of ["lattice", "soft-white", "crystal-aurora"]) {
  assert.match(themes, new RegExp(`"${theme}"`), `主题注册表缺少 ${theme}`);
}
assert.match(themes, /THEME_MODE_PREFERENCES = \["system", "light", "dark"\]/, "持久化必须兼容历史模式值");
assert.match(themes, /DEFAULT_MODE_PREFERENCE: ThemeModePreference = "light"/, "平台缺省模式必须保持浅色");
assert.match(themes, /return normalizeTheme\(theme\)/, "选择主题必须直接成为实际渲染主题");
assert.doesNotMatch(switcher, /modeLocked|disabled=\{modeLocked\}|深空金固定深色/, "用户模式选择不得被主题 key 锁死");
assert.match(appContext, /settingsData\.settings\?\.theme_mode/, "无用户偏好时必须读取平台默认明暗模式");
assert.match(appContext, /safeRemove\(STORAGE_KEYS\.USER_THEME_PREFERENCE\)/, "DB 空主题偏好必须清理跨账号本机主题残留");
assert.match(appContext, /safeRemove\(STORAGE_KEYS\.USER_THEME_MODE_PREFERENCE\)/, "DB 空主题偏好必须清理跨账号本机模式残留");
assert.match(appContext, /resolveAppearance\(platformTheme, platformMode\)/, "平台主题与模式必须作为一个外观合同应用");
assert.match(appContext, /invalidateClientBootstrapAppearance\(\)/, "后台保存平台默认后必须失效外观缓存");

const themeBootStart = layout.indexOf("var allowedThemes =");
const themeBootEndMarker = "} catch(e) {}";
const themeBootEnd = layout.indexOf(themeBootEndMarker, themeBootStart);
assert.ok(themeBootStart >= 0 && themeBootEnd > themeBootStart, "必须能隔离首屏主题脚本");
const themeBoot = layout
  .slice(themeBootStart, themeBootEnd)
  .replace("${SERIALIZED_VALID_THEMES}", JSON.stringify(["lattice", "soft-white", "crystal-aurora"]))
  .replace("${SERIALIZED_LIGHT_THEMES}", JSON.stringify(["soft-white"]))
  .replace("${SERIALIZED_MODE_PREFERENCES}", JSON.stringify(["system", "light", "dark"]))
  .replace("${SERIALIZED_DEFAULT_THEME}", JSON.stringify("lattice"))
  .replace("${SERIALIZED_DEFAULT_MODE_PREFERENCE}", JSON.stringify("light"));
const themeBootScript = new Script(`(function(){try {${themeBoot}} catch (error) { throw error; }})();`);

function runThemeBoot({
  platformTheme = null,
  modePreference = null,
  systemDark = false,
}: {
  platformTheme?: string | null;
  modePreference?: string | null;
  systemDark?: boolean;
}) {
  const storage = new Map<string, string>();
  const attributes = new Map<string, string>([["data-theme-selection", "lattice"], ["data-theme", "lattice"], ["data-mode-preference", "system"], ["data-mode", "dark"]]);
  if (platformTheme !== null) storage.set("platform_theme", platformTheme);
  if (modePreference !== null) storage.set("platform_theme_mode", modePreference);
  themeBootScript.runInNewContext({
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
    },
    document: {
      documentElement: {
        getAttribute: (key: string) => attributes.get(key) ?? null,
        setAttribute: (key: string, value: string) => attributes.set(key, String(value)),
      },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
  });
  return {
    selection: attributes.get("data-theme-selection"),
    theme: attributes.get("data-theme"),
    modePreference: attributes.get("data-mode-preference"),
    mode: attributes.get("data-mode"),
  };
}

assert.deepEqual(runThemeBoot({ systemDark: false }), { selection: "lattice", theme: "lattice", modePreference: "light", mode: "dark" });
assert.deepEqual(runThemeBoot({ systemDark: true }), { selection: "lattice", theme: "lattice", modePreference: "light", mode: "dark" });
assert.deepEqual(runThemeBoot({ platformTheme: "stellar-blue", modePreference: "light" }), { selection: "lattice", theme: "lattice", modePreference: "light", mode: "dark" });
assert.deepEqual(runThemeBoot({ platformTheme: "crystal-aurora", modePreference: "system", systemDark: false }), { selection: "crystal-aurora", theme: "crystal-aurora", modePreference: "system", mode: "dark" });
assert.deepEqual(runThemeBoot({ platformTheme: "crystal-aurora", modePreference: "system", systemDark: true }), { selection: "crystal-aurora", theme: "crystal-aurora", modePreference: "system", mode: "dark" });
assert.deepEqual(runThemeBoot({ platformTheme: "lattice", modePreference: "light" }), { selection: "lattice", theme: "lattice", modePreference: "light", mode: "dark" });
assert.deepEqual(runThemeBoot({ platformTheme: "retired-theme", modePreference: "dark" }), { selection: "lattice", theme: "lattice", modePreference: "dark", mode: "dark" });

assert.doesNotMatch(layout, /\beval\s*\(/, "根布局不得引入 eval，保持现有 CSP 兼容边界");
assert.doesNotMatch(layout, /new\s+Function\s*\(/, "根布局不得引入 new Function，保持现有 CSP 兼容边界");
assert.doesNotMatch(layout, /<script\s+[^>]*src=/, "根布局不得新增外链 script");

console.log("PASS root layout navigation performance contract");
