import { createHash } from "crypto";
import { z } from "zod";
import {
  getPublicInspirationCatalog,
  getPublicSiteConfig,
} from "@/lib/youcai-public-catalog";
import { listManjuPublicAssetsSync } from "@/lib/server/manju-public-asset-registry";

export const MANJU_CONFIG_ENVIRONMENTS = [
  "production",
  "staging",
  "development",
] as const;

export const MANJU_CONFIG_DOMAINS = [
  "prompt",
  "skill",
  "agent",
  "workflow",
  "content",
  "media",
  "feature_flags",
  "model_policy",
  "ui",
] as const;

/**
 * Domains that are safe to expose to an unauthenticated browser session.
 *
 * Only domains consumed by the public shell are exposed. Prompt, Skill,
 * Agent, workflow and model-policy content stay server-side because those
 * domains may contain private instructions or provider policy.
 */
export const MANJU_PUBLIC_CONFIG_DOMAINS = [
  "content",
  "media",
  "feature_flags",
] as const;
export const MANJU_RUNTIME_LATEST_SCHEMA_DOMAINS = [
  "prompt",
  ...MANJU_PUBLIC_CONFIG_DOMAINS,
] as const;

export const MANJU_PUBLIC_ENVIRONMENT = "production" as const;
export const MANJU_CONFIG_SCHEMA_VERSIONS = ["1.0.0", "1.1.0"] as const;
export const MANJU_CONFIG_LATEST_SCHEMA_VERSION = "1.1.0" as const;
export const MANJU_CONFIG_MAX_PAYLOAD_BYTES = 256 * 1024;
export const MANJU_CONFIG_MAX_DEPTH = 12;

export const ManjuConfigEnvironmentSchema = z.enum(MANJU_CONFIG_ENVIRONMENTS);
export const ManjuConfigDomainSchema = z.enum(MANJU_CONFIG_DOMAINS);
export const ManjuConfigPayloadSchema = z.record(z.string(), z.unknown());

export type ManjuConfigEnvironment = z.infer<typeof ManjuConfigEnvironmentSchema>;
export type ManjuConfigDomain = z.infer<typeof ManjuConfigDomainSchema>;
export type ManjuPublicConfigDomain = (typeof MANJU_PUBLIC_CONFIG_DOMAINS)[number];

export type ManjuJsonPrimitive = string | number | boolean | null;
export type ManjuJsonValue =
  | ManjuJsonPrimitive
  | ManjuJsonValue[]
  | { [key: string]: ManjuJsonValue };
export type ManjuConfigPayload = Record<string, ManjuJsonValue>;

const EnvironmentDomainSchema = z.object({
  environment: ManjuConfigEnvironmentSchema.default(MANJU_PUBLIC_ENVIRONMENT),
  domain: ManjuConfigDomainSchema.default("prompt"),
});

const ExpectedStorageGenerationSchema = z.number().int().nonnegative().optional();

const SchemaVersionSchema = z.enum(MANJU_CONFIG_SCHEMA_VERSIONS).default(MANJU_CONFIG_LATEST_SCHEMA_VERSION);
const OptionalUuidSchema = z.string().uuid().nullish();

export const ManjuAdminQuerySchema = EnvironmentDomainSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ManjuConfigActionSchema = z.discriminatedUnion("action", [
  EnvironmentDomainSchema.extend({
    action: z.literal("validate"),
    payload: ManjuConfigPayloadSchema,
    schema_version: SchemaVersionSchema,
  }),
  EnvironmentDomainSchema.extend({
    action: z.literal("save-draft"),
    expected_storage_generation: ExpectedStorageGenerationSchema,
    revision_id: OptionalUuidSchema,
    expected_updated_at: z.string().datetime({ offset: true }).optional(),
    payload: ManjuConfigPayloadSchema,
    schema_version: SchemaVersionSchema,
  }),
  EnvironmentDomainSchema.extend({
    action: z.literal("publish"),
    expected_storage_generation: ExpectedStorageGenerationSchema,
    revision_id: z.string().uuid(),
    expected_active_release_id: OptionalUuidSchema,
  }),
  EnvironmentDomainSchema.extend({
    action: z.literal("rollback"),
    expected_storage_generation: ExpectedStorageGenerationSchema,
    target_release_id: z.string().uuid(),
    expected_active_release_id: z.string().uuid(),
  }),
]);

export type ManjuConfigAction = z.infer<typeof ManjuConfigActionSchema>;

