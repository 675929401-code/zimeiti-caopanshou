import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";
import { invalidateBotsCache } from '@/lib/bots-cache';

/**
 * PUT /api/admin/agents/reorder
 * 批量更新智能体排序（管理员拖拽排序后持久化）
 * 
 * 请求体: { agentIds: string[] } — 按新顺序排列的智能体ID数组
 * 
 * 排序规则：
 * 1. 按分类分组，每个分类内的智能体按传入顺序分配 sort_order
 * 2. 不同分类的智能体各自独立编号（每个分类从 10 开始，步长 10）
 * 3. 前端按分类顺序 + sort_order 渲染
 */
export async function PUT(request: NextRequest) {
  // 验证管理员权限
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const { agentIds } = await request.json();

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return NextResponse.json({ error: 'agentIds 不能为空' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 获取所有涉及的智能体的分类信息
    const { data: agents, error: fetchError } = await client
      .from('agents')
      .select('id, category')
      .in('id', agentIds)
      .is('deleted_at', null);

    if (fetchError) {
      return NextResponse.json({ error: '获取智能体信息失败' }, { status: 500 });
    }

    // 构建 id → category 映射
    const agentCategoryMap = new Map<string, string>();
    (agents || []).forEach((a: { id: string; category: string | null }) => {
      agentCategoryMap.set(a.id, a.category || '未分类');
    });

    // 按分类分组，计算每个分类内的新 sort_order
    const categoryOrderCounters = new Map<string, number>();
    const updates: Array<{ id: string; sort_order: number }> = [];

    for (const agentId of agentIds) {
      const category = agentCategoryMap.get(agentId) || '未分类';
      const currentCounter = categoryOrderCounters.get(category) ?? 0;
      const newSortOrder = currentCounter + 10;
      categoryOrderCounters.set(category, newSortOrder);
      updates.push({ id: agentId, sort_order: newSortOrder });
    }

    // 批量更新 sort_order
    // Supabase 不支持批量 update，需要逐条更新
    const results = await Promise.allSettled(
      updates.map(({ id, sort_order }) =>
        client
          .from('agents')
          .update({ sort_order, updated_at: new Date().toISOString() })
          .eq('id', id)
      )
    );

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('[reorder] Some updates failed:', failures);
      return NextResponse.json({ 
        error: `部分排序更新失败（${failures.length}/${updates.length}）`,
        updated: updates.length - failures.length,
      }, { status: 207 });
    }

    // 失效 /api/bots 缓存，确保前台即时可见新排序
    invalidateBotsCache();

    return NextResponse.json({ 
      success: true, 
      updated: updates.length,
    });
  } catch (err) {
    console.error('[reorder] Error:', err);
    return NextResponse.json({ error: '排序更新失败' }, { status: 500 });
  }
}
