import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adminUserVerificationKey, maskQqEmail } from "../src/lib/admin-user-verification";
import { isQqEmail, normalizeQqEmail } from "../src/lib/qq-email";
import {
  AGENT_NAVIGATION_OPTIONS,
  getAgentCategoryDisplayName,
  normalizeAllowedAgentCategoryIds,
  normalizeAllowedAgentNavigationKeys,
} from "../src/lib/agent-category-access";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

assert.equal(normalizeQqEmail(" 123456789@QQ.COM "), "123456789@qq.com");
assert.equal(isQqEmail("12345@qq.com"), true);
assert.equal(isQqEmail("123456789012@qq.com"), true);
assert.equal(isQqEmail("1234@qq.com"), false);
assert.equal(isQqEmail("student@qq.com"), false);

assert.equal(adminUserVerificationKey("create", "admin-1"), "admin_create:admin-1");
assert.equal(adminUserVerificationKey("email_change", "admin-1", "user-2"), "admin_email_change:admin-1:user-2");
assert.equal(adminUserVerificationKey("password_reset", "admin-1", "user-2"), "admin_password_reset:admin-1:user-2");
assert.equal(maskQqEmail("123456789@qq.com"), "12***89@qq.com");
assert.deepEqual(normalizeAllowedAgentCategoryIds(null), []);
assert.deepEqual(normalizeAllowedAgentCategoryIds(undefined), []);
assert.deepEqual(normalizeAllowedAgentCategoryIds(["cat-1", "cat-1", " cat-2 "]), ["cat-1", "cat-2"]);
assert.equal(getAgentCategoryDisplayName("自用"), "内部工具");
assert.deepEqual(AGENT_NAVIGATION_OPTIONS, [
  { key: "bip:loop", label: "商业IP" },
  { key: "task:影像编导", label: "影像编导" },
  { key: "task:文案创作", label: "文案创作" },
  { key: "task:获客转化", label: "运营增长" },
  { key: "自用", label: "内部工具" },
]);
assert.deepEqual(
  normalizeAllowedAgentNavigationKeys(["legacy-category-uuid", "task:文案创作", "task:文案创作", "自用"]),
  ["task:文案创作", "自用"],
);

const verificationRoute = read("src/app/api/admin/users/verification-code/route.ts");
assert.match(verificationRoute, /verifyAdminToken/);
assert.match(verificationRoute, /isEmailConfigured/);
assert.match(verificationRoute, /sendVerificationCode/);
assert.match(verificationRoute, /purpose === "password_reset"/);
assert.match(verificationRoute, /checkAdminUserIdentity/);

