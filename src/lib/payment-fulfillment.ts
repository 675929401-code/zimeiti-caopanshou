import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export type PaymentFulfillmentEvidence = {
  tradeOrderId: string;
  provider: string;
  providerTradeOrderId: string;
  providerTransactionId: string;
  paidAmount: string | number;
};

type FulfillmentResult = {
  success: boolean;
  alreadyFulfilled?: boolean;
  error?: string;
};

type AtomicPaymentResult = {
  success?: boolean;
  already_fulfilled?: boolean;
  status?: string;
  trade_order_id?: string;
  provider_trade_order_id?: string;
  provider_transaction_id?: string;
  provider_paid_amount?: string | number;
};

function normalizeIdentifier(value: string, maxLength = 240): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseStrictPositiveAmount(value: string | number): number | null {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;

  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 99_999_999.99) return null;

  const normalized = Number(amount.toFixed(2));
  if (!Number.isFinite(normalized) || normalized !== amount) return null;
  return normalized;
}

/**
 * Fulfill one provider-confirmed payment with immutable provider evidence.
 *
 * The PostgreSQL RPC owns the full transaction: it locks the payment order,
 * validates the provider merchant order id, provider transaction id and exact
 * paid amount, mutates the wallet, appends the ledger and finally marks the
 * payment order paid. There is intentionally no application fallback.
 */
export async function fulfillPaymentOrder(
  evidence: PaymentFulfillmentEvidence,
): Promise<FulfillmentResult> {
  const normalizedTradeOrderId = normalizeIdentifier(evidence.tradeOrderId);
  const normalizedProviderTradeOrderId = normalizeIdentifier(evidence.providerTradeOrderId);
  const normalizedProviderTransactionId = normalizeIdentifier(evidence.providerTransactionId);
  const normalizedProvider = String(evidence.provider ?? "").trim().toLowerCase();
  const normalizedPaidAmount = parseStrictPositiveAmount(evidence.paidAmount);

  if (!normalizedTradeOrderId) {
    return { success: false, error: "Invalid payment order id" };
  }
  if (!normalizedProviderTradeOrderId || normalizedProviderTradeOrderId !== normalizedTradeOrderId) {
    return { success: false, error: "Provider merchant order id mismatch" };
  }
  if (!normalizedProviderTransactionId) {
    return { success: false, error: "Invalid provider transaction id" };
  }
  if (!/^[a-z0-9_-]{1,64}$/.test(normalizedProvider)) {
    return { success: false, error: "Invalid payment provider" };
  }
  if (normalizedPaidAmount === null) {
    return { success: false, error: "Invalid provider-paid amount" };
  }

  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc("fulfill_payment_order_with_evidence_atomic", {
    p_trade_order_id: normalizedTradeOrderId,
    p_provider: normalizedProvider,
    p_provider_trade_order_id: normalizedProviderTradeOrderId,
    p_provider_transaction_id: normalizedProviderTransactionId,
    p_paid_amount: normalizedPaidAmount,
  });

  if (error) {
    const migrationMissing = error.code === "PGRST202"
      || String(error.message || "").includes("fulfill_payment_order_with_evidence_atomic");
    return {
      success: false,
      error: migrationMissing
        ? "Evidence-based atomic payment fulfillment is not deployed"
        : "Evidence-based atomic payment fulfillment failed",
    };
  }

  const result = (Array.isArray(data) ? data[0] : data) as AtomicPaymentResult | null;
  const returnedAmount = parseStrictPositiveAmount(result?.provider_paid_amount ?? "");
  if (!result?.success
    || result.status !== "paid"
    || result.trade_order_id !== normalizedTradeOrderId
    || result.provider_trade_order_id !== normalizedProviderTradeOrderId
    || result.provider_transaction_id !== normalizedProviderTransactionId
    || returnedAmount !== normalizedPaidAmount) {
    return { success: false, error: "Atomic payment fulfillment evidence was not confirmed" };
  }

  return {
    success: true,
    alreadyFulfilled: result.already_fulfilled === true,
  };
}
