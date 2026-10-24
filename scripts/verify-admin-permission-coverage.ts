import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ADMIN_PERMISSION_CATALOG,
  ADMIN_PERMISSION_KEYS,
  ADMIN_TAB_PERMISSIONS,
  adminRequirementForRequest,
  hasAdminPermissionRequirement,
} from "../src/lib/admin-governance";
import {
  COMMAND_CENTER_ENTRY_PERMISSION_KEYS,
  commandCenterPermissionKeysForView,
  visibleCommandCenterViews,
} from "../src/lib/admin-command-center-domain";
import {
  ADMIN_CORE_TECH_PERMISSION_KEYS,
  ADMIN_JOB_TEMPLATES,
  ADMIN_OWNER_ONLY_PERMISSION_KEYS,
  ADMIN_PERMISSION_DEPENDENCIES,
  normalizeDelegableAdminPermissionKeys,
  ownerOnlyAdminPermissionKeys,
  visibleAdminPermissionSurfaces,
} from "../src/lib/admin-permission-design";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

assert.equal(new Set(ADMIN_PERMISSION_KEYS).size, ADMIN_PERMISSION_KEYS.length, "permission keys must be unique");
assert.equal(ADMIN_PERMISSION_CATALOG.length, 31, "permission catalog count changed; review database migration and UI coverage");
for (const permission of ADMIN_PERMISSION_CATALOG) {
  assert.ok(permission.group.trim(), `${permission.key}:group required`);
  assert.ok(permission.label.trim(), `${permission.key}:label required`);
  assert.ok(permission.description.trim(), `${permission.key}:description required`);
}

assert.deepEqual(
  ownerOnlyAdminPermissionKeys(["admin.accounts.manage", "members.view"]),
  ["admin.accounts.manage"],
);
assert.deepEqual(
  ownerOnlyAdminPermissionKeys(["prompts.view", "prompts.edit", "internal_tools.manage", "members.view"]),
  [],
);
assert.ok(
  !normalizeDelegableAdminPermissionKeys(ADMIN_PERMISSION_KEYS).includes("admin.accounts.manage"),
  "owner-only authority must not be delegable",
);
assert.deepEqual(
  normalizeDelegableAdminPermissionKeys(["prompts.edit"]),
  ["agents.view", "prompts.view", "prompts.edit"],
  "owner-granted prompt editing must retain both read dependencies",
);
assert.deepEqual(
  normalizeDelegableAdminPermissionKeys(["models.manage"]),
  ["models.view", "models.manage"],
  "model management must include model read access",
);
assert.deepEqual(
  normalizeDelegableAdminPermissionKeys(["members.delete"]),
  ["members.view", "members.delete"],
  "member destructive access must retain the review surface",
);
assert.deepEqual(
  normalizeDelegableAdminPermissionKeys(["member_content.view"]),
  ["members.view", "member_content.view"],
  "member content access must retain the basic member review surface",
);
assert.deepEqual(
  normalizeDelegableAdminPermissionKeys(["payment.settings.manage"]),
  ["billing.view", "payment.settings.manage"],
  "payment configuration must retain billing review access",
);
assert.deepEqual(
  normalizeDelegableAdminPermissionKeys(["white_label.manage"]),
  ["brand.settings.manage", "white_label.manage"],
  "white-label release must retain the brand control surface",
);
for (const [permissionKey, dependencies] of Object.entries(ADMIN_PERMISSION_DEPENDENCIES)) {
  assert.ok(ADMIN_PERMISSION_KEYS.includes(permissionKey), `${permissionKey}:unknown dependency owner`);
  for (const dependency of dependencies) {
    assert.ok(ADMIN_PERMISSION_KEYS.includes(dependency), `${permissionKey}:unknown dependency ${dependency}`);
  }
}

for (const template of ADMIN_JOB_TEMPLATES) {
  assert.equal(ownerOnlyAdminPermissionKeys(template.permissionKeys).length, 0, `${template.id}:owner permission forbidden`);
  assert.equal(
    template.permissionKeys.some((key) => ADMIN_CORE_TECH_PERMISSION_KEYS.includes(key as (typeof ADMIN_CORE_TECH_PERMISSION_KEYS)[number])),
    false,
    `${template.id}:job template must not auto-grant core technology`,
  );
  assert.ok(visibleAdminPermissionSurfaces(template.permissionKeys).length > 0, `${template.id}:template must expose a real work surface`);
}

