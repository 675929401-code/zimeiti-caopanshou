import { NextRequest, NextResponse } from "next/server";
import {
  parsePaymentRefundReconciliationRequest,
  paymentRefundReconciliationActionId,
  PaymentRefundReconciliationValidationError,
} from "@/lib/payment-refund-reconciliation-contract";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RECONCILIATION_BODY_BYTES = 32 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000;
const BASE_ATTEMPT_COLUMNS = [
  "attempt_id", "trade_order_id", "user_id", "admin_user_id", "state",
  "order_type", "payment_provider", "paid_amount", "wallet_amount",
  "provider_refund_id", "provider_trade_order_id", "provider_refund_amount",
  "provider_status", "provider_call_started_at", "created_at", "updated_at",
  "completed_at", "released_at",
].join(",");
const EXTENDED_ATTEMPT_COLUMNS = `${BASE_ATTEMPT_COLUMNS},last_reconciliation_action_id,last_reconciled_by,last_reconciled_at`;
const ACTION_COLUMNS = [
  "action_id", "attempt_id", "actor_id", "action", "previous_state",
  "resulting_state", "evidence", "evidence_digest", "note",
  "wallet_mutation", "wallet_operation_id", "created_at", "completed_at",
].join(",");

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function strictBoundedInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value == null || value === "") return fallback;
  if (!/^\d{1,8}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function migrationMissing(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message || "");
  return /payment_refund_reconciliation_actions|last_reconciliation|resolve_payment_refund_reconciliation_atomic|schema cache|could not find|does not exist/iu.test(message);
}

async function readBoundedJson(request: NextRequest): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new PaymentRefundReconciliationValidationError(
        "PAYMENT_REFUND_RECONCILIATION_CONTENT_LENGTH_INVALID",
        "人工退款核对请求长度无效",
        400,
      );
    }
    if (length > MAX_RECONCILIATION_BODY_BYTES) {
      throw new PaymentRefundReconciliationValidationError(
        "PAYMENT_REFUND_RECONCILIATION_REQUEST_TOO_LARGE",
        "人工退款核对请求体过大",
        413,
      );
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RECONCILIATION_BODY_BYTES) {
        await reader.cancel();
        throw new PaymentRefundReconciliationValidationError(
          "PAYMENT_REFUND_RECONCILIATION_REQUEST_TOO_LARGE",
          "人工退款核对请求体过大",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_REQUEST_INVALID",
      "人工退款核对请求格式无效",
      400,
    );
  }
}

function validationResponse(error: PaymentRefundReconciliationValidationError): NextResponse {
  return noStore(NextResponse.json({ error: error.message, code: error.code }, { status: error.status }));
}

