import { randomUUID } from "node:crypto";
import {
  WORKSPACE_SURFACE_KIND,
  applyModelPoolCompatibilityMutation,
  applyWorkspaceModelCompatibilityMutation,
  normalizeModelPoolSnapshot,
  stableConfigurationJson,
  normalizeWorkspaceModelSnapshot,
  type ModelPoolCompatibilityMutation,
  type ModelPoolEntry,
  type ModelPoolKind,
  type ModelPoolSnapshot,
  type WorkspaceModelCompatibilityMutation,
  type WorkspaceModelSnapshot,
  type WorkspaceSurface,
  type JsonObject,
} from "@/lib/platform-configuration-contract";
import {
  createPlatformConfigurationCandidate,
  stagePlatformModelCandidateWithCredentials,
  resumePlatformModelMutation,
  PlatformConfigurationMutationOutcomeUnknown,
  PlatformConfigurationError,
  previewPlatformConfigurationRelease,
  readCurrentPlatformConfiguration,
} from "@/lib/server/platform-configuration-admin";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  parseWorkspaceModelAssignmentOverrides,
  WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY,
} from "@/lib/workspace-model-assignment-settings";
import {
  IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY,
  parseImageModelSurfaceOrders,
} from "@/lib/image-model-surface-order";
import {
  parseVideoModelSurfaceOrders,
  VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY,
} from "@/lib/video-model-surface-order";

import { getImageModelCapabilities } from "@/lib/image-model-capabilities";
import { resolveImageProviderContract } from "@/lib/image-provider-contract";
import { IMAGE_MODEL_READINESS_KEYS } from "@/lib/image-model-extra-configuration";
import { MODEL_MUTATION_REQUEST_UUID, modelMutationLegacyId, type PlatformCredentialChange } from "@/lib/server/platform-configuration-pending-credentials";

type Row = Record<string, unknown>;
export type LegacyModelTable = "cover_models" | "video_models" | "llm_models" | "chat_models";

const TABLE_KIND: Record<LegacyModelTable, ModelPoolKind> = {
  cover_models: "image",
  video_models: "video",
  llm_models: "agent",
  chat_models: "agent",
};

// chat_models is an archived selector table. The public chat catalog and LLM
// runtime both read llm_models; importing chat_models would duplicate every
// logical model and manufacture missing endpoints for rows that intentionally
// contain display metadata only.
const MODEL_POOL_BOOTSTRAP_TABLES = ["cover_models", "video_models", "llm_models"] as const;

const MASKED_SECRET = /^(?:\*+|sk-\*+|configured|unchanged)$/iu;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function string(value: unknown): string {
  return String(value ?? "").trim();
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function legacyModelId(table: LegacyModelTable, rawId: unknown): string {
  const id = string(rawId) || randomUUID();
  return table === "llm_models" ? `llm:${id}` : table === "chat_models" ? `chat:${id}` : id;
}

function rawLegacyId(table: LegacyModelTable, modelId: string): string {
  if (table === "llm_models" && modelId.startsWith("llm:")) return modelId.slice(4);
  if (table === "chat_models" && modelId.startsWith("chat:")) return modelId.slice(5);
  return modelId;
}

function credentialRef(table: LegacyModelTable, id: string) {
  return `secret://platform-model/${table}/${id}`;
}

function safeEndpoint(table: LegacyModelTable, row: Row, enabled: boolean): string {
  const endpoint = table === "chat_models"
    ? string(row.proxy_url)
    : string(row.api_endpoint) || string(row.proxy_url);
  if (endpoint) return endpoint;
  if (enabled) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_MODEL_ENDPOINT_REQUIRED", `${table}:${string(row.id)} 缺少运行端点`);
  return `https://retired.invalid/${table}/${encodeURIComponent(string(row.id) || "unknown")}`;
}

function compactObject(entries: Array<[string, unknown]>): JsonObject {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== null && value !== "")) as JsonObject;
}

