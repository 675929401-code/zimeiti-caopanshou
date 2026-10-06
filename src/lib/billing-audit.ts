/**
 * 计费审计工具 — 余额变更源追踪
 * 
 * 原子钱包及其同事务 ledger 是余额变更的主审计记录。
 * 本模块只能用该事务返回的精确 before/after 补充旧审计表的展示记录。
 * PostgREST 请求各有独立事务，单独调用 set_config 无法给后续余额请求传递来源；
 * 操作者和来源必须作为同一次原子钱包 RPC 的 metadata 保存。
 */

import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

function cleanIpCandidate(value: string): string | null {
  let candidate = value.split(",")[0]?.trim() || "";
  if (!candidate || candidate.toLowerCase() === "unknown") return null;
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/u);
  if (bracketed) candidate = bracketed[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/u.test(candidate)) {
    candidate = candidate.replace(/:\d+$/u, "");
  }
  if (candidate.length < 3 || candidate.length > 64 || /[\s\r\n]/u.test(candidate)) return null;
  return candidate;
}

/** The exact request IP only; callers must never substitute a login-history IP. */
export function getAuditRequestIp(request: Request): string | null {
  return cleanIpCandidate(
    request.headers.get("x-forwarded-for")
      || request.headers.get("x-real-ip")
      || "",
  );
}

/**
 * 补充旧审计表的展示投影，禁止事后读取 users 反推前余额。
 * 调用方只在首次明确提交后调用；钱包重放不依靠此非原子投影判断是否入账。
 * 失败不改变已经提交的钱包结果，主 ledger 中仍有完整金额和操作者记录。
 */
export async function writeAuditLogDirect(params: {
  userId: string;
  field: "credits" | "cash_balance";
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  operationId: string;
  source: string;
  operatorId?: string | null;
  ipAddress?: string | null;
  context?: Record<string, string | number | boolean | null>;
}): Promise<boolean> {
  const { userId, field, delta, balanceBefore, balanceAfter, operationId, source } = params;
  if (!userId || !operationId || !source
    || ![delta, balanceBefore, balanceAfter].every(Number.isFinite)
    || Math.abs(balanceAfter - balanceBefore - delta) > 0.000001) {
    return false;
  }
  try {
    const db = getSupabaseAdminClient();
    const { error } = await db.from("balance_audit_log").insert({
      user_id: userId,
      field,
      old_value: balanceBefore,
      new_value: balanceAfter,
      delta,
      source,
      source_id: `wallet:${operationId}`,
      operator_id: params.operatorId || null,
      ip_address: params.ipAddress || null,
      context: params.context || {},
    });
    if (error) {
      console.warn("[billing-audit] Legacy audit projection unavailable; atomic wallet ledger remains authoritative");
      return false;
    }
    return true;
  } catch {
    console.warn("[billing-audit] Legacy audit projection unavailable; atomic wallet ledger remains authoritative");
    return false;
  }
}

/**
 * 余额一致性校验 — 对比 users 表余额与流水汇总是否一致
 * @param userId 用户ID，为空则检查全部用户
 * @returns 不一致的记录列表
 */
