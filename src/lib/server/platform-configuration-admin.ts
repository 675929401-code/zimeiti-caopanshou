import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  buildPlatformConfigurationPreview,
  configurationSha256,
  normalizeModelPoolSnapshot,
  normalizePlatformConfigurationSnapshot,
  validateModelPoolSnapshot,
  validateWorkspaceModelSnapshot,
  type ConfigurationValidation,
  type ModelPoolEntry,
  type ModelPoolSnapshot,
  type PlatformConfigurationKind,
  type PlatformConfigurationReleaseIdentity,
  type PlatformConfigurationReleasePreview,
  type PlatformConfigurationSnapshot,
  type WorkspaceModelSnapshot,
} from "@/lib/platform-configuration-contract";

import { MODEL_MUTATION_REQUEST_UUID, normalizeCredentialMetadata, type PlatformCredentialChange, type PlatformCredentialMetadata } from "@/lib/server/platform-configuration-pending-credentials";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { LlmModelValidationError, llmModelValidationConfigurationHash } from "@/lib/llm-model-validation-gate";
import { assertFreshVisionEvidence, visionCandidateBinding, visionCapabilityTransitions, visionConfigurationHash } from "@/lib/server/llm-vision-validation";

type Row = Record<string, unknown>;
type EvaluatedValidation = ConfigurationValidation & {
  modelPoolReleaseId?: string;
  modelPoolSnapshotSha256?: string;
  rollbackTargetId?: string;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RELEASE_TABLES: Record<PlatformConfigurationKind, string> = {
  "model-pool": "model_pool_config_releases",
  "workspace-models": "workspace_model_config_releases",
};

export const PLATFORM_CONFIGURATION_COMPATIBILITY_WRITERS = {
  modelPool: [
    "src/app/api/admin/models/route.ts",
    "src/app/api/admin/chat-models/route.ts",
    "src/app/api/admin/video-models/quick-add/route.ts",
    "src/app/api/admin/video-models/route.ts",
    "src/app/api/admin/cover-models/route.ts",
    "src/app/api/admin/cover-models/[id]/route.ts",
    "src/app/api/admin/sync/import/route.ts",
  ],
  workspaceModels: [
    "src/app/api/admin/workspace-models/route.ts",
    "src/app/api/admin/models/route.ts",
    "src/app/api/admin/sync/import/route.ts",
  ],
} as const;

export const PLATFORM_CONFIGURATION_PROTECTED_GENERAL_WRITERS = [
  "src/app/api/settings/route.ts",
  "src/app/api/settings/admin/route.ts",
] as const;

export const PLATFORM_CONFIGURATION_LEGACY_WRITERS = {
  modelPool: [] as readonly string[],
  workspaceModels: [] as readonly string[],
} as const;

export const PLATFORM_CONFIGURATION_RUNTIME_METADATA_WRITERS = [
  "src/app/api/admin/models/activate/route.ts",
  "src/app/api/admin/video-models/validation/publish/route.ts",
  "src/app/api/admin/cover-models/validation/publish/route.ts",
  "src/app/api/admin/video-test/route.ts",
  "src/lib/video-terminal-accounting.ts",
] as const;

export const PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT = {
  schema: "platform-configuration-runtime-enforcement/v1",
  code: "PLATFORM_CONFIGURATION_RUNTIME_PROJECTION_UNVERIFIED",
  requiredArtifacts: [
    "model_pool_config_releases",
    "workspace_model_config_releases",
    "platform_model_credential_bindings",
    "platform_configuration_order_map",
    "read_platform_model_pending_credential_metadata",
    "read_platform_model_mutation_receipt",
  ] as const,
} as const;

export type PlatformConfigurationRuntimeStatus = {
  schema: typeof PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.schema;
  ready: boolean;
  code: typeof PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.code;
  blockers: string[];
  checkedAt: string;
};

export class PlatformConfigurationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PlatformConfigurationError";
  }
}

export class PlatformConfigurationImageAdditionError extends PlatformConfigurationError {
  readonly retryable = false;
  readonly receiptPath: string;
  constructor(code: string, readonly candidateId: string, readonly status = 409,
    readonly outcome?: "outcome_unknown") {
    super(code, code === "IMAGE_ADDITION_ALREADY_PUBLISHED" ? "原图片模型候选已发布，请读取原候选和当前版本，不要重复提交"
      : outcome ? "原图片模型发布结果待核对，请查询原候选，不要重新发布" : "单图片模型新增事务未通过校验，本次未发布");
    this.name = "PlatformConfigurationImageAdditionError";
    this.receiptPath = `/api/admin/model-pool-releases?releaseId=${encodeURIComponent(candidateId)}`;
  }
}

export class PlatformConfigurationMutationOutcomeUnknown extends PlatformConfigurationError {
  readonly outcome = "outcome_unknown";
  readonly receiptPath: string;
  constructor(readonly requestId: string, readonly candidateId: string | null, readonly phase: "stage" | "readback" | "preview") {
    super("PLATFORM_CONFIGURATION_MUTATION_OUTCOME_UNKNOWN", "模型变更结果需要核验，请用同一请求标识读取回执后重试");
    this.name = "PlatformConfigurationMutationOutcomeUnknown";
    this.receiptPath = `/api/admin/model-pool-releases?requestId=${encodeURIComponent(requestId)}`;
  }
}

export async function readPlatformModelMutationReceipt(actorId: string, requestId: string, requestPayload?: Row) {
  requireUuid(actorId, "管理员 ID");
  if (!MODEL_MUTATION_REQUEST_UUID.test(requestId)) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED", "模型变更请求标识无效");
  let result;
  try { result = await getSupabaseAdminClient().rpc("read_platform_model_mutation_receipt", { p_actor_id: actorId, p_request_id: requestId, p_request_payload: requestPayload || null }); }
  catch { throw new PlatformConfigurationMutationOutcomeUnknown(requestId, null, "stage"); }
  if (result.error) {
    if (String(result.error.message || "").includes("PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT")) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT", "该请求标识已用于不同的模型变更");
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_MUTATION_RECEIPT_UNAVAILABLE", "无法读取模型变更回执，请保持原请求标识后重试");
  }
  if (!result.data) return null;
  const row = record(result.data);
  return { candidateId: requireUuid(row.candidateId, "配置候选 ID"), state: row.state === "applied" ? "applied" : "staged", hasStagedCredentials: row.hasStagedCredentials === true };
}

