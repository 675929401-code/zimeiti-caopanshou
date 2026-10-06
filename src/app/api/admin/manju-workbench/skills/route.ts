import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  YOUCAI_SKILL_CATALOG,
  YOUCAI_SKILL_CATEGORIES,
} from "@/lib/youcai-skill-catalog";
import { getYoucaiSkillInstruction } from "@/lib/youcai-skill-instructions";
import {
  SkillRepositoryError,
  listAdminSkillPackages,
  normalizeSkillRepositoryError,
} from "@/lib/server/skill-package-repository";
import { loadManjuStorageStates } from "@/lib/server/manju-platform-settings-store";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Authorization, Cookie",
} as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

function normalizeCommandName(commandName: string): string {
  return commandName.trim().replace(/^\/+/u, "").toLowerCase();
}

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return json({ ok: false, code: "AUTH_REQUIRED", error: "未登录" }, 401);
  const actor = await verifyAdminToken(token);
  if (!actor) return json({ ok: false, code: "AUTH_INVALID", error: "登录状态无效或已过期" }, 401);
  if (actor.role !== "admin") {
    return json({ ok: false, code: "ADMIN_REQUIRED", error: "仅管理员可查看漫剧 Skill 治理矩阵" }, 403);
  }
  return null;
}

function skillPromptHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildBaselinePayload() {
  return {
    version: "2026-08-30",
    catalog_source: "youcai-skill-runtime-catalog",
    route: "/youcai/skills",
    admin_route: "/admin?tab=manju-workbench#manju-skill-manager",
    invocation: "explicit-or-intent-routing",
    preserve_user_input: true,
    fail_closed_when_unavailable: true,
    governance: {
      builtin_runtime_catalog: {
        label: "平台内置 Skill",
        scope: "YOUCAI_SKILL_CATALOG + YOUCAI_SKILL_INSTRUCTIONS 的 36 项漫剧运行目录",
        admin_editable: true,
        user_editable: false,
        runtime_connected: true,
        edit_model: "后台 skill 域按命令名发布稀疏覆盖；未覆盖项继续读取内置安全基线",
      },
      user_custom_skill_packages: {
        label: "用户自建 Skill",
        scope: "skill_packages / skill_versions / user_skill_installations",
        admin_editable: true,
        user_editable: true,
        runtime_connected: false,
        edit_model: "用户创建或导入后进入发布包生命周期；通过审核、发布和安装后再接入 Agent",
        package_api: "/api/admin/skill-packages",
        public_api: "/api/youcai/skills",
        install_api: "/api/youcai/skills/install",
        requires_migration: "20260827093000_skill_packages_runtime.sql",
        review_required: true,
      },
    },
    skill_prompt_overrides: Object.fromEntries(
      YOUCAI_SKILL_CATALOG.map((skill) => [
        normalizeCommandName(skill.commandName),
        {
          enabled: true,
          title: skill.title.replaceAll("有彩视界", "漫剧工作台"),
          summary: skill.summary.replaceAll("有彩视界", "漫剧工作台"),
          override_mode: "supplement",
          trigger_terms: [...skill.triggerTerms],
          admin_note: "如需改变该卡片运行提示词，请在本项追加 instruction_override；不填则继续使用内置安全基线。",
        },
      ]),
    ),
    user_skill_policy: {
      allow_create: true,
      allow_import: true,
      require_review_before_public: true,
      default_visibility: "private",
      max_public_resources_per_skill: 128,
      max_prompt_override_bytes: 80000,
    },
    admin_routes: {
      governance: "/admin?tab=manju-workbench#manju-skill-manager",
      config_center: "/admin?tab=manju-workbench#manju-config-center",
      package_admin_api: "/api/admin/skill-packages",
    },
  };
}

async function loadPackageStoreSummary() {
  try {
    const packages = await listAdminSkillPackages({ limit: 200 });
    const byOrigin = packages.reduce<Record<string, number>>((accumulator, entry) => {
      const origin = entry.package.origin || "unknown";
      accumulator[origin] = (accumulator[origin] || 0) + 1;
      return accumulator;
    }, {});
    const byLifecycle = packages.reduce<Record<string, number>>((accumulator, entry) => {
      const lifecycle = entry.package.lifecycle || "unknown";
      accumulator[lifecycle] = (accumulator[lifecycle] || 0) + 1;
      return accumulator;
    }, {});
    return {
      ok: true,
      state: "ready",
      count: packages.length,
      by_origin: byOrigin,
      by_lifecycle: byLifecycle,
      message: "Skill 包控制面可读取；用户自建/导入 Skill 可进入草稿、发布与安装生命周期。",
    };
  } catch (error) {
    const normalized = error instanceof SkillRepositoryError
      ? error
      : normalizeSkillRepositoryError(error, "admin-skill-governance-package-summary");
    return {
      ok: false,
      state: normalized.code === "MIGRATION_NOT_READY" ? "migration_not_ready" : "unavailable",
      code: normalized.code,
      count: 0,
      by_origin: {},
      by_lifecycle: {},
      message: normalized.message,
    };
  }
}

