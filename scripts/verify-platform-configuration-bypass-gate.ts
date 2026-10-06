import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PLATFORM_CONFIGURATION_COMPATIBILITY_WRITERS,
  PLATFORM_CONFIGURATION_LEGACY_WRITERS,
  PLATFORM_CONFIGURATION_PROTECTED_GENERAL_WRITERS,
  PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT,
  PLATFORM_CONFIGURATION_RUNTIME_METADATA_WRITERS,
} from "../src/lib/server/platform-configuration-admin";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const posix = (value: string) => value.replaceAll("\\", "/");
let passed = 0;
const check = (name: string, work: () => void) => {
  work();
  passed += 1;
  console.log(`PASS ${name}`);
};

const candidateRoutes = [
  "src/app/api/admin/models/route.ts",
  "src/app/api/admin/chat-models/route.ts",
  "src/app/api/admin/video-models/quick-add/route.ts",
  "src/app/api/admin/video-models/route.ts",
  "src/app/api/admin/cover-models/route.ts",
  "src/app/api/admin/cover-models/[id]/route.ts",
  "src/app/api/admin/workspace-models/route.ts",
  "src/app/api/admin/sync/import/route.ts",
] as const;
const protectedGeneralRoutes = [
  "src/app/api/settings/route.ts",
  "src/app/api/settings/admin/route.ts",
] as const;
const guardedRuntimeRoutes = [
  "src/app/api/admin/models/activate/route.ts",
  "src/app/api/admin/video-models/validation/publish/route.ts",
  "src/app/api/admin/cover-models/validation/publish/route.ts",
] as const;
const expectedThirteen = [...candidateRoutes, ...protectedGeneralRoutes, ...guardedRuntimeRoutes].sort();
const directModelMutation = (source: string, table: string) => new RegExp(
  `\\.from\\s*\\(\\s*["']${table}["']\\s*\\)(?:(?!;)[\\s\\S])*?\\.(?:insert|update|upsert|delete)\\s*\\(`,
  "u",
).test(source);

check("13 条历史入口精确登记", () => {
  assert.equal(new Set(expectedThirteen).size, 13);
  const registered = new Set([
    ...PLATFORM_CONFIGURATION_COMPATIBILITY_WRITERS.modelPool,
    ...PLATFORM_CONFIGURATION_COMPATIBILITY_WRITERS.workspaceModels,
    ...PLATFORM_CONFIGURATION_PROTECTED_GENERAL_WRITERS,
    ...PLATFORM_CONFIGURATION_RUNTIME_METADATA_WRITERS,
  ]);
  assert.deepEqual(expectedThirteen.filter((relative) => !registered.has(relative)), []);
  for (const relative of expectedThirteen) assert.ok(fs.existsSync(path.join(root, relative)), relative);
});

check("旧逻辑配置绕过清单归零", () => {
  assert.deepEqual([...PLATFORM_CONFIGURATION_LEGACY_WRITERS.modelPool], []);
  assert.deepEqual([...PLATFORM_CONFIGURATION_LEGACY_WRITERS.workspaceModels], []);
});

check("八条兼容入口生成候选与差异预览且不声称发布", () => {
  const requirements: Array<[string, RegExp[]]> = [
    [candidateRoutes[0], [/stageLegacyModelPoolUpsert/u, /stageLegacyModelPoolCatalogState/u, /stageLegacyModelPoolOrder/u, /stageLegacyWorkspaceMutation/u]],
    [candidateRoutes[1], [/stageLegacyModelPoolUpsert/u, /stageLegacyModelPoolCatalogState/u]],
    [candidateRoutes[2], [/stageLegacyModelPoolUpsert/u]],
    [candidateRoutes[3], [/stageLegacyModelPoolUpsert/u, /stageLegacyModelPoolCatalogState/u]],
    [candidateRoutes[4], [/stageLegacyModelPoolUpsert/u]],
    [candidateRoutes[5], [/stageLegacyModelPoolUpsert/u, /stageLegacyModelPoolCatalogState/u]],
    [candidateRoutes[6], [/stageLegacyWorkspaceMutation/u]],
    [candidateRoutes[7], [/createPlatformConfigurationCandidate/u, /previewPlatformConfigurationRelease/u]],
  ];
  for (const [relative, patterns] of requirements) {
    const source = read(relative);
    for (const pattern of patterns) assert.match(source, pattern, relative);
    assert.match(source, /published:\s*false/u, relative);
  }
  const compatibility = read("src/lib/server/platform-configuration-compatibility.ts");
  assert.match(compatibility, /createPlatformConfigurationCandidate/u);
  assert.match(compatibility, /previewPlatformConfigurationRelease/u);
});

