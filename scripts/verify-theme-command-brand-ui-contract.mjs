import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const [themes, crystal, layout, commandCss, brandPanel] = await Promise.all([
  read("src/lib/themes.ts"),
  read("src/app/theme-crystal-aurora.css"),
  read("src/app/layout.tsx"),
  read("src/components/admin/command-center-panel.module.css"),
  read("src/components/admin/platform-brand-settings-panel.tsx"),
]);

assert.match(themes, /LIGHT_THEMES[^=]*= \["soft-white"\]/u);
assert.match(themes, /墨绿石墨底、橙金重点与薄荷状态光/u);
assert.match(layout, /var lightThemes = /u);
assert.match(layout, /lightThemes\.indexOf\(selectedTheme\) >= 0 \? 'light' : 'dark'/u);
assert.match(crystal, /--crystal-brand-gradient: linear-gradient\(112deg, #d06f28 0%, #f39a38 48%, #f4bd58 100%\)/u);
assert.match(crystal, /data-theme="crystal-aurora"\]\[data-mode="dark"\][\s\S]*\.swh-loop/u);
assert.match(crystal, /\.login-form-shell \.login-panel[\s\S]*linear-gradient\(145deg, rgba\(30, 44, 37, \.98\), rgba\(14, 25, 20, \.99\)\)/u);
assert.doesNotMatch(crystal, /data-theme="crystal-aurora"\]\[data-mode="light"\]/u);

assert.match(commandCss, /\.goalNavigation \{[\s\S]*grid-auto-flow: column;[\s\S]*overflow-x: auto;[\s\S]*border: 1px solid/u);
assert.doesNotMatch(commandCss, /\.goalNavigation \{ grid-template-columns: repeat\((?:2|4|7)/u);
assert.match(commandCss, /\.sectionGrid > \.sectionPanel:only-child \{ grid-column: 1 \/ -1; \}/u);
assert.match(commandCss, /\.sectionGrid > \.sectionPanel:only-child \.metricGrid \{ grid-template-columns: repeat\(auto-fit/u);

assert.match(brandPanel, /data-testid="brand-advanced-assets"/u);
assert.match(brandPanel, /使用主 Logo 自动适配/u);
assert.match(brandPanel, /\/api\/admin\/branding\/assets\/\$\{assetId\}/u);
assert.equal((brandPanel.match(/brand-actions-sticky/gu) || []).length, 1);
assert.doesNotMatch(brandPanel, /brand-actions-bottom/u);

console.log("theme, command center, and brand UI contract verification passed");
