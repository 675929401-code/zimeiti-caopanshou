import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 9 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const RECORD_ID_PATTERN = /^[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const SENSITIVE_HEADER_PATTERN = /(authorization|cookie|set-cookie|api[-_]?key|token|secret|password|credential)/iu;

type ReconciliationBody = Record<string, unknown>;
type TargetState = "succeeded" | "failed";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function errorResponse(code: string, error: string, status: number): NextResponse {
  return noStore(NextResponse.json({ error, code }, { status }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(body: ReconciliationBody, ...names: string[]): string {
  for (const name of names) {
    if (typeof body[name] === "string") return body[name].trim();
  }
  return "";
}

function rawStringField(body: ReconciliationBody, ...names: string[]): string {
  for (const name of names) {
    if (typeof body[name] === "string") return body[name];
  }
  return "";
}

function numberField(body: ReconciliationBody, ...names: string[]): number | null {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      return typeof body[name] === "number" ? body[name] : null;
    }
  }
  return null;
}

function readHeaders(body: ReconciliationBody): Record<string, string> | null {
  const value = body.headers ?? body.response_headers;
  if (!isObject(value)) return null;
  const result: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > 64) return null;
  for (const [name, rawValue] of entries) {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(normalizedName)) return null;
    if (SENSITIVE_HEADER_PATTERN.test(normalizedName)) continue;
    if (typeof rawValue !== "string" || rawValue.length > 2048) return null;
    result[normalizedName] = rawValue;
  }
  return result;
}

function parseBody(body: unknown): {
  recordId: string;
  expectedAttemptNo: number;
  targetState: TargetState;
  reason: string;
  httpStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseFingerprint: string;
  resultReference: string;
} | { error: NextResponse } {
  if (!isObject(body)) return { error: errorResponse("LLM_RECONCILIATION_REQUEST_INVALID", "对账请求格式无效", 400) };
  const recordId = stringField(body, "record_id", "recordId");
  const expectedAttemptNo = numberField(body, "expected_attempt_no", "expectedAttemptNo");
  const targetState = stringField(body, "target_state", "targetState").toLowerCase();
  const reason = stringField(body, "reason");
  const httpStatus = numberField(body, "http_status", "httpStatus");
  const responseHeaders = readHeaders(body);
  const responseBody = rawStringField(body, "body", "response_body", "responseBody");
  const responseFingerprint = stringField(body, "fingerprint", "response_fingerprint", "responseFingerprint").toLowerCase();
  const resultReference = stringField(body, "resultReference", "result_reference");

  if (!RECORD_ID_PATTERN.test(recordId)) {
    return { error: errorResponse("LLM_RECONCILIATION_RECORD_ID_INVALID", "record_id 无效", 400) };
  }
  if (expectedAttemptNo === null || !Number.isSafeInteger(expectedAttemptNo) || expectedAttemptNo < 1 || expectedAttemptNo > 2_147_483_647) {
    return { error: errorResponse("LLM_RECONCILIATION_ATTEMPT_NO_INVALID", "expected_attempt_no 无效", 400) };
  }
  if (targetState !== "succeeded" && targetState !== "failed") {
    return { error: errorResponse("LLM_RECONCILIATION_TARGET_STATE_INVALID", "target_state 只允许 succeeded 或 failed", 400) };
  }
  if (reason.length < 8 || reason.length > 500) {
    return { error: errorResponse("LLM_RECONCILIATION_REASON_INVALID", "reason 长度必须在 8 到 500 个字符之间", 400) };
  }
  if (httpStatus === null || !Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    return { error: errorResponse("LLM_RECONCILIATION_HTTP_STATUS_INVALID", "HTTP 状态码无效", 400) };
  }
  if (!responseHeaders) {
    return { error: errorResponse("LLM_RECONCILIATION_HEADERS_INVALID", "headers 必须是对象且不能包含敏感 header", 400) };
  }
  if (!responseBody || Buffer.byteLength(responseBody, "utf8") > MAX_RESPONSE_BODY_BYTES) {
    return { error: errorResponse("LLM_RECONCILIATION_BODY_INVALID", "body 必须为非空且不超过 8 MiB", 422) };
  }
  if (!FINGERPRINT_PATTERN.test(responseFingerprint)) {
    return { error: errorResponse("LLM_RECONCILIATION_FINGERPRINT_INVALID", "fingerprint 必须是小写 SHA-256", 422) };
  }
  const computedFingerprint = crypto.createHash("sha256").update(responseBody, "utf8").digest("hex");
  if (computedFingerprint !== responseFingerprint) {
    return { error: errorResponse("LLM_RECONCILIATION_FINGERPRINT_MISMATCH", "fingerprint 与 body 不匹配", 422) };
  }
  if (targetState === "succeeded" && (httpStatus < 200 || httpStatus > 299 || !resultReference || resultReference.length > 2048)) {
    return { error: errorResponse("LLM_RECONCILIATION_SUCCESS_EVIDENCE_REQUIRED", "成功对账必须提供 2xx、body、SHA-256 fingerprint 和 resultReference", 422) };
  }
  if (targetState === "failed" && httpStatus >= 200 && httpStatus <= 299) {
    return { error: errorResponse("LLM_RECONCILIATION_FAILURE_EVIDENCE_INVALID", "失败对账的 HTTP 状态不能是 2xx", 422) };
  }
  if (targetState === "failed" && resultReference) {
    return { error: errorResponse("LLM_RECONCILIATION_FAILURE_REFERENCE_FORBIDDEN", "失败对账不能提供 resultReference", 422) };
  }
  return {
    recordId,
    expectedAttemptNo,
    targetState,
    reason,
    httpStatus,
    responseHeaders,
    responseBody,
    responseFingerprint,
    resultReference,
  };
}

function errorCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  return String(value?.code || "LLM_RECONCILIATION_STORE_UNAVAILABLE");
}

function errorStatus(error: unknown): number {
  const message = String((error as { message?: unknown } | null)?.message || "");
  if (/NOT_FOUND/iu.test(message)) return 404;
  if (/INPUT_INVALID|EVIDENCE_REQUIRED|RESPONSE_TOO_LARGE|UNKNOWN_RESPONSE/iu.test(message)) return 422;
  if (/CONFLICT|NOT_READY/iu.test(message)) return 409;
  if (/schema cache|does not exist|reconcile_llm_request_attempt_atomic/iu.test(message)) return 503;
  return 503;
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function redactedRecord(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const responseBody = typeof value.response_body === "string" ? value.response_body : null;
  const resultReference = typeof value.result_reference === "string" ? value.result_reference : "";
  const userId = typeof value.user_id === "string" ? value.user_id : "";
  const clientRequestId = typeof value.client_request_id === "string" ? value.client_request_id : "";
  return {
    recordId: typeof value.record_id === "string" ? value.record_id : null,
    state: typeof value.state === "string" ? value.state : null,
    attemptNo: Number.isSafeInteger(value.attempt_no) ? value.attempt_no : null,
    httpStatus: Number.isSafeInteger(value.http_status) ? value.http_status : null,
    responseFingerprint: typeof value.response_fingerprint === "string" ? value.response_fingerprint : null,
    responseBodyBytes: responseBody === null ? null : Buffer.byteLength(responseBody, "utf8"),
    responseHeadersPresent: isObject(value.response_headers) && Object.keys(value.response_headers).length > 0,
    resultReferenceHash: resultReference ? shortHash(resultReference) : null,
    userReference: userId ? shortHash(userId) : null,
    clientRequestReference: clientRequestId ? shortHash(clientRequestId) : null,
    errorCode: typeof value.error_code === "string" ? value.error_code : null,
    errorMessagePresent: typeof value.error_message === "string" && value.error_message.length > 0,
    providerCallStartedAt: typeof value.provider_call_started_at === "string" ? value.provider_call_started_at : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

function migrationMissing(error: unknown): boolean {
  return /schema cache|does not exist|reconcile_llm_request_attempt_atomic/iu.test(
    String((error as { message?: unknown } | null)?.message || ""),
  );
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "llm_request_attempt_reconcile",
    auditAllowed: true,
  });
  if (!authorization.ok) return noStore(authorization.response);

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return errorResponse("LLM_RECONCILIATION_REQUEST_TOO_LARGE", "对账请求体过大", 413);
  }
  let input: ReturnType<typeof parseBody>;
  try {
    input = parseBody(await request.json());
  } catch {
    return errorResponse("LLM_RECONCILIATION_REQUEST_INVALID", "对账请求格式无效", 400);
  }
  if ("error" in input) return input.error;

  try {
    const { data, error } = await getSupabaseAdminClient().rpc("reconcile_llm_request_attempt_atomic", {
      p_record_id: input.recordId,
      p_expected_attempt_no: input.expectedAttemptNo,
      p_actor_user_id: authorization.actor.userId,
      p_target_state: input.targetState,
      p_reason: input.reason,
      p_http_status: input.httpStatus,
      p_response_headers: input.responseHeaders,
      p_response_body: input.responseBody,
      p_response_fingerprint: input.responseFingerprint,
      p_result_reference: input.resultReference || null,
    });
    if (error) throw error;
    const raw = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    const record = redactedRecord(raw?.record);
    if (!record) throw new Error("LLM_RECONCILIATION_RESULT_INVALID");
    const auditComplete = await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "models.manage",
      action: "llm_request_attempt_reconcile_result",
      result: "success",
      reasonCode: `LLM_RECONCILIATION_${input.targetState.toUpperCase()}`,
      resource: "llm_request_attempts",
      request,
      metadata: { recordId: input.recordId, targetState: input.targetState, expectedAttemptNo: input.expectedAttemptNo },
    });
    return noStore(NextResponse.json({
      success: true,
      attempt: record,
      accounting: {
        readOnly: true,
        ledgerMutation: false,
        automaticRefund: false,
        automaticRetry: false,
        linkage: "llm_request_attempts",
        resultReferenceHash: record.resultReferenceHash,
      },
      auditStatus: auditComplete ? "complete" : "authorized_intent_only",
    }, { status: auditComplete ? 200 : 202 }));
  } catch (error) {
    const code = migrationMissing(error)
      ? "LLM_RECONCILIATION_MIGRATION_NOT_READY"
      : errorCode(error).startsWith("LLM_") ? errorCode(error) : "LLM_RECONCILIATION_STORE_UNAVAILABLE";
    const status = migrationMissing(error) ? 503 : errorStatus(error);
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "models.manage",
      action: "llm_request_attempt_reconcile_result",
      result: "failure",
      reasonCode: code,
      resource: "llm_request_attempts",
      request,
      metadata: { recordId: input.recordId, targetState: input.targetState, expectedAttemptNo: input.expectedAttemptNo },
    });
    return errorResponse(code, migrationMissing(error) ? "LLM 对账迁移尚未部署，本次未改动记录" : "LLM 对账未完成，原记录保持待核对状态", status);
  }
}
