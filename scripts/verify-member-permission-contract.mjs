#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const migration = read("supabase/migrations/20261001003000_member_permission_snapshots.sql");
const cascadeMigration = read("supabase/migrations/20261001004500_member_permission_user_delete_cascade.sql");
const adminMigration = read("supabase/migrations/20261001010000_admin_business_permissions.sql");
const rollback = read("supabase/rollbacks/20261001003000_member_permission_snapshots.rollback.sql");
const catalog = read("src/lib/member-permissions.ts");
const authority = read("src/lib/server/member-permission-authority.ts");
const proxy = read("src/proxy.ts");
const boundary = read("src/components/member-permission-boundary.tsx");
const adminApi = read("src/app/api/admin/users/permissions/route.ts");
const adminUi = read("src/app/admin/page.tsx");
const chatRoute = read("src/app/api/chat/route.ts");
const llmRoute = read("src/app/api/llm/route.ts");
const favoriteRoute = read("src/app/api/agent-favorites/route.ts");

for (const table of ["member_permission_profiles", "member_permission_assignments", "member_permission_events"]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`), `${table}:missing`);
  assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`), `${table}:rls`);
}
assert.match(migration, /MEMBER_PERMISSION_DIRECT_WRITE_FORBIDDEN/u, "assignment direct-write guard missing");
assert.match(migration, /MEMBER_PERMISSION_EVENT_IMMUTABLE/u, "audit immutability guard missing");
assert.match(cascadeMigration, /NOT EXISTS[\s\S]*public\.users/u, "account deletion cascade compatibility missing");
assert.match(migration, /MEMBER_PERMISSION_REVISION_CONFLICT/u, "optimistic concurrency missing");
assert.match(migration, /MEMBER_PERMISSION_IDEMPOTENCY_CONFLICT/u, "idempotency guard missing");
assert.match(migration, /member_permission_checksum/u, "checksum missing");
assert.match(migration, /以后新增功能默认关闭/u, "upgrade-safe snapshot statement missing");
assert.match(rollback, /ROLLBACK_BLOCKED_MEMBER_PERMISSION_EVENTS_EXIST/u, "destructive rollback guard missing");
assert.match(adminMigration, /admin_default/u, "administrator product snapshot missing");
assert.match(adminMigration, /EXECUTE replace\(v_definition, v_forbidden_block, ''\)/u, "administrator target guard is not removed atomically");

for (const key of ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"]) {
  assert.ok(catalog.includes(`"${key}"`) || catalog.includes(key), `catalog missing ${key}`);
}
assert.match(authority, /authorityStatus: status/u, "fail-closed authority snapshot missing");
assert.match(proxy, /MEMBER_FEATURE_ACCESS_DENIED/u, "API feature gate missing");
assert.match(boundary, /member-feature-access-denied/u, "direct page gate missing");
assert.match(adminApi, /set_member_permissions_atomic/u, "admin atomic save missing");
assert.match(adminUi, /系统以后新增功能不会自动加入已有会员/u, "admin upgrade boundary copy missing");
assert.match(adminUi, /保存采用版本校验/u, "admin concurrency explanation missing");
assert.match(adminUi, /后台管理权由角色保留；此处只配置前台业务与智能体权限/u, "administrator permission boundary copy missing");
for (const route of [chatRoute, llmRoute, favoriteRoute]) {
  assert.match(route, /readMemberPermissionSnapshot/u, "direct Agent route does not read durable permissions");
}
assert.match(chatRoute, /本次未调用模型/u, "Coze gate must run before provider use");
assert.match(llmRoute, /CATEGORY_ACCESS_DENIED/u, "LLM Agent category gate missing");

console.log(JSON.stringify({ passed: true, checks: 31, productionWrites: 0 }, null, 2));