function entryFromLegacyRow(table: LegacyModelTable, raw: Row): ModelPoolEntry {
  const legacyId = string(raw.id) || randomUUID();
  // Catalog intent and operational readiness are separate. Image/video
  // validation may keep is_active=false while the published pool still owns
  // the configured model identity.
  const enabled = raw.is_hidden !== true && string(raw.provider) !== "retired_configuration";
  const kind = TABLE_KIND[table];
  const { __model_activation_gate: runtimeActivationGate, ...providerProtocolConfig } = record(raw.api_protocol_config);
  const pendingActivationGate = record(runtimeActivationGate).state === "pending"
    ? runtimeActivationGate
    : undefined;
  // Accepted evidence is runtime state and must not enter immutable catalogue
  // snapshots. A brand-new model is different: its initial pending gate has no
  // pre-existing physical row for the atomic publisher to preserve. Carry only
  // that pending gate through the first publication so a saved candidate can
  // never become an ungated customer-facing model.
  const apiProtocolConfig = pendingActivationGate
    ? { ...providerProtocolConfig, __model_activation_gate: pendingActivationGate }
    : providerProtocolConfig;
  const capabilities = kind === "image"
    ? compactObject([
      ["supportsImageInput", bool(raw.supports_image_input)],
      ["protocol", apiProtocolConfig],
    ])
    : kind === "video"
      ? compactObject([
        ["supportsImageInput", bool(raw.supports_image_input)],
        ["requiresImage", bool(raw.requires_image)],
        ["durationSeconds", finite(raw.duration_seconds)],
        ["maxDuration", finite(raw.max_duration)],
        ["protocol", apiProtocolConfig],
      ])
      : compactObject([
        ["deepThinkingType", finite(raw.deep_thinking_type)],
        ["webSearch", bool(raw.enable_web_search)],
        ["imageParsing", string(raw.image_parsing)],
        ["fileParsing", string(raw.file_parsing)],
        ["protocol", apiProtocolConfig],
      ]);
  const pricing = kind === "image"
    ? compactObject([["currency", "CNY"], ["cost", finite(raw.cost_price)], ["selling", finite(raw.selling_price ?? raw.cost_per_use)]])
    : kind === "video"
      ? compactObject([
        ["currency", string(raw.currency) || "CNY"], ["cost", finite(raw.cost_price)], ["selling", finite(raw.price_per_use ?? raw.cost_per_use)],
        ["costPerUse", finite(raw.cost_per_use)], ["inputCostPerMillion", finite(raw.input_cost_per_million)],
        ["outputCostPerMillion", finite(raw.output_cost_per_million)],
      ])
      : compactObject([
        ["currency", "CNY"], ["billingMode", string(raw.billing_mode) || "credit"],
        ["costPerUse", finite(raw.cost_per_use)], ["costPrice", finite(raw.cost_price)],
        ["inputCostPerMillion", finite(raw.input_cost_per_million)],
        ["outputCostPerMillion", finite(raw.output_cost_per_million)],
        ["cachedCostPerMillion", finite(raw.cached_cost_per_million)],
      ]);
  const configuration = compactObject([
    ["legacyTable", table],
    ["legacyId", legacyId],
    ["description", string(raw.description)],
    ["category", string(raw.category)],
    ["iconUrl", string(raw.icon_url)],
    ["adminNotes", string(raw.admin_notes)],
    ["userAccess", string(raw.user_access)],
    ["billingMode", string(raw.billing_mode)],
    ["tokenBillingEnabled", bool(raw.token_billing_enabled)],
    ["profitMargin", finite(raw.profit_margin)],
    ["tokenRoundingUnit", finite(raw.token_rounding_unit)],
    ["maxContextRounds", finite(raw.max_context_rounds)],
    ["maxContextTokens", finite(raw.max_context_tokens)],
    ["maxReplyTokens", finite(raw.max_reply_tokens)],
    ["timeout", finite(raw.timeout)],
    ["deductDeepThink", finite(raw.deduct_deep_think)],
    ["frequencyLimit", finite(raw.frequency_limit)],
    ["temperature", finite(raw.temperature)],
    ["responseFormat", string(raw.response_format)],
    ["protocolConfig", apiProtocolConfig],
    ...(table === "video_models" ? [["requestTemplate", raw.request_template], ["responseMapping", raw.response_mapping]] as Array<[string, unknown]> : []),
  ]);
  return {
    id: legacyModelId(table, legacyId),
    kind,
    name: string(raw.name) || string(raw.display_name) || string(raw.model_name) || legacyId,
    modelName: string(raw.model_name) || legacyId,
    provider: string(raw.provider) || string(apiProtocolConfig.provider) || (table === "chat_models" ? "legacy-chat" : "legacy"),
    protocol: string(raw.protocol_type) || string(apiProtocolConfig.protocol) || `${kind}-protocol-unconfigured`,
    endpoint: safeEndpoint(table, { ...raw, id: legacyId }, enabled),
    ...(string(raw.api_key) ? { credentialRef: credentialRef(table, legacyId) } : {}),
    catalogState: enabled ? "enabled" : "retired",
    sortOrder: Math.max(0, Math.round(finite(raw.sort_order) || 0)),
    capabilities,
    pricing,
    configuration,
  };
}

