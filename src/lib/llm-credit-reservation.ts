import { calculateCredits, type BillingConfig, type BillingResult, type CreditDeductionResult } from "@/lib/billing";
import type { ChatRequest } from "@/lib/llm-proxy";
import type { LlmRequestAttemptExecution } from "@/lib/llm-request-idempotency";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export interface LlmStreamReservation {
  recordId: string;
  leaseOwner: string;
  leaseToken: number;
  amount: number;
}

export class LlmCreditReservationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "LlmCreditReservationError";
  }
}

// Some OpenAI-compatible gateways add server-owned instructions and request
// envelope tokens after our JSON payload leaves this service. UTF-8 bytes are
// already a conservative ceiling for the messages we send; this allowance
// covers the provider-only portion that cannot be measured before submission.
export const LLM_PROVIDER_INPUT_ALLOWANCE_TOKENS = 8192;

export function estimateLlmReservationInputBudget(
  messages: ChatRequest["messages"],
  roundingAllowance: number,
): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8")
    + messages.length * 64
    + LLM_PROVIDER_INPUT_ALLOWANCE_TOKENS
    + roundingAllowance;
}

/** One bounded text response. Tool loops and multimodal usage retain settled delivery. */
export function quoteLlmStreamReservation(request: ChatRequest, config: BillingConfig, thinkingMultiplier: number) {
  if (request.tools?.length || request.messages.some(message => typeof message.content !== "string")) return null;
  const maxOutput = request.max_tokens;
  if (!Number.isSafeInteger(maxOutput) || !maxOutput || maxOutput < 1 || maxOutput > 262144) return null;
  if (!Number.isFinite(thinkingMultiplier) || thinkingMultiplier < 0) return null;
  const roundingAllowance = config.tokenRoundingEnabled ? Math.max(config.tokenRoundingMin, Math.min(config.tokenRoundingMax, config.tokenRoundingUnit)) * 2 : 0;
  const inputBudget = estimateLlmReservationInputBudget(request.messages, roundingAllowance);
  const outputBudget = Math.ceil(maxOutput * thinkingMultiplier);
  const quote = calculateCredits({ ...config, inputCostPerMillion: Math.max(config.inputCostPerMillion, config.cachedCostPerMillion) }, inputBudget, outputBudget, 0);
  if (!Number.isFinite(quote.creditsCharged) || quote.creditsCharged < 0) return null;
  return { amount: quote.creditsCharged, inputBudget, outputBudget, maxOutput };
}

/**
 * Refuse an internally inconsistent settlement instead of shrinking the sale
 * below provider cost. The reservation is the maximum amount authorized for
 * this request; callers release it and withhold buffered output on failure.
 */
export function validateLlmStreamReservationSettlement(
  reservation: Pick<LlmStreamReservation, "amount">,
  billing: BillingResult,
): BillingResult {
  if (!Number.isFinite(reservation.amount) || reservation.amount < 0
      || !Number.isFinite(billing.creditsCharged) || billing.creditsCharged < 0
      || !Number.isFinite(billing.actualCostRmb) || billing.actualCostRmb < 0
      || !Number.isFinite(billing.sellPriceRmb) || billing.sellPriceRmb < 0
      || !Number.isFinite(billing.profitRmb)) {
    throw new LlmCreditReservationError(
      "LLM_BILLING_RESULT_INVALID",
      "模型结算结果无效，本次未扣款、未交付",
      503,
    );
  }
  if (billing.creditsCharged > reservation.amount) {
    throw new LlmCreditReservationError(
      "LLM_RESERVATION_BUDGET_EXCEEDED",
      "模型实际用量超过预留额度，本次未扣款、未交付，请联系管理员核对",
      409,
    );
  }
  if (billing.sellPriceRmb < billing.actualCostRmb || billing.profitRmb < 0) {
    throw new LlmCreditReservationError(
      "LLM_BILLING_MARGIN_INVALID",
      "模型售价低于实际成本，本次未扣款、未交付，请联系管理员核对",
      503,
    );
  }
  return billing;
}

