import { createHash } from "node:crypto";
import type { CoverPrepareRow } from "./cover-prepare-repository";

export const COVER_ANALYSIS_RECOVERY_VERSION = "cover-analysis-recovery/2";
export const COVER_RECOVERABLE_ANALYSIS_CODES: readonly string[] = [
  "ANALYSIS_SCHEMA_INVALID", "ANALYSIS_EVIDENCE_INVALID", "ANALYSIS_UNGROUNDED_CLAIM", "COVER_ANALYSIS_FORMAT_INVALID",
];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function canRecoverPaidCoverAnalysis(row: CoverPrepareRow): boolean {
  const previous = object(row.result?.analysisRecovery);
  if (previous.schemaVersion === COVER_ANALYSIS_RECOVERY_VERSION && previous.outcome === "not_recoverable"
    && previous.childRecordId === row.analysis_attempt_id) return false;
  return row.preparation.recordKind !== "confirmation" && row.state === "failed" && COVER_RECOVERABLE_ANALYSIS_CODES.includes(row.error_code || "")
    && typeof row.billing.credits_charged === "number" && Number.isFinite(row.billing.credits_charged) && row.billing.credits_charged > 0
    && Boolean(row.billing.operation_id) && row.consent?.analysis === true
    && (row.preparation.workflowVersion === 3 || row.consent?.image === true);
}
export type VerifiedCoverAnalysisReplay = Readonly<{
  parentId: string; ownerId: string; revision: number; updatedAt: string; originalErrorCode: string | null;
  recordId: string; payloadFingerprint: string; responseFingerprint: string; resultReference: string; attemptNo: number;
  payload: unknown;
}>;
const issued = new WeakSet<VerifiedCoverAnalysisReplay>();

/** Authenticate the original durable child; never regenerate or normalize its bytes. */
export function verifyCoverAnalysisReplay(row: CoverPrepareRow, childValue: unknown): VerifiedCoverAnalysisReplay | null {
  const child = object(childValue);
  const expectedRecordId = sha(`${row.user_id}\0${row.analysis_request_id}`);
  if (row.preparation.recordKind === "confirmation" || !["analyzing", "unknown", "failed"].includes(row.state) || row.state === "failed" && !canRecoverPaidCoverAnalysis(row)
    || child.user_id !== row.user_id || child.client_request_id !== row.analysis_request_id
    || child.record_id !== expectedRecordId || child.state !== "succeeded" || child.http_status !== 200
    || !Number.isSafeInteger(child.attempt_no) || Number(child.attempt_no) < 1
    || typeof child.response_body !== "string" || Buffer.byteLength(child.response_body, "utf8") > 2 * 1024 * 1024
    || !/^[a-f0-9]{64}$/u.test(String(row.preparation.analysisPayloadFingerprint || ""))
    || child.payload_fingerprint !== row.preparation.analysisPayloadFingerprint) return null;
  const responseFingerprint = sha(child.response_body);
  const resultReference = `llm-result:${expectedRecordId}:${child.attempt_no}:${responseFingerprint}`;
  if (child.response_fingerprint !== responseFingerprint || child.result_reference !== resultReference
    || row.state === "failed" && row.analysis_attempt_id !== expectedRecordId) return null;
  let payload: unknown;
  try { payload = JSON.parse(child.response_body); } catch { return null; }
  if (row.state === "failed") {
    const billing = object(object(payload)._billing);
    if (billing.credits_charged !== row.billing.credits_charged || String(billing.operation_id) !== String(row.billing.operation_id)) return null;
  }
  const proof: VerifiedCoverAnalysisReplay = Object.freeze({ parentId: row.id, ownerId: row.user_id, revision: row.revision,
    updatedAt: row.updated_at, originalErrorCode: row.error_code, recordId: expectedRecordId,
    payloadFingerprint: String(child.payload_fingerprint), responseFingerprint, resultReference, attemptNo: Number(child.attempt_no), payload });
  issued.add(proof);
  return proof;
}

/** A plain DTO or another owner's proof cannot authorize failed→ready. */
export function isVerifiedCoverAnalysisReplay(proof: VerifiedCoverAnalysisReplay, row: CoverPrepareRow): boolean {
  return issued.has(proof) && proof.parentId === row.id && proof.ownerId === row.user_id && proof.revision === row.revision
    && proof.updatedAt === row.updated_at && proof.originalErrorCode === row.error_code
    && proof.recordId === row.analysis_attempt_id && proof.payloadFingerprint === row.preparation.analysisPayloadFingerprint;
}
