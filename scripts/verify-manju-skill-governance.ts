import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function source(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  const exists = existsSync(absolutePath);
  add(`file:${relativePath}`, exists, exists ? "present" : "missing");
  return exists ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, text: string, tokens: readonly string[]) {
  const missing = tokens.filter((token) => !text.includes(token));
  add(
    name,
    missing.length === 0,
    missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`,
  );
}

function excludesAll(name: string, text: string, tokens: readonly string[]) {
  const present = tokens.filter((token) => text.includes(token));
  add(
    name,
    present.length === 0,
    present.length === 0 ? "forbidden tokens absent" : `present: ${present.join(", ")}`,
  );
}

const managerPath = "src/components/admin/ManjuSkillManager.tsx";
const customPackageManagerPath = "src/components/admin/ManjuCustomSkillPackageManager.tsx";
const adminTabPath = "src/components/admin/ManjuWorkbenchAdminTab.tsx";
const routePath = "src/app/api/admin/manju-workbench/skills/route.ts";
const configCenterPath = "src/components/admin/ManjuConfigCenter.tsx";
const seedPath = "src/lib/server/manju-production-seed.ts";
const runtimeConfigPath = "src/lib/server/manju-runtime-config.ts";
const publishedGovernancePath = "src/lib/server/manju-published-skill-governance.ts";
const orchestratorPath = "src/lib/server/manga-skill-orchestrator.ts";
const llmRoutePath = "src/app/api/llm/route.ts";

const manager = source(managerPath);
const customPackageManager = source(customPackageManagerPath);
const adminTab = source(adminTabPath);
const route = source(routePath);
const configCenter = source(configCenterPath);
const seed = source(seedPath);
const runtimeConfig = source(runtimeConfigPath);
const publishedGovernance = source(publishedGovernancePath);
const orchestrator = source(orchestratorPath);
const llmRoute = source(llmRoutePath);

includesAll("manager:visible-governance-matrix", manager, [
  "漫剧 Skill 治理矩阵",
  "平台内置 Skill",
  "用户自建 Skill",
  "userEditable: boolean",
  "runtimeConnected",
  "skill.governance.editTarget",
  "skill_prompt_overrides",
  "前台测试",
  "去配置中心",
]);
includesAll("manager:card-level-edit-publish", manager, [
  "fetchSkillConfig",
  "saveSkillDraft",
  "直接编辑本卡",
  "保存草稿",
  "保存并发布",
  "下线并发布",
  "expected_storage_generation",
  "/api/admin/manju-config",
]);
includesAll("admin-tab:skill-manager-mounted", adminTab, [
  "ManjuSkillManager",
  "ManjuCustomSkillPackageManager",
  "Skill 治理矩阵",
  "<ManjuSkillManager token={token} />",
  "<ManjuCustomSkillPackageManager token={token} />",
]);
includesAll("custom-package-manager:admin-lifecycle-entry", customPackageManager, [
  "用户自建 / 导入 Skill 包",
  "/api/admin/skill-packages?limit=80",
  "新增 Skill",
  "校验结构",
  "保存草稿",
  "发布",
  "回滚到此版本",
  "MIGRATION_NOT_READY",
]);
includesAll("custom-package-manager:clear-boundary", customPackageManager, [
  "和上方 36 张平台内置 Skill 卡片分离",
  "不能把“新增 Skill”伪装成已保存",
  "当前只允许“校验结构”，不允许假保存",
  "不把未发布内容硬塞进前台",
]);
includesAll("route:admin-only-and-catalog-backed", route, [
  "getTokenFromHeaders",
  "verifyAdminToken",
  'actor.role !== "admin"',
  "YOUCAI_SKILL_CATALOG",
  "getYoucaiSkillInstruction",
  "listAdminSkillPackages",
  "loadManjuStorageStates",
  "configStore",
  "baselinePayload",
  "skill_prompt_overrides",
  "用户自建 Skill",
  "平台内置 Skill",
]);
includesAll("config-center:skill-template-entry", configCenter, [
  "loadSkillBaseline",
  "/api/admin/manju-workbench/skills",
  "载入 36 项 Skill 管理模板",
  'id="manju-config-center"',
]);
includesAll("seed:skill-domain-governed", seed, [
  'catalog_source: "youcai-skill-runtime-catalog"',
  'admin_route: "/admin?tab=manju-workbench#manju-skill-manager"',
  "builtin_runtime_catalog",
  "user_custom_skill_packages",
  "skill_prompt_overrides",
  "20260827093000_skill_packages_runtime.sql",
]);
includesAll("runtime-config:skill-domain-schema-gate", runtimeConfig, [
  "validateManjuSkillContract",
  "MANJU_SKILL_PAYLOAD_FIELDS",
  "MANJU_SKILL_OVERRIDE_FIELDS",
  "SKILL_BUILTIN_BOUNDARY_INVALID",
  "SKILL_CUSTOM_BOUNDARY_INVALID",
  'domain === "skill"',
]);
includesAll("published-governance:server-runtime-loader", publishedGovernance, [
  'import "server-only"',
  "loadPublishedMangaSkillGovernance",
  "skill_prompt_overrides",
  "published-native",
  "published-compat",
  "source-fallback",
  "validateManjuDomainContract",
]);
includesAll("orchestrator:published-skill-governance-applied", orchestrator, [
  "PublishedMangaSkillGovernance",
  "renderPublishedSkillGovernanceBlock",
  "SKILL_DISABLED",
  "publishedOverride?.enabled === false",
  "instructionOverride",
]);
includesAll("llm-route:loads-skill-governance-before-agent-call", llmRoute, [
  "loadPublishedMangaSkillGovernance",
  "ManjuPublishedSkillGovernanceUnavailableError",
  "publishedSkillGovernance",
  "resolveMangaSkillOrchestration(",
]);
excludesAll("route:no-mutation-handlers", route, [
  "export async function POST",
  "export async function PUT",
  "export async function PATCH",
  "export async function DELETE",
]);

const failed = checks.filter((check) => !check.passed);
console.log(JSON.stringify({
  ok: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
  failed,
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}