async function legacyRows(table: LegacyModelTable): Promise<Row[]> {
  const result = await getSupabaseAdminClient().from(table).select("*");
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_LEGACY_READ_FAILED", `读取 ${table} 失败：${result.error.message}`);
  return (result.data || []) as Row[];
}

async function bootstrapModelPoolSnapshot(): Promise<ModelPoolSnapshot> {
  const tables: readonly LegacyModelTable[] = MODEL_POOL_BOOTSTRAP_TABLES;
  const rows = await Promise.all(tables.map(async (table) => (await legacyRows(table)).map((row) => entryFromLegacyRow(table, row))));
  return normalizeModelPoolSnapshot({ schema: "model-pool-config/v1", models: rows.flat() });
}

function legacyIdentity(entry: ModelPoolEntry): string {
  return `${string(entry.configuration.legacyTable)}:${string(entry.configuration.legacyId)}`;
}

/**
 * A legacy model mutation must never roll an existing model binding back to
 * endpoint, pricing or protocol metadata stored in an older pool release.
 * Reconcile only models already owned by the current release with their live
 * physical rows, while preserving release-owned membership, catalog state,
 * credential reference and order until the requested mutation is applied.
 * Newly created physical rows are deliberately not auto-published.
 */
async function currentModelPoolWithLiveBindings(): Promise<ModelPoolSnapshot> {
  const current = await readCurrentPlatformConfiguration("model-pool");
  if (!current) return bootstrapModelPoolSnapshot();
  const live = await bootstrapModelPoolSnapshot();
  const liveByIdentity = new Map(live.models.map((entry) => [legacyIdentity(entry), entry]));
  return normalizeModelPoolSnapshot({
    schema: "model-pool-config/v1",
    models: current.snapshot.models.map((entry) => {
      const liveEntry = liveByIdentity.get(legacyIdentity(entry));
      if (!liveEntry) return entry;
      // A physical row containing an API key causes bootstrap to synthesize a
      // credentialRef. Keep that out unless the immutable current release
      // already owns the corresponding credential binding.
      const liveBinding: ModelPoolEntry = { ...liveEntry };
      delete liveBinding.credentialRef;
      return {
        ...liveBinding,
        id: entry.id,
        kind: entry.kind,
        ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}),
        catalogState: entry.catalogState,
        sortOrder: entry.sortOrder,
      };
    }),
  });
}

async function currentLegacyRow(table: LegacyModelTable, id: string): Promise<Row> {
  const result = await getSupabaseAdminClient().from(table).select("*").eq("id", id).maybeSingle();
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_LEGACY_READ_FAILED", `读取 ${table}:${id} 失败：${result.error.message}`);
  return record(result.data);
}

async function createMutationCandidate(
  actorId: string,
  kind: "model-pool" | "workspace-models",
  snapshot: ModelPoolSnapshot | WorkspaceModelSnapshot,
  note: string,
) {
  const release = await createPlatformConfigurationCandidate(actorId, kind, snapshot, note);
  const releaseId = string(release.id);
  const preview = await previewPlatformConfigurationRelease(kind, releaseId);
  return { release, preview };
}

export async function stageInitialModelPoolCandidate(input: { actorId: string; changeNote?: string }) {
  const current = await readCurrentPlatformConfiguration("model-pool");
  if (current) {
    throw new PlatformConfigurationError("MODEL_POOL_BASELINE_ALREADY_PUBLISHED", "模型池已有 current 发布版本，无需重复建立迁移基线");
  }
  return createMutationCandidate(
    input.actorId,
    "model-pool",
    await bootstrapModelPoolSnapshot(),
    input.changeNote || "从当前物理模型资源建立首个版本化迁移基线",
  );
}


type ImageBusinessDelta = { path: string[]; remove: boolean; value?: unknown };
const IMAGE_BINDING_IDENTITY = ["provider", "protocol", "modelName", "endpoint"] as const;
const IMAGE_REQUEST_BINDING_FIELDS = ["provider_contract", "submit_path", "poll_path"] as const;
const IMAGE_NON_EXECUTION_PROTOCOL_FIELDS = new Set(["admin_notes", "resolution_prices", "resolution_cost_prices"]);
const IMAGE_DELTA_UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertImageDeltaJson(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object") return;
  if (depth > 32) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_DELTA_INVALID", "图片配置层级过深");
  for (const key of Object.keys(value)) {
    if (IMAGE_DELTA_UNSAFE_KEYS.has(key)) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_DELTA_INVALID", "图片配置包含不安全字段");
    assertImageDeltaJson((value as Row)[key], depth + 1);
  }
}

