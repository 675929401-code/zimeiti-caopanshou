#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_CONCEALED_BUNDLE_SENTINELS } from "./lib/admin-loaded-javascript-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const page = read("src/app/admin/page.tsx");
const governance = read("src/components/admin/super-admin-governance-panel.tsx");
const unlock = read("src/components/admin/admin-sensitive-unlock-control.tsx");
const payment = read("src/components/admin/payment-config-admin-tab.tsx");
const integrations = read("src/components/admin/integration-settings-admin-tab.tsx");
const security = read("src/components/admin/security-center-admin-tab.tsx");
const guardLogs = read("src/components/admin/guard-logs-admin-tab.tsx");
const backup = read("src/components/admin/backup-admin-tab.tsx");
const modelsShell = read("src/components/admin/models-admin-tab.tsx");
const modelsReadOnly = read("src/components/admin/unified-models-read-only-admin-tab.tsx");
const modelsManage = read("src/components/unified-models-tab.tsx");
const promptHistory = read("src/components/prompt-version-history.tsx");
const liveE2e = read("scripts/verify-admin-role-concealment-live.mjs");

assert.match(page, /import dynamic from "next\/dynamic"/u, "admin page must use Next dynamic imports");
for (const modulePath of [
  "@/components/admin/super-admin-governance-panel",
  "@/components/admin/CommerceAgentAdminTab",
  "@/components/admin/ManjuWorkbenchAdminTab",
  "@/components/admin/WorkspaceModelsAdminTab",
  "@/components/admin/security-center-admin-tab",
  "@/components/admin/guard-logs-admin-tab",
  "@/components/admin/login-logs-admin-tab",
  "@/components/admin/sync-admin-tab",
  "@/components/admin/backup-admin-tab",
  "@/components/admin/payment-config-admin-tab",
  "@/components/admin/models-admin-tab",
  "@/components/admin/integration-settings-admin-tab",
  "@/components/prompt-version-history",
  "@/components/preset-template-editor",
  "@/components/billing-audit-panel",
  "@/components/admin/DigitalHumanAdminTab",
  "@/components/admin/VoiceStudioAdminTab",
  "@/components/admin/PluginManagementTab",
  "@/components/admin/operation-flight-recorder-panel",
]) {
  const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.doesNotMatch(
    page,
    new RegExp(`^import\\s+(?!type\\b)[^;]*${escaped}`, "mu"),
    `${modulePath}: protected module must not be a runtime static import`,
  );
  assert.match(
    page,
    new RegExp(`dynamic\\([\\s\\S]{0,180}import\\("${escaped}"\\)[\\s\\S]{0,240}ssr:\\s*false`, "u"),
    `${modulePath}: protected module must be a client-only deferred chunk`,
  );
}

assert.match(page, /activeTab === "payment"[\s\S]{0,300}<PaymentConfigAdminTab/u, "payment chunk needs an authorized tab gate");
assert.match(page, /activeTab === "connection" && hasIntegrationSettingsPermission[\s\S]{0,300}<IntegrationSettingsAdminTab/u, "integration chunk needs an explicit self-permission gate");
assert.match(page, /activeTab === "security"[\s\S]{0,300}<SecurityCenterAdminTab/u, "security chunk needs an authorized tab gate");
assert.match(modelsShell, /canManageModelsPermission \? \([\s\S]*?<UnifiedModelsTab[\s\S]*?: \([\s\S]*?<UnifiedModelsReadOnlyAdminTab/u, "model management chunk must be selected only after self permission confirmation");
assert.match(modelsReadOnly, /fetch\("\/api\/admin\/models"/u, "read-only model catalog must use the projected admin DTO");
for (const sensitiveField of ["api_endpoint", "api_key", "cost_price", "provider", "protocol_type", "proxy_url"]) {
  assert.doesNotMatch(modelsReadOnly, new RegExp(`\\b${sensitiveField}\\b`, "u"), `read-only model chunk exposes ${sensitiveField}`);
}

const sensitiveSourceBySentinel = new Map([
  ["迅虎支付（虎皮椒）配置", payment],
  ["SMTP 授权码", integrations],
  ["凭据安全清单", modelsManage],
  ["高/严重风险关联账号 Top10", security],
  ["脱敏拦截摘要：", guardLogs],
  ["灾备与恢复证据", backup],
  ["使用此版本", promptHistory],
]);
for (const [sentinel, protectedSource] of sensitiveSourceBySentinel) {
  assert.ok(protectedSource.includes(sentinel), `${sentinel}: protected source sentinel missing`);
  assert.ok(!page.includes(sentinel), `${sentinel}: base admin source must not contain protected implementation copy`);
}

assert.match(page, /from "@\/components\/admin\/admin-sensitive-unlock-control"/u, "step-up control must remain in the base authorized shell");
assert.doesNotMatch(governance, /export function AdminSensitiveUnlockControl/u, "governance chunk must not own the shared unlock control");
assert.doesNotMatch(governance, /export function useAdminStepUpReady/u, "governance chunk must not own the shared step-up timer");
assert.match(unlock, /export function AdminSensitiveUnlockControl/u);
assert.match(unlock, /export function useAdminStepUpReady/u);
assert.doesNotMatch(page, /dggbx5s53w\.coze\.site/u, "real Coze deployment address must not be a client default");
assert.match(page, /coze_coding_api_url:\s*""/u, "Coze coding URL must start empty and hydrate only from authorized scoped settings");

assert.ok(ADMIN_CONCEALED_BUNDLE_SENTINELS.includes("SUPER ADMIN CONTROL PLANE"));
assert.ok(ADMIN_CONCEALED_BUNDLE_SENTINELS.includes("带货 Agent 管理"));
assert.ok(ADMIN_CONCEALED_BUNDLE_SENTINELS.includes("漫剧 Agent 私有 Prompt 来源"));
for (const sentinel of sensitiveSourceBySentinel.keys()) {
  assert.ok(ADMIN_CONCEALED_BUNDLE_SENTINELS.includes(sentinel), `${sentinel}: loaded-JavaScript audit sentinel missing`);
}
assert.match(liveE2e, /createLoadedJavaScriptSentinelAudit/u, "live E2E must reuse the loaded-JavaScript audit helper");
assert.match(liveE2e, /ORDINARY_ADMIN_CONCEALED_CHUNKS_MUST_NOT_LOAD/u, "ordinary-admin E2E must fail when a protected chunk loads");
assert.match(liveE2e, /SUPER_ADMIN_GOVERNANCE_CHUNK_MUST_LOAD/u, "super-admin E2E must prove the protected chunk can load after authorization");

console.log(JSON.stringify({
  ok: true,
  deferredModules: 19,
  sharedUnlockModule: true,
  realClientDefaultRemoved: true,
  projectedReadOnlyModelChunk: true,
  sensitiveSentinelCount: ADMIN_CONCEALED_BUNDLE_SENTINELS.length,
  loadedJavascriptSentinels: ADMIN_CONCEALED_BUNDLE_SENTINELS,
}, null, 2));
