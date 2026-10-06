import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export type SkillJsonPrimitive = string | number | boolean | null;
export type SkillJsonValue = SkillJsonPrimitive | SkillJsonValue[] | { [key: string]: SkillJsonValue };
export type SkillJsonObject = { [key: string]: SkillJsonValue };

export const SKILL_PACKAGE_SCHEMA_VERSION = "1.0.0";
export const SKILL_PAYLOAD_MAX_BYTES = 512 * 1024;
export const SKILL_PAYLOAD_MAX_DEPTH = 24;
export const SKILL_PUBLIC_LIST_MAX = 100;

export const SkillOriginSchema = z.enum(["builtin", "open_source", "community", "custom"]);
export const SkillVisibilitySchema = z.enum(["private", "tenant", "public"]);
export const SkillRuntimeKindSchema = z.enum(["prompt", "tool", "workflow", "hybrid"]);
export const SkillLifecycleSchema = z.enum(["draft", "published", "archived"]);
export const SkillVersionStatusSchema = z.enum(["draft", "released"]);
export const SkillExecutionTypeSchema = z.enum(["prompt", "tool", "workflow", "hybrid"]);
export const SkillProvenanceKindSchema = z.enum([
  "oss_public_source",
  "public_contract_reimplementation",
  "internal_original",
]);

const JsonObjectSchema = z.record(z.string(), z.unknown());
const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "标识不能包含控制字符");
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill slug 格式不合法");
const SemverSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?(?:\+[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$/,
    "Skill 版本号必须是合法 semver",
  );
const SchemaVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,79}$/, "Skill schema 版本格式不合法");
const CommandNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(96)
  .regex(/^\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "Skill 命令必须是 /command-name 格式");
const HttpUrlSchema = z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), "仅允许 HTTP(S) URL");

export const SkillActorSchema = z.object({
  userId: IdentifierSchema,
  role: z.enum(["admin", "student"]),
  displayName: z.string().trim().min(1).max(128).optional(),
}).strict();

export type SkillActor = z.infer<typeof SkillActorSchema>;

export const SkillPermissionSchema = z.object({
  capability: z.string().trim().min(1).max(128),
  description: z.string().trim().max(500).default(""),
  required: z.boolean().default(true),
}).strict();

