import "server-only";

import {
  SkillInvocationClaimSchema,
  SkillInvocationCompleteSchema,
  SkillInvocationFailureSchema,
  parseSkillPayloadFingerprint,
  stableSkillJson,
  type ResolvedSkillPackage,
  type SkillActor,
  type SkillInvocationRecord,
  type SkillJsonObject,
  type SkillListQuery,
} from "@/lib/server/skill-package-contract";
import {
  SkillRepositoryError,
  getSkillInvocationDatabase,
  listAvailableSkillsForActor,
  normalizeSkillRepositoryError,
  requirePublishedSkillVersion,
} from "@/lib/server/skill-package-repository";
import {
  buildSkillExecutionContexts,
  resolveSkillSelection,
  type SkillExecutionContext,
  type SkillSelectionResult,
} from "@/lib/server/skill-policy";

export interface ClaimedSkillInvocation {
  created: boolean;
  invocationId: string;
  state: SkillInvocationRecord["state"];
  payloadFingerprint: string;
  record: SkillInvocationRecord;
  skill: ResolvedSkillPackage;
}

export interface SkillInvocationResult {
  invocationId: string;
  state: SkillInvocationRecord["state"];
  record: SkillInvocationRecord;
}

export interface PreparedSkillInvocationContext {
  availableSkills: ResolvedSkillPackage[];
  selection: SkillSelectionResult;
  executionContexts: SkillExecutionContext[];
}

function jsonObject(value: unknown, fallback: SkillJsonObject = {}): SkillJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  stableSkillJson(value);
  return value as SkillJsonObject;
}

function invocationRecord(value: unknown): SkillInvocationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRepositoryError(
      "SKILL_STORE_UNAVAILABLE",
      "Skill invocation 返回异常",
      503,
      "invocation-result",
    );
  }
  const row = value as Record<string, unknown>;
  const state = String(row.state ?? "");
  if (!["claimed", "completed", "failed", "failed_unknown"].includes(state)) {
    throw new SkillRepositoryError(
      "SKILL_STORE_UNAVAILABLE",
      "Skill invocation 状态异常",
      503,
      "invocation-result",
    );
  }
  return {
    id: String(row.id ?? ""),
    user_id: String(row.user_id ?? ""),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    package_id: String(row.package_id ?? ""),
    version_id: String(row.version_id ?? ""),
    client_idempotency_key: String(row.client_idempotency_key ?? ""),
    payload_fingerprint: String(row.payload_fingerprint ?? ""),
    input: jsonObject(row.input),
    state: state as SkillInvocationRecord["state"],
    output: row.output ? jsonObject(row.output) : null,
    error_code: row.error_code ? String(row.error_code) : null,
    error_detail: row.error_detail ? jsonObject(row.error_detail) : null,
    model_id: row.model_id ? String(row.model_id) : null,
    billing_operation_id: row.billing_operation_id ? String(row.billing_operation_id) : null,
    task_id: row.task_id ? String(row.task_id) : null,
    provider_task_id: row.provider_task_id ? String(row.provider_task_id) : null,
    asset_ids: Array.isArray(row.asset_ids) ? row.asset_ids.map(String) : [],
    charged_credits: Number(row.charged_credits ?? 0),
    charged_cash: Number(row.charged_cash ?? 0),
    cost_snapshot: jsonObject(row.cost_snapshot),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function rpcEnvelope(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new SkillRepositoryError(
      "SKILL_STORE_UNAVAILABLE",
      "Skill 原子状态机返回异常",
      503,
      "invocation-rpc",
    );
  }
  const envelope = row as Record<string, unknown>;
  if (envelope.ok !== true) {
    throw new SkillRepositoryError(
      "SKILL_STORE_UNAVAILABLE",
      "Skill 原子状态机未确认成功",
      503,
      "invocation-rpc",
    );
  }
  return envelope;
}

