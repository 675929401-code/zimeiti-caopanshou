import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  visibleAdminAgentRows,
  visibleAdminCategoryRows,
  visibleAdminNavigationRows,
} from "../src/lib/admin-agent-catalog-visibility";

const categories = [
  { name: "公开", visibility: "normal", is_active: true },
  { name: "内部", visibility: "private", is_active: true },
  { name: "自用", visibility: "normal", is_active: true },
  { name: "停用", visibility: "normal", is_active: false },
];
const agents = [
  { name: "公开助手", category: "公开", user_access: "available" },
  { name: "隐藏助手", category: "公开", user_access: "hidden" },
  { name: "内部助手", category: "内部", user_access: "available" },
  { name: "自用助手", category: "自用", user_access: "available" },
  { name: "失配助手", category: "不存在", user_access: "available" },
];
const navigation = [
  { name: "公开入口", status: "ready", is_active: true },
  { name: "隐藏入口", status: "hidden", is_active: true },
  { name: "停用入口", status: "ready", is_active: false },
];

assert.deepEqual(visibleAdminCategoryRows(categories, false).map((row) => row.name), ["公开"]);
assert.deepEqual(visibleAdminAgentRows(agents, categories, false).map((row) => row.name), ["公开助手"]);
assert.deepEqual(visibleAdminNavigationRows(navigation, false).map((row) => row.name), ["公开入口"]);
assert.equal(visibleAdminCategoryRows(categories, true).length, categories.length);
assert.equal(visibleAdminAgentRows(agents, categories, true).length, agents.length);
assert.equal(visibleAdminNavigationRows(navigation, true).length, navigation.length);

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");
for (const [label, source] of [
  ["agents", read("src/app/api/admin/agents/route.ts")],
  ["categories", read("src/app/api/admin/categories/route.ts")],
  ["nav-items", read("src/app/api/admin/nav-items/route.ts")],
] as const) {
  assert.match(source, /authorizeAdminCapability\(request, ['"]agents\.view['"]/u, `${label}:agents.view route gate required`);
  assert.match(source, /include_internal/u, `${label}:explicit internal request flag required`);
  assert.match(source, /authorizeAdminCapability\(request, ['"]internal_tools\.manage['"]/u, `${label}:internal capability gate required`);
  assert.match(
    source,
    /authorizeAdminCapability\(request, ['"]internal_tools\.manage['"][\s\S]{0,220}?requireStepUp: true/u,
    `${label}:internal capability must require step-up`,
  );
  assert.doesNotMatch(source, /verifyAdminToken|getTokenFromHeaders/u, `${label}:mutations must not fall back to role-only authorization`);
}

const agentRoute = read("src/app/api/admin/agents/route.ts");
assert.match(agentRoute, /authorizeAdminCapability\(request, 'agents\.manage', \{[\s\S]{0,160}?requireStepUp: true/u);
for (const operation of ["agent_create", "agent_update", "agent_delete"]) {
  assert.match(agentRoute, new RegExp(`authorizeAgentMutation\\(request, '${operation}'\\)`, "u"));
}
for (const operation of ["internal_agent_create", "internal_agent_update", "internal_agent_delete"]) {
  assert.match(agentRoute, new RegExp(`authorizeInternalAgentMutation\\(request, '${operation}'\\)`, "u"));
}
assert.match(agentRoute, /\.select\('id,category,user_access'\)/u);
assert.match(agentRoute, /categoryRequiresInternalAccess\(currentAgent\.category\)/u);
assert.match(agentRoute, /if \(categoryName === '自用'\) return true/u);

const publicCategoryRoute = read("src/app/api/categories/route.ts");
assert.match(
  publicCategoryRoute,
  /authorizeAdminCapability\(request, "internal_tools\.manage"[\s\S]{0,220}?requireStepUp: true/u,
);
assert.match(
  publicCategoryRoute,
  /category\.visibility === "private" \|\| category\.name\.trim\(\) === "自用"/u,
);

const publicAgentRoute = read("src/app/api/bots/route.ts");
assert.match(
  publicAgentRoute,
  /authorizeAdminCapability\(request, "internal_tools\.manage"[\s\S]{0,220}?requireStepUp: true/u,
);
assert.match(
  publicAgentRoute,
  /category\.visibility === "private" \|\| category\.name\.trim\(\) === "自用"/u,
);

const categoryRoute = read("src/app/api/admin/categories/route.ts");
assert.match(categoryRoute, /authorizeAdminCapability\(request, "agents\.manage", \{[\s\S]{0,160}?requireStepUp: true/u);
for (const operation of ["agent_category_create", "agent_category_update", "agent_category_delete"]) {
  assert.match(categoryRoute, new RegExp(`authorizeCategoryMutation\\(request, "${operation}"\\)`, "u"));
}
for (const operation of ["internal_agent_category_create", "internal_agent_category_update", "internal_agent_category_delete"]) {
  assert.match(categoryRoute, new RegExp(`authorizeInternalCategoryMutation\\(request, "${operation}"\\)`, "u"));
}

const navigationRoute = read("src/app/api/admin/nav-items/route.ts");
assert.match(navigationRoute, /authorizeAdminCapability\(request, "agents\.manage", \{[\s\S]{0,160}?requireStepUp: true/u);
for (const operation of ["agent_navigation_create", "agent_navigation_update", "agent_navigation_delete"]) {
  assert.match(navigationRoute, new RegExp(`authorizeNavigationMutation\\(request, "${operation}"\\)`, "u"));
}
for (const operation of [
  "internal_agent_navigation_create",
  "internal_agent_navigation_update",
  "internal_agent_navigation_reorder",
  "internal_agent_navigation_delete",
]) {
  assert.match(navigationRoute, new RegExp(`authorizeInternalNavigationMutation\\(request, "${operation}"\\)`, "u"));
}

const page = read("src/app/admin/page.tsx");
assert.match(
  page,
  /const canViewInternalTools = grantedPermissionKeys\.has\("internal_tools\.manage"\) && sensitiveUnlocked/u,
);
assert.match(page, /const canManageInternalTools = canViewInternalTools/u);
assert.match(page, /if \(canViewInternalTools\) query\.set\("include_internal", "1"\)/u);
assert.match(page, /canViewInternalTools \? "\?include_internal=1" : ""/u);

console.log("admin internal catalog concealment contract: ok");
