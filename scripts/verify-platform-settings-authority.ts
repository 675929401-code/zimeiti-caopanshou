import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PlatformSettingValidationError,
  parsePlatformSettingPatch,
} from "../src/lib/platform-settings-contract";

const compatible = parsePlatformSettingPatch({
  platform_name: "旧页面缓存值",
  platform_cover: "https://stale.example/logo.png",
  welcome_message: "旧欢迎语",
  restore_token: "旧页面缓存中的已退役字段",
  restore_token_configured: true,
  theme: "lattice",
  theme_mode: "system",
  email_smtp_pass_configured: true,
}, "general");
assert.deepEqual(compatible.values, { theme: "lattice", theme_mode: "system" });
assert.deepEqual(compatible.ignoredKeys, [
  "email_smtp_pass_configured",
  "platform_cover",
  "platform_name",
  "restore_token",
  "restore_token_configured",
  "welcome_message",
]);

assert.throws(
  () => parsePlatformSettingPatch({ arbitrary_key: "value" }, "general"),
  (error: unknown) => error instanceof PlatformSettingValidationError
    && error.code === "PLATFORM_SETTING_NOT_ALLOWED",
);
assert.throws(
  () => parsePlatformSettingPatch({ coze_api_base_url: "javascript:alert(1)" }, "general"),
  (error: unknown) => error instanceof PlatformSettingValidationError
    && error.code === "INVALID_URL_SETTING",
);
assert.throws(
  () => parsePlatformSettingPatch({ email_smtp_port: "70000" }, "general"),
  (error: unknown) => error instanceof PlatformSettingValidationError
    && error.code === "INVALID_SMTP_PORT",
);

const email = readFileSync("src/lib/email.ts", "utf8");
assert.match(email, /readPublishedPlatformBranding/u);
assert.doesNotMatch(email, /eq\(['"]setting_key['"], ['"]platform_name['"]\)/u);

const authority = readFileSync("src/lib/server/brand-authority.ts", "utf8");
assert.match(authority, /if \(!data\) return readLegacyPlatformBranding\(\)/u);
assert.doesNotMatch(authority, /if \(controlPlaneUnavailable\(error\)\) return readLegacyPlatformBranding\(\)/u);

const settingsRoute = readFileSync("src/app/api/settings/route.ts", "utf8");
assert.match(settingsRoute, /platformBrandingLegacyCompatibilitySettings\(branding\)/u);
assert.match(settingsRoute, /parsePlatformSettingPatch\(settings, "general"\)/u);
assert.match(settingsRoute, /adminPlatformSettingScopesForKeys\(requestedKeys\)/u);
assert.match(settingsRoute, /adminPlatformSettingPermission\(scope, "write"\)/u);
assert.match(settingsRoute, /requireStepUp: true/u);
assert.match(settingsRoute, /appendAdminGovernanceAudit/u);
assert.match(settingsRoute, /changedKeys\.map/u);
assert.doesNotMatch(settingsRoute, /for \(const \[key, value\] of Object\.entries\(settings\)\)/u);

const adminSettingsRoute = readFileSync("src/app/api/settings/admin/route.ts", "utf8");
assert.match(adminSettingsRoute, /parsePlatformSettingPatch\(body, "admin"\)/u);
assert.match(adminSettingsRoute, /requestedScope\(request\)/u);
assert.match(adminSettingsRoute, /adminPlatformSettingPermission\(scope, mode\)/u);
assert.match(adminSettingsRoute, /adminPlatformSettingKeysForScope\(scope\)/u);
assert.match(adminSettingsRoute, /adminPlatformSettingScopesForKeys\(keys\)/u);
assert.match(adminSettingsRoute, /PLATFORM_SETTING_SCOPE_MISMATCH/u);
assert.match(adminSettingsRoute, /requireStepUp: true/u);
assert.match(adminSettingsRoute, /appendAdminGovernanceAudit/u);
assert.match(adminSettingsRoute, /changedKeys\.map/u);
assert.doesNotMatch(adminSettingsRoute, /for \(const \[key, value\] of Object\.entries\(body\)\)/u);
assert.doesNotMatch(adminSettingsRoute, /["']restore_token["']/u);

const retiredRestoreRoute = readFileSync("src/app/api/restore/bootstrap/route.ts", "utf8");
assert.match(retiredRestoreRoute, /LEGACY_RESTORE_DISABLED/u);
assert.match(retiredRestoreRoute, /status:\s*404/u);

console.log("platform settings authority verification passed");