export const SkillResourceSchema = z.object({
  id: z.string().trim().min(1).max(128),
  kind: z.enum(["reference", "template", "example", "schema", "asset"]),
  title: z.string().trim().min(1).max(160),
  mediaType: z.string().trim().min(1).max(128).default("text/plain"),
  version: z.string().trim().min(1).max(64).default("1"),
  description: z.string().trim().max(500).default(""),
  content: z.string().max(200_000).optional(),
  url: HttpUrlSchema.optional(),
  checksum: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict().refine((value) => Boolean(value.content || value.url), {
  message: "Skill 资源必须提供 content 或 url",
});

export const SkillManifestSchema = z.object({
  commandName: CommandNameSchema,
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  category: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  triggerSignals: z.array(z.string().trim().min(1).max(160)).max(64).default([]),
  negativeTriggerSignals: z.array(z.string().trim().min(1).max(160)).max(64).default([]),
  autoInvoke: z.boolean().default(false),
  priority: z.number().int().min(-1000).max(1000).default(0),
  permissions: z.array(SkillPermissionSchema).max(64).default([]),
  author: z.string().trim().min(1).max(120),
  coverUrl: HttpUrlSchema.optional(),
  featured: z.boolean().default(false),
  priceCredits: z.number().finite().min(0).max(1_000_000).default(0),
  installCount: z.number().int().min(0).default(0),
  purchaseCount: z.number().int().min(0).default(0),
}).strict();

export const SkillOrchestrationStageSchema = z.object({
  id: z.string().trim().min(1).max(96),
  type: z.enum(["prompt", "model", "tool", "workflow", "transform", "output"]),
  title: z.string().trim().min(1).max(160),
  dependsOn: z.array(z.string().trim().min(1).max(96)).max(32).default([]),
  instruction: z.string().max(40_000).optional(),
  modelCapability: z.string().trim().min(1).max(128).optional(),
  toolId: z.string().trim().min(1).max(160).optional(),
  outputKey: z.string().trim().min(1).max(128).optional(),
  config: JsonObjectSchema.default({}),
}).strict();

export const SkillToolBindingSchema = z.object({
  id: z.string().trim().min(1).max(160),
  capability: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).default(""),
  required: z.boolean().default(true),
  config: JsonObjectSchema.default({}),
}).strict();

export const SkillProvenanceSchema = z.object({
  kind: SkillProvenanceKindSchema,
  sourceName: z.string().trim().min(1).max(200),
  sourceUrl: HttpUrlSchema.optional(),
  license: z.string().trim().min(1).max(200),
  attribution: z.string().trim().max(1_000).default(""),
  publicBehaviorReference: z.string().trim().max(1_000).default(""),
}).strict();

export const SkillPackagePayloadSchema = z.object({
  manifest: SkillManifestSchema,
  instructions: z.string().trim().min(1).max(200_000),
  input_schema: JsonObjectSchema,
  output_schema: JsonObjectSchema,
  execution_type: SkillExecutionTypeSchema,
  sanitized_config: JsonObjectSchema.default({}),
  routing: z.object({
    explicitCommands: z.array(CommandNameSchema).max(32).default([]),
    triggerSignals: z.array(z.string().trim().min(1).max(160)).max(64).default([]),
    negativeTriggerSignals: z.array(z.string().trim().min(1).max(160)).max(64).default([]),
    autoInvoke: z.boolean().default(false),
    priority: z.number().int().min(-1000).max(1000).default(0),
  }).strict().default({
    explicitCommands: [],
    triggerSignals: [],
    negativeTriggerSignals: [],
    autoInvoke: false,
    priority: 0,
  }),
  orchestration: z.object({
    stages: z.array(SkillOrchestrationStageSchema).min(1).max(128),
    missingInputPolicy: z.enum(["ask", "fail", "use_defaults"]).default("ask"),
    maxModelCalls: z.number().int().min(0).max(32).default(1),
    maxToolCalls: z.number().int().min(0).max(64).default(0),
  }).strict(),
  tools: z.array(SkillToolBindingSchema).max(64).default([]),
  resources: z.array(SkillResourceSchema).max(128).default([]),
  provenance: SkillProvenanceSchema,
}).strict();

export type SkillPackagePayload = z.infer<typeof SkillPackagePayloadSchema>;

export interface SkillPackageRow {
  id: string;
  slug: string;
  display_name: string;
  summary: string;
  origin: z.infer<typeof SkillOriginSchema>;
  visibility: z.infer<typeof SkillVisibilitySchema>;
  runtime_kind: z.infer<typeof SkillRuntimeKindSchema>;
  lifecycle: z.infer<typeof SkillLifecycleSchema>;
  active_version_id: string | null;
  latest_version_number: number;
  metadata: SkillJsonObject;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionRow {
  id: string;
  package_id: string;
  version_number: number;
  semver: string;
  status: z.infer<typeof SkillVersionStatusSchema>;
  payload: SkillPackagePayload;
  payload_hash: string;
  schema_version: string;
  parent_version_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface UserSkillInstallationRow {
  user_id: string;
  package_id: string;
  version_id: string;
  enabled: boolean;
  priority: number;
  install_config: SkillJsonObject;
  installed_by: string;
  created_at: string;
  updated_at: string;
}

export interface ResolvedSkillPackage {
  package: SkillPackageRow;
  version: SkillVersionRow;
  installation: UserSkillInstallationRow | null;
}

export interface PublicSkillResource {
  id: string;
  kind: "reference" | "template" | "example" | "schema" | "asset";
  title: string;
  mediaType: string;
  version: string;
  description: string;
  checksum?: string;
}

export interface PublicSkillPackage {
  id: string;
  packageId: string;
  slug: string;
  source: z.infer<typeof SkillOriginSchema>;
  visibility: z.infer<typeof SkillVisibilitySchema>;
  runtimeKind: z.infer<typeof SkillRuntimeKindSchema>;
  title: string;
  commandName: string;
  description: string;
  summary: string;
  category: string;
  tags: string[];
  version: string;
  schemaVersion: string;
  priceCredits: number;
  featured: boolean;
  installed: boolean;
  enabled: boolean;
  agentAutoInvokeEnabled: boolean;
  installCount: number;
  purchaseCount: number;
  author: string;
  coverUrl?: string;
  permissions: Array<{ capability: string; description: string; required: boolean }>;
  inputSchema: SkillJsonObject;
  outputSchema: SkillJsonObject;
  executionType: z.infer<typeof SkillExecutionTypeSchema>;
  resources: PublicSkillResource[];
  provenance: Omit<z.infer<typeof SkillProvenanceSchema>, "sourceUrl"> & { sourceUrl?: string };
  publishedAt: string;
}

export const SkillListQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  source: SkillOriginSchema.optional(),
  category: z.string().trim().max(80).optional(),
  tag: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(SKILL_PUBLIC_LIST_MAX).default(50),
}).strict();

export type SkillListQuery = z.infer<typeof SkillListQuerySchema>;

export const InstallSkillRequestSchema = z.object({
  packageId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-1000).max(1000).default(0),
  installConfig: JsonObjectSchema.default({}),
}).strict();