export async function resumePlatformModelMutation(actorId: string, requestId: string, requestPayload: Row) {
  const receipt = await readPlatformModelMutationReceipt(actorId, requestId, requestPayload);
  if (!receipt) return null;
  try { const row = await release("model-pool", receipt.candidateId); snapshotFromRow("model-pool", row); return row; }
  catch { throw new PlatformConfigurationMutationOutcomeUnknown(requestId, receipt.candidateId, "readback"); }
}

/**
 * Read the actual database before every publication. This is deliberately not
 * a build-time boolean: a build may be moved between databases, while schema
 * migrations and credential isolation are environment-owned state.
 */
export async function readPlatformConfigurationRuntimeStatus(): Promise<PlatformConfigurationRuntimeStatus> {
  const db = getSupabaseAdminClient();
  const probes = [
    { artifact: "model_pool_config_releases", run: () => db.from("model_pool_config_releases").select("id", { head: true, count: "exact" }) },
    { artifact: "workspace_model_config_releases", run: () => db.from("workspace_model_config_releases").select("id", { head: true, count: "exact" }) },
    { artifact: "platform_model_credential_bindings", run: () => db.from("platform_model_credential_bindings").select("credential_ref,revision", { head: true, count: "exact" }) },
    { artifact: "platform_configuration_order_map", run: () => db.rpc("platform_configuration_order_map", { p_ids: [] }) },
    { artifact: "read_platform_model_pending_credential_metadata", run: () => db.rpc("read_platform_model_pending_credential_metadata", { p_release_id: "00000000-0000-0000-0000-000000000000" }) },
    { artifact: "read_platform_model_mutation_receipt", run: () => db.rpc("read_platform_model_mutation_receipt", { p_actor_id: "00000000-0000-0000-0000-000000000000", p_request_id: "00000000-0000-0000-0000-000000000000", p_request_payload: null }) },
  ];
  const checks = await Promise.all(probes.map(async ({ artifact, run }) => [artifact, await run()] as const));
  const blockers = checks.flatMap(([artifact, result]) => result.error ? [`${artifact}: ${result.error.message}`] : []);
  return {
    schema: PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.schema,
    ready: blockers.length === 0,
    code: PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.code,
    blockers,
    checkedAt: new Date().toISOString(),
  };
}

export async function assertPlatformConfigurationPublishReady(): Promise<PlatformConfigurationRuntimeStatus> {
  const status = await readPlatformConfigurationRuntimeStatus();
  if (!status.ready) {
    throw new PlatformConfigurationError(
      PLATFORM_CONFIGURATION_RUNTIME_ENFORCEMENT.code,
      `版本化投影迁移尚未在当前数据库完整实装并精确读回，平台配置发布已安全阻断：${status.blockers.join("；")}`,
    );
  }
  return status;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function requireUuid(value: unknown, label: string): string {
  const result = String(value || "").trim();
  if (!UUID.test(result)) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_ID_INVALID", `${label}无效`);
  return result;
}

function changeNote(value: unknown, fallback: string): string {
  const result = String(value || fallback).trim();
  if (!result || result.length > 1000) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CHANGE_NOTE_INVALID", "变更说明不能为空且不能超过 1000 字符");
  return result;
}

function table(kind: PlatformConfigurationKind) {
  return RELEASE_TABLES[kind];
}

function identity(row: Row): PlatformConfigurationReleaseIdentity {
  return {
    releaseId: String(row.id || ""),
    releaseVersion: Number(row.release_version),
    snapshotSha256: String(row.snapshot_sha256 || ""),
    status: String(row.status || ""),
  };
}

function snapshotFromRow(kind: "model-pool", row: Row): ModelPoolSnapshot;
function snapshotFromRow(kind: "workspace-models", row: Row): WorkspaceModelSnapshot;
function snapshotFromRow(kind: PlatformConfigurationKind, row: Row): PlatformConfigurationSnapshot;
function snapshotFromRow(kind: PlatformConfigurationKind, row: Row): PlatformConfigurationSnapshot {
  const snapshot = normalizePlatformConfigurationSnapshot(kind, row.snapshot);
  const actual = configurationSha256(snapshot);
  if (actual !== String(row.snapshot_sha256 || "")) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_HASH_MISMATCH", "配置快照哈希与数据库身份不一致");
  }
  return snapshot;
}

async function release(kind: PlatformConfigurationKind, releaseId: string): Promise<Row> {
  const result = await getSupabaseAdminClient().from(table(kind)).select("*").eq("id", releaseId).maybeSingle();
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_READ_FAILED", `读取配置版本失败：${result.error.message}`);
  if (!result.data) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND", "配置版本不存在");
  return result.data as Row;
}

/** Read the original release after a lost publication acknowledgement; never dispatches a model. */
export async function readPlatformConfigurationRelease(kind: PlatformConfigurationKind, releaseIdValue: string): Promise<Row> {
  const row = await release(kind, requireUuid(releaseIdValue, "配置版本 ID"));
  snapshotFromRow(kind, row);
  return row;
}

async function currentRelease(kind: PlatformConfigurationKind): Promise<Row | null> {
  const result = await getSupabaseAdminClient().from(table(kind)).select("*")
    .eq("is_current", true).eq("status", "published").limit(1).maybeSingle();
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_READ_FAILED", `读取当前发布失败：${result.error.message}`);
  return result.data as Row | null;
}

async function referencedModelPool(snapshot: WorkspaceModelSnapshot): Promise<{ row: Row; snapshot: ModelPoolSnapshot }> {
  const row = await release("model-pool", snapshot.modelPoolRelease.releaseId);
  if (!["validated", "published", "superseded"].includes(String(row.status))) {
    throw new PlatformConfigurationError("WORKSPACE_MODEL_POOL_RELEASE_NOT_VALIDATED", "工作台只能引用已校验或历史发布的模型池版本");
  }
  if (String(row.snapshot_sha256) !== snapshot.modelPoolRelease.snapshotSha256) {
    throw new PlatformConfigurationError("WORKSPACE_MODEL_POOL_RELEASE_CHANGED", "工作台引用的模型池版本身份不一致");
  }
  return { row, snapshot: snapshotFromRow("model-pool", row) };
}

