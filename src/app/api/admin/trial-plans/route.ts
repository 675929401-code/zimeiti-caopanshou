import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

// GET - 鍒楀嚭鎵€鏈夎瘯鐢ㄥ椁愶紙鍚叧鑱旂殑鏅鸿兘浣揑D鍒楄〃锛?
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const client = getSupabaseClient();
    const { data: plans, error } = await client
      .from('trial_plans')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) return NextResponse.json({ error: '实时试用套餐数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });

    // 鑾峰彇姣忎釜濂楅鍏宠仈鐨勬櫤鑳戒綋
    const plansWithAgents = await Promise.all((plans || []).map(async (plan: Record<string, unknown>) => {
      const { data: agentLinks } = await client
        .from('trial_plan_agents')
        .select('agent_id')
        .eq('plan_id', plan.id);

      return {
        ...plan,
        agent_ids: (agentLinks || []).map((link: { agent_id: string }) => link.agent_id),
      };
    }));

    return NextResponse.json({ plans: plansWithAgents });
  } catch (err) {
    console.error('List trial plans error:', err);
    return NextResponse.json({ error: '实时试用套餐数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });
  }
}

// POST - 鍒涘缓璇曠敤濂楅
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const body = await request.json();
    const { name, description, credits, durationDays, duration_days, isActive, is_active, sortOrder, sort_order, agentIds, agent_ids } = body;

    if (!name) return NextResponse.json({ error: '套餐名称不能为空' }, { status: 400 });
    if (credits === undefined || credits < 0) return NextResponse.json({ error: '积分数必须大于等于 0' }, { status: 400 });

    const client = getSupabaseClient();
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { data, error } = await client
      .from('trial_plans')
      .insert({
        id: planId,
        name,
        description: description || '',
        credits,
        duration_days: duration_days || durationDays || 7,
        is_active: is_active ?? isActive ?? true,
        sort_order: sort_order || sortOrder || 0,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: `创建试用套餐失败: ${error.message}` }, { status: 500 });

    // 鍏宠仈鏅鸿兘浣?
    const planAgentIds = agent_ids || agentIds || [];
    if (planAgentIds.length > 0) {
      const links = planAgentIds.map((aid: string) => ({
        plan_id: planId,
        agent_id: aid,
      }));
      await client.from('trial_plan_agents').insert(links);
    }

    return NextResponse.json({ success: true, plan: data });
  } catch (err) {
    console.error('Create trial plan error:', err);
    return NextResponse.json({ error: '创建试用套餐失败' }, { status: 500 });
  }
}

// PUT - 鏇存柊璇曠敤濂楅
export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const body = await request.json();
    const { planId, name, description, credits, durationDays, duration_days, isActive, is_active, sortOrder, sort_order, agentIds, agent_ids } = body;
    const resolvedPlanId = String(planId || new URL(request.url).searchParams.get('id') || '').trim();

    if (!resolvedPlanId) return NextResponse.json({ error: '套餐 ID 不能为空' }, { status: 400 });

    const client = getSupabaseClient();
    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) fields.name = name;
    if (description !== undefined) fields.description = description;
    if (credits !== undefined) fields.credits = credits;
    if (durationDays !== undefined) fields.duration_days = durationDays;
    if (duration_days !== undefined) fields.duration_days = duration_days;
    if (isActive !== undefined) fields.is_active = isActive;
    if (is_active !== undefined) fields.is_active = is_active;
    if (sortOrder !== undefined) fields.sort_order = sortOrder;
    if (sort_order !== undefined) fields.sort_order = sort_order;

    const { data, error } = await client
      .from('trial_plans')
      .update(fields)
      .eq('id', resolvedPlanId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: `更新试用套餐失败: ${error.message}` }, { status: 500 });

    // 濡傛灉浼犱簡agent_ids锛屾洿鏂板叧鑱?
    const planAgentIds = agent_ids ?? agentIds;
    if (planAgentIds !== undefined) {
      // 鍏堝垹闄ゆ棫鐨勫叧鑱?
      await client.from('trial_plan_agents').delete().eq('plan_id', resolvedPlanId);
      // 鍐嶆彃鍏ユ柊鐨勫叧鑱?
      if (planAgentIds.length > 0) {
        const links = planAgentIds.map((aid: string) => ({
          plan_id: resolvedPlanId,
          agent_id: aid,
        }));
        await client.from('trial_plan_agents').insert(links);
      }
    }

    return NextResponse.json({ success: true, plan: data });
  } catch (err) {
    console.error('Update trial plan error:', err);
    return NextResponse.json({ error: '更新试用套餐失败' }, { status: 500 });
  }
}

// DELETE - 鍒犻櫎璇曠敤濂楅
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const { searchParams } = new URL(request.url);
    const planId = searchParams.get('id');
    if (!planId) return NextResponse.json({ error: '套餐 ID 不能为空' }, { status: 400 });

    const client = getSupabaseClient();
    // 鍏宠仈鐨則rial_plan_agents浼氶€氳繃ON DELETE CASCADE鑷姩鍒犻櫎
    const { error } = await client.from('trial_plans').delete().eq('id', planId);
    if (error) return NextResponse.json({ error: `删除试用套餐失败: ${error.message}` }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Delete trial plan error:', err);
    return NextResponse.json({ error: '删除试用套餐失败' }, { status: 500 });
  }
}
