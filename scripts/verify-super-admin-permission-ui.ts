import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterAdminPermissionCatalog,
  SuperAdminGovernancePanel,
} from "../src/components/admin/super-admin-governance-panel";
import {
  ADMIN_PERMISSION_CATALOG,
  type AdminAccessClientState,
} from "../src/lib/admin-governance";
import {
  ADMIN_STEP_UP_DURATION_MINUTES,
  ADMIN_STEP_UP_RATE_LIMIT,
} from "../src/lib/admin-step-up-contract";
import {
  ADMIN_CORE_TECH_PERMISSION_KEYS,
  ADMIN_JOB_TEMPLATES,
  ADMIN_OWNER_ONLY_PERMISSION_KEYS,
  ADMIN_PERMISSION_DEPENDENCIES,
  normalizeDelegableAdminPermissionKeys,
  visibleAdminPermissionSurfaces,
} from "../src/lib/admin-permission-design";

const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(
  path.join(root, "src/components/admin/super-admin-governance-panel.tsx"),
  "utf8",
);
const selfRoute = readFileSync(
  path.join(root, "src/app/api/admin/access-control/self/route.ts"),
  "utf8",
);
const authoritySource = readFileSync(
  path.join(root, "src/lib/server/admin-governance-authority.ts"),
  "utf8",
);
const unlockRoute = readFileSync(
  path.join(root, "src/app/api/admin/access-control/unlock/route.ts"),
  "utf8",
);
const unlockControl = readFileSync(
  path.join(root, "src/components/admin/admin-sensitive-unlock-control.tsx"),
  "utf8",
);
const adminPage = readFileSync(
  path.join(root, "src/app/admin/page.tsx"),
  "utf8",
);

assert.equal(ADMIN_PERMISSION_CATALOG.length, 31, "the UI contract requires the complete 31-item catalog");
assert.equal(new Set(ADMIN_PERMISSION_CATALOG.map((permission) => permission.key)).size, 31, "permission keys must be unique");

const groups = [...new Set(ADMIN_PERMISSION_CATALOG.map((permission) => permission.group))];
assert.equal(groups.length, 6, "all six product permission groups must remain visible");
for (const group of groups) {
  const expected = ADMIN_PERMISSION_CATALOG.filter((permission) => permission.group === group);
  assert.deepEqual(
    filterAdminPermissionCatalog(ADMIN_PERMISSION_CATALOG, "", group),
    expected,
    `${group}: group filter must preserve every item`,
  );
}

for (const permission of ADMIN_PERMISSION_CATALOG) {
  const byKey = filterAdminPermissionCatalog(ADMIN_PERMISSION_CATALOG, permission.key, "");
  assert.deepEqual(byKey.map((item) => item.key), [permission.key], `${permission.key}: exact key search must find one item`);
  const byLabel = filterAdminPermissionCatalog(ADMIN_PERMISSION_CATALOG, permission.label, "");
  assert.ok(byLabel.some((item) => item.key === permission.key), `${permission.key}: label search must find the item`);
}

assert.equal(ADMIN_JOB_TEMPLATES.length, 5, "the five least-privilege job templates must remain available");
assert.deepEqual(
  [...ADMIN_OWNER_ONLY_PERMISSION_KEYS],
  ["admin.accounts.manage", "prompts.view", "prompts.edit", "internal_tools.manage"],
  "ordinary administrators must never receive owner accounts, prompt bodies or internal-tool authority",
);
for (const permissionKey of ADMIN_OWNER_ONLY_PERMISSION_KEYS) {
  assert.deepEqual(
    normalizeDelegableAdminPermissionKeys([permissionKey]),
    [],
    `${permissionKey}: owner-only authority must be stripped before delegation`,
  );
}
for (const template of ADMIN_JOB_TEMPLATES) {
  const normalized = normalizeDelegableAdminPermissionKeys(template.permissionKeys);
  assert.ok(normalized.length > 0, `${template.id}: template must grant a real work scope`);
  assert.equal(
    normalized.some((permissionKey) => ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
      permissionKey as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
    )),
    false,
    `${template.id}: owner authority must never be templated`,
  );
  assert.equal(
    normalized.some((permissionKey) => ADMIN_CORE_TECH_PERMISSION_KEYS.includes(
      permissionKey as (typeof ADMIN_CORE_TECH_PERMISSION_KEYS)[number],
    )),
    false,
    `${template.id}: a job template must never silently grant core technology`,
  );
  assert.ok(visibleAdminPermissionSurfaces(normalized).length > 0, `${template.id}: template must expose at least one entry`);
}