export const ReplaceSkillInstallationEntrySchema = z.object({
  package_id: z.string().uuid(),
  version_id: z.string().uuid(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-1000).max(1000).default(0),
  config: JsonObjectSchema.default({}),
}).strict();

export const ReplaceSkillInstallationsSchema = z.array(ReplaceSkillInstallationEntrySchema).max(256);

export type ReplaceSkillInstallationEntry = z.infer<typeof ReplaceSkillInstallationEntrySchema>;

export const SkillAdminQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  lifecycle: SkillLifecycleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

const SaveDraftActionSchema = z.object({
  action: z.literal("save-draft"),
  packageId: z.string().uuid().nullable().optional(),
  versionId: z.string().uuid().nullable().optional(),
  baseVersionId: z.string().uuid().nullable().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  slug: SlugSchema,
  displayName: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2_000),
  origin: SkillOriginSchema,
  visibility: SkillVisibilitySchema,
  runtimeKind: SkillRuntimeKindSchema,
  payload: SkillPackagePayloadSchema,
  semver: SemverSchema,
  schemaVersion: SchemaVersionSchema.default(SKILL_PACKAGE_SCHEMA_VERSION),
  metadata: JsonObjectSchema.default({}),
}).strict();

const ValidateActionSchema = SaveDraftActionSchema.omit({ action: true }).extend({
  action: z.literal("validate"),
}).strict();

const PublishActionSchema = z.object({
  action: z.literal("publish"),
  versionId: z.string().uuid(),
  expectedActiveVersionId: z.string().uuid().nullable().optional(),
}).strict();

const RollbackActionSchema = z.object({
  action: z.literal("rollback"),
  packageId: z.string().uuid(),
  targetVersionId: z.string().uuid(),
  expectedActiveVersionId: z.string().uuid().nullable().optional(),
}).strict();

const ArchiveActionSchema = z.object({
  action: z.literal("archive"),
  packageId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedActiveVersionId: z.string().uuid().nullable(),
}).strict();

export const SkillAdminActionSchema = z.discriminatedUnion("action", [
  ValidateActionSchema,
  SaveDraftActionSchema,
  PublishActionSchema,
  RollbackActionSchema,
  ArchiveActionSchema,
]);

export type SkillAdminAction = z.infer<typeof SkillAdminActionSchema>;

export const SkillInvocationClaimSchema = z.object({
  invocationId: z.string().uuid().default(() => randomUUID()),
  userId: IdentifierSchema,
  agentId: IdentifierSchema.nullable().default(null),
  packageId: z.string().uuid(),
  versionId: z.string().uuid(),
  clientIdempotencyKey: z.string().trim().min(8).max(200),
  input: JsonObjectSchema,
  modelId: z.string().trim().min(1).max(200).nullable().default(null),
  billingOperationId: z.string().trim().min(1).max(200).nullable().default(null),
  taskId: z.string().trim().min(1).max(200).nullable().default(null),
}).strict();

export const SkillInvocationCompleteSchema = z.object({
  invocationId: z.string().uuid(),
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  output: JsonObjectSchema,
  modelId: z.string().trim().min(1).max(200).nullable().default(null),
  billingOperationId: z.string().trim().min(1).max(200).nullable().default(null),
  taskId: z.string().trim().min(1).max(200).nullable().default(null),
  providerTaskId: z.string().trim().min(1).max(200).nullable().default(null),
  assetIds: z.array(z.string().trim().min(1).max(200)).max(128).default([]),
  chargedCredits: z.number().finite().min(0).default(0),
  chargedCash: z.number().finite().min(0).default(0),
  costSnapshot: JsonObjectSchema.default({}),
}).strict();

