import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_NAVIGATION_OPTIONS,
  resolveAllowedAgentNavigationKeys,
} from "../src/lib/agent-category-access";

assert.deepEqual(
  AGENT_NAVIGATION_OPTIONS.map((option) => option.label),
  ["商业IP", "影像编导", "文案创作", "运营增长", "内部工具"],
  "cami permissions must use the five stable learner navigation labels",
);

const legacyCategories = [
  { id: "legacy-self-uuid", name: "自用" },
  { id: "legacy-copy-uuid", name: "营销策略" },
];
const legacyAgents = [
  { id: "legacy-tool", name: "内部效率工具", category: "自用" },
  { id: "legacy-copy", name: "爆款文案重构师", category: "营销策略" },
];
assert.deepEqual(
  resolveAllowedAgentNavigationKeys(
    ["legacy-self-uuid", "legacy-copy-uuid"],
    legacyCategories,
    legacyAgents,
  ),
  ["task:文案创作", "自用"],
  "legacy category ids must resolve to stable navigation keys",
);

const adminRoute = readFileSync(resolve("src/app/api/admin/cami/route.ts"), "utf8");
assert.match(adminRoute, /resolveAllowedAgentNavigationKeys\(storedGrants, legacyCategories, agents\)/u);
assert.match(adminRoute, /allowed_categories_status: permissionStatus/u);
assert.match(adminRoute, /'legacy-unresolved'/u);

const adminPage = readFileSync(resolve("src/app/admin/page.tsx"), "utf8");
assert.match(adminPage, /不追加智能体权限/u);
assert.match(adminPage, /历史权限（待重新配置）/u);
assert.match(adminPage, />智能体导航栏<\/th>/u);
assert.doesNotMatch(adminPage, />分类权限<\/th>/u);
assert.doesNotMatch(adminPage, /空=全部/u);
assert.doesNotMatch(
  adminPage,
  /camiCategories\.find\(cat => cat\.id === id\)\?\.name \|\| id/u,
  "admin cami list must never fall back to a raw legacy id",
);

const redeemRoute = readFileSync(resolve("src/app/api/cami/route.ts"), "utf8");
const permissionMigration = readFileSync(resolve("supabase/migrations/20261001003000_member_permission_snapshots.sql"), "utf8");
assert.match(redeemRoute, /allowed_categories: navigationKeys/u);
assert.match(redeemRoute, /\.map\(\(key\) => nameMap\.get\(key\)\)/u);
assert.doesNotMatch(
  redeemRoute,
  /(?:navigationNameMap|nameMap)\.get\(key\) \|\| key/u,
  "redeem response must never expose a raw permission id as a label",
);
assert.match(permissionMigration, /CREATE TRIGGER users_member_permission_projection_sync/u);
assert.match(permissionMigration, /AFTER INSERT OR UPDATE OF allowed_categories, role ON public\.users/u);
assert.match(permissionMigration, /v_features := v_current\.feature_navigation_keys/u);
assert.match(permissionMigration, /v_agents := public\.resolve_legacy_member_agent_keys\(NEW\.allowed_categories\)/u);

const profilePage = readFileSync(resolve("src/app/profile/page.tsx"), "utf8");
assert.match(profilePage, /已开通智能体导航栏/u);
assert.match(profilePage, /智能体导航栏权限卡密/u);
assert.doesNotMatch(profilePage, /已解锁分类权限/u);

const redeemDialog = readFileSync(resolve("src/components/cami-redeem-dialog.tsx"), "utf8");
assert.match(redeemDialog, /已开通导航：/u);
assert.match(redeemDialog, /项导航/u);
assert.doesNotMatch(redeemDialog, /已解锁分类/u);

console.log("cami navigation permission contract: PASS");