async function validateSnapshot(kind: "model-pool", snapshot: ModelPoolSnapshot): Promise<EvaluatedValidation>;
async function validateSnapshot(kind: "workspace-models", snapshot: WorkspaceModelSnapshot): Promise<EvaluatedValidation>;
async function validateSnapshot(kind: PlatformConfigurationKind, snapshot: PlatformConfigurationSnapshot): Promise<EvaluatedValidation> {
  if (kind === "model-pool") return validateModelPoolSnapshot(snapshot as ModelPoolSnapshot);
  const dependency = await referencedModelPool(snapshot as WorkspaceModelSnapshot);
  return {
    ...validateWorkspaceModelSnapshot(snapshot as WorkspaceModelSnapshot, dependency.snapshot),
    modelPoolReleaseId: String(dependency.row.id),
    modelPoolSnapshotSha256: String(dependency.row.snapshot_sha256),
  };
}

function validationRecord(validation: EvaluatedValidation, actorId: string): Row {
  return {
    ...validation,
    schema: "platform-configuration-validation/v1",
    mode: "deterministic-contract",
    checkedAt: new Date().toISOString(),
    checkedBy: actorId,
  };
}

async function createCandidateRow(input: {
  kind: PlatformConfigurationKind;
  actorId: string;
  snapshot: PlatformConfigurationSnapshot;
  validation: EvaluatedValidation;
  note: string;
  parentReleaseId: string | null;
  rollbackTargetId: string | null;
}) {
  const snapshotSha256 = configurationSha256(input.snapshot);
  const validation = validationRecord(input.validation, input.actorId);
  const status = input.validation.ok ? "validated" : "draft";
  const created = await getSupabaseAdminClient().rpc("create_platform_configuration_candidate_atomic", {
    p_kind: input.kind,
    p_actor_id: input.actorId,
    p_snapshot: input.snapshot,
    p_snapshot_sha256: snapshotSha256,
    p_validation_result: validation,
    p_status: status,
    p_change_note: input.note,
    p_parent_release_id: input.parentReleaseId,
    p_rollback_target_id: input.rollbackTargetId,
  });
  if (created.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CANDIDATE_CREATE_FAILED", `创建配置候选失败：${created.error.message}`);
  const createdRow = record(created.data);
  const createdId = requireUuid(createdRow.id, "新配置版本 ID");
  const readback = await release(input.kind, createdId);
  if (String(readback.snapshot_sha256) !== snapshotSha256 || String(readback.status) !== status || readback.is_current === true) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CANDIDATE_READBACK_MISMATCH", "配置候选创建后读回身份不一致");
  }
  snapshotFromRow(input.kind, readback);
  return readback;
}

export async function platformConfigurationOverview(kind: PlatformConfigurationKind) {
  const [result, runtimeEnforcement] = await Promise.all([
    getSupabaseAdminClient().from(table(kind)).select("*")
      .order("release_version", { ascending: false }).limit(200),
    readPlatformConfigurationRuntimeStatus(),
  ]);
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_READ_FAILED", `读取配置版本失败：${result.error.message}`);
  const releases = (result.data || []) as Row[];
  for (const row of releases) snapshotFromRow(kind, row);
  return {
    kind,
    releases,
    current: releases.find((row) => row.is_current === true && row.status === "published") || null,
    runtimeEnforcement,
  };
}

export async function createPlatformConfigurationCandidate(
  actorIdValue: string,
  kind: PlatformConfigurationKind,
  rawSnapshot: unknown,
  rawChangeNote?: unknown,
) {
  const actorId = requireUuid(actorIdValue, "管理员 ID");
  const snapshot = normalizePlatformConfigurationSnapshot(kind, rawSnapshot);
  const validation = kind === "model-pool"
    ? await validateSnapshot("model-pool", snapshot as ModelPoolSnapshot)
    : await validateSnapshot("workspace-models", snapshot as WorkspaceModelSnapshot);
  const current = await currentRelease(kind);
  return createCandidateRow({
    kind,
    actorId,
    snapshot,
    validation,
    note: changeNote(rawChangeNote, "创建平台配置候选"),
    parentReleaseId: current ? String(current.id) : null,
    rollbackTargetId: null,
  });
}

