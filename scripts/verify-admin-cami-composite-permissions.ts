import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'src/app/api/admin/cami/route.ts'), 'utf8');
const governance = fs.readFileSync(path.join(root, 'src/lib/admin-governance.ts'), 'utf8');

function exportedHandler(name: 'GET' | 'POST' | 'PATCH' | 'DELETE'): string {
  const marker = `export async function ${name}`;
  const start = route.indexOf(marker);
  assert.notEqual(start, -1, `${name} handler must exist`);
  const next = route.indexOf('\nexport async function ', start + marker.length);
  return route.slice(start, next === -1 ? route.length : next);
}

const getHandler = exportedHandler('GET');
const postHandler = exportedHandler('POST');
const patchHandler = exportedHandler('PATCH');
const deleteHandler = exportedHandler('DELETE');
const memberBranchEnd = getHandler.indexOf('\n  const page =');
assert.notEqual(memberBranchEnd, -1, 'ordinary card-list branch must remain after the member branch');
const memberBranch = getHandler.slice(0, memberBranchEnd);
const ordinaryListBranch = getHandler.slice(memberBranchEnd);

assert.match(governance, /const write = isWrite\(method\);/u);
assert.match(
  governance,
  /if \(pathname\.startsWith\("\/api\/admin\/cami"\)\) return \{ permission: "cards\.manage", requireStepUp: write, operation: "cards" \};/u,
  'cami routes must retain cards.manage centrally, with step-up on write methods',
);

assert.match(route, /readAdminAccessSnapshot\(adminId\)/u);
assert.match(route, /access\.authorityStatus !== 'ready' \|\| !access\.integrityValid/u);
assert.match(route, /hasAdminPermissionRequirement\(access\.permissionKeys, requiredPermissionKeys\)/u);
assert.match(route, /error: '当前管理员无权执行此操作', code: 'ADMIN_PERMISSION_DENIED'/u);
assert.doesNotMatch(route, /requiredPermission\s*:/u, 'ordinary denial responses must not reveal a permission key');

assert.match(
  memberBranch,
  /requireAdditionalCamiPermissions\(admin\.userId, \['members\.view', 'packages\.manage'\]\)/u,
  'member detail must require both member visibility and package management',
);
assert.doesNotMatch(
  ordinaryListBranch,
  /requireAdditionalCamiPermissions/u,
  'ordinary card inventory GET must remain on the central cards.manage gate',
);
assert.match(memberBranch, /const canViewBilling = hasAdminPermissionRequirement\(authorization\.access\.permissionKeys, 'billing\.view'\)/u);
assert.match(
  memberBranch,
  /const paymentResultPromise = canViewBilling[\s\S]*?\.from\('offline_payment_receipts'\)[\s\S]*?\.select\('id,status,business_type,amount,paid_at,payment_channel'\)[\s\S]*?: Promise\.resolve\(null\);/u,
  'offline payment amount and channel columns must only be queried with billing.view',
);
assert.equal(
  route.match(/\.from\('offline_payment_receipts'\)/gu)?.length,
  1,
  'the route must have no second unconditional offline-payment query',
);
assert.match(memberBranch, /\.\.\.\(canViewBilling \? \{ confirmedOfflinePayment: confirmedTuition \} : \{\}\)/u);
assert.doesNotMatch(
  memberBranch,
  /\n\s*confirmedOfflinePayment:\s*confirmedTuition,/u,
  'payment state must be absent, rather than populated, without billing.view',
);

assert.match(
  postHandler,
  /requireAdditionalCamiPermissions\(admin\.userId, \['packages\.manage'\]\)[\s\S]*?request\.json\(\)/u,
  'card generation must verify packages.manage before parsing or using a package template',
);
assert.match(
  patchHandler,
  /requireAdditionalCamiPermissions\(admin\.userId, \['members\.view', 'packages\.manage'\]\)[\s\S]*?ADMIN_CAMI_ASSIGNMENT_REAUTH_HEADER/u,
  'card assignment must verify both permissions while preserving its existing re-auth guard',
);
assert.doesNotMatch(deleteHandler, /requireAdditionalCamiPermissions/u, 'DELETE must keep its existing central gate only');

assert.equal(
  route.match(/requireAdditionalCamiPermissions\(admin\.userId,/gu)?.length,
  3,
  'only member detail, card generation, and card assignment need the route-local composite gate',
);

console.log('admin cami composite permissions: OK');
