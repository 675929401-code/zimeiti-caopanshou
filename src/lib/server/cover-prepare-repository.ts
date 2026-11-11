import { createHash } from "node:crypto";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { CoverPrepareInput } from "@/lib/cover-workbench-contract";
import { canRecoverPaidCoverAnalysis, isVerifiedCoverAnalysisReplay, type VerifiedCoverAnalysisReplay } from "./cover-analysis-recovery";

export type CoverPrepareState = "prepared" | "analyzing" | "needs_input" | "plan_ready" | "unknown" | "failed";
export type CoverPrepareRow = {
  id: string; user_id: string; client_request_id: string; material_fingerprint: string;
  revision: number; state: CoverPrepareState; materials: CoverPrepareInput;
  preparation: Record<string, unknown>; result: Record<string, unknown> | null;
  analysis_request_id: string; analysis_attempt_id: string | null;
  billing: Record<string, unknown>; consent: Record<string, unknown> | null;
  error_code: string | null; created_at: string; updated_at: string;
};

export class CoverPrepareError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

/** Contains only an ID already read through the current owner's scope. */
export class CoverConfirmationQueryOriginalError extends CoverPrepareError {
  constructor(readonly originalConfirmationId: string) {
    super("COVER_CONFIRMATION_QUERY_ORIGINAL", "原确认订单已存在或结果尚未确定，请查询原单；本次未创建或派发新订单", 409);
  }
}

/** RFC 9562 UUIDv5: one atomic PK slot per owner's immutable paid plan. */
export function coverConfirmationPlanId(userId: string, parentId: string, confirmedPlanHash: string) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace)
    .update(JSON.stringify(["cover-confirmation-plan-identity/v1", userId, parentId, confirmedPlanHash])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Object-key order cannot create another paid analysis for the same materials. */
export function coverMaterialFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function databaseError(): never {
  throw new CoverPrepareError("COVER_PREPARE_STORAGE_UNAVAILABLE", "封面任务存储尚未就绪，本次不会调用模型", 503);
}

export async function loadCoverPreparation(userId: string, id?: string) {
  let query = getSupabaseClient().from("cover_prepare_operations").select("*").eq("user_id", userId);
  query = id ? query.eq("id", id) : query.order("created_at", { ascending: false }).limit(1);
  const result = await query.maybeSingle();
  if (result.error) databaseError();
  return result.data as CoverPrepareRow | null;
}

export async function findReusableCoverAnalysis(userId: string, contentFingerprint: string) {
  const result = await getSupabaseClient().from("cover_prepare_operations").select("*")
    .eq("user_id", userId).eq("state", "plan_ready").eq("preparation->>contentFingerprint", contentFingerprint)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) databaseError();
  const row = result.data as CoverPrepareRow | null;
  return row?.preparation.recordKind === "confirmation" ? null : row;
}

export async function loadCoverPreparationByKey(userId: string, clientRequestId: string) {
  const result = await getSupabaseClient().from("cover_prepare_operations").select("*")
    .eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle();
  if (result.error) databaseError();
  return result.data as CoverPrepareRow | null;
}

/** All historical children, including old random IDs; never repair or update. */
export async function loadCoverConfirmationsForAnalysis(userId: string, parentId: string) {
  const rows: CoverPrepareRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await getSupabaseClient().from("cover_prepare_operations").select("*")
      .eq("user_id", userId).eq("preparation->>recordKind", "confirmation")
      .eq("preparation->>originalAnalysisOperationId", parentId)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499);
    if (result.error || !Array.isArray(result.data)) databaseError();
    const page = result.data as CoverPrepareRow[];
    if (page.some(row => row.user_id !== userId || row.preparation.recordKind !== "confirmation"
      || row.preparation.originalAnalysisOperationId !== parentId)) databaseError();
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

function assertAnalysisRecord(row: CoverPrepareRow) {
  if (row.preparation.recordKind === "confirmation") {
    throw new CoverPrepareError("COVER_CONFIRMATION_ANALYSIS_FORBIDDEN", "已确认方案不能再次调用文案分析，请查询原任务");
  }
}

/** Append once. Never UPDATE an original analysis or an existing confirmation. */
export async function insertCoverConfirmation(row: CoverPrepareRow) {
  const parentId = String(row.preparation.originalAnalysisOperationId || "");
  const planHash = String(row.preparation.confirmedPlanHash || "");
  if (row.preparation.recordKind !== "confirmation" || !parentId || !/^[a-f0-9]{64}$/u.test(planHash)
    || row.preparation.route !== "original_layout" && row.id !== coverConfirmationPlanId(row.user_id, parentId, planHash)) {
    throw new CoverPrepareError("COVER_CONFIRMATION_IDENTITY_INVALID", "确认订单标识未绑定当前账号与原方案，本次未保存", 422);
  }
  const created = await getSupabaseClient().from("cover_prepare_operations").insert(row).select("*").single();
  if (!created.error && created.data) return created.data as CoverPrepareRow;
  // The paid-plan PK can conflict even when the client key is different.
  const existing = await loadCoverPreparation(row.user_id, row.id)
    || await loadCoverPreparationByKey(row.user_id, row.client_request_id);
  if (!existing) databaseError();
  if (existing.user_id !== row.user_id) databaseError();
  if (existing.preparation.recordKind === "confirmation" && existing.preparation.originalAnalysisOperationId === parentId
    && existing.preparation.confirmedPlanHash === planHash && existing.client_request_id !== row.client_request_id) {
    throw new CoverConfirmationQueryOriginalError(existing.id);
  }
  if (existing.preparation.recordKind !== "confirmation" || existing.preparation.originalAnalysisOperationId !== parentId
    || existing.preparation.confirmedPlanHash !== planHash || existing.client_request_id !== row.client_request_id
    || existing.preparation.confirmationRequestHash !== row.preparation.confirmationRequestHash) {
    throw new CoverPrepareError("COVER_CONFIRMATION_KEY_CONFLICT", "该确认标识已用于其他方案，请保留原确认或使用新的确认标识");
  }
  return existing;
}