export const SkillInvocationFailureSchema = z.object({
  invocationId: z.string().uuid(),
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  failureKind: z.enum(["failed", "failed_unknown"]),
  errorCode: z.string().trim().min(1).max(160),
  errorDetail: JsonObjectSchema.default({}),
  billingOperationId: z.string().trim().min(1).max(200).nullable().default(null),
  taskId: z.string().trim().min(1).max(200).nullable().default(null),
}).strict();

export type SkillInvocationClaim = z.infer<typeof SkillInvocationClaimSchema>;
export type SkillInvocationComplete = z.infer<typeof SkillInvocationCompleteSchema>;
export type SkillInvocationFailure = z.infer<typeof SkillInvocationFailureSchema>;

export interface SkillInvocationRecord {
  id: string;
  user_id: string;
  agent_id: string | null;
  package_id: string;
  version_id: string;
  client_idempotency_key: string;
  payload_fingerprint: string;
  input: SkillJsonObject;
  state: "claimed" | "completed" | "failed" | "failed_unknown";
  output: SkillJsonObject | null;
  error_code: string | null;
  error_detail: SkillJsonObject | null;
  model_id: string | null;
  billing_operation_id: string | null;
  task_id: string | null;
  provider_task_id: string | null;
  asset_ids: string[];
  charged_credits: number;
  charged_cash: number;
  cost_snapshot: SkillJsonObject;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(secret|token|password|passphrase|authorization|cookie|credential|private[_-]?key|api[_-]?key|access[_-]?key|client[_-]?secret|signing[_-]?key)(?:$|[_-])/i;
const SECRET_REFERENCE_PATTERN = /\b(?:secret|vault|env|supabase-vault):\/\/[^\s"'`<>]+/gi;
const EXACT_SECRET_REFERENCE_PATTERN = /^(?:secret|vault|env|supabase-vault):\/\/[A-Za-z0-9._\-/:]+$/;

export class SkillPayloadValidationError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "SkillPayloadValidationError";
    this.code = code;
    this.path = path;
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(`_${normalized}_`);
}

export function isAllowedSecretReference(value: unknown): value is string {
  return typeof value === "string" && EXACT_SECRET_REFERENCE_PATTERN.test(value.trim());
}

function assertJsonTree(value: unknown, path: string, depth: number): asserts value is SkillJsonValue {
  if (depth > SKILL_PAYLOAD_MAX_DEPTH) {
    throw new SkillPayloadValidationError("SKILL_PAYLOAD_TOO_DEEP", "Skill 配置嵌套层级过深", path);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SkillPayloadValidationError("SKILL_PAYLOAD_NON_FINITE", "Skill 配置不能包含非有限数字", path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonTree(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SkillPayloadValidationError("SKILL_PAYLOAD_NOT_JSON", "Skill 配置必须是纯 JSON", path);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (isSensitiveKey(key) && !isAllowedSecretReference(entry)) {
      throw new SkillPayloadValidationError(
        "INLINE_SECRET_FORBIDDEN",
        "敏感配置只能保存 secret://、vault://、env:// 或 supabase-vault:// 引用",
        nextPath,
      );
    }
    if (!isSensitiveKey(key) && typeof entry === "string" && isAllowedSecretReference(entry)) {
      throw new SkillPayloadValidationError(
        "SECRET_REFERENCE_MISPLACED",
        "Secret 引用必须放在明确的敏感字段中",
        nextPath,
      );
    }
    assertJsonTree(entry, nextPath, depth + 1);
  }
}

function normalizeJson(value: unknown): SkillJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  );
}

export function stableSkillJson(value: unknown): string {
  assertJsonTree(value, "", 0);
  return JSON.stringify(normalizeJson(value));
}

export function skillPayloadHash(value: unknown): string {
  return createHash("sha256").update(stableSkillJson(value), "utf8").digest("hex");
}

export function validateSkillPackagePayload(value: unknown): SkillPackagePayload {
  const parsed = SkillPackagePayloadSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SkillPayloadValidationError(
      "SKILL_PAYLOAD_INVALID",
      first?.message ?? "Skill 包格式不合法",
      first?.path.join("."),
    );
  }
  assertJsonTree(parsed.data, "payload", 0);
  const encoded = Buffer.byteLength(stableSkillJson(parsed.data), "utf8");
  if (encoded > SKILL_PAYLOAD_MAX_BYTES) {
    throw new SkillPayloadValidationError("SKILL_PAYLOAD_TOO_LARGE", "Skill 包超过 512 KiB 限制", "payload");
  }
  return parsed.data as SkillPackagePayload;
}