check("候选入口不直接改四张物理模型表", () => {
  for (const relative of candidateRoutes) {
    const source = read(relative);
    for (const table of ["llm_models", "chat_models", "cover_models", "video_models"]) {
      assert.equal(directModelMutation(source, table), false, `${relative} -> ${table}`);
    }
  }
});

check("通用导入拒绝物理模型表和工作台投影键", () => {
  const source = read("src/app/api/admin/sync/import/route.ts");
  const tables = source.match(/const SYNC_TABLES\s*=\s*\[([^\]]*)\]/u)?.[1] || "";
  assert.doesNotMatch(tables, /(?:video|cover|llm|chat)_models/u);
  assert.match(source, /VERSIONED_MODEL_TABLE_IMPORT_REQUIRED/u);
  assert.match(source, /VERSIONED_WORKSPACE_SETTING_IMPORT_REQUIRED/u);
  assert.match(source, /configurationCandidate\s*=\s*\{\s*kind,\s*release,\s*preview,\s*published:\s*false/u);
});

check("通用设置只保护三个工作台投影键", () => {
  for (const relative of protectedGeneralRoutes) {
    const source = read(relative);
    const guard = source.indexOf("VERSIONED_WORKSPACE_SETTING_KEYS");
    const mutation = source.indexOf('.from("platform_settings")', guard);
    assert.ok(guard >= 0 && mutation > guard, relative);
    for (const key of ["workspace_model_assignment_overrides_v1", "image_model_surface_orders_v1", "video_model_surface_orders_v1"]) {
      assert.match(source, new RegExp(key, "u"), relative);
    }
    const setBody = source.slice(guard, source.indexOf("]);", guard));
    assert.doesNotMatch(setBody, /thinking_model_name|auto_avatar_model_id/u, relative);
  }
});

check("三条运行验收入口先核对 current published 模型身份", () => {
  const specifications: Array<[string, string]> = [
    [guardedRuntimeRoutes[0], ".update({ is_active: true })"],
    [guardedRuntimeRoutes[1], "publishValidatedVideoModel"],
    [guardedRuntimeRoutes[2], "publishValidatedImageModel"],
  ];
  for (const [relative, marker] of specifications) {
    const source = read(relative);
    const guard = source.indexOf("await assertPublishedModelPoolEntry");
    const mutation = source.indexOf(marker, guard + 1);
    assert.ok(guard >= 0 && mutation > guard, relative);
    assert.match(source, /error instanceof PlatformConfigurationError/u, relative);
  }
  const activation = read(guardedRuntimeRoutes[0]);
  assert.match(activation, /\.update\(\{\s*is_active:\s*true\s*\}\)/u);
  assert.doesNotMatch(activation, /\.update\(\{[^}]*is_hidden/u);
});

check("API 全域模型直写只剩登记运行元数据路径", () => {
  const routeRoot = path.join(root, "src", "app", "api");
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === "route.ts") files.push(absolute);
    }
  };
  walk(routeRoot);
  const directWriters = files.flatMap((absolute) => {
    const source = fs.readFileSync(absolute, "utf8");
    return ["llm_models", "chat_models", "cover_models", "video_models"].some((table) => directModelMutation(source, table))
      ? [posix(path.relative(root, absolute))]
      : [];
  }).sort();
  const runtime = new Set<string>(PLATFORM_CONFIGURATION_RUNTIME_METADATA_WRITERS);
  assert.deepEqual(directWriters.filter((relative) => !runtime.has(relative)), []);
  assert.ok(directWriters.includes("src/app/api/admin/models/activate/route.ts"));
  assert.ok(directWriters.includes("src/app/api/admin/video-test/route.ts"));
});

