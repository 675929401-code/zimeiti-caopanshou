import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION,
  isAdminAccountSecurityResponse,
  normalizeSessionRevokeReason,
} from "../src/lib/admin-account-security-contract";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const route = read("src/app/api/admin/login-logs/sessions/route.ts");
const server = read("src/lib/server/admin-account-security.ts");
const component = read("src/components/admin/admin-account-security-panel.tsx");
const css = read("src/components/admin/admin-account-security-panel.module.css");
const governance = read("src/lib/admin-governance.ts");
const design = read("supabase/design-only/20261003_admin_mfa_trusted_devices.sql");
const guide = read("docs/admin-mfa-session-governance-phase1.md");

assert.equal(normalizeSessionRevokeReason("logout"), "logout");
assert.equal(normalizeSessionRevokeReason("unrecognized"), "other");
assert.equal(normalizeSessionRevokeReason(""), null);
assert.equal(ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION, 1);
assert.equal(isAdminAccountSecurityResponse({ schemaVersion: 1 }), false);

assert.match(route, /authorizeAdminCapability\(request, "security\.view"/u);
assert.match(route, /requireStepUp: true/u);
assert.match(route, /validateBrowserWriteSource\(request\.method, request\.headers\)/u);
assert.match(route, /Idempotency-Key|idempotency-key/u);
assert.match(route, /ADMIN_ACCOUNT_SECURITY_WRITE_LIMIT/u);
assert.match(route, /recentSessionMutationCount/u);
assert.match(route, /sessionMutationAlreadyRecorded/u);
assert.match(route, /appendAdminGovernanceAudit/u);
assert.match(route, /ADMIN_SESSION_REPLAY_REJECTED/u);
assert.match(route, /ADMIN_SESSION_REVOKE_RATE_LIMITED/u);
assert.match(route, /ADMIN_EMAIL_MFA_ENFORCEMENT_NOT_READY/u);
assert.match(route, /ADMIN_TRUSTED_DEVICE_STORE_NOT_READY/u);
assert.doesNotMatch(route, /sendVerificationCode|storeCode|verifyCode/u, "phase one must not send or consume an email code");
assert.doesNotMatch(route, /targetUserId|target_user_id|body\.userId/u, "self-service route must not accept another administrator target");

const exactMapping = governance.indexOf('pathname === "/api/admin/login-logs/sessions"');
const broadMapping = governance.indexOf('security-events|guard-logs|guard-rules|login-logs|password-audit');
assert.ok(exactMapping > 0 && broadMapping > exactMapping, "narrow self-session mapping must precede the broad login-log write rule");
assert.match(
  governance.slice(exactMapping, broadMapping),
  /permission: "security\.view", requireStepUp: write/u,
  "ordinary security.view administrators may step-up manage only their own sessions",
);

assert.match(server, /createHmac\("sha256"/u);
assert.match(server, /timingSafeEqual/u);
assert.match(server, /\.eq\("user_id", actorId\)/u);
assert.match(server, /revoke_user_auth_session/u);
assert.match(server, /p_reason: "administrator_revoked"/u);
assert.doesNotMatch(server, /ip_hash:\s*row\.ip_hash|user_agent_hash:\s*row\.user_agent_hash/u, "raw stored hashes must not enter the response");
assert.match(server, /raw session|session_id/iu);
assert.match(server, /status: "unavailable"/u);
assert.match(server, /当前不具备可信地理定位/u);

for (const prop of ["token", "canManage", "stepUpReady", "onRequestUnlock", "autoRefresh"]) {
  assert.match(component, new RegExp(`\\b${prop}\\??:`), `component prop ${prop} is required in the public contract`);
}
assert.match(component, /document\.hidden/u);
assert.match(component, /navigator\.onLine/u);
assert.match(component, /requestAbortRef\.current\?\.abort\(\)/u);
assert.match(component, /ADMIN_ACCOUNT_SECURITY_POLL_INTERVAL_MS/u);
assert.match(component, /onRequestUnlock\?\.\(\)/u);
assert.doesNotMatch(component, /super-admin|SuperAdmin/u, "component must not depend on the super-admin page");

const visibleFontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/gu)].map((match) => Number(match[1]));
assert.ok(visibleFontSizes.length >= 10, "font-size coverage is unexpectedly small");
assert.ok(visibleFontSizes.every((size) => size >= 12), `visible font floor violated: ${visibleFontSizes.filter((size) => size < 12).join(",")}`);
assert.match(css, /prefers-reduced-motion: reduce/u);
assert.doesNotMatch(css, /max-width:\s*390px/u);

assert.match(design, /DESIGN ONLY — DO NOT APPLY/u);
assert.match(design, /admin_mfa_profiles/u);
assert.match(design, /admin_mfa_challenges/u);
assert.match(design, /admin_trusted_devices/u);
assert.match(design, /pending_login_nonce_hash/u);
assert.match(design, /token_hash/u);
assert.doesNotMatch(design, /CREATE POLICY/iu, "design tables must not grant browser roles a direct policy");
assert.match(guide, /此时不得创建 `user_auth_sessions`、JWT 或登录 Cookie/u);
assert.match(guide, /未执行真实邮件发送或生产数据写入/u);

console.log(JSON.stringify({
  status: "PASS",
  scope: "admin-mfa-session-governance-phase1",
  guarantees: [
    "current-admin sessions only",
    "security.view read and self-revoke with step-up",
    "HMAC session handles and no raw IP/UA/session identifiers",
    "CSRF, idempotency, replay guard, durable audit and rate limit",
    "hidden/offline polling pause and reduced-motion",
    "MFA, trusted device and login challenge remain explicitly unavailable",
  ],
  databaseWrites: 0,
  emailSends: 0,
  migrationApplies: 0,
  paidRequests: 0,
}, null, 2));