const usersRoute = read("src/app/api/admin/users/route.ts");
assert.match(usersRoute, /qqEmailError\(email\)/);
assert.match(usersRoute, /adminUserVerificationKey\('create'/);
assert.match(usersRoute, /ADMIN_USER_ACCOUNT_REAUTH_HEADER/);
assert.match(usersRoute, /verifyAdminUserAccountReauth/);
assert.match(usersRoute, /ADMIN_USER_ACCOUNT_REAUTH_REQUIRED/);
assert.match(usersRoute, /const changesLoginIdentity = changesUsername \|\| changesPassword/);
assert.match(usersRoute, /code:\s*'EMAIL_IMMUTABLE'/);
assert.match(usersRoute, /updateData\.session_id = null/);
const updateUserRoute = usersRoute.slice(usersRoute.indexOf("// PUT - Update user"), usersRoute.indexOf("// DELETE - Delete user"));
assert.doesNotMatch(updateUserRoute, /emailVerificationCode|adminUserVerificationKey|verifyCode/);
assert.match(usersRoute, /memberStatus: u\.member_status \|\| 'inactive'/);
assert.match(usersRoute, /status: u\.status \|\|/);
assert.match(usersRoute, /allowedNavigationKeys/);
assert.match(usersRoute, /resolveAllowedAgentNavigationKeys/);
assert.match(usersRoute, /ADMIN_USER_DELETE_REAUTH_HEADER/);
assert.match(usersRoute, /verifyAdminUserDeleteReauth/);
assert.match(usersRoute, /ADMIN_USER_DELETE_REAUTH_REQUIRED/);

const passwordVerificationRoute = read("src/app/api/auth/verify-password/route.ts");
assert.match(passwordVerificationRoute, /purpose === "admin_user_delete"/);
assert.match(passwordVerificationRoute, /createAdminUserDeleteReauth/);
assert.match(passwordVerificationRoute, /setting_key === "operation_password"/);

const adminPage = read("src/app/admin/page.tsx");
assert.match(adminPage, /res\.status === 401 \|\| res\.status === 403/);
assert.match(adminPage, /后台身份校验暂时失败，请稍后刷新重试/);
assert.match(adminPage, /后台身份校验网络异常，请检查连接后刷新重试/);
assert.doesNotMatch(adminPage, /if \(!res\.ok\) \{ router\.push\("\/"\)/);
assert.doesNotMatch(adminPage, /catch \{ router\.push\("\/"\); \}/);
assert.doesNotMatch(adminPage, /setTimeout\(\(\) => fetchChatList/);
assert.match(adminPage, /fetchChatList\(1, chatListSearch\)/);
assert.match(adminPage, /fetchChatList\(1, ""\)/);
assert.match(adminPage, /学员与会员/);
assert.match(adminPage, /编辑学员账号/);
assert.match(adminPage, /重置学员密码/);
assert.match(adminPage, /QQ邮箱为必填身份，创建前必须完成邮箱验证码校验/);
assert.match(adminPage, /编辑账号/);
assert.match(adminPage, /purpose: "admin_user_account_recovery"/);
assert.match(adminPage, /"x-admin-user-account-reauth": accountRecoveryToken/);
assert.match(adminPage, /adminUserDeleteVerificationRef/);
assert.match(adminPage, /usersRequestSequenceRef\.current \+= 1/);
assert.match(adminPage, /setUsers\(\(current\) => current\.filter/);
assert.match(adminPage, /setMemberFilter\("all"\)/);
assert.match(adminPage, /setUserSearch\(""\)/);
assert.match(adminPage, /cache: "no-store"/);
assert.match(adminPage, /fetch\("\/api\/admin\/users\?page_size=500"/);
assert.match(adminPage, /captureMemberListView/);
assert.match(adminPage, /restoreMemberListView/);
assert.match(adminPage, /openUserAccessEditor/);
assert.match(adminPage, /user\.allowedNavigationKeys !== undefined/);
assert.match(adminPage, /normalizeAllowedAgentNavigationKeys\(persistedValue\)/);
assert.match(adminPage, /AGENT_NAVIGATION_OPTIONS\.map\(\(option\)/);
assert.match(adminPage, /resolvedNavigationNames\.length > 0/);
assert.doesNotMatch(adminPage, /memberNavigationRequestRef|memberNavigationLoading/);
assert.doesNotMatch(adminPage, /freshCategories|availableCategoryIds\.has\(categoryId\)/);
assert.doesNotMatch(adminPage, /\$\{userCats\.length\} 个智能体导航/);
assert.match(adminPage, /会员功能权限/);
assert.match(adminPage, /业务功能导航/);
assert.match(adminPage, /智能体分类/);
assert.match(adminPage, /保存功能权限/);
assert.match(adminPage, /permissionLabel = `\$\{featureCount\} 项业务 · \$\{resolvedNavigationNames\.length\} 个智能体分类`/);
assert.match(adminPage, /option\.label/);
assert.doesNotMatch(adminPage, /仅应用广场/);
assert.doesNotMatch(adminPage, /cats == null \? categories\.filter/);
assert.doesNotMatch(adminPage, /min-w-\[1100px\]/);

console.log("admin member management contract: PASS");