for (const [permissionKey, dependencies] of Object.entries(ADMIN_PERMISSION_DEPENDENCIES)) {
  const normalized = normalizeDelegableAdminPermissionKeys([permissionKey]);
  if (ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
    permissionKey as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
  )) {
    assert.deepEqual(normalized, [], `${permissionKey}: owner-only permission must remain non-delegable`);
    continue;
  }
  for (const dependency of dependencies) {
    if (ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
      dependency as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
    )) continue;
    assert.ok(normalized.includes(dependency), `${permissionKey}: dependency ${dependency} must be auto-filled`);
  }
}

assert.match(source, /testIdPrefix="edit-admin-permission"/u, "existing-admin editor must use the searchable catalog");
assert.match(source, /testIdPrefix="create-admin-permission"/u, "create-admin dialog must use the searchable catalog");
assert.match(source, /data-testid="admin-permission-effect-preview"/u, "effective entry preview is required");
assert.match(source, /data-testid="admin-permission-dependency-preview"/u, "dependency preview is required");
assert.match(source, /data-testid="admin-core-technology-warning"/u, "core technology warning is required");
assert.match(source, /!draftCoreConfirmed/u, "saving must fail closed until core access is confirmed");
assert.match(source, /!createCoreConfirmed/u, "creation must fail closed until core access is confirmed");
assert.match(source, /catalog\.length === 31/u, "authorization must fail closed on a partial catalog");
assert.match(selfRoute, /isSuperAdmin \? ADMIN_PERMISSION_CATALOG : grantedCatalog/u, "ordinary administrators must not receive the full catalog");
assert.match(selfRoute, /filter\(\(\[, allowed\]\) => allowed === true\)/u, "ordinary administrators must receive only allowed tab names");
assert.match(authoritySource, /permissionKeysForAdminLevel\(adminLevel, row\.permission_keys\)/u, "database snapshots must strip stale owner-only grants for ordinary admins");
assert.match(authoritySource, /access\.adminLevel !== "super_admin" && OWNER_ONLY_PERMISSION_SET\.has\(permissionKey\)/u, "every centralized capability check must reject owner-only access for ordinary admins");
assert.match(authoritySource, /reasonCode: "SUPER_ADMIN_REQUIRED"/u, "owner-only denial must be auditable");
assert.deepEqual([...ADMIN_STEP_UP_DURATION_MINUTES], [10, 20], "step-up UI and API must only offer 10 or 20 minutes");
assert.deepEqual(ADMIN_STEP_UP_RATE_LIMIT, {
  routeKey: "admin-step-up-unlock",
  windowSeconds: 900,
  attemptLimit: 5,
}, "step-up rate-limit policy must remain shared between the route and contract tests");
assert.match(unlockRoute, /rpc\("consume_security_rate_limit_atomic"/u, "step-up attempts must consume the existing database-atomic limiter");
assert.match(unlockRoute, /recentFailuresError[\s\S]*ADMIN_STEP_UP_RATE_LIMIT_UNAVAILABLE/u, "failure-count read errors must fail closed");
assert.match(unlockRoute, /error: revokeError/u, "manual relock must inspect the server revoke result");
assert.match(unlockRoute, /ADMIN_STEP_UP_REVOKE_FAILED/u, "manual relock must expose a fail-closed receipt when server revoke fails");
assert.match(unlockControl, /if \(!response\.ok\) throw new Error/u, "manual relock UI must not report success after a failed server revoke");
assert.match(source, /data-testid="admin-governance-dirty"/u, "governance edits must expose a visible dirty state");
assert.match(source, /data-testid="admin-governance-refresh"/u, "governance must expose an authoritative refresh action");
assert.match(source, /数据库权威读回/u, "governance saves must report authoritative readback");
assert.match(source, /loadAbortRef\.current\?\.abort\(\)/u, "governance reads must abort stale sensitive requests");
assert.match(source, /requestSequence !== loadSequenceRef\.current \|\| !unlockedRef\.current/u, "governance payloads must recheck the unlock generation before landing");
assert.match(source, /setPayload\(null\)/u, "lock and expiry must scrub governance payloads");
assert.match(source, /setGeneratedPassword\(""\)/u, "lock and expiry must scrub one-time management passwords");
assert.match(adminPage, /setAgents\(\(current\) => current\.map\(stripAgentSensitiveClientFields\)\)/u, "lock and expiry must scrub prompt and agent configuration fields");
assert.match(adminPage, /setViewingPromptAgentId\(""\)/u, "lock and expiry must close prompt viewing state");
assert.match(adminPage, /agentsAbortControllerRef\.current\?\.abort\(\)/u, "agent reads must abort stale sensitive requests");
assert.match(adminPage, /requestsSensitiveData && !sensitiveUnlockedRef\.current/u, "agent responses must recheck unlock state before landing");
assert.match(adminPage, /setShowOpPasswordDialog\(false\)/u, "lock and expiry must close the one-time password dialog");
assert.match(adminPage, /requestSequence !== opPasswordRequestSequenceRef\.current[\s\S]{0,120}!sensitiveUnlockedRef\.current/u, "one-time password responses must recheck unlock state before landing");

const grantedPermission = ADMIN_PERMISSION_CATALOG.find((permission) => permission.key === "members.view");
assert.ok(grantedPermission);
const ordinaryState: AdminAccessClientState = {
  access: {
    authorityStatus: "ready",
    integrityValid: true,
    adminLevel: "admin",
    permissionKeys: [grantedPermission.key],
    revision: 1,
    profileActive: true,
    updatedAt: new Date(0).toISOString(),
  },
  stepUp: { status: "missing", expiresAt: null, authMethod: null },
  maintenanceLock: {
    status: "ready",
    enabled: false,
    revision: 1,
    enabledAt: null,
    expiresAt: null,
    enableReason: "",
    disabledAt: null,
    disableReason: "",
    maxDurationMinutes: 30,
  },
  tabAccess: { users: true },
  managementPasswordSet: false,
  catalog: [grantedPermission],
};
const ordinaryMarkup = renderToStaticMarkup(createElement(SuperAdminGovernancePanel, {
  token: "ordinary-admin-token",
  state: ordinaryState,
  onRequestUnlock: () => undefined,
  onAccessChanged: () => undefined,
}));
assert.match(ordinaryMarkup, /data-testid="super-admin-locked"/u, "ordinary administrators must receive the locked view");
for (const permission of ADMIN_PERMISSION_CATALOG) {
  assert.equal(ordinaryMarkup.includes(permission.key), false, `${permission.key}: internal key leaked into locked markup`);
  assert.equal(ordinaryMarkup.includes(permission.label), false, `${permission.key}: permission label leaked into locked markup`);
}

console.log(JSON.stringify({
  status: "PASS",
  permissionCount: ADMIN_PERMISSION_CATALOG.length,
  groupCount: groups.length,
  templateCount: ADMIN_JOB_TEMPLATES.length,
  lockedMarkupContainsPermissionNames: false,
  catalogMutationGate: "31/31",
}, null, 2));
