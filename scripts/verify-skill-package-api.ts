import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

function add(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function source(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  const present = existsSync(absolutePath);
  add(`file:${relativePath}`, present, present ? "present" : "missing");
  return present ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, text: string, tokens: string[]): void {
  const missing = tokens.filter((token) => !text.includes(token));
  add(
    name,
    missing.length === 0,
    missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`,
  );
}

function excludesAll(name: string, text: string, tokens: string[]): void {
  const found = tokens.filter((token) => text.includes(token));
  add(name, found.length === 0, found.length === 0 ? "forbidden tokens absent" : `found: ${found.join(", ")}`);
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = text.indexOf(end, startIndex + start.length);
  return endIndex < 0 ? text.slice(startIndex) : text.slice(startIndex, endIndex);
}

const paths = {
  contract: "src/lib/server/skill-package-contract.ts",
  repository: "src/lib/server/skill-package-repository.ts",
  policy: "src/lib/server/skill-policy.ts",
  invocation: "src/lib/server/skill-invocation-service.ts",
  publicList: "src/app/api/youcai/skills/route.ts",
  publicDetail: "src/app/api/youcai/skills/[slug]/route.ts",
  install: "src/app/api/youcai/skills/install/route.ts",
  uninstall: "src/app/api/youcai/skills/[slug]/uninstall/route.ts",
  admin: "src/app/api/admin/skill-packages/route.ts",
} as const;

const contract = source(paths.contract);
const repository = source(paths.repository);
const policy = source(paths.policy);
const invocation = source(paths.invocation);
const publicList = source(paths.publicList);
const publicDetail = source(paths.publicDetail);
const install = source(paths.install);
const uninstall = source(paths.uninstall);
const admin = source(paths.admin);

includesAll("contract:package-payload", contract, [
  "SkillPackagePayloadSchema",
  "manifest",
  "instructions",
  "input_schema",
  "output_schema",
  "execution_type",
  "sanitized_config",
  "routing",
  "orchestration",
  "tools",
  "resources",
  "provenance",
]);
includesAll("contract:provenance-vocabulary", contract, [
  "oss_public_source",
  "public_contract_reimplementation",
  "internal_original",
]);
excludesAll("contract:no-obsolete-provenance", contract, ["oss_exact"]);
includesAll("contract:sensitive-data-defense", contract, [
  "INLINE_SECRET_FORBIDDEN",
  "INSTALL_SECRET_BINDING_FORBIDDEN",
  "[REDACTED_SECRET_REFERENCE]",
  "secret|vault|env|supabase-vault",
  "SKILL_PAYLOAD_MAX_BYTES",
  "SKILL_PAYLOAD_MAX_DEPTH",
]);
includesAll("contract:migration-aligned-version-labels", contract, [
  'SKILL_PACKAGE_SCHEMA_VERSION = "1.0.0"',
  "Skill 版本号必须是合法 semver",
  "Skill schema 版本格式不合法",
  ".max(80)",
]);

const publicInterface = between(contract, "export interface PublicSkillPackage", "export const SkillListQuerySchema");
includesAll("public-dto:documented-safe-fields", publicInterface, [
  "inputSchema",
  "outputSchema",
  "resources",
  "provenance",
  "publishedAt",
]);
excludesAll("public-dto:no-runtime-secrets", publicInterface, [
  "instructions:",
  "sanitizedConfig:",
  "install_config:",
  "secret_ref:",
  "content:",
]);

const publicMapper = between(contract, "export function toPublicSkillPackage", "export function parseSkillActor");
includesAll("public-mapper:redacts-schemas-and-resources", publicMapper, [
  "sanitizeJsonForResponse(payload.input_schema, false)",
  "sanitizeJsonForResponse(payload.output_schema, false)",
  "sanitizeJsonForResponse(payload.provenance, false)",
  "resource.checksum",
]);
excludesAll("public-mapper:no-hidden-instructions-or-resource-body", publicMapper, [
  "payload.instructions",
  "resource.content",
  "resource.url",
  "payload.sanitized_config",
]);

includesAll("repository:migration-tables", repository, [
  "skill_packages",
  "skill_versions",
  "user_skill_installations",
  "skill_invocations",
]);
includesAll("repository:release-only-and-integrity", repository, [
  '.eq("lifecycle", "published")',
  '.eq("status", "released")',
  "payload_hash",
  "skillPayloadHash(payload)",
  "SKILL_PACKAGE_CORRUPT",
]);
includesAll("repository:service-role-and-migration-fail-closed", repository, [
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_REQUIRED",
  "MIGRATION_NOT_READY",
  "PGRST202",
  "PGRST205",
]);
includesAll("repository:release-rpcs", repository, [
  "save_skill_package_draft",
  "publish_skill_version",
  "rollback_skill_package_version",
]);
includesAll("repository:installation-rpcs", repository, [
  "replace_agent_skill_installations",
  "replace_user_skill_installations",
  "replaceAgentSkillInstallations",
  "replaceUserSkillInstallations",
]);
includesAll("repository:user-installation-owner-binding", repository, [
  "user_id: input.actor.userId",
  '.eq("user_id", input.actor.userId)',
  '{ onConflict: "user_id,package_id" }',
  "validateSkillInstallConfig",
]);
includesAll("repository:active-release-install-only", repository, [
  "versionId !== packageItem.active_version_id",
  "只能安装当前发布版本",
]);

includesAll("policy:explicit-auto-routing", policy, [
  "resolveSkillSelection",
  "explicitRequested",
  "negativeTriggerSignals",
  "maxAutoSkills",
  "AUTO_LIMIT",
  "buildSkillExecutionContexts",
]);
includesAll("policy:server-only-instruction-context", policy, [
  "instructions: payload.instructions",
  "orchestration: payload.orchestration",
  "tools: payload.tools",
  "sanitizedConfig: payload.sanitized_config",
]);

includesAll("invocation:public-integration-surface", invocation, [
  "prepareSkillInvocationContext",
  "claimSkillInvocation",
  "completeSkillInvocation",
  "failSkillInvocation",
]);
includesAll("invocation:atomic-rpcs", invocation, [
  "claim_skill_invocation",
  "complete_skill_invocation",
  "fail_skill_invocation",
]);
includesAll("invocation:idempotency-and-identity", invocation, [
  "clientIdempotencyKey",
  "payloadFingerprint",
  "verifyInvocationIdentity",
  "SKILL_CONFLICT",
]);
includesAll("invocation:rpc-envelope-fail-closed", invocation, [
  "envelope.ok !== true",
  "Skill 原子状态机未确认成功",
]);

for (const [name, route] of Object.entries({ publicList, publicDetail, install, uninstall, admin })) {
  includesAll(`route:${name}:no-store-node`, route, ['runtime = "nodejs"', 'dynamic = "force-dynamic"', '"Cache-Control": "no-store"']);
  excludesAll(`route:${name}:no-third-party-runtime`, route, ["youcai.art", "fetch("]);
}

includesAll("public-routes:published-redacted-only", `${publicList}\n${publicDetail}`, [
  "listPublishedSkillPackages",
  "getPublishedSkillPackageBySlug",
  "toPublicSkillPackage",
]);
includesAll("public-detail:bounded-safe-slug", publicDetail, [
  "decodeURIComponent",
  "slug.length > 80",
  "INVALID_REQUEST",
]);
excludesAll("public-routes:no-internal-payload-fields", `${publicList}\n${publicDetail}`, [
  "instructions",
  "sanitized_config",
  "secret_ref",
  "install_config",
]);
includesAll("user-routes:verified-auth-and-persistence", `${install}\n${uninstall}`, [
  "getTokenFromHeaders",
  "verifyToken",
  "installUserSkill",
  "uninstallUserSkill",
]);
includesAll("admin-route:verified-admin-and-actions", admin, [
  "authorizeAdminCapability",
  "ADMIN_SKILL_SOURCE_PERMISSIONS.skillPackages",
  "ADMIN_SKILL_WRITE_PERMISSIONS.skillPackages",
  "adminSkillSourceRequested",
  "requireStepUp: true",
  "sourceAccess",
  "SkillAdminActionSchema",
  "executeAdminSkillAction",
  "listAdminSkillPackages",
]);
excludesAll("admin-route:no-permission-key-disclosure", admin, ["sourcePermission", "sourceStepUpRequired"]);

const allRuntimeSources = [contract, repository, policy, invocation, publicList, publicDetail, install, uninstall, admin].join("\n");
excludesAll("runtime:no-client-secret-literals", allRuntimeSources, [
  "SUPABASE_SERVICE_ROLE_KEY=",
  "Bearer eyJ",
  "sk-",
  "api_key:",
]);

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "skill-package-api",
  mode: "offline-static-zero-network-zero-cost",
  passed: failed.length === 0,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
