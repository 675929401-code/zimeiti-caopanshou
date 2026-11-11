import { createHash } from "node:crypto";

export const PLATFORM_CONFIGURATION_KINDS = ["model-pool", "workspace-models"] as const;
export type PlatformConfigurationKind = typeof PLATFORM_CONFIGURATION_KINDS[number];
export type ModelPoolKind = "agent" | "image" | "video";
export type ModelCatalogState = "enabled" | "retired";

import { WORKSPACE_SURFACE_KIND, type WorkspaceSurface } from "@/lib/workspace-surface-contract";
export { WORKSPACE_SURFACE_KIND, type WorkspaceSurface } from "@/lib/workspace-surface-contract";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ModelPoolEntry = {
  id: string;
  kind: ModelPoolKind;
  name: string;
  modelName: string;
  provider: string;
  protocol: string;
  endpoint: string;
  credentialRef?: string;
  catalogState: ModelCatalogState;
  sortOrder: number;
  capabilities: JsonObject;
  pricing: JsonObject;
  configuration: JsonObject;
};

export type ModelPoolSnapshot = {
  schema: "model-pool-config/v1";
  models: ModelPoolEntry[];
};

export type WorkspaceSurfaceConfiguration = {
  kind: "image" | "video";
  assignedModelIds: string[];
  orderedModelIds: string[];
};

export type WorkspaceModelSnapshot = {
  schema: "workspace-model-config/v1";
  modelPoolRelease: {
    releaseId: string;
    snapshotSha256: string;
  };
  surfaces: Record<Exclude<WorkspaceSurface, "publish-center-image" | "publish-center-video">, WorkspaceSurfaceConfiguration>
    & Partial<Record<"publish-center-image" | "publish-center-video", WorkspaceSurfaceConfiguration>>;
};

export type PlatformConfigurationSnapshot = ModelPoolSnapshot | WorkspaceModelSnapshot;

export type ModelPoolCompatibilityMutation =
  | { action: "upsert"; entry: ModelPoolEntry }
  | { action: "set-catalog-state"; kind: ModelPoolKind; modelId: string; catalogState: ModelCatalogState }
  | { action: "reorder"; kind: ModelPoolKind; orders: Array<{ modelId: string; sortOrder: number }> };

export type WorkspaceModelCompatibilityMutation =
  | { action: "assign"; surface: WorkspaceSurface; modelId: string; enabled: boolean }
  | { action: "reorder"; surface: WorkspaceSurface; orderedModelIds: string[] };

export type ConfigurationValidation = {
  ok: boolean;
  issues: string[];
  warnings: string[];
};

type CollectionDiff = {
  added: string[];
  removed: string[];
  unchanged: string[];
};

export type ModelPoolConfigurationDiff = {
  schema: "model-pool-config-diff/v1";
  models: CollectionDiff & {
    changed: Array<{ key: string; beforeSha256: string; afterSha256: string }>;
  };
  changed: boolean;
};

export type WorkspaceConfigurationDiff = {
  schema: "workspace-model-config-diff/v1";
  modelPoolRelease: {
    before: WorkspaceModelSnapshot["modelPoolRelease"] | null;
    after: WorkspaceModelSnapshot["modelPoolRelease"];
    changed: boolean;
  };
  surfaces: Array<{
    surface: WorkspaceSurface;
    assignments: CollectionDiff;
    beforeOrder: string[];
    afterOrder: string[];
    orderChanged: boolean;
    changed: boolean;
  }>;
  changed: boolean;
};

export type PlatformConfigurationDiff = ModelPoolConfigurationDiff | WorkspaceConfigurationDiff;

export type PlatformConfigurationReleaseIdentity = {
  releaseId: string;
  releaseVersion: number;
  snapshotSha256: string;
  status: string;
};

