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

const registryPath = "src/lib/server/manju-prompt-registry.ts";
const routePath = "src/app/api/admin/manju-workbench/prompts/route.ts";
const inspectorPath = "src/components/admin/ManjuPromptInspector.tsx";

const registry = source(registryPath);
const route = source(routePath);
const inspector = source(inspectorPath);

includesAll("registry:server-only-and-hash", registry, [
  'import "server-only"',
  'createHash("sha256")',
  "MANJU_PROMPT_REGISTRY_VERSION",
]);
includesAll("registry:effective-and-real-sources", registry, [
  "MANGA_CREATIVE_AGENT_SYSTEM_PROMPT",
  "MANGA_CREATIVE_AGENT_PROMPT_VERSION",
  '@/lib/server/manga-creative-agent-system-prompt',
  '@/lib/server/manju-published-prompt',
  "loadPublishedMangaPrompt",
  "manga_effective",
  "release_id",
  'const fromPublishedRelease = effective.source !== "source-fallback"',
  "loadPublishedPromptDomain",
  "loadManjuCompatAdmin",
  'from("manju_config_active")',
  'from("manju_config_revisions")',
  "runtime_authoritative: false",
]);
includesAll("registry:required-record-contract", registry, [
  "id: string",
  "name: string",
  "source: string",
  "version: string",
  "hash: string",
  "editable: boolean",
  "runtime_authoritative: boolean",
  "content: string",
  "edit_target: ManjuPromptEditTarget",
  "runtime_effect: string",
  "release_id?: string | null",
]);
includesAll("registry:explicit-edit-targets", registry, [
  "src/lib/server/manga-creative-agent-system-prompt.data.ts",
  "/admin?tab=manju-workbench",
]);
excludesAll("registry:no-main-site-skill-agent-canvas-mixing", registry, [
  "YOUCAI_SKILL_INSTRUCTIONS",
  'from("agents")',
  'select("id,name,source,system_prompt,updated_at,is_active")',
  "CANVAS_PROMPT_PRESETS_SETTING_KEY",
  "parseCanvasPromptPresetStore",
  "skill_instruction",
  "database_agent",
  "canvas_preset",
  "/admin?tab=agents",
  "/admin?tab=canvas-prompts",
]);
excludesAll("registry:no-sensitive-database-columns", registry, [
  "api_key",
  "coze_coding_api_token",
  "access_token",
  "refresh_token",
  "service_role_key",
]);
const nonHashDatabaseMutation = /\.(?:insert|upsert|delete|rpc)\s*\(/u.test(registry)
  || (registry.match(/\.update\s*\(/gu)?.length ?? 0) !== 1
  || !registry.includes('createHash("sha256").update(content, "utf8")');
add(
  "registry:read-only-database-access",
  !nonHashDatabaseMutation,
  nonHashDatabaseMutation ? "mutating database operation found" : "select-only database access",
);
add(
  "registry:no-console-output",
  !/\bconsole\s*\./u.test(registry),
  /\bconsole\s*\./u.test(registry) ? "console output found" : "no prompt logging path",
);

includesAll("route:admin-jwt", route, [
  "getTokenFromHeaders",
  "verifyAdminToken",
  'actor.role !== "admin"',
  'code: "AUTH_REQUIRED"',
  'code: "AUTH_INVALID"',
  'code: "ADMIN_REQUIRED"',
]);
includesAll("route:private-no-store", route, [
  '"Cache-Control": "private, no-store, max-age=0, must-revalidate"',
  'Pragma: "no-cache"',
  'Vary: "Authorization, Cookie"',
]);
includesAll("route:server-registry-load", route, [
  "loadManjuPromptRegistry",
  "getSupabaseAdminClient",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  "export async function GET",
]);
excludesAll("route:no-mutation-handlers", route, [
  "export async function POST",
  "export async function PUT",
  "export async function PATCH",
  "export async function DELETE",
]);
add(
  "route:no-console-output",
  !/\bconsole\s*\./u.test(route),
  /\bconsole\s*\./u.test(route) ? "console output found" : "no prompt logging path",
);

includesAll("inspector:read-only-fetch", inspector, [
  'fetch("/api/admin/manju-workbench/prompts"',
  'method: "GET"',
  'Authorization: `Bearer ${token}`',
  'cache: "no-store"',
]);
includesAll("inspector:search-expand-copy", inspector, [
  'type="search"',
  "visiblePrompts",
  "<details",
  "prompt.content",
  "navigator.clipboard",
  "复制全文",
]);
includesAll("inspector:edit-location-and-boundary", inspector, [
  "edit_target",
  "admin_route",
  "source_file",
  "本检查器本身永远只读",
  "不会混入主站智能体卡片、Skill 应用广场或通用画布方案",
  "漫剧 Agent 当前实际生效提示词",
  "代码回退基线",
  "effectiveMangaPrompt.release_id",
  "当前已发布 Manju prompt 域",
  "实际生效说明",
]);
excludesAll("inspector:no-main-site-skill-agent-canvas-copy", inspector, [
  "可信 Skill 指令、数据库 Agent 的 system_prompt，以及画布已发布方案",
  "skill_instruction",
  "database_agent",
  "canvas_preset",
]);
excludesAll("inspector:no-mutating-request", inspector, [
  'method: "POST"',
  'method: "PUT"',
  'method: "PATCH"',
  'method: "DELETE"',
]);

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "manju-prompt-registry",
  mode: "offline-static-only",
  passed: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;
