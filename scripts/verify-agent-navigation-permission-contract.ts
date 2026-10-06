import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  AGENT_NAVIGATION_OPTIONS,
  getAgentNavigationKey,
  normalizeAllowedAgentNavigationKeys,
  resolveAllowedAgentNavigationKeys,
} from "../src/lib/agent-category-access";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const expectedKeys = [
  "bip:loop",
  "task:影像编导",
  "task:文案创作",
  "task:获客转化",
  "自用",
];
assert.deepEqual(AGENT_NAVIGATION_OPTIONS.map((item) => item.key), expectedKeys);
assert.deepEqual(normalizeAllowedAgentNavigationKeys(null), []);
assert.deepEqual(normalizeAllowedAgentNavigationKeys(undefined), []);
assert.deepEqual(normalizeAllowedAgentNavigationKeys([]), []);
assert.deepEqual(
  normalizeAllowedAgentNavigationKeys(["task:文案创作", "task:文案创作", "deleted-uuid"]),
  ["task:文案创作"],
);

const legacyCategories = [
  { id: "legacy-copy", name: "引流带货" },
  { id: "legacy-internal", name: "自用" },
];
const legacyAgents = [
  { id: "copy-1", name: "爆款文案重构师", category: "引流带货" },
  { id: "internal-1", name: "内部巡检工具", category: "自用" },
];
assert.equal(getAgentNavigationKey(legacyAgents[0]), "task:文案创作");
assert.equal(getAgentNavigationKey(legacyAgents[1]), "自用");
assert.deepEqual(
  resolveAllowedAgentNavigationKeys(["legacy-copy"], legacyCategories, legacyAgents),
  ["task:文案创作"],
);
assert.deepEqual(
  resolveAllowedAgentNavigationKeys(["deleted-uuid"], legacyCategories, legacyAgents),
  [],
);
assert.deepEqual(
  resolveAllowedAgentNavigationKeys(["task:获客转化", "legacy-copy"], legacyCategories, legacyAgents),
  ["task:获客转化"],
  "stable navigation grants must be authoritative once saved",
);

const adminCategories = read("src/app/api/admin/categories/route.ts");
assert.doesNotMatch(adminCategories, /Failed to sync allowed_categories|const merged = \[\.\.\.current, data\.id\]/);
assert.match(adminCategories, /Category publication and user authorization are independent operations/);
assert.match(adminCategories, /Deleted category grant cleanup/);
assert.match(adminCategories, /内部工具.*系统标识固定/);
assert.match(adminCategories, /固定智能体导航/);

const bots = read("src/app/api/bots/route.ts");
assert.match(bots, /readMemberPermissionSnapshot/);
assert.match(bots, /permission\.authorityStatus !== "ready" \|\| !permission\.integrityValid/);
assert.match(bots, /new Set\(permission\.agentNavigationKeys\)/);
assert.match(bots, /categoryRecord\.is_active === false/);
assert.match(bots, /internalCategoryNames\.has/);

for (const route of ["src/app/api/chat/route.ts", "src/app/api/llm/route.ts"]) {
  const source = read(route);
  assert.match(source, /readMemberPermissionSnapshot/);
  assert.match(source, /permission\.authorityStatus !== "ready" \|\| !permission\.integrityValid/);
  assert.match(source, /permission\.agentNavigationKeys\.includes/);
  assert.match(source, /MEMBER_PERMISSION_INTEGRITY_INVALID/);
  assert.match(source, /MEMBER_PERMISSION_AUTHORITY_UNAVAILABLE/);
  assert.match(source, /resolveAllowedAgentNavigationKeys/);
  assert.match(source, /agentCat\.is_active === false/);
  assert.match(source, /agentCat\.visibility === "private"/);
  assert.match(source, /尚未配置可用导航栏/);
  assert.match(source, /CATEGORY_ACCESS_DENIED/);
}

for (const route of [
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/login-email/route.ts",
  "src/app/api/auth/me/route.ts",
  "src/app/api/auth/register/route.ts",
]) {
  assert.match(read(route), /publicAllowedAgentCategoryIds/);
  assert.doesNotMatch(read(route), /allowed_categories \|\| null/);
}

const adminUsers = read("src/app/api/admin/users/route.ts");
assert.match(adminUsers, /allowedNavigationKeys/);
assert.match(adminUsers, /normalizeAllowedAgentNavigationKeys/);
assert.match(adminUsers, /finalRole === 'admin' \? null : requestedNavigationKeys/);

const adminCami = read("src/app/api/admin/cami/route.ts");
assert.match(adminCami, /normalizeAllowedAgentNavigationKeys/);
assert.match(adminCami, /navigationKeys\.length > 0 \? navigationKeys : null/);
const redeemCami = read("src/app/api/cami/route.ts");
assert.match(redeemCami, /rpc\("redeem_cami_membership_atomic"/);
assert.match(redeemCami, /p_idempotency_key: clientRequestId/);
const camiActivationMigration = read("supabase/migrations/20260930221000_member_activation_cami_invitation_rewards.sql");
assert.match(camiActivationMigration, /CREATE OR REPLACE FUNCTION public\.redeem_cami_membership_atomic/);
assert.match(camiActivationMigration, /jsonb_array_elements_text\(coalesce\(v_user\.allowed_categories/);
assert.match(camiActivationMigration, /jsonb_array_elements_text\(coalesce\(v_card\.allowed_categories/);
assert.match(camiActivationMigration, /allowed_categories = v_merged_categories/);
assert.match(camiActivationMigration, /reward_stage = 'activation'/);

const guardLogs = read("src/app/api/admin/guard-logs/route.ts");
assert.match(guardLogs, /AGENT_NAVIGATION_OPTIONS/);
assert.match(guardLogs, /无智能体权限/);

console.log("agent navigation permission contract: PASS");
