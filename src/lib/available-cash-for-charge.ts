import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

type PendingVideoCharge = {
  billing_reserved_yuan: number | string | null;
  billing_price_yuan: number | string | null;
  billing_unit: string | null;
  billing_state: string | null;
  billing_exempt: boolean | null;
  explicitly_free: boolean | null;
  billing_idempotency_key: string | null;
};

/** Read the spendable cash used by the atomic wallet guard, in cents. Only the
 * final idempotent wallet operation can commit the debit. */
export async function availableCashForCharge(userId: string): Promise<number> {
  const db = getSupabaseAdminClient();
  const wallet = await db.from('users').select('cash_balance').eq('id', userId).single();
  if (wallet.error || wallet.data?.cash_balance == null) throw Error('主站现金余额暂时无法核对');
  const value = Math.round(Number(wallet.data.cash_balance) * 100);
  if (!Number.isSafeInteger(value)) throw Error('主站现金余额格式异常');
  let held = 0;
  const pageSize = 100;
  for (let start = 0; ; start += pageSize) {
    const page = await db.from('video_tasks')
      .select('id,billing_reserved_yuan,billing_price_yuan,billing_unit,billing_state,billing_exempt,explicitly_free,billing_idempotency_key')
      .eq('user_id', userId).not('status', 'in', '(completed,failed,cancelled,expired)')
      .order('id').range(start, start + pageSize - 1);
    if (page.error || !page.data) throw Error('主站在途预留暂时无法核对');
    const pending: PendingVideoCharge[] = page.data;
    const tasks = pending.filter(row => !row.billing_exempt && !row.explicitly_free
      && Number(row.billing_reserved_yuan ?? row.billing_price_yuan) > 0
      && (row.billing_unit === 'token' || !['submission_failed','settled_pending_commit','settled','legacy_h3_settled','not_required'].includes(row.billing_state ?? '')));
    const keys = tasks.map(row => row.billing_idempotency_key).filter((key): key is string => !!key);
    const settled = new Map<string, number>();
    if (keys.length) {
      const operations = await db.from('wallet_operations').select('idempotency_key,amount,delta')
        .eq('user_id', userId).eq('wallet','cash').eq('operation_kind','cash_charge')
        .eq('status','completed').in('idempotency_key', keys);
      if (operations.error || !operations.data) throw Error('主站预留结算暂时无法核对');
      for (const op of operations.data) {
        if (Number(op.amount) === -Number(op.delta)) settled.set(op.idempotency_key, Math.round(Number(op.amount)*100));
      }
    }
    for (const row of tasks) {
      if (row.billing_idempotency_key && row.billing_price_yuan != null && settled.get(row.billing_idempotency_key) === Math.round(Number(row.billing_price_yuan)*100)) continue;
      held += Math.round(Number(row.billing_reserved_yuan ?? row.billing_price_yuan)*100);
    }
    if (page.data.length < pageSize) return Math.max(0, value - held);
  }
}
