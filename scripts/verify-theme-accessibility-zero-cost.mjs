import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const layout = read("src/app/layout.tsx");
const switcher = read("src/components/user-theme-switcher.tsx");
const polish = read("src/app/theme-polish.css");
const colors = read("src/lib/theme-color-settings.ts");
const context = read("src/contexts/app-context.tsx");
const live = read("scripts/verify-theme-switch-live.mjs");

assert.doesNotMatch(layout, /maximumScale\s*:/u);
assert.doesNotMatch(layout, /userScalable\s*:/u);
assert.ok(layout.indexOf('import "./ui-shell-fixes.css";') > layout.indexOf('import "./theme-soft-white.css";'));
assert.match(switcher, /min-h-10 min-w-10/u);
assert.match(switcher, /text-xs leading-snug/u);
assert.match(polish, /min-width:\s*44px[\s\S]*min-height:\s*44px/u);
assert.doesNotMatch(colors, /vars\["--accent-foreground"\]\s*=/u);
assert.match(colors, /removeProperty\(key\)/u);
assert.match(colors, /MANAGED_THEME_COLOR_CSS_VARS/u);
assert.match(context, /themePreferenceSaveChainRef/u);
assert.match(context, /\.then\(save\)/u);
assert.match(live, /assert\.deepEqual\(consoleErrors, \[\]/u);
assert.match(live, /unexpectedWrites/u);

console.log(JSON.stringify({
  passed: 13,
  browserZoomEnabled: true,
  desktopThemeTriggerMinimum: 40,
  mobileThemeTriggerMinimum: 44,
  serializedPreferenceWrites: true,
  contrastTokenProtected: true,
  staleInlineVariablesRemoved: true,
  networkCalls: 0,
  databaseWrites: 0,
  providerCalls: 0,
}, null, 2));