export type PlatformConfigurationReleasePreview = {
  schema: "platform-configuration-preview/v1";
  kind: PlatformConfigurationKind;
  current: PlatformConfigurationReleaseIdentity | null;
  candidate: PlatformConfigurationReleaseIdentity;
  diff: PlatformConfigurationDiff;
  previewSha256: string;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MODEL_ID = /^[^\s]{1,200}$/u;
const CREDENTIAL_REF = /^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/;
const SENSITIVE_CONFIGURATION_KEYS = new Set([
  "apikey",
  "authorization",
  "password",
  "secret",
  "servicerolekey",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "credential",
  "credentials",
]);

function isSensitiveConfigurationKey(key: string): boolean {
  const canonical = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_CONFIGURATION_KEYS.has(canonical)
    || /(?:apikey|accesstoken|refreshtoken|authorization|password|secret|credential)$/u.test(canonical);
}

function lexical(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}必须是对象`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key)).sort(lexical);
  if (unknown.length > 0) throw new Error(`${path}包含未知字段 ${unknown.join(",")}`);
}

function requiredString(value: unknown, path: string, maximum = 500): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximum) throw new Error(`${path}不能为空且长度不能超过 ${maximum}`);
  return result;
}

function modelId(value: unknown, path: string): string {
  const result = requiredString(value, path, 200);
  if (!MODEL_ID.test(result)) throw new Error(`${path}格式无效`);
  return result;
}

function uniqueIds(value: unknown, path: string, preserveOrder = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${path}必须是数组`);
  const values = value.map((entry, index) => modelId(entry, `${path}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${path}不能包含重复模型`);
  return preserveOrder ? values : values.sort(lexical);
}

function normalizeEndpoint(value: unknown, path: string): string {
  const raw = requiredString(value, path, 2000);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${path}必须是完整 HTTP(S) URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${path}只能使用无内嵌凭据的 HTTP(S) URL`);
  }
  if (parsed.hash) throw new Error(`${path}不能包含片段或隐藏凭据`);
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveConfigurationKey(key)) throw new Error(`${path}不能在查询参数中保存密钥`);
  }
  return parsed.toString();
}

function normalizeJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > 20_000) throw new Error(`${path}文本过长`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}必须是有限数值`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`));
  const source = record(value, path);
  const result: JsonObject = {};
  for (const key of Object.keys(source).sort(lexical)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, "") === "credentialref") {
      const reference = typeof source[key] === "string" ? source[key].trim() : "";
      if (!CREDENTIAL_REF.test(reference)) throw new Error(`${path}.${key}只能保存 env:// 或 secret:// 凭据引用`);
      result[key] = reference;
      continue;
    }
    if (isSensitiveConfigurationKey(key)) throw new Error(`${path}.${key}不能保存环境密钥`);
    result[key] = normalizeJson(source[key], `${path}.${key}`);
  }
  return result;
}

function normalizeJsonObject(value: unknown, path: string): JsonObject {
  return normalizeJson(record(value, path), path) as JsonObject;
}

export function stableConfigurationJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "配置"));
}

export function configurationSha256(value: unknown): string {
  return createHash("sha256").update(stableConfigurationJson(value)).digest("hex");
}