function verifyInvocationIdentity(
  record: SkillInvocationRecord,
  expected: { invocationId: string; payloadFingerprint: string; userId?: string; packageId?: string; versionId?: string },
): void {
  if (
    record.id !== expected.invocationId ||
    record.payload_fingerprint !== expected.payloadFingerprint ||
    (expected.userId && record.user_id !== expected.userId) ||
    (expected.packageId && record.package_id !== expected.packageId) ||
    (expected.versionId && record.version_id !== expected.versionId)
  ) {
    throw new SkillRepositoryError(
      "SKILL_CONFLICT",
      "Skill invocation 幂等标识或调用身份冲突",
      409,
      "verify-invocation",
    );
  }
}

export async function prepareSkillInvocationContext(input: {
  actor: SkillActor;
  message: string;
  explicitSlugs?: string[];
  maxAutoSkills?: number;
  query?: Partial<SkillListQuery>;
}): Promise<PreparedSkillInvocationContext> {
  const availableSkills = await listAvailableSkillsForActor(input.actor, input.query);
  const selection = resolveSkillSelection({
    skills: availableSkills,
    message: input.message,
    explicitSlugs: input.explicitSlugs,
    maxAutoSkills: input.maxAutoSkills,
  });
  const executionContexts = buildSkillExecutionContexts(availableSkills, selection);
  return { availableSkills, selection, executionContexts };
}

export async function claimSkillInvocation(input: {
  actor: SkillActor;
  invocationId?: string;
  agentId?: string | null;
  packageId: string;
  versionId: string;
  clientIdempotencyKey: string;
  input: SkillJsonObject;
  modelId?: string | null;
  billingOperationId?: string | null;
  taskId?: string | null;
}): Promise<ClaimedSkillInvocation> {
  const parsed = SkillInvocationClaimSchema.parse({
    invocationId: input.invocationId,
    userId: input.actor.userId,
    agentId: input.agentId ?? null,
    packageId: input.packageId,
    versionId: input.versionId,
    clientIdempotencyKey: input.clientIdempotencyKey,
    input: input.input,
    modelId: input.modelId ?? null,
    billingOperationId: input.billingOperationId ?? null,
    taskId: input.taskId ?? null,
  });
  const skill = await requirePublishedSkillVersion({
    actor: input.actor,
    packageId: parsed.packageId,
    versionId: parsed.versionId,
  });
  const payloadFingerprint = parseSkillPayloadFingerprint(parsed.input as SkillJsonObject);
  const database = getSkillInvocationDatabase();
  const result = await database.rpc("claim_skill_invocation", {
    p_invocation_id: parsed.invocationId,
    p_user_id: parsed.userId,
    p_agent_id: parsed.agentId,
    p_package_id: parsed.packageId,
    p_version_id: parsed.versionId,
    p_client_idempotency_key: parsed.clientIdempotencyKey,
    p_payload_fingerprint: payloadFingerprint,
    p_input: parsed.input,
    p_model_id: parsed.modelId,
    p_billing_operation_id: parsed.billingOperationId,
    p_task_id: parsed.taskId,
  });
  if (result.error) throw normalizeSkillRepositoryError(result.error, "claim-invocation");
  const envelope = rpcEnvelope(result.data);
  const record = invocationRecord(envelope.record);
  const invocationId = String(envelope.invocation_id ?? record.id);
  const state = String(envelope.state ?? record.state) as SkillInvocationRecord["state"];
  verifyInvocationIdentity(record, {
    invocationId,
    payloadFingerprint,
    userId: parsed.userId,
    packageId: parsed.packageId,
    versionId: parsed.versionId,
  });
  if (invocationId !== parsed.invocationId) {
    // Existing idempotent requests may return the original invocation UUID, but the
    // record must still carry the same user key and fingerprint. A different caller-
    // supplied UUID is accepted only for the non-created idempotent replay branch.
    if (envelope.created !== false) {
      throw new SkillRepositoryError("SKILL_CONFLICT", "Skill invocation UUID 冲突", 409, "claim-invocation");
    }
  }
  return {
    created: envelope.created === true,
    invocationId,
    state,
    payloadFingerprint,
    record,
    skill,
  };
}

