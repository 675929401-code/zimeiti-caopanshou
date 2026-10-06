import "server-only";

import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const STABLE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type PaymentRefundState =
  | "reserved"
  | "provider_started"
  | "reconciliation_required"
  | "completed"
  | "released";

export type PaymentRefundAttempt = {
  attemptId: string;
  tradeOrderId: string;
  userId: string;
  adminUserId: string;
  state: PaymentRefundState;
  orderType: "credits" | "cash";
  paymentProvider: "xunhupay";
  paidAmount: number;
  walletAmount: number;
  leaseOwner: string;
  leaseToken: number;
  providerRefundId: string | null;
  providerStatus: string | null;
};

export type PaymentRefundClaim = {
  action: "execute" | "in_progress" | "replay" | "reconciliation_required" | "released";
  record: PaymentRefundAttempt;
};

export class PaymentRefundLifecycleError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "PaymentRefundLifecycleError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function normalizePositiveAmount(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseAttempt(value: unknown): PaymentRefundAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_RECORD_INVALID", "退款状态记录无效，已停止继续操作", 503);
  }
  const row = value as Record<string, unknown>;
  const state = String(row.state || "") as PaymentRefundState;
  const attemptId = String(row.attempt_id || "");
  const tradeOrderId = normalizeText(row.trade_order_id, 240);
  const userId = normalizeText(row.user_id, 240);
  const adminUserId = normalizeText(row.admin_user_id, 240);
  const orderType = String(row.order_type || "");
  const paymentProvider = String(row.payment_provider || "").toLowerCase();
  const paidAmount = normalizePositiveAmount(row.paid_amount);
  const walletAmount = normalizePositiveAmount(row.wallet_amount);
  const leaseOwner = normalizeText(row.lease_owner, 240);
  const leaseToken = Number(row.lease_token);
  if (!SHA256_PATTERN.test(attemptId) || !tradeOrderId || !userId || !adminUserId
    || !["reserved", "provider_started", "reconciliation_required", "completed", "released"].includes(state)
    || (orderType !== "credits" && orderType !== "cash") || paymentProvider !== "xunhupay"
    || paidAmount === null || walletAmount === null || !leaseOwner
    || !Number.isSafeInteger(leaseToken) || leaseToken < 1) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_RECORD_INVALID", "退款状态记录无效，已停止继续操作", 503);
  }
  return {
    attemptId,
    tradeOrderId,
    userId,
    adminUserId,
    state,
    orderType,
    paymentProvider: "xunhupay",
    paidAmount,
    walletAmount,
    leaseOwner,
    leaseToken,
    providerRefundId: normalizeText(row.provider_refund_id, 240),
    providerStatus: normalizeText(row.provider_status, 64),
  };
}

function normalizeRpcError(error: unknown): never {
  if (error instanceof PaymentRefundLifecycleError) throw error;
  const message = String((error as { message?: unknown } | null)?.message || "");
  if (/payment_refund_attempts|claim_payment_refund_attempt_atomic|mark_payment_refund_provider_started_atomic|finalize_payment_refund_attempt_atomic|schema cache|could not find|does not exist/iu.test(message)) {
    throw new PaymentRefundLifecycleError(
      "PAYMENT_REFUND_MIGRATION_NOT_READY",
      "原子退款迁移尚未部署，已停止调用退款供应商",
      503,
    );
  }
  if (/PAYMENT_REFUND_ORDER_NOT_FOUND/iu.test(message)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_ORDER_NOT_FOUND", "支付订单不存在", 404);
  }
  if (/PAYMENT_REFUND_PROVIDER_UNSUPPORTED/iu.test(message)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_PROVIDER_UNSUPPORTED", "该支付渠道尚未配置自动退款", 422);
  }
  if (/PAYMENT_REFUND_BALANCE_INSUFFICIENT|INSUFFICIENT_(?:CREDITS|CASH)/iu.test(message)) {
    throw new PaymentRefundLifecycleError(
      "PAYMENT_REFUND_BALANCE_INSUFFICIENT",
      "用户可用余额不足，暂不能自动冲正这笔充值；请先完成账务核对",
      409,
    );
  }
  if (/PAYMENT_REFUND_(?:IDEMPOTENCY|ALREADY_ACTIVE|LEASE|STATE|ORDER_STATUS|EVIDENCE|RESULT|AMOUNT)/iu.test(message)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_CONFLICT", "退款请求与已有状态冲突，未再次调用供应商", 409);
  }
  throw new PaymentRefundLifecycleError("PAYMENT_REFUND_STORE_UNAVAILABLE", "原子退款服务暂时不可用，未调用退款供应商", 503);
}

