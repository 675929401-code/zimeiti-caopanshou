import "server-only";

import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import type {
  PaymentCreationClaim,
  PaymentCreationProviderResult,
  PaymentCreationRecord,
  PaymentCreationState,
} from "@/lib/payment-order-creation-machine";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export class PaymentOrderCreationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "PaymentOrderCreationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) return null;
  return normalized;
}

function normalizeMoney(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 50_000) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) <= 1e-8 ? cents / 100 : null;
}

function normalizeProviderUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 8192 || CONTROL_CHARACTER_PATTERN.test(raw)) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RECORD_INVALID", "支付订单恢复记录无效", 503);
  }
  try {
    const parsed = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:"
      && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && loopback)) {
      throw new Error("unsafe protocol");
    }
    return raw;
  } catch {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RECORD_INVALID", "支付订单恢复记录无效", 503);
  }
}

function normalizeProviderResult(
  value: unknown,
  provider: "xunhupay" | "epay",
): PaymentCreationProviderResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const paymentUrl = normalizeProviderUrl(raw.paymentUrl ?? raw.payment_url);
  const qrcodeUrl = normalizeProviderUrl(raw.qrcodeUrl ?? raw.qrcode_url);
  const platformOrderId = normalizeText(raw.platformOrderId ?? raw.platform_order_id, 240);
  if (!paymentUrl && !qrcodeUrl) return null;
  if (provider === "xunhupay" && !platformOrderId) return null;
  return { paymentUrl, qrcodeUrl, platformOrderId };
}

function parseRecord(value: unknown): PaymentCreationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RECORD_INVALID", "支付订单状态返回无效", 503);
  }
  const row = value as Record<string, unknown>;
  const tradeOrderId = normalizeText(row.trade_order_id, 240);
  const userId = normalizeText(row.user_id, 240);
  const idempotencyKey = normalizeText(row.client_idempotency_key, 128);
  const requestFingerprint = String(row.request_fingerprint ?? "").trim().toLowerCase();
  const state = String(row.creation_state ?? "") as PaymentCreationState;
  const type = String(row.type ?? "");
  const amount = normalizeMoney(row.amount);
  const creditsAmountValue = row.credits_amount == null ? null : Number(row.credits_amount);
  const creditsAmount = creditsAmountValue == null
    ? null
    : Number.isSafeInteger(creditsAmountValue) && creditsAmountValue > 0
      ? creditsAmountValue
      : Number.NaN;
  const paymentMethod = normalizeText(row.payment_method, 64);
  const paymentProvider = String(row.payment_provider ?? "").trim().toLowerCase();
  const leaseOwner = normalizeText(row.creation_lease_owner, 240);
  const leaseToken = Number(row.creation_lease_token ?? 0);

  if (!tradeOrderId || !userId || !idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    || !SHA256_PATTERN.test(requestFingerprint)
    || !["reserved", "provider_started", "reconciliation_required", "ready"].includes(state)
    || (type !== "credits" && type !== "cash") || amount === null || !paymentMethod
    || (paymentProvider !== "xunhupay" && paymentProvider !== "epay")
    || !Number.isSafeInteger(leaseToken) || leaseToken < 0
    || (type === "credits" ? creditsAmount === null || Number.isNaN(creditsAmount) : creditsAmount !== null)) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RECORD_INVALID", "支付订单状态返回无效", 503);
  }

  const providerResult = normalizeProviderResult(row.provider_creation_snapshot, paymentProvider)
    || normalizeProviderResult({
      payment_url: row.payment_url,
      qrcode_url: row.provider_qrcode_url,
      platform_order_id: row.platform_order_id,
    }, paymentProvider);
  if (state === "ready" && !providerResult) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RECORD_INVALID", "支付订单缺少渠道支付地址", 503);
  }

  return {
    tradeOrderId,
    userId,
    idempotencyKey,
    requestFingerprint,
    state,
    type,
    amount,
    creditsAmount,
    paymentMethod,
    paymentProvider,
    leaseOwner,
    leaseToken,
    providerResult,
  };
}

function parseRpcResult(value: unknown): PaymentCreationClaim {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RESULT_INVALID", "支付订单状态返回无效", 503);
  }
  const result = raw as { action?: unknown; record?: unknown };
  const action = String(result.action ?? "") as PaymentCreationClaim["action"];
  if (!["execute", "recover", "in_progress", "replay", "reconciliation_required"].includes(action)) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RESULT_INVALID", "支付订单状态返回无效", 503);
  }
  const record = parseRecord(result.record);
  if ((action === "execute" || action === "recover") && (!record.leaseOwner || record.leaseToken < 1)) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RESULT_INVALID", "支付订单执行租约无效", 503);
  }
  if (action === "recover" && !record.providerResult) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RESULT_INVALID", "支付订单恢复凭据无效", 503);
  }
  const actionStateValid = (action === "execute" && ["reserved", "provider_started"].includes(record.state))
    || (action === "recover" && record.state === "reconciliation_required")
    || (action === "in_progress" && record.state === "reserved")
    || (action === "replay" && record.state === "ready")
    || (action === "reconciliation_required"
      && ["provider_started", "reconciliation_required"].includes(record.state));
  if (!actionStateValid) {
    throw new PaymentOrderCreationError("PAYMENT_CREATE_RESULT_INVALID", "支付订单状态与动作不匹配", 503);
  }
  return { action, record };
}