async function reservationRpc(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await getSupabaseAdminClient().rpc(name, args);
    if (!error && data?.success === true) return data;
    const message = error?.message || "Invalid reservation receipt";
    if (message.includes("INSUFFICIENT_CREDITS")) throw new LlmCreditReservationError("INSUFFICIENT_CREDITS", "积分不足，无法预留本次对话额度；完成后只按实际用量结算", 402);
    if (/CONFLICT|BUDGET_EXCEEDED/.test(message)) throw new LlmCreditReservationError("LLM_RESERVATION_CONFLICT", "本次对话额度状态已变化，请查看原请求记录", 409);
    if (attempt === 2 || /schema cache|does not exist|Could not find the function/.test(message)) {
      throw new LlmCreditReservationError("LLM_RESERVATION_UNAVAILABLE", "对话额度服务暂时不可用，请稍后重试", 503);
    }
    await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
  }
  throw new LlmCreditReservationError("LLM_RESERVATION_UNAVAILABLE", "对话额度服务暂时不可用", 503);
}

function reservationArgs(reservation: LlmStreamReservation) {
  return { p_record_id: reservation.recordId, p_lease_owner: reservation.leaseOwner, p_lease_token: reservation.leaseToken };
}

export async function reserveLlmStreamCredits(execution: LlmRequestAttemptExecution, amount: number, priceSnapshot: Record<string, unknown>): Promise<LlmStreamReservation> {
  const reservation = { recordId: execution.record.recordId, leaseOwner: execution.leaseOwner, leaseToken: execution.leaseToken, amount };
  const result = await reservationRpc("reserve_llm_credits_atomic", { ...reservationArgs(reservation), p_amount: amount, p_price_snapshot: priceSnapshot });
  if (result.status !== "held" || Number(result.amount) !== amount) throw new LlmCreditReservationError("LLM_RESERVATION_CONFLICT", "对话预留额度不一致，本次未调用模型", 409);
  return reservation;
}

export async function settleLlmStreamCredits(reservation: LlmStreamReservation, billing: BillingResult, description: string, metadata: Record<string, unknown>): Promise<CreditDeductionResult> {
  const finalBilling = validateLlmStreamReservationSettlement(reservation, billing);
  const result = await reservationRpc("settle_llm_credits_atomic", {
    ...reservationArgs(reservation), p_actual_amount: finalBilling.creditsCharged, p_description: description,
    p_billing: finalBilling,
    p_metadata: { ...metadata, credits_charged: finalBilling.creditsCharged, credits_expected: billing.creditsCharged,
      actual_cost_rmb: finalBilling.actualCostRmb, sell_price_rmb: finalBilling.sellPriceRmb, profit_rmb: finalBilling.profitRmb,
      reservation_budget_exceeded: false },
  });
  if (!result.operation_id || !Number.isFinite(Number(result.available)) || Number(result.billing?.creditsCharged) !== finalBilling.creditsCharged) {
    throw new LlmCreditReservationError("LLM_RESERVATION_UNAVAILABLE", "对话结算回执无效，请查看原请求记录", 503);
  }
  return { success: true, billing: result.billing as BillingResult, operationId: String(result.operation_id),
    balanceAfter: Number(result.available), alreadyFulfilled: result.already_fulfilled === true };
}

export async function releaseLlmStreamCredits(reservation: LlmStreamReservation, reason: string) {
  await reservationRpc("release_llm_credits_atomic", { ...reservationArgs(reservation), p_reason: reason });
}

export async function recoverLlmCreditReservations(userId: string): Promise<void> {
  const { error } = await getSupabaseAdminClient().rpc("recover_llm_credit_reservations_atomic", { p_user_id: userId });
  if (error) throw new LlmCreditReservationError("LLM_RESERVATION_UNAVAILABLE", "对话额度核对服务暂时不可用", 503);
}
