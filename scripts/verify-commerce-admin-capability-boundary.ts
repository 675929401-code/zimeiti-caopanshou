import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { adminRequirementForRequest } from "../src/lib/admin-governance";

const read = (relativePath: string) => fs.readFileSync(path.resolve(relativePath), "utf8");

const centralMatrix = [
  ["/api/admin/commerce", "GET", "prompts.view", true],
  ["/api/admin/commerce/prompts", "GET", "prompts.view", true],
  ["/api/admin/commerce/prompts", "POST", "prompts.edit", true],
  ["/api/admin/commerce/cards", "GET", "agents.view", false],
  ["/api/admin/commerce/cards", "POST", "agents.manage", true],
  ["/api/admin/commerce/cards/canary", "GET", "agents.manage", true],
  ["/api/admin/commerce/models/canary", "GET", "models.manage", true],
  ["/api/admin/commerce/routes", "GET", "models.view", false],
  ["/api/admin/commerce/routes", "POST", "models.manage", true],
  ["/api/admin/commerce/releases", "GET", "prompts.view", true],
  ["/api/admin/commerce/releases", "POST", "agents.manage", true],
  ["/api/admin/commerce/jobs", "GET", "billing.view", false],
  ["/api/admin/commerce/jobs", "POST", "wallet.adjust", true],
  ["/api/admin/commerce/jobs/trace", "GET", "logs.view", false],
  ["/api/admin/commerce/voice-reconciliation", "GET", "billing.view", false],
  ["/api/admin/commerce/voice-reconciliation", "POST", "wallet.adjust", true],
] as const;

for (const [pathname, method, permission, requireStepUp] of centralMatrix) {
  const requirement = adminRequirementForRequest(pathname, method);
  assert.equal(requirement?.permission, permission, `${method} ${pathname} primary permission`);
  assert.equal(requirement?.requireStepUp, requireStepUp, `${method} ${pathname} step-up`);
}

const helper = read("src/lib/commerce-admin-auth.ts");
assert.match(helper, /requiredPermissions\?: readonly string\[\]/u);
assert.match(helper, /stepUpPermissions\?: readonly string\[\]/u);
assert.match(helper, /for \(const permissionKey of requiredPermissions\)/u);
assert.match(helper, /authorizeAdminCapability\(request, permissionKey/u);
assert.match(helper, /if \(!authorization\.ok\) return \{ response: authorization\.response \}/u);

const routeContracts = [
  {
    file: "src/app/api/admin/commerce/route.ts",
    permissions: ["agents.view", "prompts.view", "models.view"],
    firstRead: "Promise.all([commerceAdminOverview()",
  },
  {
    file: "src/app/api/admin/commerce/jobs/route.ts",
    permissions: ["billing.view", "logs.view", "member_content.view", "wallet.adjust"],
    firstRead: "const values=allJobs()",
  },
  {
    file: "src/app/api/admin/commerce/jobs/trace/route.ts",
    permissions: ["logs.view", "member_content.view", "prompts.view", "models.view"],
    firstRead: "const value = job(id, owner)",
  },
  {
    file: "src/app/api/admin/commerce/voice-reconciliation/route.ts",
    permissions: ["billing.view", "member_content.view", "wallet.adjust"],
    firstRead: "voiceReconciliationJobs()",
  },
  {
    file: "src/app/api/admin/commerce/models/canary/route.ts",
    permissions: ["models.manage"],
    firstRead: "ensureSessionForMainUser(",
  },
  {
    file: "src/app/api/admin/commerce/cards/canary/route.ts",
    permissions: ["agents.manage", "prompts.view", "models.view"],
    firstRead: "ensureSessionForMainUser(",
  },
] as const;

for (const contract of routeContracts) {
  const source = read(contract.file);
  const authorizationPosition = source.indexOf("requireCommerceAdmin(request");
  const protectedReadPosition = source.indexOf(contract.firstRead);
  assert.ok(authorizationPosition >= 0, `${contract.file} must authorize`);
  assert.ok(protectedReadPosition > authorizationPosition, `${contract.file} must authorize before protected data access`);
  for (const permission of contract.permissions) {
    assert.ok(source.includes(`'${permission}'`), `${contract.file} must require ${permission}`);
  }
}

const rootRoute = read("src/app/api/admin/commerce/route.ts");
assert.match(rootRoute, /stepUpPermissions: \['prompts\.view'\]/u);
assert.ok(rootRoute.indexOf("requireCommerceAdmin(request") < rootRoute.indexOf("commerceAdminOverview()"));

const adminPage = read("src/app/admin/page.tsx");
assert.match(adminPage, /grantedPermissionKeys\.has\("agents\.view"\).*grantedPermissionKeys\.has\("prompts\.view"\).*grantedPermissionKeys\.has\("models\.view"\).*projects\.push\("commerce"\)/u);
assert.match(adminPage, /<CommerceAgentAdminTab[\s\S]*permissionKeys=\{adminAccess\?\.access\.permissionKeys \|\| \[\]\}/u);

const commercePanel = read("src/components/admin/CommerceAgentAdminTab.tsx");
assert.match(commercePanel, /const canViewJobs=\['billing\.view','logs\.view','member_content\.view'\]\.every/u);
assert.match(commercePanel, /canManageCards\?\['功能卡片','卡片验收'\]/u);
assert.match(commercePanel, /canManageModels\?\['模型可用性'\]/u);
assert.match(commercePanel, /canManageCards\?\['发布与回滚'\]/u);
assert.match(commercePanel, /canEditPrompts&&<button/u);
assert.match(commercePanel, /canManageModels&&<section[^>]*><h3[^>]*>保存路由新版本/u);
assert.match(commercePanel, /\.\.\.\(canViewJobs\?\['任务与账务'\]:\[\]\)/u);
assert.match(commercePanel, /async function loadJobs\(\)\{if\(!canViewJobs\)return;/u);
assert.match(commercePanel, /\{canViewJobs&&tab==='任务与账务'/u);

console.log(JSON.stringify({
  passed: true,
  centralPolicies: centralMatrix.length,
  compositeRoutes: routeContracts.length,
  commerceEntryBaseline: ["agents.view", "prompts.view", "models.view"],
  financePanelBaseline: ["billing.view", "logs.view", "member_content.view"],
  externalCalls: 0,
  paidCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
}));
