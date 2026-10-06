import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { refundPayment } from "@/lib/xunhupay";
import {
  claimPaymentRefund,
  finalizePaymentRefund,
  markPaymentRefundProviderStarted,
  paymentRefundFingerprint,
  PaymentRefundLifecycleError,
  validatePaymentRefundInput,
  type PaymentRefundAttempt,
} from "@/lib/payment-refund-lifecycle";

const MAX_REFUND_REQUEST_BYTES = 16 * 1024;

async function readBoundedText(request: NextRequest, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new PaymentRefundLifecycleError(
          "PAYMENT_REFUND_REQUEST_TOO_LARGE",
          "退款请求体过大",
          413,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function lifecycleErrorResponse(error: PaymentRefundLifecycleError) {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: error.status, headers: { "Cache-Control": "no-store" } },
  );
}

function reconciliationResponse(attempt: PaymentRefundAttempt, message: string) {
  return NextResponse.json(
    {
      success: false,
      pending: true,
      retryable: false,
      code: "PAYMENT_REFUND_RECONCILIATION_REQUIRED",
      error: message,
      attemptId: attempt.attemptId,
    },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

function strictProviderAmount(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

async function appendRefundOutcomeAudit(params: {
  request: NextRequest;
  actorId: string;
  actorLevel: string | null;
  requestKey: string;
  requestFingerprint: string;
  result: "success" | "failure";
  reasonCode: string;
  attemptId?: string | null;
  lifecycleState: string;
  providerCallStarted: boolean;
}) {
  await appendAdminGovernanceAudit({
    actorId: params.actorId,
    actorLevel: params.actorLevel,
    permissionKey: "wallet.adjust",
    action: "payment_refund_result",
    result: params.result,
    reasonCode: params.reasonCode,
    resource: "payment_refund",
    request: params.request,
    requestKey: params.requestKey,
    metadata: {
      requestFingerprint: params.requestFingerprint,
      attemptId: params.attemptId || null,
      lifecycleState: params.lifecycleState,
      providerCallStarted: params.providerCallStarted,
    },
  });
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "wallet.adjust", {
    requireStepUp: true,
    operation: "payment_refund_authorize",
    auditAllowed: true,
  });
  if (!authorization.ok) {
    authorization.response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return authorization.response;
  }

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_REFUND_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "退款请求体过大", code: "PAYMENT_REFUND_REQUEST_TOO_LARGE" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  let body: { tradeOrderId?: unknown; reason?: unknown };
  try {
    const raw = await readBoundedText(request, MAX_REFUND_REQUEST_BYTES);
    body = JSON.parse(raw) as { tradeOrderId?: unknown; reason?: unknown };
  } catch (error) {
    if (error instanceof PaymentRefundLifecycleError) return lifecycleErrorResponse(error);
    return NextResponse.json(
      { error: "退款请求格式无效", code: "PAYMENT_REFUND_REQUEST_INVALID" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  let validated: ReturnType<typeof validatePaymentRefundInput>;
  try {
    validated = validatePaymentRefundInput({
      tradeOrderId: typeof body.tradeOrderId === "string" ? body.tradeOrderId : "",
      reason: typeof body.reason === "string" ? body.reason : "管理员退款",
      idempotencyKey,
    });
  } catch (error) {
    return error instanceof PaymentRefundLifecycleError
      ? lifecycleErrorResponse(error)
      : lifecycleErrorResponse(new PaymentRefundLifecycleError("PAYMENT_REFUND_REQUEST_INVALID", "退款请求无效", 400));
  }

  const requestFingerprint = paymentRefundFingerprint(validated);
  const intentRecorded = await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "wallet.adjust",
    action: "payment_refund_intent",
    result: "allowed",
    reasonCode: "REFUND_INTENT_RECORDED",
    resource: "payment_refund",
    request,
    requestKey: idempotencyKey,
    metadata: {
      requestFingerprint,
      reasonLength: validated.reason.length,
    },
  });
  if (!intentRecorded) {
    return NextResponse.json(
      { error: "退款审计服务暂不可用，本次未冻结余额也未调用供应商", code: "PAYMENT_REFUND_AUDIT_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const auditOutcome = (params: {
    result: "success" | "failure";
    reasonCode: string;
    attemptId?: string | null;
    lifecycleState: string;
    providerCallStarted: boolean;
  }) => appendRefundOutcomeAudit({
    request,
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    requestKey: idempotencyKey,
    requestFingerprint,
    ...params,
  });

  let claim;
  try {
    claim = await claimPaymentRefund({
      adminUserId: authorization.actor.userId,
      ...validated,
      leaseOwner: randomUUID(),
    });
  } catch (error) {
    return error instanceof PaymentRefundLifecycleError
      ? lifecycleErrorResponse(error)
      : lifecycleErrorResponse(new PaymentRefundLifecycleError("PAYMENT_REFUND_STORE_UNAVAILABLE", "原子退款服务暂不可用", 503));
  }

  if (claim.action === "replay") {
    await auditOutcome({ result: "success", reasonCode: "REFUND_REPLAYED", attemptId: claim.record.attemptId, lifecycleState: claim.record.state, providerCallStarted: false });
    return NextResponse.json(
      { success: true, alreadyRefunded: true, attemptId: claim.record.attemptId },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (claim.action === "released") {
    await auditOutcome({ result: "failure", reasonCode: "REFUND_PREVIOUSLY_RELEASED", attemptId: claim.record.attemptId, lifecycleState: claim.record.state, providerCallStarted: false });
    return NextResponse.json(
      { success: false, retryable: false, code: "PAYMENT_REFUND_PREVIOUSLY_RELEASED", error: "上一次退款已明确失败并退回冻结余额；如需重试，请创建新的退款请求" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (claim.action === "in_progress") {
    await auditOutcome({ result: "failure", reasonCode: "REFUND_IN_PROGRESS", attemptId: claim.record.attemptId, lifecycleState: claim.record.state, providerCallStarted: false });
    return NextResponse.json(
      { success: false, retryable: false, code: "PAYMENT_REFUND_IN_PROGRESS", error: "该退款请求正在处理，本次没有重复调用供应商" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (claim.action === "reconciliation_required") {
    await auditOutcome({ result: "failure", reasonCode: "REFUND_RECONCILIATION_REQUIRED", attemptId: claim.record.attemptId, lifecycleState: claim.record.state, providerCallStarted: false });
    return reconciliationResponse(claim.record, "退款结果尚未核实，本次没有重复调用供应商");
  }

  let started;
  try {
    started = await markPaymentRefundProviderStarted({ record: claim.record, requestFingerprint });
  } catch (error) {
    return error instanceof PaymentRefundLifecycleError
      ? lifecycleErrorResponse(error)
      : lifecycleErrorResponse(new PaymentRefundLifecycleError("PAYMENT_REFUND_STORE_UNAVAILABLE", "退款调用占位未能确认，未调用供应商", 503));
  }
  if (started.action !== "execute") {
    await auditOutcome({ result: "failure", reasonCode: "REFUND_PROVIDER_START_UNCONFIRMED", attemptId: started.record.attemptId, lifecycleState: started.record.state, providerCallStarted: false });
    return reconciliationResponse(started.record, "退款调用状态需要核查，本次没有调用供应商");
  }

  let providerResult;
  try {
    providerResult = await refundPayment({
      tradeOrderId: started.record.tradeOrderId,
      reason: validated.reason,
    });
  } catch {
    try {
      const reconciled = await finalizePaymentRefund({
        record: started.record,
        requestFingerprint,
        terminalState: "reconciliation_required",
        providerStatus: "UNKNOWN",
        providerResponse: { outcome: "transport_or_provider_result_unknown" },
      });
      await auditOutcome({ result: "failure", reasonCode: "REFUND_PROVIDER_RESULT_UNKNOWN", attemptId: reconciled.record.attemptId, lifecycleState: reconciled.record.state, providerCallStarted: true });
      return reconciliationResponse(reconciled.record, "退款供应商结果暂未确认，请在后台核对原退款请求；不要重新提交");
    } catch {
      await auditOutcome({ result: "failure", reasonCode: "REFUND_RESULT_PERSISTENCE_UNKNOWN", attemptId: started.record.attemptId, lifecycleState: "reconciliation_required", providerCallStarted: true });
      return reconciliationResponse(started.record, "退款请求可能已到达供应商，但本地核对状态保存失败；不要重新提交");
    }
  }

  const providerStatus = providerResult.refundStatus.toUpperCase();
  const providerAmount = strictProviderAmount(providerResult.refundFee);
  const safeProviderResponse = {
    refundStatus: providerStatus,
    hasProviderRefundId: Boolean(providerResult.outRefundNo),
    hasProviderTransactionId: Boolean(providerResult.transactionId),
    refundTime: providerResult.refundTime || null,
  };

  if (providerStatus === "UD") {
    try {
      const released = await finalizePaymentRefund({
        record: started.record,
        requestFingerprint,
        terminalState: "released",
        providerStatus,
        providerResponse: safeProviderResponse,
      });
      await auditOutcome({ result: "failure", reasonCode: "REFUND_PROVIDER_REJECTED", attemptId: released.record.attemptId, lifecycleState: released.record.state, providerCallStarted: true });
      return NextResponse.json(
        { success: false, retryable: false, code: "PAYMENT_REFUND_PROVIDER_REJECTED", error: "退款供应商已明确拒绝，本站冻结余额已原路释放", attemptId: released.record.attemptId },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      await auditOutcome({ result: "failure", reasonCode: "REFUND_RELEASE_UNCONFIRMED", attemptId: started.record.attemptId, lifecycleState: "reconciliation_required", providerCallStarted: true });
      return error instanceof PaymentRefundLifecycleError
        ? lifecycleErrorResponse(error)
        : reconciliationResponse(started.record, "退款失败后的余额释放状态未确认，请核对账务");
    }
  }

  const evidenceComplete = providerStatus === "CD"
    && providerResult.tradeOrderId === started.record.tradeOrderId
    && Boolean(providerResult.outRefundNo)
    && providerAmount === started.record.paidAmount;
  if (evidenceComplete) {
    try {
      const completed = await finalizePaymentRefund({
        record: started.record,
        requestFingerprint,
        terminalState: "completed",
        providerStatus,
        providerTradeOrderId: providerResult.tradeOrderId,
        providerRefundId: providerResult.outRefundNo,
        providerRefundAmount: providerAmount,
        providerResponse: safeProviderResponse,
      });
      await auditOutcome({ result: "success", reasonCode: "REFUND_COMPLETED", attemptId: completed.record.attemptId, lifecycleState: completed.record.state, providerCallStarted: true });
      return NextResponse.json(
        { success: true, alreadyRefunded: false, attemptId: completed.record.attemptId, refundId: completed.record.providerRefundId },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      await auditOutcome({ result: "failure", reasonCode: "REFUND_COMPLETION_UNCONFIRMED", attemptId: started.record.attemptId, lifecycleState: "reconciliation_required", providerCallStarted: true });
      return reconciliationResponse(started.record, "供应商已返回退款成功，但本站原子结算尚未确认；请核对账务，不要重新提交");
    }
  }

  try {
    const reconciled = await finalizePaymentRefund({
      record: started.record,
      requestFingerprint,
      terminalState: "reconciliation_required",
      providerStatus,
      providerTradeOrderId: providerResult.tradeOrderId,
      providerRefundId: providerResult.outRefundNo,
      providerRefundAmount: providerAmount,
      providerResponse: safeProviderResponse,
    });
    await auditOutcome({ result: "failure", reasonCode: "REFUND_PROVIDER_EVIDENCE_INCOMPLETE", attemptId: reconciled.record.attemptId, lifecycleState: reconciled.record.state, providerCallStarted: true });
    return reconciliationResponse(reconciled.record, providerStatus === "RD"
      ? "退款供应商正在处理，余额保持冻结，完成核对前请勿重复提交"
      : "退款供应商返回的证据不完整，余额保持冻结，请进行账务核对");
  } catch {
    await auditOutcome({ result: "failure", reasonCode: "REFUND_RECONCILIATION_PERSISTENCE_FAILED", attemptId: started.record.attemptId, lifecycleState: "reconciliation_required", providerCallStarted: true });
    return reconciliationResponse(started.record, "退款供应商结果需要核对，但本地状态保存失败；不要重新提交");
  }
}
