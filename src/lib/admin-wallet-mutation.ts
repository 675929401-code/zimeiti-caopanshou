import { applyAtomicWalletOperation } from '@/lib/billing';
import { writeAuditLogDirect } from '@/lib/billing-audit';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

type MutationKind = 'cash_topup' | 'credit_topup' | 'credit_set';

export type AdminWalletMutationResult = {
  success: true;
  operationId?: string;
  adjustmentId?: string;
  alreadyFulfilled: boolean;
  noChange: boolean;
  balanceBefore: number;
  balanceAfter: number;
  delta: number;
  auditProjection: 'recorded' | 'wallet_ledger_only' | 'not_required';
} | {
  success: false;
  status: 409 | 503;
  code: string;
  error: string;
  outcome: 'not_applied' | 'unknown';
  canRetryWithSameKey: boolean;
};

function unknownOutcome(): AdminWalletMutationResult {
  return {
    success: false, status: 503, code: 'ADMIN_WALLET_OUTCOME_UNKNOWN', outcome: 'unknown',
    error: '本次余额操作结果尚未确认，请保留原幂等键和原参数核对；不要换键重复充值或调整',
    canRetryWithSameKey: true,
  };
}

/** RPC number fields must be present; null/empty strings are not zero receipts. */
function receiptNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function receiptId(value: unknown): string | undefined {
  return (typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(String(value))
    ? String(value) : undefined;
}

export async function mutateAdminWallet(input: {
  userId: string;
  adminId: string;
  kind: MutationKind;
  amount: number;
  operationKey: string;
  description: string;
  requestIp?: string | null;
  requestRoute?: string;
}): Promise<AdminWalletMutationResult> {
  const wallet = input.kind === 'cash_topup' ? 'cash' : 'credits';
  let record: {
    operationId?: string; adjustmentId?: string; wallet?: string; operationKind?: string;
    balanceBefore?: number; balanceAfter?: number; delta?: number; amount?: number;
    alreadyFulfilled: boolean; noChange: boolean;
  };
  try {
    // Read only zero-row schema probes before any mutation. A failed probe is
    // definitely unsubmitted, unlike a transport failure after calling the RPC.
    const db = getSupabaseAdminClient();
    const prerequisites = await Promise.all([
      db.from('wallet_operations').select('id,user_id,wallet,operation_kind,idempotency_key,balance_before,balance_after,delta,metadata').limit(0),
      db.from('wallet_ledger_entries').select('operation_id,user_id,balance_before,balance_after,delta,metadata').limit(0),
    ]);
    const prerequisiteError = prerequisites.find(result => result.error)?.error;
    if (prerequisiteError) {
      const missing = ['PGRST205', '42P01', '42703'].includes(prerequisiteError.code || '');
      return {
        success: false, status: 503,
        code: missing ? 'ADMIN_WALLET_MIGRATION_NOT_READY' : 'ADMIN_WALLET_PREREQUISITES_UNAVAILABLE',
        error: missing ? '原子钱包迁移尚未就绪，本次未调整余额' : '钱包账本暂时无法检查，本次未调整余额',
        outcome: 'not_applied', canRetryWithSameKey: true,
      };
    }
    if (input.kind === 'credit_set') {
      const { data, error } = await db.rpc('set_admin_credit_balance_atomic', {
        p_admin_id: input.adminId,
        p_user_id: input.userId,
        p_target_credits: input.amount,
        p_idempotency_key: input.operationKey,
        p_description: input.description,
      });
      if (error) {
        if (['PGRST202', '42883', '42P01'].includes(error.code || '')) {
          return {
            success: false, status: 503, code: 'ADMIN_CREDIT_ADJUSTMENT_MIGRATION_NOT_READY',
            error: '管理员积分调整所需原子迁移尚未就绪，本次未调整余额',
            outcome: 'not_applied', canRetryWithSameKey: true,
          };
        }
        if (error.code === '22023' && error.message?.includes('ADMIN_CREDIT_ADJUSTMENT_CONFLICT')) {
          return {
            success: false, status: 409, code: 'ADMIN_WALLET_IDEMPOTENCY_CONFLICT',
            error: '同一幂等键已绑定其他用户或目标积分，请先核对原操作',
            outcome: 'not_applied', canRetryWithSameKey: false,
          };
        }
        return unknownOutcome();
      }
      if (!data || data.success !== true || receiptNumber(data.target_credits) !== input.amount) return unknownOutcome();
      record = {
        operationId: receiptId(data.operation_id), adjustmentId: receiptId(data.adjustment_id),
        wallet: data.wallet, operationKind: data.operation_kind,
        balanceBefore: receiptNumber(data.balance_before), balanceAfter: receiptNumber(data.balance_after),
        delta: receiptNumber(data.delta), alreadyFulfilled: data.already_fulfilled === true,
        noChange: data.no_change === true,
      };
    } else {
      // The actual wallet RPC persists these trusted fields with its ledger in one transaction.
      const result = await applyAtomicWalletOperation({
        userId: input.userId, operationKind: input.kind, amount: input.amount,
        idempotencyKey: input.operationKey, description: input.description,
        metadata: {
          source: 'admin_manual',
          source_id: input.operationKey,
          admin_user_id: input.adminId,
          request_ip: input.requestIp || null,
          request_route: input.requestRoute || null,
        },
      });
      // The shared wrapper intentionally has no non-atomic fallback. Its generic failures
      // cannot prove whether a response was lost after commit; never expose its default 0.
      if (!result.success) return unknownOutcome();
      record = { ...result, noChange: false };
    }
  } catch {
    return unknownOutcome();
  }

  const { balanceBefore, balanceAfter, delta } = record;
  const expectedKind = input.kind === 'credit_set'
    ? record.noChange ? 'credit_set_noop' : (delta ?? 0) > 0 ? 'credit_topup' : 'credit_charge'
    : input.kind;
  if (balanceBefore === undefined || balanceAfter === undefined || delta === undefined
    || ![balanceBefore, balanceAfter, delta].every(Number.isFinite)
    || balanceAfter < 0 || balanceBefore < 0
    || Math.abs(balanceAfter - balanceBefore - delta) > 0.000001
    || record.wallet !== wallet || record.operationKind !== expectedKind
    || (!record.noChange && (!record.operationId || delta === 0))
    || (input.kind === 'credit_set' && (!record.adjustmentId || balanceAfter !== input.amount))
    || (record.noChange && (delta !== 0 || balanceBefore !== balanceAfter || record.operationId))
    || (input.kind !== 'credit_set' && (delta !== input.amount || record.amount !== input.amount))) {
    return unknownOutcome();
  }

  let auditProjection: 'recorded' | 'wallet_ledger_only' | 'not_required' = record.noChange
    ? 'not_required' : 'wallet_ledger_only';
  if (!record.alreadyFulfilled && record.operationId) {
    const recorded = await writeAuditLogDirect({
      userId: input.userId, field: wallet === 'cash' ? 'cash_balance' : 'credits',
      balanceBefore, balanceAfter, delta, operationId: record.operationId, source: 'admin_manual',
      operatorId: input.adminId,
      ipAddress: input.requestIp || null,
      context: {
        route: input.requestRoute || "admin-wallet",
        writer: "admin-wallet-v2",
      },
    });
    if (recorded) auditProjection = 'recorded';
  }
  return {
    success: true, operationId: record.operationId, adjustmentId: record.adjustmentId,
    alreadyFulfilled: record.alreadyFulfilled, noChange: record.noChange,
    balanceBefore, balanceAfter, delta, auditProjection,
  };
}

/** Keep caller validation identical for JSON numbers and numeric form strings. */
export function parseAdminBalanceValue(value: unknown, decimals: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(Math.round(number * 10 ** decimals))) return null;
  // Never silently round a requested target balance or a tiny top-up to another amount.
  return Number(number.toFixed(decimals)) === number ? number : null;
}

export function getAdminWalletRequestKey(header: string | null, body: unknown): string | null {
  const value = header || body;
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key && key.length <= 180 ? key : null;
}