check("密钥与逻辑快照分离", () => {
  const compatibility = read("src/lib/server/platform-configuration-compatibility.ts");
  const migration = read("supabase/migrations/20260925054500_platform_configuration_versioning.sql");
  assert.match(compatibility, /secret:\/\/platform-model\//u);
  assert.match(compatibility, /from\("platform_model_credential_bindings"\)\.upsert/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.platform_model_credential_bindings/u);
  assert.match(migration, /REVOKE ALL ON public\.platform_model_credential_bindings FROM PUBLIC, anon, authenticated/u);
});

check("数据库投影先于同事务 current 指针切换", () => {
  const migration = read("supabase/migrations/20260925054500_platform_configuration_versioning.sql");
  const publish = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic"));
  const modelProjection = publish.indexOf("PERFORM public.project_model_pool_configuration_atomic");
  const modelPointer = publish.indexOf("SET status = 'published', is_current = true", modelProjection);
  const workspaceProjection = publish.indexOf("PERFORM public.project_workspace_model_configuration_atomic");
  const workspacePointer = publish.indexOf("SET status = 'published', is_current = true", workspaceProjection);
  assert.ok(modelProjection >= 0 && modelPointer > modelProjection);
  assert.ok(workspaceProjection >= 0 && workspacePointer > workspaceProjection);
});

check("工作台投影不反向更新全局模型池", () => {
  const migration = read("supabase/migrations/20260925054500_platform_configuration_versioning.sql");
  const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.project_workspace_model_configuration_atomic");
  const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic", start);
  const body = migration.slice(start, end);
  assert.match(body, /INSERT INTO public\.platform_settings/u);
  assert.doesNotMatch(body, /(?:cover|video|llm|chat)_models/u);
  assert.doesNotMatch(body, /is_active|is_hidden/u);
});

check("发布保持迁移与数据库读回 fail-closed", () => {
  assert.equal(PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.code, "PLATFORM_CONFIGURATION_RUNTIME_PROJECTION_UNVERIFIED");
  assert.deepEqual([...PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.requiredArtifacts], [
    "model_pool_config_releases",
    "workspace_model_config_releases",
    "platform_model_credential_bindings",
    "platform_configuration_order_map",
  ]);
  const source = read("src/lib/server/platform-configuration-admin.ts");
  assert.match(source, /export async function readPlatformConfigurationRuntimeStatus/u);
  assert.match(source, /export async function assertPlatformConfigurationPublishReady/u);
  for (const artifact of PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.requiredArtifacts) {
    assert.match(source, new RegExp(artifact, "u"));
  }
  assert.match(source, /const status = await readPlatformConfigurationRuntimeStatus\(\)/u);
  assert.match(source, /if \(!status\.ready\)/u);
});

check("发布门禁位于任何校验写与发布 RPC 之前", () => {
  const source = read("src/lib/server/platform-configuration-admin.ts");
  const start = source.indexOf("export async function publishPlatformConfigurationRelease");
  const end = source.indexOf("export async function createPlatformConfigurationRollbackCandidate", start);
  const body = source.slice(start, end);
  const gate = body.indexOf("await assertPlatformConfigurationPublishReady()");
  const validationWrite = body.indexOf("validatePlatformConfigurationCandidate");
  const mutation = body.indexOf('rpc("publish_platform_configuration_release_atomic"');
  assert.ok(gate >= 0 && validationWrite > gate && mutation > validationWrite);
});

console.log(JSON.stringify({
  passed,
  failed: 0,
  networkCalls: 0,
  databaseWrites: 0,
  walletCalls: 0,
  providerCalls: 0,
  protectedPathCount: expectedThirteen.length,
  legacyBypassCount: 0,
  runtimePublishReadback: "required",
  requiredArtifacts: PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.requiredArtifacts,
}));