function reconciliationStoreError(error: unknown): PaymentRefundReconciliationValidationError {
  const message = String((error as { message?: unknown } | null)?.message || "");
  if (migrationMissing(error)) {
    return new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_MIGRATION_NOT_READY",
      "人工退款核对迁移尚未部署，余额继续冻结，本次未改账",
      503,
    );
  }
  if (/ATTEMPT_NOT_FOUND/iu.test(message)) {
    return new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_ATTEMPT_NOT_FOUND",
      "待核对退款记录不存在",
      404,
    );
  }
  if (/IDEMPOTENCY_CONFLICT|STATE_CONFLICT/iu.test(message)) {
    return new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_CONFLICT",
      "该退款核对请求与现有终态或幂等记录冲突，余额未变更",
      409,
    );
  }
  if (/EVIDENCE|AMOUNT_MISMATCH|ORDER_STATUS_CONFLICT/iu.test(message)) {
    return new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_EVIDENCE_REJECTED",
      "退款证据未通过原子校验，余额继续冻结",
      422,
    );
  }
  return new PaymentRefundReconciliationValidationError(
    "PAYMENT_REFUND_RECONCILIATION_STORE_UNAVAILABLE",
    "人工退款核对服务暂不可用，余额继续冻结",
    503,
  );
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "billing.view", {
    operation: "payment_refund_reconciliation_view",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const page = strictBoundedInteger(request.nextUrl.searchParams.get("page"), 1, 1, MAX_PAGE);
  const pageSize = strictBoundedInteger(request.nextUrl.searchParams.get("pageSize"), 20, 1, MAX_PAGE_SIZE);
  const attemptId = request.nextUrl.searchParams.get("attemptId")?.trim() || "";
  if (page === null || pageSize === null || (attemptId && !/^[a-f0-9]{64}$/u.test(attemptId))) {
    return noStore(NextResponse.json(
      { error: "退款核对查询参数无效", code: "PAYMENT_REFUND_RECONCILIATION_QUERY_INVALID" },
      { status: 400 },
    ));
  }

  try {
    const database = getSupabaseAdminClient();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const buildQuery = (columns: string) => {
      let query = database
        .from("payment_refund_attempts")
        .select(columns, { count: "exact" })
        .eq("state", "reconciliation_required")
        .order("updated_at", { ascending: false })
        .range(from, to);
      if (attemptId) query = query.eq("attempt_id", attemptId);
      return query;
    };

    let attemptResult = await buildQuery(EXTENDED_ATTEMPT_COLUMNS);
    let manualResolutionReady = true;
    if (attemptResult.error && migrationMissing(attemptResult.error)) {
      manualResolutionReady = false;
      attemptResult = await buildQuery(BASE_ATTEMPT_COLUMNS);
    }
    if (attemptResult.error) throw attemptResult.error;
    const attempts = (attemptResult.data || []) as Array<Record<string, unknown>>;
    const attemptIds = attempts.map((row) => String(row.attempt_id || "")).filter(Boolean);
    let actions: Array<Record<string, unknown>> = [];
    if (attemptIds.length && manualResolutionReady) {
      const actionResult = await database
        .from("payment_refund_reconciliation_actions")
        .select(ACTION_COLUMNS)
        .in("attempt_id", attemptIds)
        .order("created_at", { ascending: false })
        .limit(Math.min(attemptIds.length * 5, 500));
      if (actionResult.error && migrationMissing(actionResult.error)) {
        manualResolutionReady = false;
      } else if (actionResult.error) {
        throw actionResult.error;
      } else {
        actions = (actionResult.data || []) as Array<Record<string, unknown>>;
      }
    }

    const actionsByAttempt = new Map<string, Array<Record<string, unknown>>>();
    for (const action of actions) {
      const key = String(action.attempt_id || "");
      const current = actionsByAttempt.get(key) || [];
      current.push(action);
      actionsByAttempt.set(key, current);
    }

    return noStore(NextResponse.json({
      success: true,
      page,
      pageSize,
      total: attemptResult.count || 0,
      manualResolutionReady,
      policy: {
        automaticRelease: false,
        automaticCompletion: false,
        terminalEvidenceRequired: true,
        allowedActions: ["confirm_completed", "confirm_rejected", "keep_frozen"],
      },
      attempts: attempts.map((attempt) => ({
        ...attempt,
        actions: actionsByAttempt.get(String(attempt.attempt_id || "")) || [],
      })),
      ...(!manualResolutionReady ? {
        blocker: {
          code: "PAYMENT_REFUND_RECONCILIATION_MIGRATION_NOT_READY",
          message: "当前只能查询冻结中的退款；人工确认/拒绝迁移尚未部署，不能改账。",
        },
      } : {}),
    }));
  } catch (error) {
    console.error("[payment-refund-reconciliation] query failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
    return noStore(NextResponse.json(
      { error: "读取待核对退款失败", code: "PAYMENT_REFUND_RECONCILIATION_READ_FAILED" },
      { status: 503 },
    ));
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "wallet.adjust", {
    requireStepUp: true,
    operation: "payment_refund_reconciliation_resolve",
    auditAllowed: true,
  });
  if (!authorization.ok) return noStore(authorization.response);

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  let parsed;
  try {
    parsed = parsePaymentRefundReconciliationRequest(await readBoundedJson(request), idempotencyKey);
  } catch (error) {
    return error instanceof PaymentRefundReconciliationValidationError
      ? validationResponse(error)
      : validationResponse(new PaymentRefundReconciliationValidationError(
        "PAYMENT_REFUND_RECONCILIATION_REQUEST_INVALID",
        "人工退款核对请求无效",
        400,
      ));
  }

  const actionId = paymentRefundReconciliationActionId(authorization.actor.userId, parsed.idempotencyKey);
  const audit = (result: "allowed" | "success" | "failure", reasonCode: string, metadata: Record<string, unknown> = {}) => (
    appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "wallet.adjust",
      action: result === "allowed" ? "payment_refund_reconciliation_intent" : "payment_refund_reconciliation_result",
      result,
      reasonCode,
      resource: "payment_refund_reconciliation",
      request,
      requestKey: parsed.idempotencyKey,
      metadata: {
        actionId,
        attemptId: parsed.attemptId,
        requestedAction: parsed.action,
        evidenceSource: parsed.evidence.source,
        evidenceDigest: parsed.evidenceDigest,
        requestFingerprint: parsed.requestFingerprint,
        ...metadata,
      },
    })
  );

  const intentRecorded = await audit("allowed", "PAYMENT_REFUND_RECONCILIATION_INTENT_RECORDED");
  if (!intentRecorded) {
    return noStore(NextResponse.json(
      {
        error: "人工退款核对审计暂不可用，余额继续冻结，本次未改账",
        code: "PAYMENT_REFUND_RECONCILIATION_AUDIT_UNAVAILABLE",
      },
      { status: 503 },
    ));
  }

  try {
    const { data, error } = await getSupabaseAdminClient().rpc("resolve_payment_refund_reconciliation_atomic", {
      p_action_id: actionId,
      p_attempt_id: parsed.attemptId,
      p_actor_id: authorization.actor.userId,
      p_idempotency_key: parsed.idempotencyKey,
      p_request_fingerprint: parsed.requestFingerprint,
      p_action: parsed.action,
      p_note: parsed.note,
      p_evidence: parsed.evidence,
    });
    if (error) throw error;
    const raw = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    const resolution = String(raw?.resolution || "");
    const record = raw?.record && typeof raw.record === "object" && !Array.isArray(raw.record)
      ? raw.record as Record<string, unknown>
      : null;
    const actionRecord = raw?.actionRecord && typeof raw.actionRecord === "object" && !Array.isArray(raw.actionRecord)
      ? raw.actionRecord as Record<string, unknown>
      : null;
    if (!record || !actionRecord || !["completed", "released", "frozen", "replayed"].includes(resolution)) {
      throw new Error("PAYMENT_REFUND_RECONCILIATION_RESULT_INVALID");
    }

    const resultAudited = await audit("success", `PAYMENT_REFUND_RECONCILIATION_${resolution.toUpperCase()}`, {
      resultingState: String(record.state || ""),
      replayed: resolution === "replayed",
      walletMutation: String(actionRecord.wallet_mutation || "none"),
    });
    return noStore(NextResponse.json({
      success: true,
      resolution,
      attempt: {
        attemptId: String(record.attempt_id || ""),
        tradeOrderId: String(record.trade_order_id || ""),
        state: String(record.state || ""),
        providerStatus: record.provider_status == null ? null : String(record.provider_status),
        providerRefundId: record.provider_refund_id == null ? null : String(record.provider_refund_id),
        providerRefundAmount: record.provider_refund_amount == null ? null : Number(record.provider_refund_amount),
        lastReconciledAt: record.last_reconciled_at == null ? null : String(record.last_reconciled_at),
      },
      actionReceipt: {
        actionId: String(actionRecord.action_id || actionId),
        evidenceDigest: String(actionRecord.evidence_digest || ""),
        walletMutation: String(actionRecord.wallet_mutation || "none"),
      },
      auditStatus: resultAudited ? "complete" : "authorized_intent_only",
      ...(!resultAudited ? {
        warning: "改账原子事务已完成，结果审计待运维核查；操作意图和数据库动作凭证已保留。",
      } : {}),
    }, { status: resultAudited ? 200 : 202 }));
  } catch (error) {
    const normalized = reconciliationStoreError(error);
    await audit("failure", normalized.code);
    console.error("[payment-refund-reconciliation] resolution failed", {
      code: normalized.code,
      actionId,
      attemptId: parsed.attemptId,
    });
    return validationResponse(normalized);
  }
}
