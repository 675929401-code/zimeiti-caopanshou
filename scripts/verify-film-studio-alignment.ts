import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FILM_STUDIO_ENTRY_CARDS,
  FILM_STUDIO_WORKFLOW,
} from "../src/features/youcai-film-studio/navigation";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function verifyPortalContract(): void {
  assert.deepEqual(
    FILM_STUDIO_ENTRY_CARDS.map(({ key, href, status }) => ({ key, href, status })),
    [
      { key: "爽剧", href: "/youcai/tools/film-studio/create/drama-script", status: "available" },
      { key: "通用短剧", href: "/youcai/tools/film-studio/create/general-script", status: "available" },
      { key: "正剧", href: null, status: "coming-soon" },
      { key: "上传剧本", href: "/youcai/tools/film-studio/create/upload-script", status: "available" },
    ],
  );
  assert.equal(FILM_STUDIO_ENTRY_CARDS[2].description, "即将上线 · 单集 10+ 分钟的传统剧本");
  assert.deepEqual(FILM_STUDIO_WORKFLOW, ["剧本", "角色", "场景", "道具", "分镜", "视频"]);

  const portal = read("src/features/youcai-film-studio/youcai-film-studio-portal.tsx");
  assert.match(portal, /READ_ONLY_PROJECTS_ENDPOINT\s*=\s*"\/api\/drama\/projects"/);
  assert.match(portal, /Array\.isArray\(payload\.data\)\) source = payload\.data/);
  assert.match(portal, /搜索项目名称/);
  assert.match(portal, /全部剧种/);
  assert.match(portal, /最近更新/);

  const alias = read("src/app/api/drama/projects/route.ts");
  assert.match(alias, /@\/app\/api\/short-drama\/projects\/route/);
  assert.match(alias, /\bGET\b/);
}

