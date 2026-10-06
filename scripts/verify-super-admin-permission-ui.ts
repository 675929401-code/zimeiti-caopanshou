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
  for (const dependency of dependencies) {
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
