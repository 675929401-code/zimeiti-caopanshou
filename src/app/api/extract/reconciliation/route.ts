import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";

const RECORD_ID_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROVIDER_EVIDENCE_KEYS = new Set([
  "provider_call_started",
  "upstream_completed",
  "terminal_state",
  "provider_status",
  "provider_request_id",
  "provider_task_id",
  "provider_cost",
  "reconciled_at",
  "evidence_source",
  "notes",
]);
const BILLING_EVIDENCE_KEYS = new Set([
  "charged",
  "refunded",
  "admin_exempt",
  "reservation_operation_id",
  "settlement_operation_id",
  "refund_operation_id",
  "credits_reserved",
  "credits_charged",
  "credits_refunded",
  "wallet_state",
  "balance_after",
  "reconciled_at",
  "evidence_source",
  "notes",
]);

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeEvidence(value: unknown, allowedKeys: Set<string>): JsonObject {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, nested]) => allowedKeys.has(key)
        && (nested === null || ["string", "number", "boolean"].includes(typeof nested)))
      .slice(0, 30)
      .map(([key, nested]) => [
        key,
        typeof nested === "string" ? nested.trim().slice(0, 500) : nested,
      ]),
  );
}

async function requireReconciliationAccess(
  request: NextRequest,
  permission: "billing.view" | "wallet.adjust",
  requireStepUp: boolean,
) {
  const authorization = await authorizeAdminCapability(request, permission, {
    requireStepUp,
    operation: requireStepUp ? "extraction_reconciliation_commit" : "extraction_reconciliation_view",
  });
  if (!authorization.ok) {
    return { response: authorization.response } as const;
  }
  return { actor: authorization.actor } as const;
}

function reconciliationStoreError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message || "");
  if (/EXTRACTION_RECONCILIATION_STALE/i.test(message)) {
    return NextResponse.json({ error: "记录已被其他管理员更新，请刷新后重试", error_code: "RECONCILIATION_STALE" }, { status: 409 });
  }
  if (/ALREADY_TERMINAL|TERMINAL_CONFLICT/i.test(message)) {
    return NextResponse.json({ error: "该记录已经进入终态，不允许覆盖", error_code: "RECONCILIATION_TERMINAL" }, { status: 409 });
  }
  if (/RECONCILIATION_ATTEMPT_ACTIVE/i.test(message)) {
    return NextResponse.json({ error: "该请求仍在安全执行窗口内，暂不允许人工改写终态", error_code: "RECONCILIATION_ATTEMPT_ACTIVE" }, { status: 409 });
  }
  if (/NOT_FOUND/i.test(message)) {
    return NextResponse.json({ error: "未找到待对账记录", error_code: "RECONCILIATION_NOT_FOUND" }, { status: 404 });
  }
  if (/INPUT_INVALID|EVIDENCE_REQUIRED|STATUS_INVALID|UNKNOWN_RESPONSE_FORBIDDEN/i.test(message)) {
    return NextResponse.json({ error: "对账证据或目标状态不完整", error_code: "RECONCILIATION_INPUT_INVALID" }, { status: 400 });
  }
  if (/extraction_attempt|schema cache|function|does not exist|could not find/i.test(message)) {
    return NextResponse.json({ error: "提取对账迁移尚未部署", error_code: "RECONCILIATION_MIGRATION_NOT_READY" }, { status: 503 });
  }
  return NextResponse.json({ error: "提取对账服务暂不可用", error_code: "RECONCILIATION_STORE_UNAVAILABLE" }, { status: 503 });
}

/**
 * List unresolved attempts. This route never contacts an extraction provider.
 * Browser/admin credentials only authorize the request; all database access is
 * performed by the server-side service-role client and the RPC itself is not
 * executable by anon/authenticated database roles.
 */
export async function GET(request: NextRequest) {
  const guard = await requireReconciliationAccess(request, "billing.view", false);
  if ("response" in guard) return guard.response;
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 50);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc("list_extraction_attempts_for_reconciliation", {
      p_limit: limit,
    });
    if (error) return reconciliationStoreError(error);
    const records = isPlainObject(data) && Array.isArray(data.records) ? data.records : [];
    return NextResponse.json({ records, provider_calls: 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return reconciliationStoreError(error);
  }
}

/**
 * Evidence-only transition. It cannot delete/reset a row and contains no code
 * path that retries an upstream provider. A stale updated_at is rejected so an
 * operator cannot overwrite newer reconciliation evidence.
 */
export async function POST(request: NextRequest) {
  const guard = await requireReconciliationAccess(request, "wallet.adjust", true);
  if ("response" in guard) return guard.response;

  let body: JsonObject;
  try {
    const parsed = await request.json();
    if (!isPlainObject(parsed)) throw new Error("invalid");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }

  const recordId = String(body.record_id || "").trim().toLowerCase();
  const expectedUpdatedAt = String(body.expected_updated_at || "").trim();
  const targetState = String(body.target_state || "").trim().toLowerCase();
  const reason = String(body.reason || "").trim();
  const providerTaskId = String(body.provider_task_id || "").trim().slice(0, 240);
  const httpStatus = body.http_status == null ? null : Number(body.http_status);
  const response = body.response ?? null;
  const providerEvidence = sanitizeEvidence(body.provider_evidence, PROVIDER_EVIDENCE_KEYS);
  const billingEvidence = sanitizeEvidence(body.billing_evidence, BILLING_EVIDENCE_KEYS);

  if (!RECORD_ID_PATTERN.test(recordId)
    || Number.isNaN(Date.parse(expectedUpdatedAt))
    || !["succeeded", "failed", "failed_unknown"].includes(targetState)
    || reason.length < 8
    || reason.length > 500
    || Object.keys(providerEvidence).length === 0
    || Object.keys(billingEvidence).length === 0
    || (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) {
    return NextResponse.json({ error: "记录、状态、理由或对账证据不完整" }, { status: 400 });
  }

  let responseFingerprint: string | null = null;
  if (targetState === "succeeded" || targetState === "failed") {
    if (response === null) return NextResponse.json({ error: "终态必须提供可回放响应" }, { status: 400 });
    const serialized = JSON.stringify(response);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) {
      return NextResponse.json({ error: "对账响应超过安全持久化上限" }, { status: 413 });
    }
    responseFingerprint = createHash("sha256").update(serialized).digest("hex");
  } else if (response !== null) {
    return NextResponse.json({ error: "failed_unknown 不得附带可交付响应" }, { status: 400 });
  }

  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc("reconcile_extraction_attempt_atomic", {
      p_record_id: recordId,
      p_expected_updated_at: expectedUpdatedAt,
      p_actor_user_id: guard.actor.userId,
      p_target_state: targetState,
      p_http_status: httpStatus,
      p_response: response,
      p_response_fingerprint: responseFingerprint,
      p_provider_task_id: providerTaskId || null,
      p_provider_evidence: providerEvidence,
      p_billing_evidence: billingEvidence,
      p_error_code: typeof body.error_code === "string" ? body.error_code.trim().slice(0, 120) : null,
      p_error_message: typeof body.error_message === "string" ? body.error_message.trim().slice(0, 500) : null,
      p_reason: reason,
    });
    if (error) return reconciliationStoreError(error);
    const record = isPlainObject(data) && isPlainObject(data.record) ? data.record : null;
    if (!record) return reconciliationStoreError(new Error("invalid reconciliation response"));
    return NextResponse.json(
      { success: true, record, provider_calls: 0, audit_written: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return reconciliationStoreError(error);
  }
}
