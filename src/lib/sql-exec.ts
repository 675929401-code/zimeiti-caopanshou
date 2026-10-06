// SQL 执行工具 - 统一走 Supabase 云数据库
// 历史遗留的 PGDATABASE_URL 已废弃，所有数据操作应通过 Supabase REST API
// 此文件保留向后兼容，但已标记为 deprecated
// 新代码应直接使用 getSupabaseClient().from(table).select/insert/update/delete
import { getPool } from './db';

/**
 * 将 pg 返回的 UUID 值（可能是 Buffer）转为标准 UUID 字符串
 * 配合 db.ts 中的 types.setTypeParser(2950, ...) 全局修复使用
 * 此函数作为兜底，防止个别场景下 Buffer 未被正确转换
 */
export function uuidToString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Buffer.isBuffer(val)) {
    return val.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }
  return String(val);
}

let pgWarningShown = false;

/**
 * @deprecated 请使用 getSupabaseClient().from(table) 替代
 * 直接执行 SQL 的工具函数，走 PG 连接
 * 注意：仅在服务器端有 PGDATABASE_URL 配置时可用
 * 本地开发环境（仅 Supabase）调用此函数会失败
 */
export async function executeSql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const hasPgConfig = process.env.PGDATABASE_URL || process.env.DATABASE_URL || process.env.PG_HOST;
  if (!hasPgConfig && !pgWarningShown) {
    pgWarningShown = true;
    console.warn('[sql-exec] ⚠️ PGDATABASE_URL 未配置，executeSql 将尝试连接本地 PG。如需使用此功能，请配置 PG 环境变量，或将相关 API 迁移到 Supabase 客户端。');
  }
  const pool = getPool();
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function executeSqlOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await executeSql<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}
