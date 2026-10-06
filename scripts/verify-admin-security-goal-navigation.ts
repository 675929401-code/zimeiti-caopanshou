import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(process.cwd(), "src/app/admin/page.tsx"), "utf8");
const source = readFileSync(resolve(process.cwd(), "src/components/admin/security-center-admin-tab.tsx"), "utf8");

assert.match(
  page,
  /dynamic\([\s\S]{0,180}import\("@\/components\/admin\/security-center-admin-tab"\)[\s\S]{0,220}ssr:\s*false/u,
  "security center must be a deferred client chunk",
);
assert.doesNotMatch(
  page,
  /^import\s+(?!type\b)[^;]*security-center-admin-tab/mu,
  "security center must not be a runtime static import",
);

for (const label of ["威胁态势", "案件处置", "管理员会话"] as const) {
  assert.ok(source.includes(label), `missing security goal: ${label}`);
}

assert.match(source, /type SecurityWorkspace = "events" \| "cases" \| "sessions"/);
assert.match(source, /searchParams\.get\("securityView"\)/);
assert.match(source, /url\.searchParams\.set\("securityView", next\)/);
assert.match(source, /workspaceReady && workspace === "events"/);
assert.match(source, /if \(!workspaceReady \|\| workspace !== "events"\) return/);
assert.match(source, /workspaceReady && workspace === "cases"/);
assert.match(source, /workspaceReady && workspace === "sessions"/);
assert.match(source, /<SecurityCaseWorkbench[\s\S]*?canManage=\{canManageSecurity\}/);
assert.match(source, /<AdminAccountSecurityPanel[\s\S]*?stepUpReady=\{sensitiveUnlocked\}/);
assert.match(page, /<SecurityCenterAdminTab[\s\S]*?canManageSecurity=\{hasSecuritySettingsPermission\}/);
const casesStart = source.indexOf('{workspaceReady && workspace === "cases"');
const sessionsStart = source.indexOf('{workspaceReady && workspace === "sessions"');
const eventsStart = source.indexOf('{workspaceReady && workspace === "events"');
assert.ok(casesStart >= 0 && sessionsStart > casesStart && eventsStart > sessionsStart);
assert.ok(!source.slice(casesStart, sessionsStart).includes("AdminAccountSecurityPanel"), "cases branch must not eagerly render the sessions panel");
assert.ok(!source.slice(sessionsStart, eventsStart).includes("SecurityCaseWorkbench"), "sessions branch must not eagerly render the cases panel");

console.log(JSON.stringify({
  status: "PASS",
  scope: "admin-security-goal-navigation",
  goals: ["events", "cases", "sessions"],
  deepLink: "securityView",
  lazyRead: true,
}, null, 2));
