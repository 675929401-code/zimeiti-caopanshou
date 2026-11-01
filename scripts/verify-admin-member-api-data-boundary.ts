import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_MEMBER_PERMISSION_MUTATION_FIELDS,
  canViewAdminMemberBilling,
  exposeAdminMemberBilling,
  memberPermissionMutationFields,
} from '../src/lib/admin-member-data-boundary';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'src/app/api/admin/users/route.ts'), 'utf8');

const aliases = Object.fromEntries(ADMIN_MEMBER_PERMISSION_MUTATION_FIELDS.map((field) => [field, []]));
assert.deepEqual(
  memberPermissionMutationFields(aliases).sort(),
  [...ADMIN_MEMBER_PERMISSION_MUTATION_FIELDS].sort(),
  'every supported business-permission alias must be recognized',
);
assert.deepEqual(memberPermissionMutationFields({ displayName: '普通资料修改' }), []);
assert.deepEqual(memberPermissionMutationFields(null), []);

assert.equal(canViewAdminMemberBilling({
  authorityStatus: 'ready',
  integrityValid: true,
  permissionKeys: ['members.view'],
}), false, 'members.view alone must not reveal billing data');
assert.equal(canViewAdminMemberBilling({
  authorityStatus: 'ready',
  integrityValid: true,
  permissionKeys: ['members.view', 'billing.view'],
}), true, 'billing.view on a valid authority snapshot unlocks billing data');
assert.equal(canViewAdminMemberBilling({
  authorityStatus: 'invalid',
  integrityValid: true,
  permissionKeys: ['billing.view'],
}), false, 'an invalid authority snapshot must fail closed');

const basicMember = { id: 'member-1', name: '示例会员' };
const billing = {
  credits: 100,
  cashBalance: 20,
  totalCreditRecharge: 120,
  totalCashRecharge: 30,
  totalCreditConsume: 20,
  totalCashConsume: 10,
  totalRecharge: 150,
  totalConsume: 30,
};
const concealed = exposeAdminMemberBilling(basicMember, billing, false);
assert.deepEqual(concealed, basicMember);
for (const key of Object.keys(billing)) {
  assert.equal(Object.hasOwn(concealed, key), false, `${key} must be absent without billing.view`);
}
assert.deepEqual(exposeAdminMemberBilling(basicMember, billing, true), { ...basicMember, ...billing });

assert.match(route, /authorizeAdminCapability\(request, 'member_permissions\.manage', \{\s*requireStepUp: true,/u);
assert.equal(
  route.match(/authorizeMemberPermissionMutation\(request, body\)/gu)?.length,
  2,
  'both POST and PUT must apply the member-permission mutation guard',
);
assert.match(route, /const billingColumns = canViewBilling \? ', credits, cash_balance' : '';/u);
assert.match(route, /adminAccess\.adminLevel !== 'super_admin'/u);
assert.match(route, /query = query\.or\(`role\.neq\.admin,id\.eq\.\$\{clean\(admin\.userId\)\}`\)/u);
assert.match(route, /const \[creditRechargeData, creditConsumeData, cashRechargeData, cashConsumeData\] = canViewBilling\s*\? await Promise\.all/u);
assert.match(route, /return exposeAdminMemberBilling\(member,/u);
assert.doesNotMatch(
  route,
  /\.select\(['"][^'"\r\n]*\b(?:credits|cash_balance)\b[^'"\r\n]*['"]\)/u,
  'member create/update response selects must not unconditionally expose wallet fields',
);

console.log('admin member API data boundary: OK');