/** Operate on canonical JSON. Absence/deletion differs from null/false/zero;
 * arrays are one value, never merged by index or unioned with physical drift. */
function imageBusinessDelta(before: unknown, after: unknown, path: string[] = []): ImageBusinessDelta[] {
  if (stableConfigurationJson(before) === stableConfigurationJson(after)) return [];
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)) {
    return [{ path, remove: false, value: after }];
  }
  const prior = before as Row, next = after as Row;
  return [...new Set([...Object.keys(prior), ...Object.keys(next)])].sort().flatMap(key => {
    if (!Object.hasOwn(next, key)) return [{ path: [...path, key], remove: true }];
    if (!Object.hasOwn(prior, key)) return [{ path: [...path, key], remove: false, value: next[key] }];
    return imageBusinessDelta(prior[key], next[key], [...path, key]);
  });
}

function applyImageBusinessDelta(base: unknown, changes: ImageBusinessDelta[]): Row {
  if (base !== undefined && (!base || typeof base !== "object" || Array.isArray(base))) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_DELTA_SHAPE_CONFLICT", "已发布图片配置结构与编辑基线不一致，请核对后重建候选");
  }
  const result = JSON.parse(JSON.stringify(record(base))) as Row;
  for (const change of changes) {
    let parent = result;
    let missingRemovalParent = false;
    for (const key of change.path.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) {
        if (change.remove) { missingRemovalParent = true; break; }
        parent[key] = {};
      } else if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
        if (change.remove) { missingRemovalParent = true; break; }
        throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_DELTA_SHAPE_CONFLICT", "已发布图片配置结构与编辑基线不一致，请核对后重建候选");
      }
      parent = parent[key] as Row;
    }
    if (missingRemovalParent) continue;
    const key = change.path[change.path.length - 1];
    if (!key || change.path.some(part => IMAGE_DELTA_UNSAFE_KEYS.has(part))) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_DELTA_INVALID", "图片配置变更路径无效");
    if (change.remove) delete parent[key];
    else parent[key] = JSON.parse(JSON.stringify(change.value)) as unknown;
  }
  return result;
}

/** A full physical form is an edit intent, never the published target's base.
 * This intentionally does not claim stale-browser baseline/CAS protection. */