function verifyEntryPages(): void {
  const pages = [
    ["src/app/youcai/tools/text/drama-script/page.tsx", "YoucaiDramaScriptWizard"],
    ["src/app/youcai/tools/text/general-script/page.tsx", "YoucaiGeneralScript"],
    ["src/app/youcai/tools/text/upload-script/page.tsx", "YoucaiUploadScript"],
  ] as const;
  for (const [path, component] of pages) {
    assert.match(read(path), new RegExp(component));
  }

  const canonicalCreatePages = [
    [
      "src/app/youcai/tools/film-studio/create/drama-script/page.tsx",
      "YoucaiDramaScriptWizard",
    ],
    [
      "src/app/youcai/tools/film-studio/create/general-script/page.tsx",
      "YoucaiGeneralScript",
    ],
    [
      "src/app/youcai/tools/film-studio/create/upload-script/page.tsx",
      "YoucaiUploadScript",
    ],
  ] as const;

  const routeLayout = read("src/app/youcai/tools/film-studio/layout.tsx");
  assert.match(routeLayout, /import \{ AppRouteShell \} from "@\/components\/app-route-shell"/);
  assert.equal(
    (routeLayout.match(/<AppRouteShell\b/g) ?? []).length,
    1,
    "film-studio route layout must provide exactly one AppRouteShell",
  );
  assert.equal(
    (routeLayout.match(/<\/AppRouteShell>/g) ?? []).length,
    1,
    "film-studio route layout must close exactly one AppRouteShell",
  );

  for (const [path, component] of canonicalCreatePages) {
    const source = read(path);
    assert.ok(source.includes(component), `missing canonical component: ${component}`);
    assert.doesNotMatch(
      source,
      /AppRouteShell/,
      `${path} must inherit the single route shell instead of nesting another one`,
    );
    assert.doesNotMatch(source, /redirectLegacyFilmStudioCreatePage/);
  }

  const legacyRedirectHelper = read(
    "src/app/youcai/tools/film-studio/create/legacy-create-redirect.ts",
  );
  assert.match(legacyRedirectHelper, /import \{ redirect \} from "next\/navigation"/);
  assert.match(legacyRedirectHelper, /await searchParamsPromise/);
  assert.match(legacyRedirectHelper, /query\.append\(name, value\)/);
  assert.match(legacyRedirectHelper, /query\.toString\(\)/);
  assert.match(legacyRedirectHelper, /redirect\(serialized \?/);

  const drama = read("src/features/youcai-drama-script/youcai-drama-script-wizard.tsx");
  for (const marker of [
    "两性主题", "暴力主题", "优势主题", "复仇主题", "AI优化需求", "生成剧本",
    "续写", "重写", "剧终", "/api/youcai/chat-models", "/api/short-drama/health",
  ]) assert.ok(drama.includes(marker), `missing drama marker: ${marker}`);
  assert.match(drama, /PREFERRED_DRAMA_TEXT_MODEL_ID\s*=\s*"pm_[A-Za-z0-9_-]+"/);

  const general = read("src/features/youcai-general-script/youcai-general-script.tsx");
  for (const marker of [
    "需求驱动·原创", "素材驱动·改编", "目标受众", "故事基调", "生成集数",
    "总集数", "AI优化需求", "生成剧本", "续写", "重写", "定稿剧本", "分集视频",
  ]) assert.ok(general.includes(marker), `missing general marker: ${marker}`);

  const upload = read("src/features/youcai-upload-script/youcai-upload-script.tsx");
  for (const marker of [
    "TXT/MD/DOCX", "最大 1MB", "前 2000 字", "爽剧", "短剧",
    "格式标准化只处理格式，不创作内容", "不会补充内容", "格式标准化",
  ]) assert.ok(upload.includes(marker), `missing upload marker: ${marker}`);
}

function verifyModelAndMigrationGuards(): void {
  const modelSelector = read("src/lib/short-drama/text-model-selection.ts");
  assert.match(modelSelector, /buildMangaAgentModelCatalog/);
  assert.match(modelSelector, /normalizedRequestedId/);
  assert.match(modelSelector, /catalog\.policy\.defaultModelId/);
  assert.match(modelSelector, /所选文案模型已下架或不再兼容/);

  const migrationTool = read("scripts/apply-short-drama-core-migration.ts");
  assert.match(migrationTool, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migrationTool, /--confirm-sha256=/);
  assert.match(migrationTool, /--confirm-target-host=/);
  assert.match(migrationTool, /SHORT_DRAMA_MIGRATION_EXECUTOR_UNAVAILABLE/);
  assert.match(migrationTool, /SHORT_DRAMA_PARTIAL_SCHEMA_MANUAL_REVIEW_REQUIRED/);
  assert.match(migrationTool, /SHORT_DRAMA_TARGET_OWNER_ID_CONTRACT_MISMATCH/);
  assert.match(migrationTool, /format === "character varying"/);
  assert.match(migrationTool, /20260823043000_short_drama_core\.rollback\.sql/);
  assert.match(migrationTool, /SHORT_DRAMA_ROLLBACK_NONEMPTY_GUARD_MISSING/);
  assert.match(migrationTool, /databaseWrites: 0/);
  assert.match(migrationTool, /paidModelCalls: 0/);
  assert.match(migrationTool, /credentialsPrinted: false/);
}

function verifyProjectChainCrudAlignment(): void {
  const workbench = read(
    "src/features/film-studio-project/film-studio-project-workbench.tsx",
  );
  const entityPanel = read(
    "src/features/film-studio-project/film-studio-entity-panel.tsx",
  );
  const shotPanel = read(
    "src/features/film-studio-project/film-studio-shot-panel.tsx",
  );
  const paidReadinessHook = read(
    "src/features/youcai-film-studio/use-short-drama-paid-readiness.ts",
  );
  const generalScript = read("src/features/youcai-general-script/youcai-general-script.tsx");
  const uploadScript = read("src/features/youcai-upload-script/youcai-upload-script.tsx");
  const health = read("src/app/api/short-drama/health/route.ts");

  for (const marker of [
    'key: "script"',
    'key: "character"',
    'key: "scene"',
    'key: "prop"',
    'key: "storyboard"',
    'key: "final"',
    "FilmStudioEntityPanel",
    "FilmStudioShotPanel",
    "FilmStudioProductionPanel",
  ]) assert.ok(workbench.includes(marker), `missing project-chain marker: ${marker}`);
  assert.match(workbench, /projectStorageMode === "native"/);
  assert.match(workbench, /CompatProductionGate/);
  assert.match(workbench, /付费生产链保持关闭/);
  assert.match(workbench, /不会请求图片\/视频模型或伪装成已生成成片/);
  assert.doesNotMatch(workbench, /独立编辑 API 尚未接通/);

  assert.match(entityPanel, /\/api\/short-drama\/projects\/\$\{encodeURIComponent\(projectId\)\}\/entities/);
  assert.match(entityPanel, /method:\s*editing \? "PATCH" : "POST"/);
  assert.match(entityPanel, /method:\s*"DELETE"/);
  assert.match(entityPanel, /剧本来源 · 尚未独立持久化/);
  assert.match(entityPanel, /namespaced platform_settings 兼容层/);
  assert.match(entityPanel, /付费生成、任务、资产、结算仍保持关闭/);

  assert.match(shotPanel, /\/api\/short-drama\/projects\/\$\{encodeURIComponent\(projectId\)\}\/shots/);
  assert.match(shotPanel, /STEP 05 · SHOT CRUD/);
  assert.match(shotPanel, /新建镜头/);
  assert.match(shotPanel, /保存分镜/);
  assert.match(shotPanel, /移除无生产历史的镜头/);
  assert.match(shotPanel, /SHOT_REVISION_CONFLICT/);
  assert.match(shotPanel, /客户端不能改写 status、revision、userId 或生产历史/);
  assert.match(shotPanel, /付费生产、job、asset 与 settlement 不会写入兼容层/);
  assert.doesNotMatch(shotPanel, /\/production/);

  assert.match(health, /storageMode:\s*"compat"/);
  assert.match(health, /\.\.\.healthPayload\(false\)/);
  assert.match(health, /productionReady:\s*false/);
  assert.match(health, /分镜草稿可真实保存/);
  assert.match(health, /code:\s*"MIGRATION_NOT_READY"/);

  assert.match(paidReadinessHook, /fetch\("\/api\/short-drama\/health"/);
  assert.match(paidReadinessHook, /payload\.storageMode === "native"/);
  assert.match(paidReadinessHook, /payload\.nativeSchemaReady === true/);
  assert.match(paidReadinessHook, /payload\.paidModelCallsEnabled === true/);
  assert.match(generalScript, /useShortDramaPaidReadiness/);
  assert.match(generalScript, /paidReadiness\.status !== "ready"/);
  assert.match(uploadScript, /useShortDramaPaidReadiness/);
  assert.match(uploadScript, /paidReadiness\.status !== "ready"/);
}

verifyPortalContract();
verifyEntryPages();
verifyModelAndMigrationGuards();
verifyProjectChainCrudAlignment();
console.log("film-studio alignment verification passed (no database writes, no paid model calls)");