/** Candidate plus pending credentials are written by one database transaction only. */
export async function stagePlatformModelCandidateWithCredentials(input: {
  actorId: string; requestId: string; requestPayload: Row; snapshot: ModelPoolSnapshot;
  credentialChanges: PlatformCredentialChange[]; changeNote: string;
  expectedBase?: { releaseId: string; snapshotSha256: string };
  operation?: "video-upsert-only";
}) {
  const actorId = requireUuid(input.actorId, "管理员 ID");
  if (!MODEL_MUTATION_REQUEST_UUID.test(String(input.requestId || ""))) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED", "请提供有效的模型变更请求标识后重试");
  if (input.operation !== undefined && (input.operation !== "video-upsert-only" || !input.expectedBase)) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_OPERATION_INVALID", "模型候选操作范围或基础版本无效");
  }
  const snapshot = normalizeModelPoolSnapshot(input.snapshot);
  const validation = await validateSnapshot("model-pool", snapshot);
  const current = await currentRelease("model-pool");
  if (input.expectedBase && (!current || String(current.id) !== input.expectedBase.releaseId || String(current.snapshot_sha256) !== input.expectedBase.snapshotSha256)) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CURRENT_CHANGED", "模型池基础版本已变化，请重新创建候选");
  }
  let staged;
  try { staged = await getSupabaseAdminClient().rpc("stage_model_pool_candidate_with_credentials_atomic", {
    p_actor_id: actorId, p_request_id: input.requestId, p_request_payload: input.requestPayload,
    p_snapshot: snapshot, p_snapshot_sha256: configurationSha256(snapshot),
    // expectedBase is an application-level check and parent identity. Only the
    // explicit video marker selects the SQL transaction's video-specific CAS.
    p_validation_result: { ...validationRecord(validation, actorId), ...(input.expectedBase ? { baseSnapshotSha256: input.expectedBase.snapshotSha256 } : {}), ...(input.operation === "video-upsert-only" ? { operation: input.operation } : {}) }, p_status: validation.ok ? "validated" : "draft",
    p_change_note: changeNote(input.changeNote, "创建模型池候选"), p_parent_release_id: input.expectedBase?.releaseId || (current ? String(current.id) : null),
    p_credential_changes: input.credentialChanges,
  }); } catch { throw new PlatformConfigurationMutationOutcomeUnknown(input.requestId, null, "stage"); }
  if (staged.error) {
    const sqlState = String(staged.error.code || "");
    const knownRollback = /^(22|23)/u.test(sqlState) || ["40001", "40P01", "P0001"].includes(sqlState);
    if (!knownRollback) throw new PlatformConfigurationMutationOutcomeUnknown(input.requestId, null, "stage");
    const message = String(staged.error.message || "");
    const code = message.includes("PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT") ? "PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT"
      : message.includes("PLATFORM_CONFIGURATION_CURRENT_CHANGED") ? "PLATFORM_CONFIGURATION_CURRENT_CHANGED" : "PLATFORM_CONFIGURATION_CREDENTIAL_STAGE_FAILED";
    // Never echo a database detail which might contain an invalid secret-bearing row.
    throw new PlatformConfigurationError(code, code === "PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT" ? "该请求标识已用于不同的模型变更，请重新发起" : code === "PLATFORM_CONFIGURATION_CURRENT_CHANGED" ? "模型池基础版本已变化，请重新创建候选" : "模型候选与凭据暂存未完成，本次未修改运行凭据");
  }
  const row = record(staged.data);
  const id = MODEL_MUTATION_REQUEST_UUID.test(String(row.id || "")) ? String(row.id) : null;
  if (!id) throw new PlatformConfigurationMutationOutcomeUnknown(input.requestId, null, "readback");
  try { const readback = await release("model-pool", id); snapshotFromRow("model-pool", readback); return readback; }
  catch { throw new PlatformConfigurationMutationOutcomeUnknown(input.requestId, id, "readback"); }
}

async function credentialMetadata(releaseId: string) {
  const result = await getSupabaseAdminClient().rpc("read_platform_model_pending_credential_metadata", { p_release_id: releaseId });
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CREDENTIAL_METADATA_UNAVAILABLE", "无法核验候选凭据暂存状态，请先确认配置迁移已就绪");
  try { return normalizeCredentialMetadata(result.data); }
  catch { throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CREDENTIAL_METADATA_INVALID", "候选凭据暂存状态无效"); }
}

export async function validatePlatformConfigurationCandidate(actorIdValue: string, kind: PlatformConfigurationKind, releaseIdValue: string) {
  const actorId = requireUuid(actorIdValue, "管理员 ID");
  const releaseId = requireUuid(releaseIdValue, "配置版本 ID");
  const existing = await release(kind, releaseId);
  if (existing.is_current === true || !["draft", "validated"].includes(String(existing.status))) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_RELEASE_NOT_CANDIDATE", "只能校验未发布候选");
  }
  const snapshot = snapshotFromRow(kind, existing);
  const validation = kind === "model-pool"
    ? await validateSnapshot("model-pool", snapshot as ModelPoolSnapshot)
    : await validateSnapshot("workspace-models", snapshot as WorkspaceModelSnapshot);
  const status = validation.ok ? "validated" : "draft";
  const updated = await getSupabaseAdminClient().from(table(kind)).update({
    status,
    validation_result: { ...validationRecord(validation, actorId), ...(kind === "model-pool" && record(existing.validation_result).operation === "video-upsert-only" ? { operation: "video-upsert-only" } : {}) },
    validated_at: validation.ok ? new Date().toISOString() : null,
  }).eq("id", releaseId).eq("snapshot_sha256", String(existing.snapshot_sha256))
    .eq("is_current", false).in("status", ["draft", "validated"]).select("*").maybeSingle();
  if (updated.error || !updated.data) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_CANDIDATE_CHANGED", "配置候选在校验期间已变化，请重新读取");
  }
  return updated.data as Row;
}

export async function previewPlatformConfigurationRelease(kind: PlatformConfigurationKind, releaseIdValue: string): Promise<PlatformConfigurationReleasePreview & { credentialChanges?: PlatformCredentialMetadata[] }> {
  const releaseId = requireUuid(releaseIdValue, "配置版本 ID");
  const [candidate, current] = await Promise.all([release(kind, releaseId), currentRelease(kind)]);
  if (candidate.is_current === true || !["draft", "validated"].includes(String(candidate.status))) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_RELEASE_NOT_CANDIDATE", "只能预览未发布候选");
  }
  if (kind === "model-pool") {
    const base = buildPlatformConfigurationPreview({
      kind,
      current: current ? { identity: identity(current), snapshot: snapshotFromRow("model-pool", current) } : null,
      candidate: { identity: identity(candidate), snapshot: snapshotFromRow("model-pool", candidate) },
    });
    const credentialChanges = await credentialMetadata(releaseId);
    return credentialChanges.length ? { ...base, credentialChanges, previewSha256: configurationSha256({ basePreviewSha256: base.previewSha256, credentialChanges }) } : base;
  }
  return buildPlatformConfigurationPreview({
    kind,
    current: current ? { identity: identity(current), snapshot: snapshotFromRow("workspace-models", current) } : null,
    candidate: { identity: identity(candidate), snapshot: snapshotFromRow("workspace-models", candidate) },
  });
}

async function assertWorkspaceDependencyIsCurrent(snapshot: WorkspaceModelSnapshot) {
  const current = await currentRelease("model-pool");
  if (!current
      || String(current.id) !== snapshot.modelPoolRelease.releaseId
      || String(current.snapshot_sha256) !== snapshot.modelPoolRelease.snapshotSha256) {
    throw new PlatformConfigurationError("WORKSPACE_MODEL_POOL_NOT_CURRENT", "工作台候选引用的模型池不是当前发布版本");
  }
}

