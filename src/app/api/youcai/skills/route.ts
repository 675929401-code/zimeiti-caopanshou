import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import {
  SkillListQuerySchema,
  type SkillActor,
  type SkillListQuery,
} from "@/lib/server/skill-package-contract";
import {
  SkillRepositoryError,
  listPublishedSkillPackages,
  normalizeSkillRepositoryError,
} from "@/lib/server/skill-package-repository";
import { YOUCAI_SKILL_CATALOG } from "@/lib/youcai-skill-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function failure(error: unknown): NextResponse {
  const normalized =
    error instanceof SkillRepositoryError
      ? error
      : normalizeSkillRepositoryError(error, "public-list");
  return json(
    { ok: false, code: normalized.code, error: normalized.message, operation: normalized.operation },
    normalized.status,
  );
}

function invalid(error: z.ZodError): NextResponse {
  return json(
    {
      ok: false,
      code: "INVALID_REQUEST",
      error: "Skill 查询参数不合法",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
    400,
  );
}

function normalizeCommandName(commandName: string): string {
  return commandName.trim().replace(/^\/+/u, "").toLowerCase();
}

function buildBuiltinCatalogItems(query?: SkillListQuery) {
  const needle = query?.q?.toLocaleLowerCase("zh-CN");
  return YOUCAI_SKILL_CATALOG.map((skill, index) => {
    const commandName = normalizeCommandName(skill.commandName);
    return {
      id: skill.id,
      order: index + 1,
      source: skill.source,
      source_label: skill.source === "official" ? "平台官方内置" : "公开参考内置",
      title: skill.title.replaceAll("有彩视界", "漫剧工作台"),
      commandName,
      command_name: commandName,
      category: skill.category,
      category_label: skill.categoryLabel,
      tags: [...skill.tags],
      trigger_terms: [...skill.triggerTerms],
      version: skill.version,
      author: skill.author.replaceAll("有彩视界", "漫剧工作台"),
      summary: skill.summary.replaceAll("有彩视界", "漫剧工作台"),
      price_credits: skill.priceCredits,
      installed_by_default: skill.installedByDefault,
      agent_auto_invoke_enabled: skill.agentAutoInvokeEnabled,
      runtime_kind: "prompt",
      installed: false,
      enabled: true,
      editable_by_admin: true,
      editable_by_user: false,
      front_route: `/youcai/tools/text/text-chat?command=${encodeURIComponent(`/${commandName} `)}`,
      admin_edit_target: `skill_prompt_overrides.${commandName}`,
    };
  }).filter((item) => {
    if (query?.source && query.source !== "builtin") return false;
    if (query?.category && item.category !== query.category) return false;
    if (query?.tag && !item.tags.includes(query.tag)) return false;
    if (!needle) return true;
    return [
      item.title,
      item.commandName,
      item.category,
      item.category_label,
      item.summary,
      ...item.tags,
      ...item.trigger_terms,
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(needle));
  }).slice(0, query?.limit ?? 50);
}

function builtinCatalogResponse(
  query: SkillListQuery,
  packageStore: Record<string, unknown>,
): NextResponse {
  const builtinItems = buildBuiltinCatalogItems(query);
  return json({
    ok: true,
    mode: "builtin_runtime_catalog",
    catalog_count: builtinItems.length,
    package_count: 0,
    skills: [],
    count: builtinItems.length,
    package_store: packageStore,
    builtin_catalog: {
      state: "available",
      count: builtinItems.length,
      items: builtinItems,
      rule: "内置 Skill 目录继续由前端静态目录和漫剧 skill 域治理配置提供；不伪造用户安装状态。",
    },
  });
}

async function optionalActor(request: NextRequest): Promise<SkillActor | null | NextResponse> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return json({ ok: false, code: "UNAUTHENTICATED", error: "登录状态无效" }, 401);
  return { userId: payload.userId, role: payload.role, displayName: payload.displayName };
}

export async function GET(request: NextRequest) {
  const actor = await optionalActor(request);
  if (actor instanceof NextResponse) return actor;
  const url = new URL(request.url);
  const parsed = SkillListQuerySchema.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return invalid(parsed.error);
  try {
    const skills = await listPublishedSkillPackages({ actor, query: parsed.data });
    if (skills.length === 0) {
      return builtinCatalogResponse(parsed.data, {
        state: "ready_empty",
        message: "当前没有已发布的可安装 Skill 包；继续提供平台内置目录。",
      });
    }
    return json({ ok: true, skills, count: skills.length });
  } catch (error) {
    const normalized =
      error instanceof SkillRepositoryError
        ? error
        : normalizeSkillRepositoryError(error, "public-list");
    if (normalized.code === "MIGRATION_NOT_READY") {
      return builtinCatalogResponse(parsed.data, {
          state: "migration_not_ready",
          code: normalized.code,
          operation: normalized.operation,
          message: normalized.message,
      });
    }
    return failure(error);
  }
}
