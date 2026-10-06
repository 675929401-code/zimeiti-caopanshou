import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { YOUCAI_SKILL_CATALOG } from "../src/lib/youcai-skill-catalog";

const root = process.cwd();
const pagePath = resolve(root, "src/features/youcai-skills/youcai-skills-page.tsx");
const apiPath = resolve(root, "src/features/youcai-skills/youcai-skill-api.ts");
const pageSource = readFileSync(pagePath, "utf8");
const apiSource = readFileSync(apiPath, "utf8");
const combined = `${pageSource}\n${apiSource}`;

function includesAll(source: string, values: readonly string[], message: string): void {
  for (const value of values) assert.ok(source.includes(value), `${message}: ${value}`);
}

assert.equal(YOUCAI_SKILL_CATALOG.length, 36, "Agent 内置目录必须继续提供 36 项 Skill");
const commands = YOUCAI_SKILL_CATALOG.map((skill) => skill.commandName);
assert.equal(new Set(commands).size, commands.length, "内置 Skill 命令必须唯一");
assert.ok(YOUCAI_SKILL_CATALOG.every((skill) => skill.commandName && !skill.commandName.startsWith("/")), "静态命令应使用无斜杠规范值");

includesAll(apiSource, [
  'fetch("/api/youcai/skills?limit=100"',
  'fetch("/api/youcai/skills/install"',
  '/uninstall`',
  'credentials: "same-origin"',
  'cache: "no-store"',
], "Skill UI 客户端必须使用真实同源生命周期 API");

includesAll(apiSource, [
  'error.code === "MIGRATION_NOT_READY"',
  'error.code === "AUTH_REQUIRED"',
  'error.code === "UNAUTHENTICATED"',
  "当前仅展示内置 Skill 目录，未写入安装状态",
], "失败状态必须精确可见且回退不伪造安装");

includesAll(pageSource, [
  "listPublishedSkills(state.auth.token",
  "installPublishedSkill(skill.package.packageId, state.auth.token)",
  "uninstallPublishedSkill(skill.package.packageId, state.auth.token)",
  "installed: Boolean(skillPackage?.installed)",
  "内置 Skill 目录",
  "不代表已安装到用户账户",
  "不把内置目录伪装成已安装",
], "页面必须区分服务端安装状态与内置目录");

includesAll(pageSource, [
  "来源与版本",
  "权限要求",
  "公开输出契约",
  "permissionSummary(selectedSkill.package)",
  "schemaSummary(selectedSkill.package.outputSchema)",
  "formatPublishedAt(selectedSkill.package.publishedAt)",
], "发布包详情必须提供可公开审计摘要");

includesAll(pageSource, [
  "agentReady: true",
  "agentReady: false",
  "尚未进入 Agent 内置运行目录",
  "router.push(`/tools/text/text-chat?command=",
], "36 项内置命令应可调度，未知发布包不得伪装运行时已接线");

for (const forbidden of [
  "youcai_installed_community_skills_v1",
  "INSTALL_STORAGE_KEY",
  "localStorage.setItem",
  "localStorage.getItem",
]) {
  assert.ok(!combined.includes(forbidden), `不得保留浏览器伪安装实现: ${forbidden}`);
}

for (const forbiddenEndpoint of [
  "youcai.art/api",
  "/api/llm",
  "/api/image/generate",
  "/api/video/generate",
  "/api/payment",
]) {
  assert.ok(!combined.includes(forbiddenEndpoint), `Skill 生命周期 UI 不应触发生成、计费或第三方接口: ${forbiddenEndpoint}`);
}

assert.ok(!/system\s*prompt|hidden\s*prompt|api[_-]?key|secret[_-]?key/i.test(combined), "公开 Skill UI 不应包含隐藏提示词或密钥字段");

console.log(JSON.stringify({
  ok: true,
  builtinSkillCount: YOUCAI_SKILL_CATALOG.length,
  uniqueCommandCount: new Set(commands).size,
  lifecycleApi: {
    list: "GET /api/youcai/skills",
    install: "POST /api/youcai/skills/install",
    uninstall: "DELETE /api/youcai/skills/:packageId/uninstall",
  },
  browserFakeInstallReferences: 0,
  paidOrGenerationRequests: 0,
  thirdPartyRuntimeRequests: 0,
}, null, 2));