/** Gate direct model-pool publication as well as the legacy editor path. */
async function assertNewVisionCapabilityEvidence(releaseId: string) {
  const [candidate, current, pendingCredentials] = await Promise.all([release("model-pool", releaseId), currentRelease("model-pool"), credentialMetadata(releaseId)]);
  const candidateSnapshot = snapshotFromRow("model-pool", candidate);
  if (candidateSnapshot.models.some(entry => entry.kind === "agent" && entry.catalogState === "enabled" && String(entry.capabilities.imageParsing || "none") !== "none"
    && pendingCredentials.some(change => change.modelKey === `${entry.configuration.legacyTable}:${entry.configuration.legacyId}`))) throw new PlatformConfigurationError("VISION_CAPABILITY_BINDING_CHANGED", "图片能力证据不能同时授权密钥变更，请先单独核验通路");
  const transitions = visionCapabilityTransitions(current ? snapshotFromRow("model-pool", current) : null, candidateSnapshot);
  for (const { before, after } of transitions) {
    if (pendingCredentials.some(change => change.modelKey === `${after.configuration.legacyTable}:${after.configuration.legacyId}`)) throw new PlatformConfigurationError("VISION_CAPABILITY_BINDING_CHANGED", "图片能力单独验证不能同时授权密钥变更，请先独立发布并验证通路");
    const id = String(after.configuration.legacyId ?? "");
    const db = getSupabaseAdminClient();
    const lookup = await db.from("llm_models").select("*").eq("id", id).maybeSingle();
    if (lookup.error || !lookup.data) throw new PlatformConfigurationError("VISION_MODEL_NOT_FOUND", "视觉能力候选必须保留已有原模型ID");
    const secret = resolveProviderSecret(lookup.data.api_key);
    const binding = visionCandidateBinding(before, after, lookup.data);
    if (llmModelValidationConfigurationHash(binding, secret) !== llmModelValidationConfigurationHash(lookup.data, secret)) {
      throw new PlatformConfigurationError("VISION_CAPABILITY_BINDING_CHANGED", "原模型当前通路与候选执行配置不同，请重新核对后验证");
    }
    const expectedHash = visionConfigurationHash(binding, secret);
    const evidence = await db.from("llm_model_validation_evidence").select("model_id,configuration_hash,checked_at")
      .eq("model_id", id).eq("configuration_hash", expectedHash).maybeSingle();
    if (evidence.error) throw new PlatformConfigurationError("VISION_VALIDATION_EVIDENCE_UNAVAILABLE", "无法读取当前候选的视觉验证证据，本次未发布");
    assertFreshVisionEvidence(binding, secret, evidence.data);
  }
}