export function validateSkillInstallConfig(value: unknown): SkillJsonObject {
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new SkillPayloadValidationError("INSTALL_CONFIG_INVALID", "安装配置必须是 JSON 对象", "installConfig");
  }
  assertJsonTree(parsed.data, "installConfig", 0);
  const rejectReferences = (entry: unknown, path: string): void => {
    if (typeof entry === "string" && isAllowedSecretReference(entry)) {
      throw new SkillPayloadValidationError(
        "INSTALL_SECRET_BINDING_FORBIDDEN",
        "用户安装配置不能绑定服务端 Secret",
        path,
      );
    }
    if (Array.isArray(entry)) return entry.forEach((item, index) => rejectReferences(item, `${path}[${index}]`));
    if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
        rejectReferences(item, `${path}.${key}`);
      }
    }
  };
  rejectReferences(parsed.data, "installConfig");
  return parsed.data as SkillJsonObject;
}

function sanitizeJsonForResponse(value: unknown, exposeSensitiveKeys: boolean): SkillJsonValue | undefined {
  if (typeof value === "string") {
    return value.replace(SECRET_REFERENCE_PATTERN, "[REDACTED_SECRET_REFERENCE]");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeJsonForResponse(entry, exposeSensitiveKeys))
      .filter((entry): entry is SkillJsonValue => entry !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const result: SkillJsonObject = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      if (exposeSensitiveKeys) result[key] = "[REDACTED]";
      continue;
    }
    const safe = sanitizeJsonForResponse(entry, exposeSensitiveKeys);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

export function sanitizeSkillAdminValue(value: unknown): SkillJsonValue {
  return sanitizeJsonForResponse(value, true) ?? null;
}

export function sanitizeSkillPublicValue(value: unknown): SkillJsonValue {
  return sanitizeJsonForResponse(value, false) ?? null;
}

export function sanitizeSkillAdminPayload(value: SkillPackagePayload): SkillPackagePayload {
  return sanitizeJsonForResponse(value, true) as SkillPackagePayload;
}

export function toPublicSkillPackage(resolved: ResolvedSkillPackage): PublicSkillPackage {
  const { package: packageRow, version, installation } = resolved;
  const payload = validateSkillPackagePayload(version.payload);
  const safeInput = sanitizeJsonForResponse(payload.input_schema, false) as SkillJsonObject;
  const safeOutput = sanitizeJsonForResponse(payload.output_schema, false) as SkillJsonObject;
  const safeProvenance = sanitizeJsonForResponse(payload.provenance, false) as PublicSkillPackage["provenance"];
  const resources = payload.resources.map((resource) => ({
    id: resource.id,
    kind: resource.kind,
    title: resource.title,
    mediaType: resource.mediaType,
    version: resource.version,
    description: resource.description,
    ...(resource.checksum ? { checksum: resource.checksum } : {}),
  }));

  return {
    id: packageRow.id,
    packageId: packageRow.id,
    slug: packageRow.slug,
    source: packageRow.origin,
    visibility: packageRow.visibility,
    runtimeKind: packageRow.runtime_kind,
    title: payload.manifest.displayName,
    commandName: payload.manifest.commandName,
    description: payload.manifest.description,
    summary: packageRow.summary,
    category: payload.manifest.category,
    tags: [...payload.manifest.tags],
    version: version.semver,
    schemaVersion: version.schema_version,
    priceCredits: payload.manifest.priceCredits,
    featured: payload.manifest.featured,
    installed: Boolean(installation),
    enabled: Boolean(installation?.enabled),
    agentAutoInvokeEnabled: Boolean(installation?.enabled && payload.manifest.autoInvoke),
    installCount: payload.manifest.installCount,
    purchaseCount: payload.manifest.purchaseCount,
    author: payload.manifest.author,
    ...(payload.manifest.coverUrl ? { coverUrl: payload.manifest.coverUrl } : {}),
    permissions: payload.manifest.permissions.map((permission) => ({ ...permission })),
    inputSchema: safeInput,
    outputSchema: safeOutput,
    executionType: payload.execution_type,
    resources,
    provenance: safeProvenance,
    publishedAt: version.published_at ?? version.updated_at,
  };
}

export function parseSkillActor(value: unknown): SkillActor | null {
  const parsed = SkillActorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseSkillPayloadFingerprint(input: SkillJsonObject): string {
  return skillPayloadHash(input);
}