export interface ManjuConfigRevisionRow {
  id: string;
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  version: number;
  status: string;
  payload: ManjuConfigPayload;
  payload_hash: string;
  schema_version: string;
  parent_revision_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface ManjuConfigReleaseRow {
  id: string;
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  release_number: number;
  revision_id: string;
  previous_release_id: string | null;
  release_kind: "publish" | "rollback";
  rollback_of_release_id: string | null;
  etag: string;
  released_by: string | null;
  created_at: string;
}

export interface ManjuConfigActiveRow {
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  active_release_id: string;
  active_revision_id: string;
  etag: string;
  updated_by: string | null;
  updated_at: string;
}

export interface ManjuDatabaseErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

const MANJU_CONTENT_FIELDS = ["brand", "navigation", "account_route"] as const;
const MANJU_PUBLIC_NAVIGATION_ROUTES = new Set([
  "/youcai/assets",
  "/youcai/skills",
  "/youcai/tools",
  "/youcai/tools/text/text-chat",
  "/youcai/tools/film-studio",
  "/youcai/tools/canvas",
  "/youcai/inspiration",
  "/youcai/youcai-tv",
  "/youcai/articles",
  "/youcai/recharge",
  "/youcai/referral",
]);
const MANJU_FEATURE_FLAG_KEYS = new Set([
  "creative_agent",
  "film_studio",
  "canvas",
  "inspiration",
  "assets",
  "general_script",
  "drama_script",
  "formal_drama",
  "script_upload",
]);
const MANJU_REQUIRED_PUBLIC_FLAGS = [
  "creative_agent",
  "film_studio",
  "canvas",
  "inspiration",
  "assets",
] as const;
const MANJU_SKILL_PAYLOAD_FIELDS = [
  "version",
  "catalog_source",
  "route",
  "admin_route",
  "invocation",
  "preserve_user_input",
  "fail_closed_when_unavailable",
  "governance",
  "skill_prompt_overrides",
  "user_skill_policy",
  "admin_routes",
] as const;
const MANJU_SKILL_GOVERNANCE_FIELDS = [
  "builtin_runtime_catalog",
  "user_custom_skill_packages",
] as const;
const MANJU_SKILL_GOVERNANCE_SECTION_FIELDS = [
  "label",
  "scope",
  "admin_editable",
  "user_editable",
  "runtime_connected",
  "edit_model",
  "package_api",
  "public_api",
  "install_api",
  "requires_migration",
  "review_required",
] as const;
const MANJU_SKILL_OVERRIDE_FIELDS = [
  "enabled",
  "title",
  "summary",
  "instruction_override",
  "override_mode",
  "trigger_terms",
  "updated_reason",
  "admin_note",
] as const;
const MANJU_SKILL_OVERRIDE_COMMAND_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export class ManjuConfigPayloadError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "ManjuConfigPayloadError";
    this.code = code;
    this.path = path;
  }
}

const SENSITIVE_KEY_PATTERN = /^(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|private[_-]?key|service[_-]?role[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|authorization|credential(?:s)?|cookie|webhook[_-]?secret)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathFor(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "$" ? `$.${key}` : `${parent}.${key}`;
}

function manjuConfigRecord(value: unknown, code: string, message: string, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ManjuConfigPayloadError(code, message, path);
  }
  return value;
}

function assertAllowedManjuFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: string,
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new ManjuConfigPayloadError(
      code,
      `${label}包含未支持字段 ${unexpected}`,
      pathFor(path, unexpected),
    );
  }
}

function validateManjuShortText(
  value: unknown,
  path: string,
  label: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  const required = options.required === true;
  const max = options.max ?? 200;
  if (value === undefined) {
    if (required) {
      throw new ManjuConfigPayloadError("SKILL_TEXT_REQUIRED", `${label}不能为空`, path);
    }
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ManjuConfigPayloadError(
      "SKILL_TEXT_INVALID",
      `${label}必须是 1-${max} 个字符`,
      path,
    );
  }
  return value.trim();
}

function validateManjuSkillStringArray(
  value: unknown,
  path: string,
  label: string,
  maximumItems = 64,
  maximumLength = 160,
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value)
    || value.length > maximumItems
    || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maximumLength)
  ) {
    throw new ManjuConfigPayloadError(
      "SKILL_STRING_ARRAY_INVALID",
      `${label}必须是最多 ${maximumItems} 项、每项 1-${maximumLength} 个字符的字符串数组`,
      path,
    );
  }
}

function validateManjuSkillGovernanceSection(value: unknown, path: string): void {
  const section = manjuConfigRecord(
    value,
    "SKILL_GOVERNANCE_SECTION_REQUIRED",
    "Skill 治理分区必须是 JSON 对象",
    path,
  );
  assertAllowedManjuFields(
    section,
    MANJU_SKILL_GOVERNANCE_SECTION_FIELDS,
    path,
    "SKILL_GOVERNANCE_FIELD_UNKNOWN",
    "Skill 治理分区",
  );
  validateManjuShortText(section.label, pathFor(path, "label"), "Skill 治理分区名称", { required: true, max: 80 });
  validateManjuShortText(section.scope, pathFor(path, "scope"), "Skill 治理分区范围", { required: true, max: 240 });
  if (typeof section.admin_editable !== "boolean") {
    throw new ManjuConfigPayloadError(
      "SKILL_ADMIN_EDITABLE_REQUIRED",
      "Skill 治理分区必须显式声明 admin_editable",
      pathFor(path, "admin_editable"),
    );
  }
  if (typeof section.user_editable !== "boolean") {
    throw new ManjuConfigPayloadError(
      "SKILL_USER_EDITABLE_REQUIRED",
      "Skill 治理分区必须显式声明 user_editable",
      pathFor(path, "user_editable"),
    );
  }
}

