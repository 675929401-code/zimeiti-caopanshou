import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  buildPlatformConfigurationPreview,
  configurationSha256,
  normalizeModelPoolSnapshot,
  normalizePlatformConfigurationSnapshot,
  validateModelPoolSnapshot,
  validateWorkspaceModelSnapshot,
  type ConfigurationValidation,
  type ModelPoolSnapshot,
  type PlatformConfigurationKind,
  type PlatformConfigurationReleaseIdentity,
  type PlatformConfigurationReleasePreview,
  type PlatformConfigurationSnapshot,
  type WorkspaceModelSnapshot,
} from "@/lib/platform-configuration-contract";

import { MODEL_MUTATION_REQUEST_UUID, normalizeCredentialMetadata, type PlatformCredentialChange, type PlatformCredentialMetadata } from "@/lib/server/platform-configuration-pending-credentials";

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
}) {
  const actorId = requireUuid(input.actorId, "管理员 ID");
  if (!MODEL_MUTATION_REQUEST_UUID.test(String(input.requestId || ""))) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED", "请提供有效的模型变更请求标识后重试");
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
    p_validation_result: { ...validationRecord(validation, actorId), ...(input.expectedBase ? { operation: "video-upsert-only", baseSnapshotSha256: input.expectedBase.snapshotSha256 } : {}) }, p_status: validation.ok ? "validated" : "draft",
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

export async function publishPlatformConfigurationRelease(
  actorIdValue: string,
  kind: PlatformConfigurationKind,
  releaseIdValue: string,
  expectedPreviewSha256: string,
) {
  const actorId = requireUuid(actorIdValue, "管理员 ID");
  const releaseId = requireUuid(releaseIdValue, "配置版本 ID");
  const existing = await release(kind, releaseId);
  if (existing.is_current === true && existing.status === "published") return existing;
  if (existing.status === "superseded") throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT", "该候选已发布且已被更新版本替代，请读取当前版本");
  const preview = await previewPlatformConfigurationRelease(kind, releaseId);
  if (!expectedPreviewSha256 || preview.previewSha256 !== expectedPreviewSha256) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_PREVIEW_STALE", "发布差异预览已缺失或过期，请重新预览");
  }

  // No database mutation occurs while a legacy path can bypass versioning.
  await assertPlatformConfigurationPublishReady();

  await validatePlatformConfigurationCandidate(actorId, kind, releaseId);
  const freshPreview = await previewPlatformConfigurationRelease(kind, releaseId);
  if (freshPreview.previewSha256 !== expectedPreviewSha256) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_PREVIEW_STALE", "发布校验后配置身份已变化，请重新预览");
  }
  if (kind === "workspace-models") {
    const row = await release(kind, releaseId);
    await assertWorkspaceDependencyIsCurrent(snapshotFromRow("workspace-models", row));
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