const pageSource = read("src/app/admin/page.tsx");
const validTabsMatch = pageSource.match(/const VALID_TABS: Tab\[\] = \[([\s\S]*?)\];/u);
assert.ok(validTabsMatch, "admin VALID_TABS must remain explicit");
const validTabs = [...validTabsMatch[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
for (const tab of validTabs) {
  assert.ok(ADMIN_TAB_PERMISSIONS[tab], `${tab}:missing ADMIN_TAB_PERMISSIONS mapping`);
}
assert.match(pageSource, /function canExposeAdminTab\(/u, "admin navigation must use a concealment predicate");
assert.match(pageSource, /visibleAdminTabSet/u, "admin navigation must derive from allowed tabs");
assert.match(pageSource, /window\.history\.replaceState/u, "unauthorized deep links must be replaced");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

function routePath(file: string): string {
  const relative = path.relative(path.join(root, "src/app"), file).replaceAll("\\", "/");
  return `/${relative.replace(/\/route\.ts$/u, "").replace(/\[[^\]]+\]/gu, "fixture")}`;
}

const policyExemptions = new Set([
  "/api/admin/access-control/self",
  "/api/admin/access-control/unlock",
  "/api/admin/security-events/internal",
  "/api/admin/manju-config",
]);
const unmapped: Array<{ pathname: string; method: string }> = [];
const routes = walk(path.join(root, "src/app/api/admin")).filter((file) => file.endsWith("route.ts"));
for (const file of routes) {
  const source = readFileSync(file, "utf8");
  const pathname = routePath(file);
  const methods = [...source.matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/gu)]
    .map((match) => match[1]);
  assert.ok(methods.length > 0, `${pathname}:no exported HTTP method found`);
  for (const method of methods) {
    const requirement = adminRequirementForRequest(pathname, method, new URLSearchParams());
    if (policyExemptions.has(pathname)) {
      assert.equal(requirement, null, `${pathname}:expected route-local exemption`);
      continue;
    }
    assert.ok(requirement, `${pathname} ${method}:missing admin policy`);
    if (requirement.operation === "unmapped_admin_api") unmapped.push({ pathname, method });
    assert.ok(ADMIN_PERMISSION_KEYS.includes(requirement.permission), `${pathname} ${method}:unknown permission`);
  }
}
assert.deepEqual(unmapped, [], "all current admin routes must have an explicit policy instead of the fallback bucket");

const skillMetadata = adminRequirementForRequest("/api/admin/skills", "GET", new URLSearchParams());
assert.equal(skillMetadata?.permission, "agents.view");
assert.equal(skillMetadata?.requireStepUp, false);
const skillSource = adminRequirementForRequest("/api/admin/skills", "GET", new URLSearchParams("include_source=1"));
assert.equal(skillSource?.permission, "internal_tools.manage");
assert.equal(skillSource?.requireStepUp, true);
assert.equal(adminRequirementForRequest("/api/admin/skills", "POST")?.permission, "internal_tools.manage");
const packageSource = adminRequirementForRequest("/api/admin/skill-packages", "GET", new URLSearchParams("include_source=1"));
assert.equal(packageSource?.permission, "prompts.view");
assert.equal(packageSource?.requireStepUp, true);
assert.equal(adminRequirementForRequest("/api/admin/skill-packages", "POST")?.permission, "prompts.edit");

assert.equal(ADMIN_TAB_PERMISSIONS.payment, "payment.settings.manage");
assert.equal(ADMIN_TAB_PERMISSIONS.credits, "wallet.adjust");
assert.equal(ADMIN_TAB_PERMISSIONS.general, "brand.settings.manage");
assert.equal(ADMIN_TAB_PERMISSIONS.theme, "brand.settings.manage");
assert.equal(ADMIN_TAB_PERMISSIONS.layout, "brand.settings.manage");
assert.equal(ADMIN_TAB_PERMISSIONS.connection, "integrations.manage");
assert.deepEqual(ADMIN_TAB_PERMISSIONS.dashboard, { anyOf: COMMAND_CENTER_ENTRY_PERMISSION_KEYS });
assert.equal(hasAdminPermissionRequirement(["members.view"], ADMIN_TAB_PERMISSIONS.dashboard), true);
assert.equal(hasAdminPermissionRequirement(["announcements.manage"], ADMIN_TAB_PERMISSIONS.dashboard), false);
assert.deepEqual(visibleCommandCenterViews(["members.view"]), ["members"]);
assert.deepEqual(visibleCommandCenterViews(["billing.view"]), ["revenue"]);
assert.deepEqual(visibleCommandCenterViews(["models.view"]), ["production"]);
assert.deepEqual(visibleCommandCenterViews(["security.view"]), ["security"]);
assert.deepEqual(visibleCommandCenterViews(["logs.view"]), ["system"]);
assert.deepEqual(
  visibleCommandCenterViews(["logs.view", "members.view", "billing.view", "models.view", "security.view"]),
  ["overview", "members", "revenue", "production", "security", "system"],
);
assert.deepEqual(commandCenterPermissionKeysForView("evidence"), [
  "logs.view",
  "members.view",
  "billing.view",
  "models.view",
  "security.view",
  "announcements.manage",
  "backups.manage",
  "platform.settings.manage",
  "brand.settings.manage",
  "integrations.manage",
  "payment.settings.manage",
  "white_label.manage",
]);
for (const [view, permission] of [
  ["members", "members.view"],
  ["revenue", "billing.view"],
  ["production", "models.view"],
  ["security", "security.view"],
  ["system", "logs.view"],
] as const) {
  const requirement = adminRequirementForRequest(
    "/api/admin/command-center",
    "GET",
    new URLSearchParams({ view }),
  );
  assert.equal(requirement?.permission, permission, `${view}:command-center proxy permission drifted`);
  assert.equal(requirement?.operation, `command_center_${view}`);
}
assert.equal(adminRequirementForRequest("/api/admin/runtime-telemetry", "GET")?.permission, "logs.view");
assert.equal(adminRequirementForRequest("/api/admin/runtime-telemetry", "GET")?.operation, "runtime_telemetry_read");
assert.equal(adminRequirementForRequest("/api/admin/payment-config", "GET")?.permission, "payment.settings.manage");
assert.equal(adminRequirementForRequest("/api/admin/payment-methods", "POST")?.permission, "payment.settings.manage");
assert.equal(adminRequirementForRequest("/api/admin/branding", "POST")?.permission, "brand.settings.manage");
assert.equal(adminRequirementForRequest("/api/admin/plugins", "GET")?.permission, "integrations.manage");
assert.equal(adminRequirementForRequest("/api/admin/domain-release/status", "GET")?.permission, "white_label.manage");
assert.equal(adminRequirementForRequest("/api/admin/multitenant-boundary", "GET")?.permission, "white_label.manage");
assert.equal(adminRequirementForRequest("/api/admin/consistency-check", "GET")?.permission, "billing.view");
assert.equal(adminRequirementForRequest("/api/admin/config", "GET")?.permission, "models.manage");
assert.equal(adminRequirementForRequest("/api/admin/services", "GET")?.permission, "models.manage");
assert.equal(adminRequirementForRequest("/api/admin/aiweb-import", "POST")?.permission, "prompts.edit");
assert.equal(adminRequirementForRequest("/api/storyboard/agent", "GET")?.permission, "prompts.view");
assert.equal(adminRequirementForRequest("/api/storyboard/agent", "PUT")?.permission, "prompts.edit");
assert.equal(adminRequirementForRequest("/api/storyboard/agent", "GET")?.requireStepUp, true);
assert.equal(adminRequirementForRequest("/api/voice/nest/authorize", "GET")?.permission, "members.view");
assert.equal(adminRequirementForRequest("/api/voice/nest/authorize", "POST")?.permission, "member_permissions.manage");
assert.equal(adminRequirementForRequest("/api/extract/reconciliation", "GET")?.permission, "billing.view");
assert.equal(adminRequirementForRequest("/api/extract/reconciliation", "POST")?.permission, "wallet.adjust");
assert.equal(adminRequirementForRequest("/api/video/detect-protocol", "POST")?.permission, "models.manage");
assert.equal(adminRequirementForRequest("/api/admin/categories", "POST")?.permission, "agents.manage");
assert.equal(adminRequirementForRequest("/api/admin/nav-items", "PUT")?.permission, "agents.manage");
const unknownAdminRoute = adminRequirementForRequest("/api/admin/__unmapped_contract_probe__", "GET");
assert.equal(unknownAdminRoute?.permission, "admin.accounts.manage", "unknown admin routes must be owner-only");
assert.equal(unknownAdminRoute?.requireStepUp, true, "unknown admin routes must require step-up");
assert.equal(unknownAdminRoute?.operation, "unmapped_admin_api");

const permissionV2Migration = read("supabase/migrations/20261003090000_admin_permission_catalog_v2.sql");
for (const permissionKey of ["brand.settings.manage", "integrations.manage", "payment.settings.manage", "white_label.manage"]) {
  assert.match(permissionV2Migration, new RegExp(permissionKey.replaceAll(".", "\\."), "u"), `${permissionKey}:database catalog row missing`);
}
assert.match(permissionV2Migration, /normalize_delegable_admin_permission_keys/u);
assert.match(permissionV2Migration, /ADMIN_PERMISSION_CONTRACT_VIOLATION/u);
assert.match(permissionV2Migration, /admin_permission_catalog_contract_guard/u);
assert.match(permissionV2Migration, /noncanonical_profile_count/u);
assert.match(permissionV2Migration, /catalog_invalid_dependency_count/u);
assert.match(permissionV2Migration, /catalog_cycle_count/u);
for (const rpcName of ["set_admin_access_profile_atomic", "create_admin_account_atomic", "promote_existing_member_to_admin_atomic"]) {
  const start = permissionV2Migration.indexOf(`FUNCTION public.${rpcName}`);
  assert.ok(start >= 0, `${rpcName}:v2 definition missing`);
  const next = permissionV2Migration.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
  const definition = permissionV2Migration.slice(start, next < 0 ? undefined : next);
  assert.match(definition, /normalize_delegable_admin_permission_keys/u, `${rpcName}:database delegation normalizer missing`);
}

assert.deepEqual(ADMIN_PERMISSION_DEPENDENCIES["wallet.adjust"], ["members.view", "billing.view"]);
const walletDependencyMigration = read("supabase/migrations/20261003091500_admin_wallet_member_dependency.sql");
assert.match(walletDependencyMigration, /permission_key = 'wallet\.adjust'/u);
assert.match(walletDependencyMigration, /\["members\.view","billing\.view"\]/u);
assert.match(walletDependencyMigration, /normalize_delegable_admin_permission_keys/u);
assert.match(walletDependencyMigration, /admin_permission_dependency_v3_migration/u);

const memberContentMigration = read("supabase/migrations/20261003093000_admin_member_content_permission.sql");
assert.match(memberContentMigration, /'member_content\.view'/u);
assert.match(memberContentMigration, /\["members\.view"\]/u);
assert.match(memberContentMigration, /admin_member_content_permission_v4_migration/u);

const authoritySource = read("src/lib/server/admin-governance-authority.ts");
assert.match(authoritySource, /privilegedDenialDetails/u);
const selfSource = read("src/app/api/admin/access-control/self/route.ts");
assert.match(selfSource, /catalog: adminPermissionCatalogForSelf\(access.permissionKeys\)/u);
assert.match(selfSource, /filter\(\(\[, allowed\]\) => allowed === true\)/u);
assert.match(selfSource, /: isSuperAdmin\s*\? true/u, "super administrators must retain every tab even if a stored permission row drifts");

console.log(JSON.stringify({
  status: "PASS",
  permissionCount: ADMIN_PERMISSION_KEYS.length,
  ownerOnly: ADMIN_OWNER_ONLY_PERMISSION_KEYS,
  jobTemplates: ADMIN_JOB_TEMPLATES.map((template) => template.id),
  routeCount: routes.length,
  tabsCovered: validTabs.length,
  unmappedRoutes: 0,
}, null, 2));