function mergePublishedImageEdit(published: ModelPoolEntry, physical: ModelPoolEntry, submitted: ModelPoolEntry): ModelPoolEntry {
  for (const entry of [physical, submitted]) assertImageDeltaJson(entry);
  const normalize = (entry: ModelPoolEntry) => normalizeModelPoolSnapshot({ schema: "model-pool-config/v1", models: [entry] }).models[0];
  const before = normalize(physical), after = normalize(submitted);
  if (published.kind !== "image" || published.id !== before.id || before.id !== after.id
    || [before, after].some(entry => entry.configuration.legacyTable !== published.configuration.legacyTable || entry.configuration.legacyId !== published.configuration.legacyId)) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_IDENTITY_CONFLICT", "图片目标身份与已发布记录不一致");
  }
  if (IMAGE_BINDING_IDENTITY.some(key => before[key] !== after[key])) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_BINDING_CHANGE_UNSUPPORTED", "更换图片供应商、协议、端点或模型标识须新建隔离候选并重新验收");
  }
  const protocol = (entry: ModelPoolEntry) => Object.fromEntries(Object.entries(record(entry.configuration.protocolConfig))
    .filter(([key]) => !(IMAGE_MODEL_READINESS_KEYS as readonly string[]).includes(key)));
  // One intent feeds both mirrors. Readiness always remains release-owned.
  const protocolChanges = imageBusinessDelta(protocol(before), protocol(after));
  const executionProtocolChanged = protocolChanges.some(change => !IMAGE_NON_EXECUTION_PROTOCOL_FIELDS.has(change.path[0]));
  const supportsChanged = before.capabilities.supportsImageInput !== after.capabilities.supportsImageInput;
  const contract = (entry: ModelPoolEntry) => {
    const binding = resolveImageProviderContract({ provider: entry.provider, model_name: entry.modelName, api_endpoint: entry.endpoint,
      supports_image_input: entry.capabilities.supportsImageInput === true, api_protocol_config: record(entry.configuration.protocolConfig) });
    return { requestProtocol: binding.requestProtocol, referenceTransport: binding.referenceTransport };
  };
  if (executionProtocolChanged || supportsChanged) {
    let changedContract = true;
    try { changedContract = stableConfigurationJson(contract(before)) !== stableConfigurationJson(contract(after)); } catch { /* Unknown execution binding stays isolated. */ }
    if (changedContract || IMAGE_REQUEST_BINDING_FIELDS.some(key => stableConfigurationJson(protocol(before)[key] ?? null) !== stableConfigurationJson(protocol(after)[key] ?? null))) {
      throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_BINDING_CHANGE_UNSUPPORTED", "更换图片请求协议、传输或提交/轮询接口须新建隔离候选并重新验收");
    }
  }
  let physicalBindingDrift = IMAGE_BINDING_IDENTITY.some(key => published[key] !== before[key]);
  if (executionProtocolChanged && !physicalBindingDrift) {
    try { physicalBindingDrift = stableConfigurationJson(contract(published)) !== stableConfigurationJson(contract(before)); } catch { physicalBindingDrift = true; }
  }
  if (executionProtocolChanged && physicalBindingDrift) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_PHYSICAL_BASE_CONFLICT", "物理接口与已发布接口不一致，请先核对逻辑配置后再修改协议参数");
  }
  const businessChanges = imageBusinessDelta(before, after).filter(change => !["id", "kind", "credentialRef", "catalogState"].includes(change.path[0])
    && !(change.path[0] === "configuration" && ["legacyTable", "legacyId", "protocolConfig"].includes(change.path[1]))
    && !(change.path[0] === "capabilities" && change.path[1] === "protocol"));
  const result = applyImageBusinessDelta(published, businessChanges);
  if (protocolChanges.length) {
    const configuration = record(result.configuration), capabilities = record(result.capabilities);
    configuration.protocolConfig = applyImageBusinessDelta(configuration.protocolConfig, protocolChanges);
    capabilities.protocol = applyImageBusinessDelta(capabilities.protocol, protocolChanges);
    result.configuration = configuration; result.capabilities = capabilities;
  }
  const candidate = normalize(result as ModelPoolEntry);
  if (executionProtocolChanged || supportsChanged) {
    // An inactive physical alias can become active in L. Check the ACTUAL
    // normalized object to be persisted, including each mirror's own fields.
    const executionIdentity = (entry: ModelPoolEntry, mirror: "configuration" | "capabilities") => {
      const config = record(mirror === "configuration" ? entry.configuration.protocolConfig : entry.capabilities.protocol);
      const model = { provider: entry.provider, model_name: entry.modelName, api_endpoint: entry.endpoint,
        supports_image_input: entry.capabilities.supportsImageInput === true, api_protocol_config: config };
      const binding = resolveImageProviderContract(model), inputs = getImageModelCapabilities(model);
      return { provider: entry.provider, protocol: entry.protocol, modelName: entry.modelName, endpoint: entry.endpoint,
        supportsImageInput: model.supports_image_input, requestProtocol: binding.requestProtocol, referenceTransport: binding.referenceTransport,
        supportsReferenceInput: inputs.supportsReferenceInput, referenceInputMode: inputs.referenceInputMode,
        identityReferenceLevel: inputs.identityReferenceLevel, maxReferenceImages: inputs.maxReferenceImages, maxCharacterReferences: inputs.maxCharacterReferences,
        requestBinding: Object.fromEntries(IMAGE_REQUEST_BINDING_FIELDS.map(key => [key, config[key] ?? null])) };
    };
    let changedExecution = true;
    try { changedExecution = (["configuration", "capabilities"] as const).some(mirror =>
      stableConfigurationJson(executionIdentity(published, mirror)) !== stableConfigurationJson(executionIdentity(candidate, mirror))); }
    catch { /* An unparseable execution edit never reaches stage or credentials. */ }
    if (changedExecution) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_BINDING_CHANGE_UNSUPPORTED", "最终图片协议、输入能力或请求绑定发生变化，须新建隔离候选并重新验收");
  }
  return candidate;
}