export async function completeSkillInvocation(input: {
  invocationId: string;
  payloadFingerprint: string;
  output: SkillJsonObject;
  modelId?: string | null;
  billingOperationId?: string | null;
  taskId?: string | null;
  providerTaskId?: string | null;
  assetIds?: string[];
  chargedCredits?: number;
  chargedCash?: number;
  costSnapshot?: SkillJsonObject;
}): Promise<SkillInvocationResult> {
  const parsed = SkillInvocationCompleteSchema.parse({
    ...input,
    modelId: input.modelId ?? null,
    billingOperationId: input.billingOperationId ?? null,
    taskId: input.taskId ?? null,
    providerTaskId: input.providerTaskId ?? null,
    assetIds: input.assetIds ?? [],
    chargedCredits: input.chargedCredits ?? 0,
    chargedCash: input.chargedCash ?? 0,
    costSnapshot: input.costSnapshot ?? {},
  });
  const database = getSkillInvocationDatabase();
  const result = await database.rpc("complete_skill_invocation", {
    p_invocation_id: parsed.invocationId,
    p_payload_fingerprint: parsed.payloadFingerprint,
    p_output: parsed.output,
    p_model_id: parsed.modelId,
    p_billing_operation_id: parsed.billingOperationId,
    p_task_id: parsed.taskId,
    p_provider_task_id: parsed.providerTaskId,
    p_asset_ids: parsed.assetIds,
    p_charged_credits: parsed.chargedCredits,
    p_charged_cash: parsed.chargedCash,
    p_cost_snapshot: parsed.costSnapshot,
  });
  if (result.error) throw normalizeSkillRepositoryError(result.error, "complete-invocation");
  const envelope = rpcEnvelope(result.data);
  const record = invocationRecord(envelope.record);
  const invocationId = String(envelope.invocation_id ?? record.id);
  verifyInvocationIdentity(record, {
    invocationId,
    payloadFingerprint: parsed.payloadFingerprint,
  });
  if (record.state !== "completed") {
    throw new SkillRepositoryError("SKILL_CONFLICT", "Skill invocation 未进入完成态", 409, "complete-invocation");
  }
  return { invocationId, state: record.state, record };
}

export async function failSkillInvocation(input: {
  invocationId: string;
  payloadFingerprint: string;
  failureKind: "failed" | "failed_unknown";
  errorCode: string;
  errorDetail?: SkillJsonObject;
  billingOperationId?: string | null;
  taskId?: string | null;
}): Promise<SkillInvocationResult> {
  const parsed = SkillInvocationFailureSchema.parse({
    ...input,
    errorDetail: input.errorDetail ?? {},
    billingOperationId: input.billingOperationId ?? null,
    taskId: input.taskId ?? null,
  });
  const database = getSkillInvocationDatabase();
  const result = await database.rpc("fail_skill_invocation", {
    p_invocation_id: parsed.invocationId,
    p_payload_fingerprint: parsed.payloadFingerprint,
    p_failure_kind: parsed.failureKind,
    p_error_code: parsed.errorCode,
    p_error_detail: parsed.errorDetail,
    p_billing_operation_id: parsed.billingOperationId,
    p_task_id: parsed.taskId,
  });
  if (result.error) throw normalizeSkillRepositoryError(result.error, "fail-invocation");
  const envelope = rpcEnvelope(result.data);
  const record = invocationRecord(envelope.record);
  const invocationId = String(envelope.invocation_id ?? record.id);
  verifyInvocationIdentity(record, {
    invocationId,
    payloadFingerprint: parsed.payloadFingerprint,
  });
  if (record.state !== parsed.failureKind) {
    throw new SkillRepositoryError("SKILL_CONFLICT", "Skill invocation 未进入失败态", 409, "fail-invocation");
  }
  return { invocationId, state: record.state, record };
}