function validateManjuSkillPromptOverride(value: unknown, path: string): void {
  const override = manjuConfigRecord(
    value,
    "SKILL_OVERRIDE_OBJECT_REQUIRED",
    "Skill 提示词覆盖项必须是 JSON 对象",
    path,
  );
  assertAllowedManjuFields(
    override,
    MANJU_SKILL_OVERRIDE_FIELDS,
    path,
    "SKILL_OVERRIDE_FIELD_UNKNOWN",
    "Skill 提示词覆盖项",
  );
  if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
    throw new ManjuConfigPayloadError("SKILL_ENABLED_INVALID", "Skill 启停必须是布尔值", pathFor(path, "enabled"));
  }
  validateManjuShortText(override.title, pathFor(path, "title"), "Skill 标题", { max: 120 });
  validateManjuShortText(override.summary, pathFor(path, "summary"), "Skill 摘要", { max: 600 });
  validateManjuShortText(override.updated_reason, pathFor(path, "updated_reason"), "Skill 修改原因", { max: 500 });
  validateManjuShortText(override.admin_note, pathFor(path, "admin_note"), "Skill 管理备注", { max: 800 });
  if (
    override.override_mode !== undefined
    && override.override_mode !== "supplement"
    && override.override_mode !== "replace_full_instruction"
  ) {
    throw new ManjuConfigPayloadError(
      "SKILL_OVERRIDE_MODE_INVALID",
      "Skill 提示词覆盖模式只能是 supplement 或 replace_full_instruction",
      pathFor(path, "override_mode"),
    );
  }
  if (override.instruction_override !== undefined) {
    if (
      typeof override.instruction_override !== "string"
      || override.instruction_override.trim().length < 20
      || override.instruction_override.length > 80_000
    ) {
      throw new ManjuConfigPayloadError(
        "SKILL_INSTRUCTION_OVERRIDE_INVALID",
        "Skill 提示词覆盖正文必须是 20-80000 个字符",
        pathFor(path, "instruction_override"),
      );
    }
  }
  validateManjuSkillStringArray(override.trigger_terms, pathFor(path, "trigger_terms"), "Skill 触发词");
}

function validateManjuSkillContract(payload: ManjuConfigPayload): void {
  assertAllowedManjuFields(
    payload,
    MANJU_SKILL_PAYLOAD_FIELDS,
    "$",
    "SKILL_FIELD_UNKNOWN",
    "skill 域",
  );
  validateManjuShortText(payload.version, "$.version", "skill 域版本", { required: true, max: 80 });
  if (payload.catalog_source !== "youcai-skill-runtime-catalog") {
    throw new ManjuConfigPayloadError(
      "SKILL_CATALOG_SOURCE_INVALID",
      "skill 域必须声明 catalog_source=youcai-skill-runtime-catalog",
      "$.catalog_source",
    );
  }
  if (payload.route !== "/youcai/skills") {
    throw new ManjuConfigPayloadError(
      "SKILL_ROUTE_INVALID",
      "skill 域前台目录入口必须映射到 /youcai/skills",
      "$.route",
    );
  }
  if (payload.admin_route !== "/admin?tab=manju-workbench#manju-skill-manager") {
    throw new ManjuConfigPayloadError(
      "SKILL_ADMIN_ROUTE_INVALID",
      "skill 域后台入口必须映射到漫剧工作台 Skill 治理面板",
      "$.admin_route",
    );
  }
  const governance = manjuConfigRecord(
    payload.governance,
    "SKILL_GOVERNANCE_REQUIRED",
    "skill 域必须包含 governance 对象",
    "$.governance",
  );
  assertAllowedManjuFields(
    governance,
    MANJU_SKILL_GOVERNANCE_FIELDS,
    "$.governance",
    "SKILL_GOVERNANCE_FIELD_UNKNOWN",
    "Skill 治理对象",
  );
  validateManjuSkillGovernanceSection(
    governance.builtin_runtime_catalog,
    "$.governance.builtin_runtime_catalog",
  );
  const builtin = governance.builtin_runtime_catalog as Record<string, unknown>;
  if (builtin.admin_editable !== true || builtin.user_editable !== false) {
    throw new ManjuConfigPayloadError(
      "SKILL_BUILTIN_BOUNDARY_INVALID",
      "平台内置 Skill 必须允许管理员治理，且禁止普通用户直接编辑",
      "$.governance.builtin_runtime_catalog",
    );
  }
  validateManjuSkillGovernanceSection(
    governance.user_custom_skill_packages,
    "$.governance.user_custom_skill_packages",
  );
  const custom = governance.user_custom_skill_packages as Record<string, unknown>;
  if (custom.admin_editable !== true || custom.user_editable !== true) {
    throw new ManjuConfigPayloadError(
      "SKILL_CUSTOM_BOUNDARY_INVALID",
      "用户自建 Skill 必须显式允许用户定制，同时接受管理员治理",
      "$.governance.user_custom_skill_packages",
    );
  }
  const overrides = manjuConfigRecord(
    payload.skill_prompt_overrides,
    "SKILL_OVERRIDES_REQUIRED",
    "skill 域必须包含 skill_prompt_overrides 对象",
    "$.skill_prompt_overrides",
  );
  for (const [command, override] of Object.entries(overrides)) {
    if (!MANJU_SKILL_OVERRIDE_COMMAND_PATTERN.test(command)) {
      throw new ManjuConfigPayloadError(
        "SKILL_COMMAND_INVALID",
        "Skill 覆盖键必须使用不带斜杠的命令名",
        pathFor("$.skill_prompt_overrides", command),
      );
    }
    validateManjuSkillPromptOverride(override, pathFor("$.skill_prompt_overrides", command));
  }
}