export async function publishPlatformConfigurationRelease(
  actorIdValue: string,
  kind: PlatformConfigurationKind,
  releaseIdValue: string,
  expectedPreviewSha256: string,
  options: { imageAdditionDryRun?: boolean } = {},
) {
  const actorId = requireUuid(actorIdValue, "管理员 ID");
  const releaseId = requireUuid(releaseIdValue, "配置版本 ID");
  const existing = await release(kind, releaseId);
  if (existing.is_current === true && existing.status === "published") {
    if (options.imageAdditionDryRun) throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_CANDIDATE_INVALID", releaseId);
    return existing;
  }
  if (existing.status === "superseded") throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT", "该候选已发布且已被更新版本替代，请读取当前版本");
  const preview = await previewPlatformConfigurationRelease(kind, releaseId);
  if (!expectedPreviewSha256 || preview.previewSha256 !== expectedPreviewSha256) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_PREVIEW_STALE", "发布差异预览已缺失或过期，请重新预览");
  }

  // No database mutation occurs while a legacy path can bypass versioning.
  await assertPlatformConfigurationPublishReady();

  if (options.imageAdditionDryRun) {
    if (kind !== "model-pool" || existing.status !== "validated") {
      throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_CANDIDATE_INVALID", releaseId);
    }
    const validation = await validateSnapshot("model-pool", snapshotFromRow("model-pool", existing));
    if (!validation.ok) throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_CANDIDATE_INVALID", releaseId);
  } else await validatePlatformConfigurationCandidate(actorId, kind, releaseId);
  const freshPreview = await previewPlatformConfigurationRelease(kind, releaseId);
  if (freshPreview.previewSha256 !== expectedPreviewSha256) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_PREVIEW_STALE", "发布校验后配置身份已变化，请重新预览");
  }
  if (kind === "workspace-models") {
    const row = await release(kind, releaseId);
    await assertWorkspaceDependencyIsCurrent(snapshotFromRow("workspace-models", row));
  }
  if (kind === "model-pool") {
    try { await assertNewVisionCapabilityEvidence(releaseId); }
    catch (error) {
      if (error instanceof LlmModelValidationError) throw new PlatformConfigurationError(error.code, error.message);
      throw error;
    }
  }
  // The reviewed logical diff selects the narrow transaction on the server.
  // The helper rechecks both complete snapshots while holding the publish lock.
  const diff = freshPreview.diff;
  const singleImageAddition = kind === "model-pool" && freshPreview.current !== null && existing.rollback_target_id == null
    && diff?.schema === "model-pool-config-diff/v1"
    && diff.models.added.length === 1 && diff.models.added[0].startsWith("image:")
    && diff.models.removed.length === 0 && diff.models.changed.length === 0
    && !freshPreview.credentialChanges?.some(change => change.modelKey !== `cover_models:${diff.models.added[0].slice("image:".length)}`);
  if (singleImageAddition || options.imageAdditionDryRun) {
    if (!singleImageAddition || !freshPreview.current) {
      throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_CANDIDATE_INVALID", releaseId);
    }
    const [candidate, current] = await Promise.all([release("model-pool", releaseId), currentRelease("model-pool")]);
    if (!current || String(current.id) !== freshPreview.current.releaseId
      || String(current.snapshot_sha256) !== freshPreview.current.snapshotSha256
      || String(candidate.snapshot_sha256) !== freshPreview.candidate.snapshotSha256) {
      throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_BASE_CHANGED", releaseId);
    }
    snapshotFromRow("model-pool", current); snapshotFromRow("model-pool", candidate);
    const imageAddition = await import("@/lib/server/image-model-addition-publication");
    const addition = imageAddition.inspectImageModelAddition(current.snapshot, candidate.snapshot);
    if (!addition) throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_CANDIDATE_INVALID", releaseId);
    let result;
    try {
      result = await imageAddition.publishImageModelAdditionRelease({ actorId,
        currentReleaseId: freshPreview.current.releaseId, currentSnapshotSha256: freshPreview.current.snapshotSha256,
        candidateReleaseId: releaseId, candidateSnapshotSha256: freshPreview.candidate.snapshotSha256,
        targetModelId: addition.targetId, dryRun: options.imageAdditionDryRun === true });
    } catch (error) {
      if (error instanceof imageAddition.ImageModelAdditionPublicationError) {
        const unknown = error.code === "IMAGE_ADDITION_OUTCOME_UNKNOWN" || error.outcome === "outcome_unknown";
        throw new PlatformConfigurationImageAdditionError(error.code, releaseId, unknown ? 503 : error.status,
          unknown ? "outcome_unknown" : undefined);
      }
      // An unclassified failure from a dispatched transaction is never a retry signal.
      throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_OUTCOME_UNKNOWN", releaseId, 503, "outcome_unknown");
    }
    if (options.imageAdditionDryRun) {
      if (result.dryRun !== true || result.outcome !== "rolled_back") {
        throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_OUTCOME_UNKNOWN", releaseId, 503, "outcome_unknown");
      }
      return { dryRun: true, outcome: "rolled_back", releaseId, evidence: result.evidence };
    }
    try {
      const readback = await currentRelease("model-pool");
      if (!readback || String(readback.id) !== releaseId || readback.status !== "published"
        || readback.is_current !== true || String(readback.snapshot_sha256) !== freshPreview.candidate.snapshotSha256) {
        throw new Error("IMAGE_ADDITION_READBACK_MISMATCH");
      }
      snapshotFromRow("model-pool", readback);
      return readback;
    } catch {
      throw new PlatformConfigurationImageAdditionError("IMAGE_ADDITION_OUTCOME_UNKNOWN", releaseId, 503, "outcome_unknown");
    }
  }
  const published = await getSupabaseAdminClient().rpc("publish_platform_configuration_release_atomic", {
    p_kind: kind,
    p_release_id: releaseId,
    p_actor_id: actorId,
    p_expected_candidate_sha256: freshPreview.candidate.snapshotSha256,
    p_expected_current_id: freshPreview.current?.releaseId || null,
    p_expected_current_sha256: freshPreview.current?.snapshotSha256 || null,
  });
  if (published.error) {
    const message = String(published.error.message || "");
    const code = message.trim() === "PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED" ? "PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED"
      : message.includes("PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED") ? "PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED"
      : message.includes("PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT") ? "PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT"
      : message.includes("PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT") ? "PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT" : "PLATFORM_CONFIGURATION_PUBLISH_FAILED";
    throw new PlatformConfigurationError(code, code === "PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED" ? "此候选同时包含密钥变更和模型下架，请先单独发布密钥变更，再创建下架候选。" : code === "PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED" ? "模型池已更新，本候选暂存凭据尚未应用；请基于当前版本重新创建候选" : code === "PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT" ? "候选创建后运行凭据已变化，请重新创建候选并预览；本次未发布" : "配置原子发布未完成，请读取当前版本后重试");
  }
  const readback = await currentRelease(kind);
  if (!readback
      || String(readback.id) !== releaseId
      || readback.status !== "published"
      || readback.is_current !== true
      || String(readback.snapshot_sha256) !== freshPreview.candidate.snapshotSha256) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_PUBLISH_READBACK_MISMATCH", "原子发布后的数据库读回身份不一致");
  }
  snapshotFromRow(kind, readback);
  return readback;
}

/** Same authenticated publication preparation, with all image transaction DML rolled back. */
export async function previewImageModelAdditionTransaction(actorId: string, releaseId: string, expectedPreviewSha256: string) {
  return publishPlatformConfigurationRelease(actorId, "model-pool", releaseId, expectedPreviewSha256, { imageAdditionDryRun: true });
}

export async function createPlatformConfigurationRollbackCandidate(
  actorIdValue: string,
  kind: PlatformConfigurationKind,
  targetIdValue: string,
  rawChangeNote?: unknown,
) {
  const actorId = requireUuid(actorIdValue, "管理员 ID");
  const targetId = requireUuid(targetIdValue, "回滚目标 ID");
  const [target, current] = await Promise.all([release(kind, targetId), currentRelease(kind)]);
  if (target.is_current === true || !["published", "superseded"].includes(String(target.status))) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_ROLLBACK_TARGET_INVALID", "回滚目标必须是非当前的历史发布版本");
  }
  const snapshot = snapshotFromRow(kind, target);
  const validation = kind === "model-pool"
    ? await validateSnapshot("model-pool", snapshot as ModelPoolSnapshot)
    : await validateSnapshot("workspace-models", snapshot as WorkspaceModelSnapshot);
  if (!validation.ok) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_ROLLBACK_VALIDATION_FAILED", `回滚目标已不满足当前门禁：${validation.issues.join("；")}`);
  }
  return createCandidateRow({
    kind,
    actorId,
    snapshot,
    validation: { ...validation, rollbackTargetId: targetId },
    note: changeNote(rawChangeNote, `从历史版本 ${target.release_version} 创建回滚候选`),
    parentReleaseId: current ? String(current.id) : null,
    rollbackTargetId: targetId,
  });
}

export async function readCurrentPlatformConfiguration(kind: "model-pool"): Promise<{ release: Row; snapshot: ModelPoolSnapshot } | null>;
export async function readCurrentPlatformConfiguration(kind: "workspace-models"): Promise<{ release: Row; snapshot: WorkspaceModelSnapshot } | null>;
export async function readCurrentPlatformConfiguration(kind: PlatformConfigurationKind): Promise<{ release: Row; snapshot: PlatformConfigurationSnapshot } | null>;
export async function readCurrentPlatformConfiguration(kind: PlatformConfigurationKind): Promise<{ release: Row; snapshot: PlatformConfigurationSnapshot } | null> {
  const current = await currentRelease(kind);
  if (!current) return null;
  return {
    release: current,
    snapshot: snapshotFromRow(kind, current),
  };
}