export async function stageLegacyModelPoolUpsert(input: {
  actorId: string;
  requestId: string;
  requestPayload: Row;
  table: LegacyModelTable;
  id?: string;
  values: Row;
  changeNote: string;
}) {
  if (!MODEL_MUTATION_REQUEST_UUID.test(String(input.requestId || ""))) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED", "请提供有效的模型变更请求标识后重试");
  if (!input.requestPayload || typeof input.requestPayload !== "object" || Array.isArray(input.requestPayload)) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_PAYLOAD_REQUIRED", "模型变更缺少原始逻辑请求");
  const generatedId = modelMutationLegacyId(input.actorId, input.requestId, input.table);
  const originalTargetId = string(input.requestPayload.targetId || record(input.requestPayload.body).id);
  const imagePost = String(input.requestPayload.method || "").toUpperCase() === "POST" && input.table === "cover_models";
  const imageCreate = imagePost && !originalTargetId;
  const legacyId = imageCreate ? `pending-cover-model-${generatedId}` : (imagePost ? originalTargetId : "") || string(input.id || input.values.id) || generatedId;
  const resumed = await resumePlatformModelMutation(input.actorId, input.requestId, input.requestPayload);
  if (resumed) {
    const rawSnapshot = record(resumed.snapshot);
    const models = Array.isArray(rawSnapshot.models) ? rawSnapshot.models as Row[] : [];
    const model = models.find(entry => record(entry.configuration).legacyTable === input.table && record(entry.configuration).legacyId === legacyId);
    // The receipt is authoritative for the candidate; response identity is metadata.
    try { return { release: resumed, preview: ["draft", "validated"].includes(String(resumed.status)) ? await previewPlatformConfigurationRelease("model-pool", string(resumed.id)) : null, modelId: model ? string(model.id) : legacyModelId(input.table, legacyId), legacyId }; }
    catch { throw new PlatformConfigurationMutationOutcomeUnknown(input.requestId, string(resumed.id), "preview"); }
  }
  const existing = await currentLegacyRow(input.table, legacyId);
  const secret = string(input.values.api_key);
  const credentialChanges: PlatformCredentialChange[] = secret && !MASKED_SECRET.test(secret)
    ? [{ model_key: `${input.table}:${legacyId}`, credential_ref: credentialRef(input.table, legacyId), secret_value: secret }]
    : [];
  const merged: Row = { ...existing, ...input.values, id: legacyId };
  // Unified image forms send an empty operator note even when the existing
  // protocol has never stored one. Preserve absence for that redundant default;
  // an existing note can still be explicitly cleared, and creates keep defaults.
  if (input.table === "cover_models" && !imageCreate && string(existing.id) === legacyId
      && !Object.hasOwn(record(existing.api_protocol_config), "admin_notes")
      && record(merged.api_protocol_config).admin_notes === "") {
    const protocol = { ...record(merged.api_protocol_config) };
    delete protocol.admin_notes;
    merged.api_protocol_config = protocol;
  }
  if (!string(merged.api_key) && string(input.values.api_key)) merged.api_key = input.values.api_key;
  let entry = entryFromLegacyRow(input.table, merged);
  if (string(merged.provider) !== "retired_configuration") entry.catalogState = "enabled";
  if (string(input.values.api_key) && !entry.credentialRef) entry.credentialRef = credentialRef(input.table, legacyId);
  // Image/video upserts own exactly one entry. Keep all other published
  // entries unchanged. Published image targets receive only actual edit intent.
  const scopedUpsert = input.table === "cover_models" || input.table === "video_models";
  const scopedBase = scopedUpsert ? await readCurrentPlatformConfiguration("model-pool") : null;
  if (scopedUpsert && !scopedBase) throw new PlatformConfigurationError("MODEL_POOL_CURRENT_RELEASE_REQUIRED", "图片和视频变更需要已发布的模型池基础版本");
  const previous = scopedBase?.snapshot.models.find((model) => model.kind === entry.kind && model.id === entry.id);
  if (input.table === "cover_models" && !imageCreate && previous) {
    if (string(existing.id) !== legacyId) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_IMAGE_PHYSICAL_BASE_NOT_FOUND", "无法读取已发布图片目标的物理基线");
    entry = mergePublishedImageEdit(previous, entryFromLegacyRow(input.table, existing), entry);
    if (credentialChanges.length) entry.credentialRef = credentialRef(input.table, legacyId);
  }
  if (scopedBase && credentialChanges.length === 0) {
    delete entry.credentialRef;
    if (previous?.credentialRef) entry.credentialRef = previous.credentialRef;
  }
  const snapshot = applyModelPoolCompatibilityMutation(scopedBase ? scopedBase.snapshot : await currentModelPoolWithLiveBindings(), { action: "upsert", entry });
  const release = await stagePlatformModelCandidateWithCredentials({ actorId: input.actorId, requestId: input.requestId, requestPayload: input.requestPayload, snapshot, credentialChanges, changeNote: input.changeNote,
    ...(scopedBase ? { expectedBase: { releaseId: string(scopedBase.release.id), snapshotSha256: string(scopedBase.release.snapshot_sha256) } } : {}),
    ...(input.table === "video_models" ? { operation: "video-upsert-only" as const } : {}),
  });
  try { const preview = await previewPlatformConfigurationRelease("model-pool", string(release.id)); return { release, preview, modelId: entry.id, legacyId }; }
  catch { throw new PlatformConfigurationMutationOutcomeUnknown(input.requestId, string(release.id), "preview"); }
}

