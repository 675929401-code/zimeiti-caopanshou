/**
 * Unified billing executor.
 *
 * Every balance mutation is delegated to the database RPC exposed by
 * billing.ts. There is deliberately no application-level balance update or
 * transaction fallback: if the migration/RPC is unavailable, billing fails
 * closed and the caller must not deliver a paid result.
 */

import { applyAtomicWalletOperation } from '@/lib/billing';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

export interface CreditBillingParams {
  userId: string;
  amount: number;
  /** Stable request/task identity. Never generate this at deduction time. */
  idempotencyKey: string;
  agentName: string;
  model: string;
  phase?: string;
  publicModelId?: string;
  priceSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  inputCostRmb?: number;
  outputCostRmb?: number;
  cachedCostRmb?: number;
  actualCostRmb?: number;
  sellPriceRmb?: number;
  profitRmb?: number;
  creditsExpected?: number;
  profitMargin?: number;
  creditsPerYuan?: number;
}

export interface CashBillingParams {
  userId: string;
  amount: number;
  /** Stable request/task identity. Never generate this at deduction time. */
  idempotencyKey: string;
  modelName: string;
  description: string;
  phase?: string;
  publicModelId?: string;
  priceSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface BillingResult {
  success: boolean;
  creditsCharged?: number;
  cashCharged?: number;
  remaining?: number;
  alreadyFulfilled?: boolean;
  operationId?: string;
  error?: string;
  retryCount?: number;
}

function validateMutationInput(params: {
  userId: string;
  amount: number;
  idempotencyKey: string;
}): string | undefined {
  if (!params.userId?.trim()) return '缺少有效的用户标识';
  const key = params.idempotencyKey?.trim() || '';
  if (!key || key.length > 240) return '缺少有效的幂等业务标识';
  if (!Number.isFinite(Number(params.amount)) || Number(params.amount) <= 0) {
    return '扣费金额必须为有效正数';
  }
  return undefined;
}

export async function executeCreditDeduction(params: CreditBillingParams): Promise<BillingResult> {
  const validationError = validateMutationInput(params);
  if (validationError) return { success: false, error: validationError, retryCount: 0 };

  const amount = Number(params.amount);
  const result = await applyAtomicWalletOperation({
    userId: params.userId,
    operationKind: 'credit_charge',
    idempotencyKey: params.idempotencyKey,
    amount,
    description: `${params.agentName} 对话（${params.model}）`,
    metadata: {
      ...(params.metadata || {}),
      phase: params.phase || null,
      public_model_id: params.publicModelId || null,
      price_snapshot: params.priceSnapshot || null,
      agent_name: params.agentName,
      model: params.model,
      prompt_tokens: params.promptTokens ?? 0,
      completion_tokens: params.completionTokens ?? 0,
      cached_tokens: params.cachedTokens ?? 0,
      input_cost_rmb: params.inputCostRmb ?? 0,
      output_cost_rmb: params.outputCostRmb ?? 0,
      cached_cost_rmb: params.cachedCostRmb ?? 0,
      actual_cost_rmb: params.actualCostRmb ?? 0,
      sell_price_rmb: params.sellPriceRmb ?? 0,
      profit_rmb: params.profitRmb ?? 0,
      credits_charged: amount,
      credits_expected: params.creditsExpected ?? amount,
      profit_margin: params.profitMargin ?? null,
      credits_per_yuan: params.creditsPerYuan ?? null,
      billing_source: 'billing-executor',
    },
  });

  return {
    success: result.success,
    creditsCharged: result.success && !result.alreadyFulfilled ? amount : 0,
    remaining: result.success ? result.balanceAfter : undefined,
    alreadyFulfilled: result.alreadyFulfilled,
    operationId: result.operationId,
    error: result.error,
    retryCount: 0,
  };
}

export async function executeCashDeduction(params: CashBillingParams): Promise<BillingResult> {
  const validationError = validateMutationInput(params);
  if (validationError) return { success: false, error: validationError, retryCount: 0 };

  const amount = Number(params.amount);
  const result = await applyAtomicWalletOperation({
    userId: params.userId,
    operationKind: 'cash_charge',
    idempotencyKey: params.idempotencyKey,
    amount,
    description: params.description,
    metadata: {
      ...(params.metadata || {}),
      phase: params.phase || null,
      public_model_id: params.publicModelId || null,
      price_snapshot: params.priceSnapshot || null,
      model_name: params.modelName,
      cash_charged: amount,
      billing_source: 'billing-executor',
    },
  });

  return {
    success: result.success,
    cashCharged: result.success && !result.alreadyFulfilled ? amount : 0,
    remaining: result.success ? result.balanceAfter : undefined,
    alreadyFulfilled: result.alreadyFulfilled,
    operationId: result.operationId,
    error: result.error,
    retryCount: 0,
  };
}

export async function checkCreditBalance(userId: string): Promise<{ credits: number; exists: boolean }> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('users').select('credits').eq('id', userId).single();
  if (error || !data) return { credits: 0, exists: false };
  const credits = Number(data.credits);
  return { credits: Number.isFinite(credits) ? credits : 0, exists: Number.isFinite(credits) };
}

export async function checkCashBalance(userId: string): Promise<{ balance: number; exists: boolean }> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('users').select('cash_balance').eq('id', userId).single();
  if (error || !data) return { balance: 0, exists: false };
  const balance = Number(data.cash_balance);
  return { balance: Number.isFinite(balance) ? balance : 0, exists: Number.isFinite(balance) };
}

/** @deprecated Paid delivery must await executeCreditDeduction and inspect success. */
export function fireAndForgetCreditDeduction(params: CreditBillingParams): void {
  void executeCreditDeduction(params).then((result) => {
    if (!result.success) console.error('[BillingExecutor] credit deduction failed:', result.error);
  });
}

/** @deprecated Paid delivery must await executeCashDeduction and inspect success. */
export function fireAndForgetCashDeduction(params: CashBillingParams): void {
  void executeCashDeduction(params).then((result) => {
    if (!result.success) console.error('[BillingExecutor] cash deduction failed:', result.error);
  });
}