/** Dedicated capability-only path: never delegates to the ordinary publisher. */
const VISION_PUBLICATION_ONLY_MODEL_ID = "b6a9d79d-9a0f-4ca5-86fa-4601d80e590d";
function visionPublicationPrivateJson(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)])) : item;
  return JSON.stringify(stable(value));
}
function visionOnlyTarget(current: Row, candidate: Row, modelId: string) {
  if (modelId !== VISION_PUBLICATION_ONLY_MODEL_ID) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_SCOPE_INVALID", "本次单独发布仅限已审核的原GPT6Sol模型ID");
  }
  // Check persisted JSON as well as its normalized/hash-checked contract. JSONB
  // object key order is immaterial; every array order and every other value is
  // preserved. Normalization must never hide a reorder or a second legacy alias.
  snapshotFromRow("model-pool", current);
  snapshotFromRow("model-pool", candidate);
  const previous = record(current.snapshot);
  const next = record(candidate.snapshot);
  if (!Array.isArray(previous.models) || !Array.isArray(next.models)) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_SCOPE_INVALID", "图片能力候选快照无效");
  }
  const models = previous.models as ModelPoolEntry[];
  const positions = models.flatMap((entry, index) => entry.id === `llm:${modelId}` ? [index] : []);
  if (positions.length !== 1 || models.filter(entry => entry.configuration.legacyTable === "llm_models" && entry.configuration.legacyId === modelId).length !== 1) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_SCOPE_INVALID", "图片能力候选必须唯一绑定原模型ID");
  }
  const index = positions[0];
  const before = models[index];
  const after = next.models[index] as ModelPoolEntry | undefined;
  if (before.kind !== "agent" || before.catalogState !== "enabled"
    || before.configuration.legacyTable !== "llm_models" || before.configuration.legacyId !== modelId
    || String(before.capabilities.imageParsing || "none") !== "none"
    || !before.credentialRef || after?.capabilities.imageParsing !== "gpt_vision") {
    throw new PlatformConfigurationError("VISION_PUBLICATION_SCOPE_INVALID", "仅支持原模型图片解析能力从none改为gpt_vision");
  }
  const expected = structuredClone(previous);
  const expectedModels = expected.models as ModelPoolEntry[];
  expectedModels[index].capabilities.imageParsing = "gpt_vision";
  if (configurationSha256(expected) !== configurationSha256(next)) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_SCOPE_INVALID", "图片能力单独发布不能改变其他配置、模型或顺序");
  }
  return { before, after };
}