function inspectJsonValue(
  value: unknown,
  path: string,
  depth: number,
  rejectSensitiveKeys: boolean,
): { value: ManjuJsonValue; maxDepth: number } {
  if (depth > MANJU_CONFIG_MAX_DEPTH) {
    throw new ManjuConfigPayloadError(
      "CONFIG_DEPTH_LIMIT",
      `配置层级不能超过 ${MANJU_CONFIG_MAX_DEPTH} 层`,
      path,
    );
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { value, maxDepth: depth };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ManjuConfigPayloadError("CONFIG_JSON_INVALID", "配置包含非有限数字", path);
    }
    return { value, maxDepth: depth };
  }

  if (Array.isArray(value)) {
    let maxDepth = depth;
    const output = value.map((entry, index) => {
      const inspected = inspectJsonValue(
        entry,
        pathFor(path, index),
        depth + 1,
        rejectSensitiveKeys,
      );
      maxDepth = Math.max(maxDepth, inspected.maxDepth);
      return inspected.value;
    });
    return { value: output, maxDepth };
  }

  if (!isPlainObject(value)) {
    throw new ManjuConfigPayloadError("CONFIG_JSON_INVALID", "配置只能包含 JSON 数据", path);
  }

  let maxDepth = depth;
  const output: Record<string, ManjuJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = pathFor(path, key);
    if (rejectSensitiveKeys && SENSITIVE_KEY_PATTERN.test(key)) {
      throw new ManjuConfigPayloadError(
        "CONFIG_SENSITIVE_KEY",
        "配置中不得保存密钥、令牌、密码或凭据",
        childPath,
      );
    }
    const inspected = inspectJsonValue(value[key], childPath, depth + 1, rejectSensitiveKeys);
    output[key] = inspected.value;
    maxDepth = Math.max(maxDepth, inspected.maxDepth);
  }
  return { value: output, maxDepth };
}

function stableJson(value: ManjuJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export function validateManjuConfigPayload(input: unknown): {
  payload: ManjuConfigPayload;
  payloadHash: string;
  byteSize: number;
  maxDepth: number;
} {
  const parsed = ManjuConfigPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManjuConfigPayloadError("CONFIG_JSON_INVALID", "配置根节点必须是 JSON 对象", "$");
  }

  const inspected = inspectJsonValue(parsed.data, "$", 0, true);
  const payload = inspected.value as ManjuConfigPayload;
  const canonical = stableJson(payload);
  const byteSize = Buffer.byteLength(canonical, "utf8");
  if (byteSize > MANJU_CONFIG_MAX_PAYLOAD_BYTES) {
    throw new ManjuConfigPayloadError(
      "CONFIG_PAYLOAD_TOO_LARGE",
      `配置不能超过 ${MANJU_CONFIG_MAX_PAYLOAD_BYTES} 字节`,
      "$",
    );
  }

  return {
    payload,
    payloadHash: createHash("sha256").update(canonical).digest("hex"),
    byteSize,
    maxDepth: inspected.maxDepth,
  };
}

function showcaseContractError(code: string, message: string, path: string): never {
  throw new ManjuConfigPayloadError(code, message, path);
}

function showcaseRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return showcaseContractError("SHOWCASE_OBJECT_REQUIRED", "展示配置必须是 JSON 对象", path);
  }
  return value;
}

function assertShowcaseKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    showcaseContractError(
      "SHOWCASE_FIELD_UNKNOWN",
      `展示配置包含未支持字段 ${unexpected}`,
      pathFor(path, unexpected),
    );
  }
}

function validateShowcaseText(
  value: unknown,
  path: string,
  maximum: number,
  label: string,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    showcaseContractError(
      "SHOWCASE_TEXT_INVALID",
      `${label}必须是 1-${maximum} 个字符`,
      path,
    );
  }
}