function normalizeRpcError(error: unknown): never {
  if (error instanceof PaymentOrderCreationError) throw error;
  const record = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const diagnostic = [record.code, record.message, record.details, record.hint]
    .map((value) => String(value ?? ""))
    .join(" ");
  if (/PAYMENT_CREATE_IDEMPOTENCY_CONFLICT/iu.test(diagnostic)) {
    throw new PaymentOrderCreationError(
      "PAYMENT_CREATE_IDEMPOTENCY_CONFLICT",
      "该幂等标识已绑定另一组充值参数，请重新发起",
      409,
    );
  }
  if (/claim_payment_order_creation_atomic|mark_payment_order_creation_provider_started_atomic|finalize_payment_order_creation_atomic|mark_payment_order_creation_reconciliation_atomic|client_idempotency_key|creation_state|provider_creation_snapshot|PGRST20[245]|42P01|42703|42883|schema cache|could not find|does not exist/iu.test(diagnostic)) {
    throw new PaymentOrderCreationError(
      "PAYMENT_CREATE_MIGRATION_NOT_READY",
      "支付订单幂等服务尚未启用，本次未调用支付渠道",
      503,
    );
  }
  if (/PAYMENT_CREATE_(?:LEASE|STATE|RESULT|ORDER|REQUEST|PROVIDER|METHOD|AMOUNT|CREDITS|EXPIRE|TRADE)/iu.test(diagnostic)) {
    throw new PaymentOrderCreationError(
      "PAYMENT_CREATE_STATE_CONFLICT",
      "支付订单状态冲突，已停止重复创建",
      409,
    );
  }
  throw new PaymentOrderCreationError(
    "PAYMENT_CREATE_STORE_UNAVAILABLE",
    "支付订单服务暂时不可用，本次未调用支付渠道",
    503,
  );
}

async function callRpc(name: string, params: Record<string, unknown>): Promise<PaymentCreationClaim> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc(name, params);
    if (error) normalizeRpcError(error);
    return parseRpcResult(data);
  } catch (error) {
    normalizeRpcError(error);
  }
}

export function validatePaymentCreationIdempotencyKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new PaymentOrderCreationError(
      "PAYMENT_CREATE_IDEMPOTENCY_KEY_REQUIRED",
      "缺少有效的 Idempotency-Key",
      400,
    );
  }
  return key;
}

export function paymentCreationTradeOrderId(input: {
  userId: string;
  idempotencyKey: string;
  type: "credits" | "cash";
}): string {
  const suffix = sha256(`${input.userId}\u0000${input.idempotencyKey}`).slice(0, 32).toUpperCase();
  return `PAY_${input.type}_${suffix}`;
}

export function paymentOrderCreationFingerprint(input: {
  type: "credits" | "cash";
  amount: number;
  creditsAmount: number | null;
  paymentMethodId: string;
  paymentMethod: string;
  paymentProvider: "xunhupay" | "epay";
  callbackOrigin: string;
}): string {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    type: input.type,
    amount: input.amount.toFixed(2),
    creditsAmount: input.creditsAmount,
    paymentMethodId: input.paymentMethodId,
    paymentMethod: input.paymentMethod,
    paymentProvider: input.paymentProvider,
    callbackOrigin: input.callbackOrigin,
  }));
}

export function claimPaymentOrderCreation(input: {
  userId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  tradeOrderId: string;
  type: "credits" | "cash";
  amount: number;
  creditsAmount: number | null;
  paymentMethod: string;
  paymentProvider: "xunhupay" | "epay";
  expireAt: string;
  leaseOwner: string;
}): Promise<PaymentCreationClaim> {
  return callRpc("claim_payment_order_creation_atomic", {
    p_user_id: input.userId,
    p_client_idempotency_key: input.idempotencyKey,
    p_request_fingerprint: input.requestFingerprint,
    p_trade_order_id: input.tradeOrderId,
    p_type: input.type,
    p_amount: input.amount,
    p_credits_amount: input.creditsAmount,
    p_payment_method: input.paymentMethod,
    p_payment_provider: input.paymentProvider,
    p_expire_at: input.expireAt,
    p_lease_owner: input.leaseOwner,
    p_lease_seconds: 90,
  });
}

export function markPaymentOrderCreationProviderStarted(record: PaymentCreationRecord): Promise<PaymentCreationClaim> {
  return callRpc("mark_payment_order_creation_provider_started_atomic", {
    p_trade_order_id: record.tradeOrderId,
    p_request_fingerprint: record.requestFingerprint,
    p_lease_owner: record.leaseOwner,
    p_lease_token: record.leaseToken,
  });
}

export function finalizePaymentOrderCreation(
  record: PaymentCreationRecord,
  result: PaymentCreationProviderResult,
): Promise<PaymentCreationClaim> {
  return callRpc("finalize_payment_order_creation_atomic", {
    p_trade_order_id: record.tradeOrderId,
    p_request_fingerprint: record.requestFingerprint,
    p_lease_owner: record.leaseOwner,
    p_lease_token: record.leaseToken,
    p_payment_url: result.paymentUrl || null,
    p_qrcode_url: result.qrcodeUrl || null,
    p_platform_order_id: result.platformOrderId,
  });
}

export function markPaymentOrderCreationRecoveryRequired(
  record: PaymentCreationRecord,
  result: PaymentCreationProviderResult | null,
  reason: "provider_outcome_unknown" | "local_finalize_failed",
): Promise<PaymentCreationClaim> {
  return callRpc("mark_payment_order_creation_reconciliation_atomic", {
    p_trade_order_id: record.tradeOrderId,
    p_request_fingerprint: record.requestFingerprint,
    p_lease_owner: record.leaseOwner,
    p_lease_token: record.leaseToken,
    p_error_code: reason === "local_finalize_failed"
      ? "PAYMENT_CREATE_LOCAL_FINALIZE_FAILED"
      : "PAYMENT_CREATE_PROVIDER_OUTCOME_UNKNOWN",
    p_payment_url: result?.paymentUrl || null,
    p_qrcode_url: result?.qrcodeUrl || null,
    p_platform_order_id: result?.platformOrderId || null,
  });
}