export async function publishLlmVisionCapabilityOnlyRelease(
  actorIdValue: string, releaseIdValue: string, expectedPreviewSha256: string, targetModelIdValue: string,
) {
  const actorId = requireUuid(actorIdValue, "管理员 ID");
  const releaseId = requireUuid(releaseIdValue, "配置版本 ID");
  const modelId = requireUuid(targetModelIdValue, "原模型 ID");
  if (modelId !== VISION_PUBLICATION_ONLY_MODEL_ID || !/^[a-f0-9]{64}$/u.test(expectedPreviewSha256)) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_INPUT_INVALID", "仅接受本次原模型ID和已审阅预览身份");
  }
  const [candidate, current] = await Promise.all([release("model-pool", releaseId), currentRelease("model-pool")]);
  if (!current) throw new PlatformConfigurationError("VISION_PUBLICATION_CURRENT_CHANGED", "当前模型池发布身份缺失");
  if (candidate.is_current === true && candidate.status === "published") {
    // Already published recovery does not depend on fresh evidence or a new
    // provider call, but still checks this operation's original target/scope.
    if (current.id !== candidate.id) throw new PlatformConfigurationError("VISION_PUBLICATION_CURRENT_CHANGED", "发布回执已不是当前版本");
    const parentId = requireUuid(candidate.parent_release_id, "原发布基础版本 ID");
    visionOnlyTarget(await release("model-pool", parentId), candidate, modelId);
    return candidate;
  }
  if (candidate.status !== "validated" || candidate.is_current === true
    || candidate.parent_release_id !== current.id || candidate.rollback_target_id != null) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_CANDIDATE_BASE_CHANGED", "仅能力候选须已校验且以当前模型池为基础");
  }
  const { before, after } = visionOnlyTarget(current, candidate, modelId);
  const validation = await validateSnapshot("model-pool", snapshotFromRow("model-pool", candidate));
  if (!validation.ok) throw new PlatformConfigurationError("VISION_PUBLICATION_SCOPE_INVALID", "图片能力候选未通过模型池合同校验");
  const preview = await previewPlatformConfigurationRelease("model-pool", releaseId);
  if (!expectedPreviewSha256 || preview.previewSha256 !== expectedPreviewSha256) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_PREVIEW_STALE", "发布差异预览已缺失或过期，请重新预览");
  }
  if ((await credentialMetadata(releaseId)).length) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_PENDING_CREDENTIALS_REJECTED", "图片能力单独发布不能携带任何暂存凭据");
  }
  await assertPlatformConfigurationPublishReady();
  const db = getSupabaseAdminClient();
  // SERVER-PRIVATE: guard contains the existing physical credential. Never
  // return it, log it, persist it as review evidence, or accept it from HTTP.
  const guarded = await db.rpc("read_llm_vision_publication_guard", {
    p_model_id: modelId, p_credential_ref: before.credentialRef,
  });
  if (guarded.error) throw new PlatformConfigurationError("VISION_PUBLICATION_RPC_UNAVAILABLE", "图片能力单独发布迁移尚未就绪，本次未发布");
  const guard = record(guarded.data);
  const physical = record(guard.physical);
  if (physical.id !== modelId || guard.credentialLiteral !== true || guard.bindingExists !== true
    || guard.bindingMatches !== true || guard.credentialRef !== before.credentialRef
    || !UUID.test(String(guard.bindingRevision || "")) || !/^[0-9]+$/u.test(String(guard.rowVersion || ""))) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_CREDENTIAL_CHANGED", "原模型凭据绑定已变化或不属于本次支持的字面凭据通路");
  }
  if (physical.is_hidden !== false || physical.user_access === "hidden") {
    throw new PlatformConfigurationError("VISION_PUBLICATION_PHYSICAL_CHANGED", "原模型当前目录状态不属于本次已审核范围");
  }
  let ordinaryHash: string;
  let expectedVisionHash: string;
  let evidenceRow: Row;
  try {
    const secret = resolveProviderSecret(physical.api_key);
    const binding = visionCandidateBinding(before, after, physical);
    ordinaryHash = llmModelValidationConfigurationHash(binding, secret);
    if (ordinaryHash !== llmModelValidationConfigurationHash(physical, secret)) {
      throw new PlatformConfigurationError("VISION_CAPABILITY_BINDING_CHANGED", "原模型执行与计费配置已变化，图片证据不能授权额外变更");
    }
    expectedVisionHash = visionConfigurationHash(binding, secret);
    const evidence = await db.from("llm_model_validation_evidence").select("id,model_id,configuration_hash,checked_at")
      .eq("model_id", modelId).eq("configuration_hash", expectedVisionHash).maybeSingle();
    if (evidence.error) throw new PlatformConfigurationError("VISION_VALIDATION_EVIDENCE_UNAVAILABLE", "无法读取当前能力候选的真实视觉验证证据");
    assertFreshVisionEvidence(binding, secret, evidence.data);
    evidenceRow = record(evidence.data);
    requireUuid(evidenceRow.id, "视觉验证证据 ID");
  } catch (error) {
    if (error instanceof LlmModelValidationError) throw new PlatformConfigurationError(error.code, error.message);
    throw error;
  }
  // All proof fields originate above. The HTTP action accepts only target ID,
  // release ID and the user's reviewed preview identity.
  let published;
  try { published = await db.rpc("publish_llm_vision_capability_only_atomic", {
    p_release_id: releaseId, p_actor_id: actorId,
    p_expected_candidate_sha256: String(candidate.snapshot_sha256),
    p_expected_current_id: String(current.id), p_expected_current_sha256: String(current.snapshot_sha256),
    p_expected_current_snapshot: current.snapshot, p_expected_candidate_snapshot: candidate.snapshot,
    p_target_model_id: modelId, p_expected_row_version: String(guard.rowVersion),
    p_expected_credential_ref: before.credentialRef, p_expected_credential_revision: String(guard.bindingRevision),
    p_ordinary_configuration_hash: ordinaryHash, p_vision_configuration_hash: expectedVisionHash,
    p_evidence_id: String(evidenceRow.id), p_evidence_checked_at: String(evidenceRow.checked_at),
  }); } catch {
    throw new PlatformConfigurationError("VISION_PUBLICATION_OUTCOME_UNKNOWN", "发布请求结果待核对，请读取原候选和当前版本；不要重复提交或转入普通发布");
  }
  if (published.error) {
    const errorCode = String(published.error.code || "");
    const message = String(published.error.message || "");
    if (["PGRST202", "42883"].includes(errorCode)) {
      throw new PlatformConfigurationError("VISION_PUBLICATION_RPC_UNAVAILABLE", "图片能力单独发布迁移尚未就绪，本次未发布");
    }
    const allowed = ["INPUT_INVALID", "CURRENT_CHANGED", "CANDIDATE_CHANGED", "CANDIDATE_BASE_CHANGED", "PENDING_CREDENTIALS_REJECTED",
      "SCOPE_INVALID", "CREDENTIAL_CHANGED", "PHYSICAL_CHANGED", "EVIDENCE_DOMAIN_INVALID", "EVIDENCE_REQUIRED", "UPDATE_INCOMPLETE"];
    const suffix = allowed.find(value => message.includes(`VISION_PUBLICATION_${value}`));
    throw new PlatformConfigurationError(suffix ? `VISION_PUBLICATION_${suffix}` : "VISION_PUBLICATION_OUTCOME_UNKNOWN", "图片能力单独发布未获确认，请核对原候选和当前版本；不会转入全局发布");
  }
  let readback: Row | null;
  let postGuard: Row;
  try {
    readback = await currentRelease("model-pool");
    const post = await db.rpc("read_llm_vision_publication_guard", { p_model_id: modelId, p_credential_ref: before.credentialRef });
    if (post.error) throw new Error("private readback unavailable");
    postGuard = record(post.data);
  } catch { throw new PlatformConfigurationError("VISION_PUBLICATION_OUTCOME_UNKNOWN", "发布后读回暂不可确认，请查询原候选；不要重复提交"); }
  if (!readback || readback.id !== releaseId || readback.status !== "published" || readback.is_current !== true
    || readback.snapshot_sha256 !== candidate.snapshot_sha256) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_OUTCOME_UNKNOWN", "图片能力单独发布后读回身份不一致，请读取当前版本核验");
  }
  snapshotFromRow("model-pool", readback);
  // The existing visibility trigger keeps ordinary catalogue rows active and
  // visible. Generation remains gated by user_access, not is_active. Compare
  // every other physical value and credential exactly; never serialize this
  // credential-bearing row into an HTTP reply or an evidence file.
  const expectedPhysical: Row = { ...physical, image_parsing: "gpt_vision", is_active: true, user_access: "pending_model_activation" };
  const actualPhysical: Row = { ...record(postGuard.physical) };
  delete expectedPhysical.updated_at; delete actualPhysical.updated_at;
  if (visionPublicationPrivateJson(expectedPhysical) !== visionPublicationPrivateJson(actualPhysical)
    || postGuard.credentialRef !== guard.credentialRef || postGuard.bindingRevision !== guard.bindingRevision
    || postGuard.bindingMatches !== true || postGuard.credentialLiteral !== true
    || !Number.isFinite(Date.parse(String(record(postGuard.physical).updated_at || "")))) {
    throw new PlatformConfigurationError("VISION_PUBLICATION_OUTCOME_UNKNOWN", "模型能力或待激活状态读回不一致，请查询原候选；视觉验证不会自动激活模型");
  }
  return readback;
}