function validateShowcaseEnabled(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    showcaseContractError("SHOWCASE_ENABLED_INVALID", "enabled 必须是布尔值", path);
  }
}

function validateShowcaseAssetReference(
  value: unknown,
  path: string,
  knownPaths: ReadonlySet<string>,
  pathByAssetId: ReadonlyMap<string, string>,
): void {
  const reference = showcaseRecord(value, path);
  assertShowcaseKeys(reference, ["assetId", "path"], path);
  const assetPath = reference.path;
  if (
    typeof assetPath !== "string"
    || assetPath.length > 512
    || !assetPath.startsWith("/")
    || assetPath.startsWith("//")
    || assetPath.includes("..")
    || /^(?:data|blob|https?):/iu.test(assetPath)
    || !knownPaths.has(assetPath)
  ) {
    showcaseContractError(
      "SHOWCASE_ASSET_PATH_UNKNOWN",
      "展示素材只能引用 /api/inspiration 或 /api/site-config 已登记的本站路径",
      pathFor(path, "path"),
    );
  }
  if (reference.assetId !== undefined) {
    if (
      typeof reference.assetId !== "string"
      || reference.assetId.length > 160
      || pathByAssetId.get(reference.assetId) !== assetPath
    ) {
      showcaseContractError(
        "SHOWCASE_ASSET_ID_PATH_MISMATCH",
        "素材 ID 与本站素材路径不匹配",
        pathFor(path, "assetId"),
      );
    }
  }
}

function validateShowcaseBannerOverride(
  value: unknown,
  path: string,
  knownPaths: ReadonlySet<string>,
  pathByAssetId: ReadonlyMap<string, string>,
): void {
  const override = showcaseRecord(value, path);
  assertShowcaseKeys(override, ["enabled", "asset", "poster"], path);
  validateShowcaseEnabled(override.enabled, pathFor(path, "enabled"));
  if (override.asset !== undefined) {
    validateShowcaseAssetReference(override.asset, pathFor(path, "asset"), knownPaths, pathByAssetId);
  }
  if (override.poster !== undefined) {
    validateShowcaseAssetReference(override.poster, pathFor(path, "poster"), knownPaths, pathByAssetId);
  }
}