export async function consistencyCheck(userId?: string): Promise<{
  checked: number;
  inconsistencies: Array<{
    user_id: string;
    field: 'credits' | 'cash_balance';
    db_value: number;
    calculated_value: number;
    diff: number;
  }>;
}> {
  const db = getSupabaseAdminClient();
  const inconsistencies: Array<{
    user_id: string;
    field: 'credits' | 'cash_balance';
    db_value: number;
    calculated_value: number;
    diff: number;
  }> = [];

  // 查询目标用户
  let userQuery = db.from('users').select('id, credits, cash_balance');
  if (userId) {
    userQuery = userQuery.eq('id', userId);
  }
  const { data: users, error: userError } = await userQuery;

  if (userError || !users) {
    console.error('[consistencyCheck] fetch users error:', userError);
    return { checked: 0, inconsistencies };
  }

  for (const user of users) {
    const uid = String(user.id);

    // 积分：recharge/topup/admin_adjust 汇总 - consume/consumption 汇总。
    // 历史版本混用过枚举，审计口径必须兼容，否则会把真实流水误判为空。
    const { data: creditTx } = await db
      .from('credit_transactions')
      .select('amount, type')
      .eq('user_id', uid);

    if (creditTx && creditTx.length > 0) {
      const topup = creditTx
        .filter((t: {type:string;amount:number}) => ['topup', 'recharge'].includes(t.type) || (t.type === 'admin_adjust' && Number(t.amount) > 0))
        .reduce((sum: number, t: {type:string;amount:number}) => sum + Number(t.amount), 0);
      const consumption = creditTx
        .filter((t: {type:string;amount:number}) => ['consume', 'consumption'].includes(t.type) || (t.type === 'admin_adjust' && Number(t.amount) < 0))
        .reduce((sum: number, t: {type:string;amount:number}) => sum + Math.abs(Number(t.amount)), 0);
      const calculated = topup - consumption;
      const dbValue = Number(user.credits);
      const diff = Math.abs(dbValue - calculated);
      
      if (diff > 1) { // 允许1积分浮点误差
        inconsistencies.push({
          user_id: uid,
          field: 'credits',
          db_value: dbValue,
          calculated_value: calculated,
          diff,
        });
      }
    }

    // 现金：topup/recharge 汇总 - consume/consumption 汇总。
    const { data: cashTx } = await db
      .from('cash_transactions')
      .select('amount, type')
      .eq('user_id', uid);

    if (cashTx && cashTx.length > 0) {
      const topup = cashTx
        .filter((t: {type:string;amount:number}) => ['topup', 'recharge'].includes(t.type))
        .reduce((sum: number, t: {type:string;amount:number}) => sum + Number(t.amount), 0);
      const consumption = cashTx
        .filter((t: {type:string;amount:number}) => ['consume', 'consumption'].includes(t.type))
        .reduce((sum: number, t: {type:string;amount:number}) => sum + Math.abs(Number(t.amount)), 0);
      const calculated = Math.round((topup - consumption) * 100) / 100;
      const dbValue = Number(user.cash_balance);
      const diff = Math.abs(dbValue - calculated);

      if (diff > 0.01) { // 允许0.01元浮点误差
        inconsistencies.push({
          user_id: uid,
          field: 'cash_balance',
          db_value: dbValue,
          calculated_value: calculated,
          diff,
        });
      }
    }
  }

  return { checked: users.length, inconsistencies };
}

/**
 * 查询余额审计日志
 */
export async function getBalanceAuditLog(params: {
  userId?: string;
  field?: 'credits' | 'cash_balance';
  source?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  total: number;
  logs: Array<{
    id: number;
    user_id: string;
    field: string;
    old_value: number;
    new_value: number;
    delta: number;
    source: string;
    source_id: string | null;
    created_at: string;
  }>;
}> {
  const db = getSupabaseAdminClient();
  const { userId, field, source, limit = 50, offset = 0 } = params;

  let query = db
    .from('balance_audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (userId) query = query.eq('user_id', userId);
  if (field) query = query.eq('field', field);
  if (source) query = query.eq('source', source);

  const { data, count, error } = await query;

  if (error) {
    console.error('[getBalanceAuditLog] error:', error);
    return { total: 0, logs: [] };
  }

  return {
    total: count || 0,
    logs: (data || []).map((d: Record<string, unknown>) => ({
      id: d.id,
      user_id: String(d.user_id),
      field: d.field,
      old_value: Number(d.old_value),
      new_value: Number(d.new_value),
      delta: Number(d.delta),
      source: d.source,
      source_id: d.source_id,
      created_at: d.created_at,
    })),
  };
}
