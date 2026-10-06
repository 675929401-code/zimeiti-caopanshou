import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "src/app/admin/page.tsx"), "utf8");

for (const permissionKey of [
  "members.manage",
  "members.delete",
  "member_content.view",
  "member_permissions.manage",
  "packages.manage",
  "wallet.adjust",
  "billing.view",
  "billing.export",
  "security.view",
]) {
  assert.ok(source.includes(`grantedPermissionKeys.has("${permissionKey}")`), `${permissionKey}: missing UI gate`);
}

assert.match(source, /if \(tab\.key === "chats"\) return canViewMemberContent;/u);
assert.match(source, /adminAccess\?\.access\.permissionKeys\.includes\("member_content\.view"\)\) fetchChatList/u);
assert.match(source, /canViewMemberContent && userSubTab === "chats"/u);
assert.match(source, /const chatPromise = canViewMemberContent/u);
assert.match(source, /canViewBilling && userSubTab === "recharge"/u);
assert.match(source, /canViewBilling && userSubTab === "consumption"/u);
assert.match(source, /hasMembersDeletePermission && user\.id !== currentUserId/u);
assert.match(source, /hasMemberPermissionsManagePermission && <button[^\n]+openUserAccessEditor/u);
assert.match(source, /hasPackagesManagePermission && user\.role !== "admin"/u);
assert.match(source, /hasWalletAdjustPermission && visibleAdminTabSet\.has\("offline-payments"\)/u);
assert.match(source, /canViewMemberSecurity && <p><span[^>]+>最近登录/u);
assert.match(source, /if \(!hasBillingExportPermission\) return;/u);
assert.match(source, /if \(!canExportBilling\) \{\s*onRequestUnlock\(\)/u);
assert.match(source, /if \(!hasWalletAdjustPermission\) return;/u);
assert.match(source, /if \(!canAdjustWallet\) \{\s*onRequestUnlock\(\)/u);
assert.match(source, /if \(!token \|\| !canManagePackages\) \{\s*setCamiPackages\(\[\]\)/u);
assert.match(source, /canManagePackages && canViewMembers && assigningCard/u);
assert.match(source, /canManagePackages=\{canManagePackages\} canViewMembers=\{canViewMembers\}/u);
assert.match(source, /hasBillingExportPermission && <button[^\n]+exportMemberReconciliation/u);
assert.match(source, /hasWalletAdjustPermission && visibleAdminTabSet\.has\("offline-payments"\)/u);
assert.match(source, /hasPackagesManagePermission && visibleAdminTabSet\.has\("cami"\)/u);
assert.match(source, /filter\(\(tab\) => tab\.key === "login" \? canViewMemberSecurity : canViewBilling\)/u);
assert.match(source, /canViewBilling && \(transactionTab === "all" \|\| transactionTab === "credits" \|\| transactionTab === "cash"\)/u);
assert.match(source, /data-testid="member-dossier-minimal-view"/u);
assert.match(source, /canViewBilling && transactionTab === "lifecycle"/u);
assert.match(source, /canViewMemberSecurity && transactionTab === "login"/u);
assert.doesNotMatch(source, /adminLevel === "super_admin" && <button[^\n]+openUserAccessEditor/u);

console.log(JSON.stringify({ status: "PASS", gates: 20, unauthorizedPrefetchBlocked: true }, null, 2));