function validateManjuShowcaseContract(payload: ManjuConfigPayload, referenceScope: "current" | "stored"): void {
  if (payload.showcase_catalog === undefined) return;

  const root = showcaseRecord(payload.showcase_catalog, "$.showcase_catalog");
  const invalidVersion = Object.keys(root).find((key) => !/^v[1-9][0-9]*$/u.test(key));
  if (invalidVersion) {
    showcaseContractError(
      "SHOWCASE_VERSION_KEY_INVALID",
      "showcase_catalog 只允许 v1、v2 等明确版本键",
      pathFor("$.showcase_catalog", invalidVersion),
    );
  }
  if (root.v1 === undefined) {
    showcaseContractError("SHOWCASE_V1_REQUIRED", "showcase_catalog 必须包含 v1", "$.showcase_catalog.v1");
  }
  const v1 = showcaseRecord(root.v1, "$.showcase_catalog.v1");
  assertShowcaseKeys(v1, ["inspiration", "canvas_examples", "banners", "hero"], "$.showcase_catalog.v1");

  let inspiration;
  let siteConfig;
  try {
    inspiration = getPublicInspirationCatalog();
    siteConfig = getPublicSiteConfig();
  } catch {
    showcaseContractError(
      "SHOWCASE_SOURCE_CATALOG_INVALID",
      "本站素材事实清单未通过完整性校验",
      "$.showcase_catalog.v1",
    );
  }

  const pathByAssetId = new Map(inspiration.map((item) => [item.id, item.url] as const));
  const knownPaths = new Set<string>();
  for (const item of inspiration) knownPaths.add(item.url);
  // Historical snapshots keep their identity after an upload is taken offline.
  // Only registered tombstones are accepted; writes still require live assets.
  const registeredAssets = listManjuPublicAssetsSync({ includeDisabled: true });
  if (referenceScope === "stored") {
    for (const asset of registeredAssets) {
      pathByAssetId.set(asset.id, asset.path);
      knownPaths.add(asset.path);
    }
  }
  for (const banner of Object.values(siteConfig.banners).flat()) {
    knownPaths.add(banner.url);
    if (banner.poster) knownPaths.add(banner.poster);
  }
  knownPaths.add(siteConfig.heroVideo.url);
  if (siteConfig.heroVideo.poster) knownPaths.add(siteConfig.heroVideo.poster);
  for (const banner of siteConfig.backgroundVideos) {
    knownPaths.add(banner.url);
    if (banner.poster) knownPaths.add(banner.poster);
  }
  for (const example of siteConfig.canvasExamples) knownPaths.add(example.coverImage);

  const inspirationConfig = showcaseRecord(v1.inspiration, "$.showcase_catalog.v1.inspiration");
  assertShowcaseKeys(inspirationConfig, ["overrides"], "$.showcase_catalog.v1.inspiration");
  const inspirationOverrides = showcaseRecord(
    inspirationConfig.overrides,
    "$.showcase_catalog.v1.inspiration.overrides",
  );
  if (Object.keys(inspirationOverrides).length > 500) {
    showcaseContractError(
      "SHOWCASE_OVERRIDE_LIMIT",
      "灵感展示覆盖不能超过 500 项",
      "$.showcase_catalog.v1.inspiration.overrides",
    );
  }
  const validCategories = new Set<string>(inspiration.map((item) => item.category));
  if (referenceScope === "stored") {
    for (const asset of registeredAssets) validCategories.add(asset.category);
  }
  for (const [id, rawOverride] of Object.entries(inspirationOverrides)) {
    const path = pathFor("$.showcase_catalog.v1.inspiration.overrides", id);
    if (!pathByAssetId.has(id)) {
      if (registeredAssets.some((asset) => asset.id === id)) {
        showcaseContractError("SHOWCASE_ASSET_UNAVAILABLE", `素材 ${id} 已下线，请移除其配置后再发布`, path);
      }
      showcaseContractError("SHOWCASE_INSPIRATION_ID_UNKNOWN", `灵感素材 ${id} 不存在`, path);
    }
    const override = showcaseRecord(rawOverride, path);
    assertShowcaseKeys(override, ["enabled", "title", "summary", "prompt", "category", "sortOrder"], path);
    validateShowcaseEnabled(override.enabled, pathFor(path, "enabled"));
    validateShowcaseText(override.title, pathFor(path, "title"), 160, "标题");
    validateShowcaseText(override.summary, pathFor(path, "summary"), 500, "摘要");
    validateShowcaseText(override.prompt, pathFor(path, "prompt"), 12_000, "提示词");
    if (
      override.category !== undefined
      && (typeof override.category !== "string" || !validCategories.has(override.category))
    ) {
      showcaseContractError("SHOWCASE_CATEGORY_UNKNOWN", "灵感分类不存在", pathFor(path, "category"));
    }
    if (
      override.sortOrder !== undefined
      && (!Number.isSafeInteger(override.sortOrder) || Number(override.sortOrder) < 0 || Number(override.sortOrder) > 100_000)
    ) {
      showcaseContractError("SHOWCASE_SORT_INVALID", "排序值必须是 0-100000 的整数", pathFor(path, "sortOrder"));
    }
  }

  const canvasConfig = showcaseRecord(v1.canvas_examples, "$.showcase_catalog.v1.canvas_examples");
  assertShowcaseKeys(canvasConfig, ["order", "overrides"], "$.showcase_catalog.v1.canvas_examples");
  const canvasIds = siteConfig.canvasExamples.map((item) => item.canvasId);
  const canvasIdSet = new Set(canvasIds);
  if (canvasConfig.order !== undefined) {
    if (
      !Array.isArray(canvasConfig.order)
      || canvasConfig.order.length !== canvasIds.length
      || !canvasConfig.order.every((id) => typeof id === "string" && canvasIdSet.has(id))
      || new Set(canvasConfig.order).size !== canvasIds.length
    ) {
      showcaseContractError(
        "SHOWCASE_CANVAS_ORDER_INVALID",
        "画布示例排序必须完整包含所有 canvasId 且不重复",
        "$.showcase_catalog.v1.canvas_examples.order",
      );
    }
  }
  const canvasOverrides = showcaseRecord(
    canvasConfig.overrides,
    "$.showcase_catalog.v1.canvas_examples.overrides",
  );
  for (const [id, rawOverride] of Object.entries(canvasOverrides)) {
    const path = pathFor("$.showcase_catalog.v1.canvas_examples.overrides", id);
    if (!canvasIdSet.has(id)) {
      showcaseContractError("SHOWCASE_CANVAS_ID_UNKNOWN", `画布示例 ${id} 不存在`, path);
    }
    const override = showcaseRecord(rawOverride, path);
    assertShowcaseKeys(override, ["enabled", "title", "tag", "cover"], path);
    validateShowcaseEnabled(override.enabled, pathFor(path, "enabled"));
    validateShowcaseText(override.title, pathFor(path, "title"), 160, "画布标题");
    validateShowcaseText(override.tag, pathFor(path, "tag"), 60, "画布标签");
    if (override.cover !== undefined) {
      validateShowcaseAssetReference(override.cover, pathFor(path, "cover"), knownPaths, pathByAssetId);
    }
  }

  const bannersConfig = showcaseRecord(v1.banners, "$.showcase_catalog.v1.banners");
  assertShowcaseKeys(bannersConfig, ["overrides"], "$.showcase_catalog.v1.banners");
  const bannerOverrides = showcaseRecord(bannersConfig.overrides, "$.showcase_catalog.v1.banners.overrides");
  const bannerKeys = new Set(
    Object.entries(siteConfig.banners).flatMap(([group, items]) => items.map((_, index) => `${group}:${index}`)),
  );
  for (const [key, value] of Object.entries(bannerOverrides)) {
    const path = pathFor("$.showcase_catalog.v1.banners.overrides", key);
    if (!bannerKeys.has(key)) {
      showcaseContractError("SHOWCASE_BANNER_ID_UNKNOWN", `横幅 ${key} 不存在`, path);
    }
    validateShowcaseBannerOverride(value, path, knownPaths, pathByAssetId);
  }
  validateShowcaseBannerOverride(v1.hero, "$.showcase_catalog.v1.hero", knownPaths, pathByAssetId);
}