function parseRpcResult(value: unknown): PaymentRefundClaim {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_RESULT_INVALID", "退款状态返回无效", 503);
  }
  const result = raw as { action?: unknown; record?: unknown };
  const action = String(result.action || "") as PaymentRefundClaim["action"];
  if (!["execute", "in_progress", "replay", "reconciliation_required", "released"].includes(action)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_RESULT_INVALID", "退款状态返回无效", 503);
  }
  return { action, record: parseAttempt(result.record) };
}

export function paymentRefundFingerprint(input: { tradeOrderId: string; reason: string }) {
  return sha256(JSON.stringify({ tradeOrderId: input.tradeOrderId, reason: input.reason }));
}

export function paymentRefundAttemptId(adminUserId: string, idempotencyKey: string) {
  return sha256(`${adminUserId}\u0000${idempotencyKey}`);
}

export function validatePaymentRefundInput(input: {
  tradeOrderId: string;
  reason: string;
  idempotencyKey: string;
}) {
  const tradeOrderId = normalizeText(input.tradeOrderId, 240);
  const reason = String(input.reason || "管理员退款").trim();
  if (!tradeOrderId) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_ORDER_ID_INVALID", "缺少有效的支付订单号", 400);
  }
  if (!reason || reason.length > 80 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_REASON_INVALID", "退款原因格式无效", 400);
  }
  if (!STABLE_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new PaymentRefundLifecycleError("PAYMENT_REFUND_IDEMPOTENCY_KEY_REQUIRED", "退款请求缺少稳定的幂等标识", 400);
  }
  return { tradeOrderId, reason, idempotencyKey: input.idempotencyKey };
}

export async function claimPaymentRefund(input: {
  adminUserId: string;
  tradeOrderId: string;
  reason: string;
  idempotencyKey: string;
  leaseOwner: string;
}): Promise<PaymentRefundClaim> {
  const validated = validatePaymentRefundInput(input);
  const attemptId = paymentRefundAttemptId(input.adminUserId, validated.idempotencyKey);
  const requestFingerprint = paymentRefundFingerprint(validated);
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("claim_payment_refund_attempt_atomic", {
      p_attempt_id: attemptId,
      p_trade_order_id: validated.tradeOrderId,
      p_admin_user_id: input.adminUserId,
      p_idempotency_key: validated.idempotencyKey,
      p_request_fingerprint: requestFingerprint,
      p_reason: validated.reason,
      p_lease_owner: input.leaseOwner,
      p_lease_seconds: 300,
    });
    if (error) normalizeRpcError(error);
    return parseRpcResult(data);
  } catch (error) {
    normalizeRpcError(error);
  }
}

export async function markPaymentRefundProviderStarted(input: {
  record: PaymentRefundAttempt;
  requestFingerprint: string;
}): Promise<PaymentRefundClaim> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("mark_payment_refund_provider_started_atomic", {
      p_attempt_id: input.record.attemptId,
      p_request_fingerprint: input.requestFingerprint,
      p_lease_owner: input.record.leaseOwner,
      p_lease_token: input.record.leaseToken,
    });
    if (error) normalizeRpcError(error);
    return parseRpcResult(data);
  } catch (error) {
    normalizeRpcError(error);
  }
}

export async function finalizePaymentRefund(input: {
  record: PaymentRefundAttempt;
  requestFingerprint: string;
  terminalState: "completed" | "released" | "reconciliation_required";
  providerStatus: string;
  providerTradeOrderId?: string | null;
  providerRefundId?: string | null;
  providerRefundAmount?: number | null;
  providerResponse?: Record<string, unknown>;
}): Promise<PaymentRefundClaim> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("finalize_payment_refund_attempt_atomic", {
      p_attempt_id: input.record.attemptId,
      p_request_fingerprint: input.requestFingerprint,
      p_lease_owner: input.record.leaseOwner,
      p_lease_token: input.record.leaseToken,
      p_terminal_state: input.terminalState,
      p_provider_status: input.providerStatus,
      p_provider_trade_order_id: input.providerTradeOrderId || null,
      p_provider_refund_id: input.providerRefundId || null,
      p_provider_refund_amount: input.providerRefundAmount ?? null,
      p_provider_response: input.providerResponse || {},
    });
    if (error) normalizeRpcError(error);
    return parseRpcResult(data);
  } catch (error) {
    normalizeRpcError(error);
  }
}
