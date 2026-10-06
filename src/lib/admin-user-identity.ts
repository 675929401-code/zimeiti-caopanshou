import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

export function adminUserFieldsError(fields: Record<string, unknown>): string {
  const limits: Record<string, number> = { username: 64, displayName: 128, phone: 11, email: 254 };
  for (const [key, limit] of Object.entries(limits)) {
    const value = fields[key];
    if (value == null && (key === 'phone' || key === 'email')) continue;
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > limit) return '用户资料格式或长度不正确';
    if ((key === 'username' || key === 'displayName') && !value.trim()) return '用户名和显示名称不能为空';
    if (value !== value.trim()) return '用户资料首尾不能包含空格';
  }
  if (fields.phone && !/^1[3-9]\d{9}$/.test(String(fields.phone))) return '请输入正确的手机号';
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fields.email))) return '请输入正确的邮箱地址';
  if (fields.role !== undefined && !['admin', 'student'].includes(String(fields.role))) return '无效的用户角色';
  return '';
}

export async function checkAdminUserIdentity(
  client: ReturnType<typeof getSupabaseAdminClient>,
  fields: { username?: unknown; phone?: unknown; email?: unknown },
  userId?: string,
): Promise<{ error: string; status: number } | null> {
  const identifiers = [...new Set(Object.values(fields).filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim().toLowerCase()))];
  if (!identifiers.length) return null;
  let query = client.from('user_login_identifiers').select('user_id').in('identifier', identifiers);
  if (userId) query = query.neq('user_id', userId);
  const { data, error } = await query.limit(1);
  if (error) return { error: '账号校验服务暂不可用，请稍后重试', status: 503 };
  return data?.length ? { error: '用户名、手机号或邮箱已被其他账号使用', status: 409 } : null;
}