export async function prepareCoverOperation(userId: string, materials: CoverPrepareInput, preparation: Record<string, unknown>) {
  const fingerprint = coverMaterialFingerprint(materials);
  const created = await getSupabaseClient().from("cover_prepare_operations").upsert({
    user_id: userId, client_request_id: materials.clientRequestId,
    material_fingerprint: fingerprint, revision: materials.materialRevision, materials, preparation,
    analysis_request_id: `cover_analysis_${createHash("sha256").update(`${userId}:${materials.clientRequestId}`).digest("hex").slice(0, 48)}`,
  }, { onConflict: "user_id,client_request_id", ignoreDuplicates: true });
  if (created.error) databaseError();
  const result = await getSupabaseClient().from("cover_prepare_operations").select("*")
    .eq("user_id", userId).eq("client_request_id", materials.clientRequestId).single();
  if (result.error || !result.data) databaseError();
  const row = result.data as CoverPrepareRow;
  assertAnalysisRecord(row);
  if (row.material_fingerprint !== fingerprint) throw new CoverPrepareError("COVER_MATERIAL_CONFLICT", "这份材料已经更改，请创建新的封面任务");
  return row;
}

export async function claimCoverAnalysis(row: CoverPrepareRow, consent: Record<string, unknown>) {
  assertAnalysisRecord(row);
  const claimed = await getSupabaseClient().from("cover_prepare_operations")
    .update({ state: "analyzing", consent, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("user_id", row.user_id).eq("revision", row.revision).eq("state", "prepared")
    .eq("updated_at", row.updated_at).eq("preparation->>promptDependenciesFingerprint", row.preparation.promptDependenciesFingerprint)
    .eq("preparation->>preparationFingerprint", row.preparation.preparationFingerprint)
    .select("*").maybeSingle();
  if (claimed.error) databaseError();
  return claimed.data as CoverPrepareRow | null;
}

export async function bindCoverAnalysisRequest(row: CoverPrepareRow, fingerprint: string) {
  assertAnalysisRecord(row);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new CoverPrepareError("COVER_ANALYSIS_REQUEST_INVALID", "文案分析参数无效");
  if (row.preparation.analysisPayloadFingerprint && row.preparation.analysisPayloadFingerprint !== fingerprint) {
    throw new CoverPrepareError("COVER_ANALYSIS_REQUEST_CONFLICT", "原分析请求与当前材料不一致，请查询原任务");
  }
  const result = await getSupabaseClient().from("cover_prepare_operations")
    .update({ preparation: { ...row.preparation, analysisPayloadFingerprint: fingerprint }, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("user_id", row.user_id).eq("revision", row.revision).eq("state", "analyzing")
    .eq("updated_at", row.updated_at).eq("preparation->>promptDependenciesFingerprint", row.preparation.promptDependenciesFingerprint)
    .eq("preparation->>preparationFingerprint", row.preparation.preparationFingerprint)
    .select("*").maybeSingle();
  if (result.error || !result.data) databaseError();
  return result.data as CoverPrepareRow;
}

export async function finishCoverAnalysis(row: CoverPrepareRow, update: {
  state: Exclude<CoverPrepareState, "prepared" | "analyzing">; result?: Record<string, unknown>;
  billing?: Record<string, unknown>; analysis_attempt_id?: string; error_code?: string | null;
}) {
  assertAnalysisRecord(row);
  if (row.state === "failed" && update.state === "plan_ready") {
    throw new CoverPrepareError("COVER_ANALYSIS_REPLAY_PROOF_REQUIRED", "原分析需要先核验收费回执，不能重新提交");
  }
  const result = await getSupabaseClient().from("cover_prepare_operations").update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("user_id", row.user_id).eq("revision", row.revision).eq("state", row.state).eq("updated_at", row.updated_at).select("*").maybeSingle();
  if (result.error) databaseError();
  return result.data as CoverPrepareRow | null || await loadCoverPreparation(row.user_id, row.id) || databaseError();
}

/** Reuse only this owner's verified, already paid child; billing is untouched. */
export async function finishRecoveredCoverAnalysis(row: CoverPrepareRow, result: Record<string, unknown>, proof: VerifiedCoverAnalysisReplay) {
  assertAnalysisRecord(row);
  if (!canRecoverPaidCoverAnalysis(row) || !isVerifiedCoverAnalysisReplay(proof, row)) {
    throw new CoverPrepareError("COVER_ANALYSIS_REPLAY_PROOF_REQUIRED", "原分析回执尚未通过核验，请查询原任务");
  }
  const updated = await getSupabaseClient().from("cover_prepare_operations")
    .update({ state: "plan_ready", result, analysis_attempt_id: proof.recordId, error_code: null, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("user_id", row.user_id).eq("client_request_id", row.client_request_id)
    .eq("analysis_request_id", row.analysis_request_id).eq("analysis_attempt_id", row.analysis_attempt_id)
    .eq("revision", row.revision).eq("state", "failed").eq("error_code", row.error_code).eq("updated_at", row.updated_at)
    .eq("billing->>operation_id", String(row.billing.operation_id)).eq("billing->>credits_charged", String(row.billing.credits_charged))
    .select("*").maybeSingle();
  if (updated.error) databaseError();
  return updated.data as CoverPrepareRow | null || await loadCoverPreparation(row.user_id, row.id) || databaseError();
}
