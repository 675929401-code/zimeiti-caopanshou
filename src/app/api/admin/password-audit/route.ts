import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

// GET /api/admin/password-audit — 查询密码操作审计日志（仅管理员）
export async function GET(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') {
    return NextResponse.json({ error: '仅管理员可查看' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = Math.min(parseInt(searchParams.get('pageSize') || '20'), 100);
    const userId = searchParams.get('userId') || '';
    const action = searchParams.get('action') || '';

    const client = getSupabaseAdminClient();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = client
      .from('password_audit_log')
      .select('id,user_id,action,performed_by,performed_by_role,performed_by_name,ip_address,user_agent,details,created_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (userId) {
      query = query.eq('user_id', userId);
    }
    if (action) {
      query = query.eq('action', action);
    }

    const { data, count, error } = await query.range(from, to);

    if (error) {
      // 表不存在时优雅降级，返回空列表
      if (error.message && error.message.includes('Could not find')) {
        console.warn('[password-audit] 表 password_audit_log 不存在，返回空列表');
        return NextResponse.json({ logs: [], totalCount: 0, page, pageSize, warning: 'password_audit_log 表尚未创建，请执行建表 SQL' });
      }
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }

    return NextResponse.json({ logs: data || [], totalCount: count || 0, page, pageSize });
  } catch (err) {
    console.error('Password audit query error:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
