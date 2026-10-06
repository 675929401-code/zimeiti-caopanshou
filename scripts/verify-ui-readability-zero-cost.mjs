import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const source = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");

const sidebar = source("src/components/app-sidebar.tsx");
assert.match(sidebar, /getSemanticAgentAvatarFallback/u);
assert.match(sidebar, /sidebar-shortcut-card[^\n]*min-h-16/u);
assert.match(sidebar, /calc\(34px \* var\(--sidebar-scale/u);
assert.match(sidebar, /Math\.min\(1\.25, Math\.max\(0\.9/u);
assert.match(sidebar, /sidebar-conv-name[^\n]*clamp\(13px, calc\(14px \* var\(--sidebar-scale/u);
assert.match(sidebar, /sidebar-conv-time[^\n]*clamp\(11px, calc\(12px \* var\(--sidebar-scale/u);
assert.match(sidebar, /data-testid=\{`sidebar-history-avatar-\$\{conv\.id\}`\}/u);
assert.match(sidebar, /Math\.min\(460, Math\.max\(280/u);

const shell = source("src/app/ui-shell-fixes.css");
assert.match(source("src/components/agent-marketplace.tsx"), /--market-nav-font-size[\s\S]*clampUiNumber\(nl\.fontSize, 19, 22/u);
assert.match(source("src/components/agent-marketplace.tsx"), /--market-category-font-size[\s\S]*clampUiNumber\(cal\.fontSize, 16, 20/u);
assert.match(shell, /html\[data-theme\] \.marketplace-shell \.nav-pill[\s\S]*font-size: var\(--market-nav-font-size, 19px\) !important/u);
assert.match(shell, /html\[data-theme\] \.marketplace-shell \.category-tab[\s\S]*font-size: var\(--market-category-font-size, 16px\) !important/u);
assert.match(shell, /\.sidebar-shell \.sidebar-shortcut-grid \.sidebar-tool-card[\s\S]*min-height: 64px/u);
assert.doesNotMatch(shell, /\.marketplace-shell \.sidebar-/u);
assert.match(shell, /\.marketplace-search[\s\S]*width: clamp\(160px, 14vw, 200px\) !important/u);
assert.match(shell, /\.nav-bar-container[\s\S]*mask-image: linear-gradient\(90deg, transparent, #000 10px, #000 calc\(100% - 10px\), transparent\)/u);
assert.match(shell, /\.nav-pill-add > span[\s\S]*font-size: 15px !important/u);

const storyboard = source("src/app/storyboard-workbench/storyboard-workbench.css");
assert.match(storyboard, /grid-template-columns: minmax\(360px, 380px\)/u);
assert.match(storyboard, /\.sbw-root \.sbw-model-list > button[\s\S]*min-height: 76px/u);
assert.match(storyboard, /\.sbw-root \.sbw-model-name \{ font-size: 14px/u);
assert.match(storyboard, /\.sbw-root \.sbw-model-price \{ font-size: 12px/u);
assert.doesNotMatch(storyboard, /font-size:\s*(?:[1-9]|10)(?:\.[0-9]+)?px/u);

const secondaryHeader = source("src/app/theme-polish.css");
assert.match(secondaryHeader, /--subpage-header-height: 60px/u);
assert.match(secondaryHeader, /\.sub-page-subtitle[\s\S]*font-size: 12px/u);

for (const file of [
  "src/features/official-tool-directory/official-tool-directory.module.css",
  "src/features/official-inspiration/official-inspiration.module.css",
  "src/features/youcai-skills/youcai-skills-page.module.css",
  "src/features/official-core-routes/official-assets-route.module.css",
  "src/app/cover/cover-studio-v2.css",
  "src/app/voice-studio/voice-studio.css",
  "src/app/free-canvas-original.css",
]) {
  assert.match(source(file), /Readability/u, `${file} is missing its scoped readability pass`);
}

for (const file of [
  "src/app/cover/cover-studio-v2.css",
  "src/app/help/help.module.css",
  "src/app/free-canvas-original.css",
  "src/app/short-drama/short-drama.module.css",
  "src/app/voice-studio/voice-studio.css",
  "src/features/official-tool-directory/official-tool-directory.module.css",
  "src/features/official-inspiration/official-inspiration.module.css",
  "src/features/youcai-skills/youcai-skills-page.module.css",
  "src/features/official-core-routes/official-assets-route.module.css",
  "src/components/app-route-shell.module.css",
]) {
  assert.doesNotMatch(source(file), /font-size:\s*(?:[1-9]|10)(?:\.[0-9]+)?px/u, `${file} still contains sub-11px text`);
}

assert.match(source("src/components/app-route-shell.module.css"), /\.accountCopy small[\s\S]*font-size: 12px/u);
assert.match(source("src/components/toolbox-menu.tsx"), /text-\[clamp\(13px,calc\(13px\*var\(--sidebar-scale,1\)\),15px\)\][^\n]*>工具箱</u);

console.log(JSON.stringify({
  verifier: "ui-readability-zero-cost",
  passed: true,
  routesCoveredBySharedOrScopedRules: 24,
  browserWrites: 0,
  providerCalls: 0,
}, null, 2));