export async function stageLegacyModelPoolCatalogState(input: {
  actorId: string;
  table: LegacyModelTable;
  id: string;
  catalogState: "enabled" | "retired";
  changeNote: string;
}) {
  const snapshot = await currentModelPoolWithLiveBindings();
  const modelId = legacyModelId(input.table, rawLegacyId(input.table, input.id));
  const next = applyModelPoolCompatibilityMutation(snapshot, {
    action: "set-catalog-state",
    kind: TABLE_KIND[input.table],
    modelId,
    catalogState: input.catalogState,
  });
  return { ...(await createMutationCandidate(input.actorId, "model-pool", next, input.changeNote)), modelId };
}

export async function assertPublishedModelPoolEntry(table: LegacyModelTable, id: string) {
  const current = await readCurrentPlatformConfiguration("model-pool");
  if (!current) throw new PlatformConfigurationError("MODEL_POOL_CURRENT_RELEASE_REQUIRED", "模型池尚无 current published 版本");
  const modelId = legacyModelId(table, rawLegacyId(table, id));
  const entry = current.snapshot.models.find((model) => model.kind === TABLE_KIND[table] && model.id === modelId);
  if (!entry || entry.catalogState !== "enabled") {
    throw new PlatformConfigurationError("MODEL_NOT_IN_CURRENT_POOL", "模型必须先通过差异预览发布到 current 模型池，再执行运行验收激活");
  }
  const legacyTable = string(entry.configuration.legacyTable);
  const legacyId = string(entry.configuration.legacyId);
  if (legacyTable !== table || legacyId !== rawLegacyId(table, id)) {
    throw new PlatformConfigurationError("MODEL_POOL_IDENTITY_MISMATCH", "current 模型池的物理映射身份不一致");
  }
  return entry;
}

export async function stageLegacyModelPoolOrder(input: {
  actorId: string;
  table: LegacyModelTable;
  orders: Array<{ id: string; sortOrder: number }>;
  changeNote: string;
}) {
  const mutation: ModelPoolCompatibilityMutation = {
    action: "reorder",
    kind: TABLE_KIND[input.table],
    orders: input.orders.map((entry) => ({ modelId: legacyModelId(input.table, entry.id), sortOrder: entry.sortOrder })),
  };
  const snapshot = applyModelPoolCompatibilityMutation(await currentModelPoolWithLiveBindings(), mutation);
  return createMutationCandidate(input.actorId, "model-pool", snapshot, input.changeNote);
}