/** Domain-specific contract gate applied before a draft can be saved. */
export function validateManjuDomainContract(
  domain: ManjuConfigDomain,
  payload: ManjuConfigPayload,
  schemaVersion = "1.0.0",
  referenceScope: "current" | "stored" = "current",
): void {
  if (!MANJU_CONFIG_SCHEMA_VERSIONS.includes(schemaVersion as (typeof MANJU_CONFIG_SCHEMA_VERSIONS)[number])) {
    throw new ManjuConfigPayloadError(
      "CONFIG_SCHEMA_VERSION_UNSUPPORTED",
      `不支持的配置 schema ${schemaVersion}`,
      "$.schema_version",
    );
  }
  const usesGovernedPublicContract = schemaVersion === MANJU_CONFIG_LATEST_SCHEMA_VERSION;
  if (domain === "content") {
    if (!usesGovernedPublicContract) return;
    const unexpected = Object.keys(payload).find(
      (key) => !MANJU_CONTENT_FIELDS.includes(key as (typeof MANJU_CONTENT_FIELDS)[number]),
    );
    if (unexpected) {
      throw new ManjuConfigPayloadError(
        "CONTENT_FIELD_UNKNOWN",
        `content 域包含未支持字段 ${unexpected}`,
        `$.${unexpected}`,
      );
    }
    if (typeof payload.brand !== "string" || !payload.brand.trim() || payload.brand.length > 80) {
      throw new ManjuConfigPayloadError("CONTENT_BRAND_INVALID", "品牌名称必须是 1-80 个字符", "$.brand");
    }
    if (
      !Array.isArray(payload.navigation)
      || payload.navigation.length === 0
      || payload.navigation.length > MANJU_PUBLIC_NAVIGATION_ROUTES.size
      || payload.navigation.some(
        (route) => typeof route !== "string" || !MANJU_PUBLIC_NAVIGATION_ROUTES.has(route),
      )
      || new Set(payload.navigation).size !== payload.navigation.length
    ) {
      throw new ManjuConfigPayloadError(
        "CONTENT_NAVIGATION_INVALID",
        "导航必须由本站已登记路由组成，且不得为空、重复或包含未知入口",
        "$.navigation",
      );
    }
    if (payload.account_route !== "/youcai/profile") {
      throw new ManjuConfigPayloadError(
        "CONTENT_ACCOUNT_ROUTE_INVALID",
        "账户入口必须映射到 /youcai/profile",
        "$.account_route",
      );
    }
    return;
  }
  if (domain === "skill") {
    if (!usesGovernedPublicContract) return;
    validateManjuSkillContract(payload);
    return;
  }
  if (domain === "feature_flags") {
    if (!usesGovernedPublicContract) return;
    const invalid = Object.entries(payload).find(
      ([key, value]) => !MANJU_FEATURE_FLAG_KEYS.has(key) || typeof value !== "boolean",
    );
    if (invalid) {
      throw new ManjuConfigPayloadError(
        "FEATURE_FLAG_INVALID",
        `功能开关 ${invalid[0]} 未登记或不是布尔值`,
        `$.${invalid[0]}`,
      );
    }
    const missing = MANJU_REQUIRED_PUBLIC_FLAGS.find((key) => typeof payload[key] !== "boolean");
    if (missing) {
      throw new ManjuConfigPayloadError(
        "FEATURE_FLAG_REQUIRED",
        `公共功能开关 ${missing} 必须显式配置`,
        `$.${missing}`,
      );
    }
    return;
  }
  if (domain === "media") {
    if (usesGovernedPublicContract && payload.showcase_catalog === undefined) {
      showcaseContractError(
        "SHOWCASE_CATALOG_REQUIRED",
        "media 域必须包含可由后台治理的 showcase_catalog",
        "$.showcase_catalog",
      );
    }
    validateManjuShowcaseContract(payload, referenceScope);
    return;
  }
  if (domain !== "prompt" || !usesGovernedPublicContract) return;

  const runtimePrompts = payload.runtime_prompts;
  if (!runtimePrompts || typeof runtimePrompts !== "object" || Array.isArray(runtimePrompts)) {
    throw new ManjuConfigPayloadError(
      "PROMPT_RUNTIME_MAP_REQUIRED",
      "prompt 域必须包含 runtime_prompts 对象",
      "$.runtime_prompts",
    );
  }
  const mangaPrompt = runtimePrompts.manga_virtual_agent_prompt;
  if (!mangaPrompt || typeof mangaPrompt !== "object" || Array.isArray(mangaPrompt)) {
    throw new ManjuConfigPayloadError(
      "MANGA_RUNTIME_PROMPT_REQUIRED",
      "prompt 域必须配置 manga_virtual_agent_prompt",
      "$.runtime_prompts.manga_virtual_agent_prompt",
    );
  }
  const version = mangaPrompt.version;
  const content = mangaPrompt.content;
  if (
    typeof version !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u.test(version.trim())
  ) {
    throw new ManjuConfigPayloadError(
      "MANGA_RUNTIME_PROMPT_VERSION_INVALID",
      "漫剧运行提示词必须包含合法版本号",
      "$.runtime_prompts.manga_virtual_agent_prompt.version",
    );
  }
  if (typeof content !== "string" || content.trim().length < 200 || content.length > 240_000) {
    throw new ManjuConfigPayloadError(
      "MANGA_RUNTIME_PROMPT_CONTENT_INVALID",
      "漫剧运行提示词正文长度必须在 200 至 240000 字符之间",
      "$.runtime_prompts.manga_virtual_agent_prompt.content",
    );
  }
}