export function normalizeModelPoolSnapshot(value: unknown): ModelPoolSnapshot {
  const root = record(value, "模型池快照");
  assertOnlyKeys(root, ["schema", "models"], "模型池快照");
  if (root.schema !== "model-pool-config/v1") throw new Error("模型池快照 schema 必须是 model-pool-config/v1");
  if (!Array.isArray(root.models)) throw new Error("模型池快照 models 必须是数组");
  const models = root.models.map((raw, index): ModelPoolEntry => {
    const source = record(raw, `models[${index}]`);
    assertOnlyKeys(source, ["id", "kind", "name", "modelName", "provider", "protocol", "endpoint", "credentialRef", "catalogState", "sortOrder", "capabilities", "pricing", "configuration"], `models[${index}]`);
    const kind = String(source.kind || "") as ModelPoolKind;
    if (!["agent", "image", "video"].includes(kind)) throw new Error(`models[${index}].kind 无效`);
    const catalogState = String(source.catalogState || "") as ModelCatalogState;
    if (!["enabled", "retired"].includes(catalogState)) throw new Error(`models[${index}].catalogState 无效`);
    const sortOrder = Number(source.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error(`models[${index}].sortOrder 必须是非负整数`);
    const credentialRef = source.credentialRef === undefined ? undefined : requiredString(source.credentialRef, `models[${index}].credentialRef`, 220);
    if (credentialRef !== undefined && !CREDENTIAL_REF.test(credentialRef)) throw new Error(`models[${index}].credentialRef 必须引用 env:// 或 secret://`);
    return {
      id: modelId(source.id, `models[${index}].id`),
      kind,
      name: requiredString(source.name, `models[${index}].name`, 200),
      modelName: requiredString(source.modelName, `models[${index}].modelName`, 300),
      provider: requiredString(source.provider, `models[${index}].provider`, 160),
      protocol: requiredString(source.protocol, `models[${index}].protocol`, 120),
      endpoint: normalizeEndpoint(source.endpoint, `models[${index}].endpoint`),
      ...(credentialRef ? { credentialRef } : {}),
      catalogState,
      sortOrder,
      capabilities: normalizeJsonObject(source.capabilities, `models[${index}].capabilities`),
      pricing: normalizeJsonObject(source.pricing, `models[${index}].pricing`),
      configuration: normalizeJsonObject(source.configuration, `models[${index}].configuration`),
    };
  }).sort((left, right) => lexical(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`));
  const keys = models.map((entry) => `${entry.kind}:${entry.id}`);
  if (new Set(keys).size !== keys.length) throw new Error("模型池快照不能包含重复 kind/id");
  return { schema: "model-pool-config/v1", models };
}

export function normalizeWorkspaceModelSnapshot(value: unknown): WorkspaceModelSnapshot {
  const root = record(value, "工作台快照");
  assertOnlyKeys(root, ["schema", "modelPoolRelease", "surfaces"], "工作台快照");
  if (root.schema !== "workspace-model-config/v1") throw new Error("工作台快照 schema 必须是 workspace-model-config/v1");
  const reference = record(root.modelPoolRelease, "modelPoolRelease");
  assertOnlyKeys(reference, ["releaseId", "snapshotSha256"], "modelPoolRelease");
  const releaseId = requiredString(reference.releaseId, "modelPoolRelease.releaseId", 80);
  const snapshotSha256 = requiredString(reference.snapshotSha256, "modelPoolRelease.snapshotSha256", 64);
  if (!UUID.test(releaseId) || !SHA256.test(snapshotSha256)) throw new Error("modelPoolRelease 身份无效");
  const rawSurfaces = record(root.surfaces, "surfaces");
  assertOnlyKeys(rawSurfaces, Object.keys(WORKSPACE_SURFACE_KIND), "surfaces");
  const surfaces = {} as WorkspaceModelSnapshot["surfaces"];
  for (const surface of Object.keys(WORKSPACE_SURFACE_KIND) as WorkspaceSurface[]) {
    if ((surface === "publish-center-image" || surface === "publish-center-video") && rawSurfaces[surface] === undefined) continue;
    const source = record(rawSurfaces[surface], `surfaces.${surface}`);
    assertOnlyKeys(source, ["kind", "assignedModelIds", "orderedModelIds"], `surfaces.${surface}`);
    const kind = WORKSPACE_SURFACE_KIND[surface];
    if (source.kind !== kind) throw new Error(`surfaces.${surface}.kind 必须是 ${kind}`);
    const assignedModelIds = uniqueIds(source.assignedModelIds, `surfaces.${surface}.assignedModelIds`);
    const orderedModelIds = uniqueIds(source.orderedModelIds, `surfaces.${surface}.orderedModelIds`, true);
    const assigned = new Set(assignedModelIds);
    if (orderedModelIds.some((id) => !assigned.has(id))) throw new Error(`surfaces.${surface}.orderedModelIds 只能引用已分配模型`);
    surfaces[surface] = { kind, assignedModelIds, orderedModelIds };
  }
  return {
    schema: "workspace-model-config/v1",
    modelPoolRelease: { releaseId, snapshotSha256 },
    surfaces,
  };
}

export function normalizePlatformConfigurationSnapshot(kind: PlatformConfigurationKind, value: unknown): PlatformConfigurationSnapshot {
  return kind === "model-pool" ? normalizeModelPoolSnapshot(value) : normalizeWorkspaceModelSnapshot(value);
}

/**
 * Compatibility writers can only create a complete candidate snapshot. They
 * never patch a published row or mutate another configuration stream.
 */
export function applyModelPoolCompatibilityMutation(
  current: ModelPoolSnapshot,
  mutation: ModelPoolCompatibilityMutation,
): ModelPoolSnapshot {
  if (mutation.action === "upsert") {
    const entry = normalizeModelPoolSnapshot({ schema: "model-pool-config/v1", models: [mutation.entry] }).models[0];
    const key = `${entry.kind}:${entry.id}`;
    return normalizeModelPoolSnapshot({
      schema: "model-pool-config/v1",
      models: [...current.models.filter((model) => `${model.kind}:${model.id}` !== key), entry],
    });
  }
  if (mutation.action === "set-catalog-state") {
    const id = modelId(mutation.modelId, "mutation.modelId");
    let found = false;
    const models = current.models.map((entry) => {
      if (entry.kind !== mutation.kind || entry.id !== id) return entry;
      found = true;
      return { ...entry, catalogState: mutation.catalogState };
    });
    if (!found) throw new Error(`模型池不存在 ${mutation.kind}:${id}`);
    return normalizeModelPoolSnapshot({ schema: "model-pool-config/v1", models });
  }
  const requested = new Map<string, number>();
  for (const [index, item] of mutation.orders.entries()) {
    const id = modelId(item.modelId, `mutation.orders[${index}].modelId`);
    const sortOrder = Number(item.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error(`mutation.orders[${index}].sortOrder 必须是非负整数`);
    if (requested.has(id)) throw new Error("模型池排序不能包含重复模型");
    requested.set(id, sortOrder);
  }
  const existing = new Set(current.models.filter((entry) => entry.kind === mutation.kind).map((entry) => entry.id));
  const missing = [...requested.keys()].filter((id) => !existing.has(id));
  if (missing.length > 0) throw new Error(`模型池排序引用不存在的模型 ${missing.join(",")}`);
  return normalizeModelPoolSnapshot({
    schema: "model-pool-config/v1",
    models: current.models.map((entry) => entry.kind === mutation.kind && requested.has(entry.id)
      ? { ...entry, sortOrder: requested.get(entry.id)! }
      : entry),
  });
}

/** Workspace mutations cannot carry catalogState/isActive and therefore cannot
 * reverse-modify the global model pool. */
export function applyWorkspaceModelCompatibilityMutation(
  current: WorkspaceModelSnapshot,
  mutation: WorkspaceModelCompatibilityMutation,
): WorkspaceModelSnapshot {
  const surface = current.surfaces[mutation.surface] || ((mutation.surface === "publish-center-image" || mutation.surface === "publish-center-video") ? { kind: WORKSPACE_SURFACE_KIND[mutation.surface], assignedModelIds: [], orderedModelIds: [] } : undefined);
  if (!surface) throw new Error(`未知工作台 ${mutation.surface}`);
  if (mutation.action === "assign") {
    const id = modelId(mutation.modelId, "mutation.modelId");
    const assigned = new Set(surface.assignedModelIds);
    if (mutation.enabled) assigned.add(id);
    else assigned.delete(id);
    const ordered = surface.orderedModelIds.filter((entry) => assigned.has(entry));
    if (mutation.enabled && !ordered.includes(id)) ordered.push(id);
    return normalizeWorkspaceModelSnapshot({
      ...current,
      surfaces: {
        ...current.surfaces,
        [mutation.surface]: { ...surface, assignedModelIds: [...assigned], orderedModelIds: ordered },
      },
    });
  }
  const ordered = uniqueIds(mutation.orderedModelIds, "mutation.orderedModelIds", true);
  const assigned = new Set(surface.assignedModelIds);
  if (ordered.length !== assigned.size || ordered.some((id) => !assigned.has(id))) {
    throw new Error("工作台排序必须精确覆盖已分配模型");
  }
  return normalizeWorkspaceModelSnapshot({
    ...current,
    surfaces: {
      ...current.surfaces,
      [mutation.surface]: { ...surface, orderedModelIds: ordered },
    },
  });
}

export function validateModelPoolSnapshot(snapshot: ModelPoolSnapshot): ConfigurationValidation {
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const kind of ["agent", "image", "video"] as const) {
    const models = snapshot.models.filter((entry) => entry.kind === kind);
    if (models.length === 0) issues.push(`模型池缺少 ${kind} 模型`);
    if (!models.some((entry) => entry.catalogState === "enabled")) issues.push(`模型池没有启用的 ${kind} 模型`);
  }
  for (const model of snapshot.models) {
    if (!model.credentialRef && model.catalogState === "enabled") warnings.push(`${model.kind}:${model.id} 尚未绑定环境凭据引用`);
    if (Object.keys(model.pricing).length === 0 && model.catalogState === "enabled") warnings.push(`${model.kind}:${model.id} 尚未声明价格合同`);
  }
  return { ok: issues.length === 0, issues, warnings };
}

export function validateWorkspaceModelSnapshot(snapshot: WorkspaceModelSnapshot, modelPool: ModelPoolSnapshot): ConfigurationValidation {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (configurationSha256(modelPool) !== snapshot.modelPoolRelease.snapshotSha256) issues.push("工作台引用的模型池哈希与实际快照不一致");
  const index = new Map(modelPool.models.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
  for (const surface of Object.keys(WORKSPACE_SURFACE_KIND) as WorkspaceSurface[]) {
    const configuration = snapshot.surfaces[surface];
    if (!configuration) continue;
    if (configuration.assignedModelIds.length === 0 && surface !== "publish-center-image" && surface !== "publish-center-video") issues.push(`${surface} 没有分配模型`);
    for (const id of configuration.assignedModelIds) {
      const model = index.get(`${configuration.kind}:${id}`);
      if (!model) issues.push(`${surface} 引用了不存在或类型不匹配的模型 ${id}`);
      else if (model.catalogState !== "enabled") issues.push(`${surface} 引用了已退役模型 ${id}`);
    }
    const ordered = new Set(configuration.orderedModelIds);
    const unordered = configuration.assignedModelIds.filter((id) => !ordered.has(id));
    if (unordered.length > 0) warnings.push(`${surface} 的 ${unordered.length} 个模型使用资源池兜底排序`);
  }
  return { ok: issues.length === 0, issues, warnings };
}

function collectionDiff(before: readonly string[], after: readonly string[]): CollectionDiff {
  const previous = new Set(before);
  const next = new Set(after);
  return {
    added: after.filter((value) => !previous.has(value)).sort(lexical),
    removed: before.filter((value) => !next.has(value)).sort(lexical),
    unchanged: after.filter((value) => previous.has(value)).sort(lexical),
  };
}

export function diffModelPoolSnapshots(before: ModelPoolSnapshot | null, after: ModelPoolSnapshot): ModelPoolConfigurationDiff {
  const previous = new Map((before?.models || []).map((entry) => [`${entry.kind}:${entry.id}`, entry]));
  const next = new Map(after.models.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
  const base = collectionDiff([...previous.keys()], [...next.keys()]);
  const changed = base.unchanged.flatMap((key) => {
    const beforeValue = previous.get(key)!;
    const afterValue = next.get(key)!;
    const beforeSha256 = configurationSha256(beforeValue);
    const afterSha256 = configurationSha256(afterValue);
    return beforeSha256 === afterSha256 ? [] : [{ key, beforeSha256, afterSha256 }];
  });
  return {
    schema: "model-pool-config-diff/v1",
    models: { ...base, changed },
    changed: base.added.length > 0 || base.removed.length > 0 || changed.length > 0,
  };
}

export function diffWorkspaceModelSnapshots(before: WorkspaceModelSnapshot | null, after: WorkspaceModelSnapshot): WorkspaceConfigurationDiff {
  const modelPoolRelease = {
    before: before?.modelPoolRelease || null,
    after: after.modelPoolRelease,
    changed: !before || stableConfigurationJson(before.modelPoolRelease) !== stableConfigurationJson(after.modelPoolRelease),
  };
  const surfaces = (Object.keys(WORKSPACE_SURFACE_KIND) as WorkspaceSurface[]).map((surface) => {
    const previous = before?.surfaces[surface];
    const next = after.surfaces[surface] || { kind: WORKSPACE_SURFACE_KIND[surface], assignedModelIds: [], orderedModelIds: [] };
    const assignments = collectionDiff(previous?.assignedModelIds || [], next.assignedModelIds);
    const beforeOrder = previous?.orderedModelIds || [];
    const afterOrder = next.orderedModelIds;
    const orderChanged = stableConfigurationJson(beforeOrder) !== stableConfigurationJson(afterOrder);
    return {
      surface,
      assignments,
      beforeOrder,
      afterOrder,
      orderChanged,
      changed: assignments.added.length > 0 || assignments.removed.length > 0 || orderChanged,
    };
  });
  return {
    schema: "workspace-model-config-diff/v1",
    modelPoolRelease,
    surfaces,
    changed: modelPoolRelease.changed || surfaces.some((entry) => entry.changed),
  };
}

export function buildPlatformConfigurationPreview(input: {
  kind: "model-pool";
  current: { identity: PlatformConfigurationReleaseIdentity; snapshot: ModelPoolSnapshot } | null;
  candidate: { identity: PlatformConfigurationReleaseIdentity; snapshot: ModelPoolSnapshot };
} | {
  kind: "workspace-models";
  current: { identity: PlatformConfigurationReleaseIdentity; snapshot: WorkspaceModelSnapshot } | null;
  candidate: { identity: PlatformConfigurationReleaseIdentity; snapshot: WorkspaceModelSnapshot };
}): PlatformConfigurationReleasePreview {
  const value: Omit<PlatformConfigurationReleasePreview, "previewSha256"> = input.kind === "model-pool"
    ? {
      schema: "platform-configuration-preview/v1",
      kind: input.kind,
      current: input.current?.identity || null,
      candidate: input.candidate.identity,
      diff: diffModelPoolSnapshots(input.current?.snapshot || null, input.candidate.snapshot),
    }
    : {
      schema: "platform-configuration-preview/v1",
      kind: input.kind,
      current: input.current?.identity || null,
      candidate: input.candidate.identity,
      diff: diffWorkspaceModelSnapshots(input.current?.snapshot || null, input.candidate.snapshot),
    };
  return { ...value, previewSha256: configurationSha256(value) };
}