function orderedAssigned(ids: string[], order: Record<string, number>, poolOrder: Map<string, number>) {
  return [...ids].sort((left, right) => (order[left] ?? poolOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (order[right] ?? poolOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
}

async function bootstrapWorkspaceSnapshot(): Promise<WorkspaceModelSnapshot> {
  const pool = await readCurrentPlatformConfiguration("model-pool");
  if (!pool) throw new PlatformConfigurationError("WORKSPACE_MODEL_POOL_NOT_CURRENT", "请先发布模型池版本，再创建工作台候选");
  const settings = await getSupabaseAdminClient().from("platform_settings").select("setting_key,setting_value")
    .in("setting_key", [WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY, IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY, VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY]);
  if (settings.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_LEGACY_READ_FAILED", `读取工作台配置失败：${settings.error.message}`);
  const values = new Map((settings.data || []).map((row: Row) => [string(row.setting_key), row.setting_value]));
  const assignments = parseWorkspaceModelAssignmentOverrides(values.get(WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY));
  const imageOrders = parseImageModelSurfaceOrders(values.get(IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY));
  const videoOrders = parseVideoModelSurfaceOrders(values.get(VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY));
  const models = pool.snapshot.models.filter((model) => model.catalogState === "enabled");
  const order = new Map(models.map((model) => [model.id, model.sortOrder]));
  const orderFor = (surface: WorkspaceSurface) => {
    if (surface === "publish-center-image") return imageOrders["publish-center-image"];
    if (surface === "publish-center-video") return videoOrders["publish-center-video"];
    if (surface === "image-workbench") return imageOrders["image-workbench"];
    if (surface === "cover-studio") return imageOrders["cover-studio"];
    if (surface === "storyboard-image") return imageOrders["storyboard-workbench"];
    if (surface === "free-canvas-image") return imageOrders["free-canvas"];
    if (surface === "film-studio-image") return imageOrders["film-studio"];
    if (surface === "video-page") return videoOrders["ai-video"];
    if (surface === "storyboard-video") return videoOrders.storyboard;
    if (surface === "free-canvas-video") return videoOrders["free-canvas"];
    if (surface === "film-studio-video") return videoOrders["film-studio"];
    return videoOrders["commerce-agent"];
  };
  const surfaces = Object.fromEntries((Object.keys(WORKSPACE_SURFACE_KIND) as WorkspaceSurface[]).map((surface) => {
    const kind = WORKSPACE_SURFACE_KIND[surface];
    const assignedModelIds = models.filter((model) => model.kind === kind && assignments[surface]?.[model.id] === true).map((model) => model.id);
    return [surface, { kind, assignedModelIds, orderedModelIds: orderedAssigned(assignedModelIds, orderFor(surface), order) }];
  }));
  return normalizeWorkspaceModelSnapshot({
    schema: "workspace-model-config/v1",
    modelPoolRelease: { releaseId: string(pool.release.id), snapshotSha256: string(pool.release.snapshot_sha256) },
    surfaces,
  });
}

async function currentOrBootstrapWorkspace() {
  const [current, pool] = await Promise.all([
    readCurrentPlatformConfiguration("workspace-models"),
    readCurrentPlatformConfiguration("model-pool"),
  ]);
  if (!pool) throw new PlatformConfigurationError("WORKSPACE_MODEL_POOL_NOT_CURRENT", "请先发布模型池版本，再创建工作台候选");
  if (!current) return bootstrapWorkspaceSnapshot();

  const poolIdentity = {
    releaseId: string(pool.release.id),
    snapshotSha256: string(pool.release.snapshot_sha256),
  };
  if (current.snapshot.modelPoolRelease.releaseId === poolIdentity.releaseId
      && current.snapshot.modelPoolRelease.snapshotSha256 === poolIdentity.snapshotSha256) {
    return current.snapshot;
  }

  // A model-pool publication supersedes the dependency identity of the current
  // workspace snapshot. Rebase only surviving enabled assignments onto that
  // exact pool; never copy catalog or operational activation state back from a
  // workspace mutation.
  const enabled = new Map(pool.snapshot.models
    .filter((model) => model.catalogState === "enabled")
    .map((model) => [model.id, model]));
  const surfaces = Object.fromEntries((Object.keys(WORKSPACE_SURFACE_KIND) as WorkspaceSurface[]).map((surface) => {
    const existing = current.snapshot.surfaces[surface] || { kind: WORKSPACE_SURFACE_KIND[surface], assignedModelIds: [], orderedModelIds: [] };
    const assignedModelIds = existing.assignedModelIds.filter((id) => enabled.get(id)?.kind === existing.kind);
    const assigned = new Set(assignedModelIds);
    const orderedModelIds = existing.orderedModelIds.filter((id) => assigned.has(id));
    orderedModelIds.push(...assignedModelIds
      .filter((id) => !orderedModelIds.includes(id))
      .sort((left, right) => (enabled.get(left)?.sortOrder ?? Number.MAX_SAFE_INTEGER)
        - (enabled.get(right)?.sortOrder ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)));
    return [surface, { ...existing, assignedModelIds, orderedModelIds }];
  }));
  return normalizeWorkspaceModelSnapshot({
    schema: "workspace-model-config/v1",
    modelPoolRelease: poolIdentity,
    surfaces,
  });
}

export async function stageInitialWorkspaceModelCandidate(input: { actorId: string; changeNote?: string }) {
  const current = await readCurrentPlatformConfiguration("workspace-models");
  if (current) {
    throw new PlatformConfigurationError("WORKSPACE_MODEL_BASELINE_ALREADY_PUBLISHED", "工作台模型已有 current 发布版本，无需重复建立迁移基线");
  }
  return createMutationCandidate(
    input.actorId,
    "workspace-models",
    await bootstrapWorkspaceSnapshot(),
    input.changeNote || "从当前工作台分配建立首个版本化迁移基线",
  );
}

export async function stageLegacyWorkspaceMutation(input: {
  actorId: string;
  mutation: WorkspaceModelCompatibilityMutation;
  changeNote: string;
}) {
  const current = await currentOrBootstrapWorkspace();
  const next = applyWorkspaceModelCompatibilityMutation(current, input.mutation);
  return createMutationCandidate(input.actorId, "workspace-models", next, input.changeNote);
}

export const PLATFORM_CONFIGURATION_COMPATIBILITY_TABLES = Object.freeze(Object.keys(TABLE_KIND) as LegacyModelTable[]);