function sanitizePublicValue(value: unknown, path: string, depth: number): ManjuJsonValue {
  if (depth > MANJU_CONFIG_MAX_DEPTH) {
    throw new ManjuConfigPayloadError(
      "CONFIG_DEPTH_LIMIT",
      `已发布配置层级超过 ${MANJU_CONFIG_MAX_DEPTH} 层`,
      path,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ManjuConfigPayloadError("CONFIG_JSON_INVALID", "已发布配置包含非有限数字", path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizePublicValue(entry, pathFor(path, index), depth + 1));
  }
  if (!isPlainObject(value)) {
    throw new ManjuConfigPayloadError("CONFIG_JSON_INVALID", "已发布配置不是 JSON 数据", path);
  }

  const output: Record<string, ManjuJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    output[key] = sanitizePublicValue(value[key], pathFor(path, key), depth + 1);
  }
  return output;
}

export function sanitizeManjuPublicPayload(input: unknown): ManjuConfigPayload {
  const sanitized = sanitizePublicValue(input, "$", 0);
  if (!isPlainObject(sanitized)) {
    throw new ManjuConfigPayloadError("CONFIG_JSON_INVALID", "公开配置根节点必须是 JSON 对象", "$");
  }
  const canonical = stableJson(sanitized as ManjuConfigPayload);
  if (Buffer.byteLength(canonical, "utf8") > MANJU_CONFIG_MAX_PAYLOAD_BYTES) {
    throw new ManjuConfigPayloadError(
      "CONFIG_PAYLOAD_TOO_LARGE",
      "已发布配置超过公开读取大小限制",
      "$",
    );
  }
  return sanitized as ManjuConfigPayload;
}

export function stableManjuConfigHash(value: ManjuJsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function manjuHttpEtag(value: ManjuJsonValue): string {
  return `"manju-${stableManjuConfigHash(value)}"`;
}

export function isUuid(value: string): boolean {
  return z.string().uuid().safeParse(value).success;
}

function databaseErrorText(error: ManjuDatabaseErrorLike): string {
  return [error.code, error.message, error.details, error.hint]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

export function isManjuMigrationNotReadyError(error: ManjuDatabaseErrorLike | null | undefined): boolean {
  if (!error) return false;
  const text = databaseErrorText(error);
  const namesExpectedObject = text.includes("manju_config_");
  if (!namesExpectedObject) return false;
  if (["42P01", "42883"].includes(error.code ?? "")) return true;
  if (["PGRST202", "PGRST205"].includes(error.code ?? "")) {
    return text.includes("schema cache") || text.includes("could not find");
  }
  return (
    text.includes("does not exist") ||
    text.includes("undefined table") ||
    text.includes("undefined function")
  );
}

export function isManjuConflictError(error: ManjuDatabaseErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (["23505", "40001", "55000"].includes(error.code ?? "")) return true;
  const text = databaseErrorText(error);
  return (
    text.includes("conflict") ||
    text.includes("expected_active_release") ||
    text.includes("optimistic") ||
    text.includes("not a draft") ||
    text.includes("not_draft") ||
    text.includes("immutable") ||
    text.includes("already published")
  );
}

export function isManjuDatabaseValidationError(
  error: ManjuDatabaseErrorLike | null | undefined,
): boolean {
  if (!error) return false;
  return ["22023", "23514", "P0002"].includes(error.code ?? "");
}

export function normalizeRpcRow<T>(data: T | T[] | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}
