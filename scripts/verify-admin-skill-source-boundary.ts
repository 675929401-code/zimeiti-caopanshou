import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADMIN_PERMISSION_CATALOG,
  ADMIN_SKILL_SOURCE_PERMISSIONS,
  ADMIN_SKILL_WRITE_PERMISSIONS,
  adminRequirementForRequest,
  adminSkillSourceRequested,
} from "../src/lib/admin-governance";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function section(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
}

function assertCriticalPermission(key: string): void {
  const permission = ADMIN_PERMISSION_CATALOG.find((item) => item.key === key);
  assert.ok(permission, `${key} must exist in the admin permission catalog`);
  assert.equal(permission.risk, "critical", `${key} must remain critical`);
  assert.equal(permission.stepUpRequired, true, `${key} must require step-up`);
}

const noSource = new URLSearchParams();
const fullSource = new URLSearchParams("include_source=1");
assert.equal(adminSkillSourceRequested(noSource), false);
assert.equal(adminSkillSourceRequested(fullSource), true);
assert.equal(adminSkillSourceRequested(new URLSearchParams("include_source=true")), true);
assert.equal(adminSkillSourceRequested(new URLSearchParams("include_source=0")), false);

assertCriticalPermission(ADMIN_SKILL_SOURCE_PERMISSIONS.skills);
assertCriticalPermission(ADMIN_SKILL_SOURCE_PERMISSIONS.skillPackages);
assertCriticalPermission(ADMIN_SKILL_WRITE_PERMISSIONS.skills);
assertCriticalPermission(ADMIN_SKILL_WRITE_PERMISSIONS.skillPackages);

assert.deepEqual(adminRequirementForRequest("/api/admin/skills", "GET", noSource), {
  permission: "agents.view",
  requireStepUp: false,
  operation: "skill_metadata_view",
});
assert.deepEqual(adminRequirementForRequest("/api/admin/skills", "GET", fullSource), {
  permission: "internal_tools.manage",
  requireStepUp: true,
  operation: "skill_source_view",
});
assert.deepEqual(adminRequirementForRequest("/api/admin/skill-packages", "GET", noSource), {
  permission: "agents.view",
  requireStepUp: false,
  operation: "skill_package_metadata_view",
});
assert.deepEqual(adminRequirementForRequest("/api/admin/skill-packages", "GET", fullSource), {
  permission: "prompts.view",
  requireStepUp: true,
  operation: "skill_package_source_view",
});
for (const method of ["POST", "PUT", "DELETE"]) {
  assert.deepEqual(adminRequirementForRequest("/api/admin/skills", method, fullSource), {
    permission: "internal_tools.manage",
    requireStepUp: true,
    operation: "skills_manage",
  });
}
assert.deepEqual(adminRequirementForRequest("/api/admin/skill-packages", "POST", fullSource), {
  permission: "prompts.edit",
  requireStepUp: true,
  operation: "skill_packages_manage",
});

const skillsRoute = source("src/app/api/admin/skills/route.ts");
const skillsMetadataMapper = section(skillsRoute, "function toSkillMetadata", "// ── GET");
for (const forbidden of ["config", "tool_definition", "trigger_signals", "instructions"]) {
  assert.doesNotMatch(skillsMetadataMapper, new RegExp(`\\b${forbidden}\\b`, "u"), `legacy Skill metadata leaked ${forbidden}`);
}
for (const required of [
  "SKILL_METADATA_COLUMNS",
  "adminSkillSourceRequested",
  "authorizeAdminCapability",
  "ADMIN_SKILL_SOURCE_PERMISSIONS.skills",
  "ADMIN_SKILL_WRITE_PERMISSIONS.skills",
  'sourceAccess: "protected"',
  'includeSource ? "visible" : "protected"',
]) {
  assert.ok(skillsRoute.includes(required), `legacy Skill route missing ${required}`);
}
assert.match(skillsRoute, /\.select\(includeSource \? "\*" : SKILL_METADATA_COLUMNS\)/u);
assert.doesNotMatch(skillsRoute, /\bsourcePermission\b|\bsourceStepUpRequired\b/u);
assert.equal(skillsRoute.match(/authorizeAdminCapability\(request, ADMIN_SKILL_WRITE_PERMISSIONS\.skills, \{/gu)?.length, 3);

const packageRoute = source("src/app/api/admin/skill-packages/route.ts");
const packageMetadataMapper = section(packageRoute, "function toSkillPackageMetadata", "function invalid");
for (const forbidden of ["payload", "metadata", "instructions", "config", "tool_definition", "trigger_signals"]) {
  assert.doesNotMatch(packageMetadataMapper, new RegExp(`\\b${forbidden}\\b`, "u"), `Skill package metadata leaked ${forbidden}`);
}
for (const required of [
  "adminSkillSourceRequested",
  "authorizeAdminCapability",
  "ADMIN_SKILL_SOURCE_PERMISSIONS.skillPackages",
  "ADMIN_SKILL_WRITE_PERMISSIONS.skillPackages",
  "packages: includeSource ? packages : packages.map(toSkillPackageMetadata)",
  'sourceAccess: includeSource ? "visible" : "protected"',
  "requireStepUp: true",
]) {
  assert.ok(packageRoute.includes(required), `Skill package route missing ${required}`);
}
assert.doesNotMatch(packageRoute, /\bsourcePermission\b|\bsourceStepUpRequired\b/u);

const component = source("src/components/admin/ManjuCustomSkillPackageManager.tsx");
for (const required of [
  "/api/admin/skill-packages?limit=80&include_source=1",
  'body.sourceAccess !== "visible"',
  'body.code === "ADMIN_STEP_UP_REQUIRED"',
  'body.code === "ADMIN_PERMISSION_DENIED"',
  "clearProtectedPackageState();",
  "需解锁敏感操作",
  "无核心源权限",
]) {
  assert.ok(component.includes(required), `Skill package editor missing ${required}`);
}

console.log(JSON.stringify({
  passed: true,
  checks: [
    "ordinary agents.view maps to metadata-only responses",
    "legacy Skill source requires internal_tools.manage plus step-up",
    "Skill package source requires prompts.view plus step-up",
    "legacy Skill writes require internal_tools.manage plus step-up",
    "Skill package writes require prompts.edit plus step-up",
    "metadata DTOs omit source fields",
    "editor explicitly requests source and clears protected state on denial",
  ],
  databaseReads: 0,
  databaseWrites: 0,
  networkRequests: 0,
}, null, 2));
