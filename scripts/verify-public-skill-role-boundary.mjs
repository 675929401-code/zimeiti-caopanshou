import assert from 'node:assert/strict';
import fs from 'node:fs';

function source(file) {
  return fs.readFileSync(file, 'utf8');
}

const repository = source('src/lib/server/skill-package-repository.ts');
const policy = source('src/lib/server/skill-policy.ts');
const publicList = source('src/app/api/youcai/skills/route.ts');
const publicDetail = source('src/app/api/youcai/skills/[slug]/route.ts');
const adminControl = source('src/app/api/admin/skill-packages/route.ts');
const concealmentE2e = source('scripts/verify-admin-role-concealment-live.mjs');

assert.doesNotMatch(
  repository,
  /function canReadPackage[\s\S]{0,500}actor\?\.role === ["']admin["']/u,
  'public/business Skill repository must not treat an administrator as an internal catalog reader',
);
assert.match(repository, /row\.visibility === "public"/u);
assert.match(repository, /row\.visibility === "tenant"[\s\S]{0,100}Boolean\(actor\)/u);
assert.match(repository, /row\.created_by === actor\.userId/u);

assert.doesNotMatch(
  policy,
  /function isSkillAvailableForActor[\s\S]{0,900}actor\?\.role === ["']admin["']/u,
  'runtime Skill selection must not treat an administrator as automatically installed or available',
);
assert.match(policy, /packageRow\.visibility === "private" && packageRow\.created_by !== actor\?\.userId/u);
assert.match(policy, /skill\.installation[\s\S]{0,80}skill\.installation\.enabled/u);

assert.match(publicList, /listPublishedSkillPackages\(\{ actor, query: parsed\.data \}\)/u);
assert.match(publicDetail, /getPublishedSkillPackageBySlug\(slug, actor\)/u);
assert.match(adminControl, /authorizeAdminCapability\(/u);
assert.match(adminControl, /ADMIN_SKILL_SOURCE_PERMISSIONS\.skillPackages/u);
assert.match(adminControl, /ADMIN_SKILL_WRITE_PERMISSIONS\.skillPackages/u);

assert.match(
  concealmentE2e,
  /uniquePermissionKeys: new Set\(superSelf\.access\.permissionKeys\)\.size/u,
  'live report must derive the permission count from the current catalog instead of a stale literal',
);
assert.doesNotMatch(concealmentE2e, /uniquePermissionKeys:\s*30/u);

console.log(JSON.stringify({
  passed: true,
  checks: [
    'public Skill listing and detail treat employee administrators as ordinary product accounts',
    'runtime Skill selection still requires ownership, installation or public implicit-install policy',
    'private Skill control plane remains behind explicit read/write capabilities',
    'live concealment report computes its unique permission count from the current catalog',
  ],
  networkCalls: 0,
  databaseWrites: 0,
}, null, 2));
