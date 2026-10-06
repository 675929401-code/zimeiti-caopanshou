/**
 * 计费防护层 — 包裹核心计费函数，注入审计源信息
 * 
 * 设计原则：
 * 1. 不修改 billing.ts 锁定代码，通过包装函数注入审计源
 * 2. 每次余额变更后记录审计日志（变更后快照，确保准确）
 * 3. 支付回调/管理员手动/自动扣费 统一走此层
 * 
 * 使用方式：
 *   import { auditedAddCredits, auditedTopupCash, auditedDeductCash } from '@/lib/billing-guard';
 *   // 替代直接调用 billing.ts 的 addCredits / topupCash / deductCash
 */

import {
  addCredits,
  topupCash,
  deductCash,
  deductCredits,
  type BillingOperationContext,
  type CreditDeductionResult,
} from '@/lib/billing';

// 别名导出：topUpCash 已合并为 topupCash
/** @deprecated 使用 topupCash 代替 */
export const topUpCash = topupCash;
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

// ─── 审计源类型 ──────────────────────────────
export type BalanceSource =
  | 'payment_callback'      // 在线支付回调
  | 'admin_manual'          // 管理员手动充值
  | 'billing_deduction'     // 计费扣费（LLM/Coze对话）
  | 'video_billing'         // 视频扣费
  | 'image_billing'         // 封面扣费
  | 'trial_plan'            // 试用套餐
  | 'cami_redeem'           // 卡密兑换
  | 'refund'                // 退款
  | 'system_adjustment';    // 系统调整

// ─── 内部工具：变更后写入审计日志 ──────
async function writeAuditLogAfter(params: {
  userId: string;
  field: 'credits' | 'cash_balance';
  delta: number;
  source: BalanceSource;
  sourceId: string;
}): Promise<void> {
  const db = getSupabaseAdminClient();
  try {
    // 变更后读取真实余额
    const { data: user } = await db
      .from('users')
      .select('credits, cash_balance')
      .eq('id', params.userId)
      .single();

    if (!user) return;

    const newValue = params.field === 'credits' ? Number(user.credits) : Number(user.cash_balance);
    const oldValue = Math.round((newValue - params.delta) * 100) / 100;

    await db.from('balance_audit_log').insert({
      user_id: params.userId,
      field: params.field,
      old_value: oldValue,
      new_value: newValue,
      delta: params.delta,
      source: params.source,
      source_id: params.sourceId,
    });
  } catch (e) {
    // 审计日志写入失败不影响业务
    console.warn('[billing-guard] audit log write failed:', e);
  }
}

// ─── 审计包裹函数 ──────────────────────────────

/**
 * 审计积分充值（包裹 addCredits）
 * 核心函数执行成功后才写审计日志，确保数据准确
 */
export async function auditedAddCredits(
  userId: string,
  amount: number,
  description: string,
  sourceId: string,
  source: BalanceSource = 'payment_callback',
): Promise<{ success: boolean; balanceAfter?: number; error?: string }> {
  const result = await addCredits(
    userId,
    amount,
    description,
    sourceId,
    source === 'refund' ? 'credit_refund' : 'credit_topup',
  );
  
  if (result.success && !result.alreadyFulfilled) {
    // 核心函数成功才写审计日志
    await writeAuditLogAfter({ userId, field: 'credits', delta: amount, source, sourceId });
  }
  
  return result;
}

/**
 * 审计现金充值（包裹 topupCash）
 */
export async function auditedTopupCash(
  userId: string,
  amount: number,
  description: string,
  sourceId: string,
  source: BalanceSource = 'payment_callback',
): Promise<{ success: boolean; balanceAfter: number; error?: string }> {
  const result = await topupCash(userId, amount, description, sourceId);
  
  if (result.success && !result.alreadyFulfilled) {
    await writeAuditLogAfter({ userId, field: 'cash_balance', delta: amount, source, sourceId });
  }
  
  return result;
}

/**
 * 审计现金充值（别名 — 内部委托 auditedTopupCash）
 * @deprecated 使用 auditedTopupCash 代替
 */
export const auditedTopUpCash = auditedTopupCash;

/**
 * 审计现金扣费（包裹 deductCash）
 */
export async function auditedDeductCash(
  userId: string,
  amount: number,
  description: string,
  referenceId: string,
  source: BalanceSource = 'video_billing',
): Promise<{ success: boolean; deductedAmount: number; balanceAfter: number; alreadyFulfilled?: boolean; operationId?: string; error?: string }> {
  const result = await deductCash(userId, amount, description, referenceId);
  
  if (result.success && !result.alreadyFulfilled && result.deductedAmount > 0) {
    await writeAuditLogAfter({ userId, field: 'cash_balance', delta: -amount, source, sourceId: referenceId });
  }
  
  return result;
}

/**
 * 审计积分扣费（包裹 deductCredits）
 */
export async function auditedDeductCredits(
  userId: string,
  agentName: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  operation: BillingOperationContext,
  baseFeeCredits: number = 0,
  source: BalanceSource = 'billing_deduction',
): Promise<CreditDeductionResult> {
  const result = await deductCredits(
    userId,
    agentName,
    model,
    promptTokens,
    completionTokens,
    cachedTokens,
    operation,
    baseFeeCredits,
  );
  
  if (result.success && !result.alreadyFulfilled && result.billing) {
    const delta = -(result.billing.creditsCharged || 0);
    await writeAuditLogAfter({
      userId,
      field: 'credits',
      delta,
      source,
      sourceId: operation.idempotencyKey,
    });
  }
  
  return result;
}