async function loadConfigStoreSummary() {
  try {
    if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      return {
        ok: false,
        state: "service_role_missing",
        code: "MANJU_SERVICE_ROLE_REQUIRED",
        message: "漫剧配置写入需要数据库服务凭据；当前只能读取内置安全基线。",
      };
    }
    const storage = (await loadManjuStorageStates(
      getSupabaseAdminClient(),
      "production",
      ["skill"],
    )).skill;
    return {
      ok: true,
      state: storage.mode,
      mode: storage.mode,
      generation: storage.generation,
      message: `skill 域当前使用 ${storage.mode} 存储，代次 ${storage.generation}。`,
    };
  } catch {
    return {
      ok: false,
      state: "unavailable",
      code: "CONFIG_STORAGE_STATE_UNAVAILABLE",
      message: "漫剧配置存储状态不可读取；请先检查配置表或数据库连接。",
    };
  }
}

export async function GET(request: NextRequest) {
  const authFailure = await requireAdmin(request);
  if (authFailure) return authFailure;

  const categoryLabelByValue = new Map(YOUCAI_SKILL_CATEGORIES.map((item) => [item.value, item.label]));
  const skills = YOUCAI_SKILL_CATALOG.map((skill, index) => {
    const commandName = normalizeCommandName(skill.commandName);
    const instruction = getYoucaiSkillInstruction(commandName);
    return {
      id: skill.id,
      order: index + 1,
      title: skill.title.replaceAll("有彩视界", "漫剧工作台"),
      commandName,
      category: skill.category,
      categoryLabel: categoryLabelByValue.get(skill.category) || skill.categoryLabel,
      source: skill.source,
      sourceLabel: skill.source === "official" ? "平台官方内置" : "公开参考内置",
      version: skill.version,
      author: skill.author.replaceAll("有彩视界", "漫剧工作台"),
      tags: [...skill.tags],
      triggerTerms: [...skill.triggerTerms],
      installedByDefault: skill.installedByDefault,
      agentAutoInvokeEnabled: skill.agentAutoInvokeEnabled,
      summary: skill.summary.replaceAll("有彩视界", "漫剧工作台"),
      governance: {
        lane: "builtin_runtime_catalog",
        adminEditable: true,
        userEditable: false,
        runtimeConnected: Boolean(instruction),
        editTarget: `skill_prompt_overrides.${commandName}`,
        frontRoute: `/youcai/tools/text/text-chat?command=${encodeURIComponent(`/${commandName} `)}`,
        configDomain: "skill",
      },
      instruction: instruction
        ? {
            present: true,
            version: instruction.version,
            provenance: instruction.provenance,
            origin: instruction.origin,
            length: instruction.fullInstruction.length,
            hash: skillPromptHash(instruction.fullInstruction),
          }
        : {
            present: false,
            version: "",
            provenance: "",
            origin: "",
            length: 0,
            hash: "",
          },
    };
  });

  const [packageStore, configStore] = await Promise.all([
    loadPackageStoreSummary(),
    loadConfigStoreSummary(),
  ]);

  return json({
    ok: true,
    version: "manju-skill-governance.v1",
    generatedAt: new Date().toISOString(),
    boundary: {
      page: "漫剧工作台后台 Skill 治理矩阵",
      builtInRule: "36 项内置 Skill 是漫剧工作台运行目录；普通用户只能调用，不能直接改平台内置提示词。",
      customRule: "用户自建 Skill 进入 Skill 包生命周期；用户可定制，管理员可审核、发布、归档。",
      notThis: "不是主站应用广场卡片后台，也不是把主站智能体 Prompt 混入漫剧工作台。",
    },
    counts: {
      total: skills.length,
      officialBuiltIn: skills.filter((skill) => skill.source === "official").length,
      publicReferenceBuiltIn: skills.filter((skill) => skill.source === "community").length,
      runtimeConnected: skills.filter((skill) => skill.governance.runtimeConnected).length,
      userEditableBuiltIn: 0,
      adminEditableBuiltIn: skills.length,
    },
    packageStore,
    configStore,
    baselinePayload: buildBaselinePayload(),
    skills,
  });
}
