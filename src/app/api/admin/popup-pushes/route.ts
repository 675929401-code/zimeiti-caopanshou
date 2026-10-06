import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { withAdminAuth } from '@/lib/api-middleware';

// GET /api/admin/popup-pushes - 管理员获取所有弹窗
export async function GET(request: NextRequest) {
  return withAdminAuth(request, async () => {
  try {
    const supabase = getSupabaseClient();
    const { data: popups, error } = await supabase
      .from('popup_pushes')
      .select('id, title, content, wechat_id, wechat_label, wechat_note, show_cami_entry, show_trial_plans, target_audience, is_enabled, priority, dismiss_behavior, created_at, updated_at')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('获取弹窗列表失败:', error);
      return NextResponse.json({ success: false, error: '获取弹窗列表失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true, popups: popups || [] });
  } catch (error) {
    console.error('获取弹窗列表失败:', error);
    return NextResponse.json({ success: false, error: '获取弹窗列表失败' }, { status: 500 });
  }
  });
}

// POST /api/admin/popup-pushes - 创建弹窗
export async function POST(request: NextRequest) {
  return withAdminAuth(request, async () => {
  try {
    const supabase = getSupabaseClient();
    const body = await request.json();
    const { title, content, wechat_id, wechat_label, wechat_note,
      show_cami_entry, show_trial_plans, target_audience, dismiss_behavior, priority } = body;

    if (!title || !target_audience) {
      return NextResponse.json({ success: false, error: '标题和目标受众为必填项' }, { status: 400 });
    }

    const { data: result, error } = await supabase
      .from('popup_pushes')
      .insert({
        title,
        content: content || '',
        wechat_id: wechat_id || '',
        wechat_label: wechat_label || '添加微信获取卡密',
        wechat_note: wechat_note || '',
        show_cami_entry: show_cami_entry !== false,
        show_trial_plans: show_trial_plans === true,
        target_audience,
        dismiss_behavior: dismiss_behavior || 'session',
        priority: priority || 0,
      })
      .select('id')
      .single();

    if (error) {
      console.error('创建弹窗失败:', error);
      return NextResponse.json({ success: false, error: '创建弹窗失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: result?.id });
  } catch (error) {
    console.error('创建弹窗失败:', error);
    return NextResponse.json({ success: false, error: '创建弹窗失败' }, { status: 500 });
  }
  });
}

// PUT /api/admin/popup-pushes - 更新弹窗
export async function PUT(request: NextRequest) {
  return withAdminAuth(request, async () => {
  try {
    const supabase = getSupabaseClient();
    const body = await request.json();
    const { id, title, content, wechat_id, wechat_label, wechat_note,
      show_cami_entry, show_trial_plans, target_audience, is_enabled,
      dismiss_behavior, priority } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: '缺少弹窗ID' }, { status: 400 });
    }

    // 构建更新对象，只包含提供的字段
    const updateObj: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updateObj.title = title;
    if (content !== undefined) updateObj.content = content;
    if (wechat_id !== undefined) updateObj.wechat_id = wechat_id;
    if (wechat_label !== undefined) updateObj.wechat_label = wechat_label;
    if (wechat_note !== undefined) updateObj.wechat_note = wechat_note;
    if (show_cami_entry !== undefined) updateObj.show_cami_entry = show_cami_entry;
    if (show_trial_plans !== undefined) updateObj.show_trial_plans = show_trial_plans;
    if (target_audience !== undefined) updateObj.target_audience = target_audience;
    if (is_enabled !== undefined) updateObj.is_enabled = is_enabled;
    if (dismiss_behavior !== undefined) updateObj.dismiss_behavior = dismiss_behavior;
    if (priority !== undefined) updateObj.priority = priority;

    const { error } = await supabase
      .from('popup_pushes')
      .update(updateObj)
      .eq('id', id);

    if (error) {
      console.error('更新弹窗失败:', error);
      return NextResponse.json({ success: false, error: '更新弹窗失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('更新弹窗失败:', error);
    return NextResponse.json({ success: false, error: '更新弹窗失败' }, { status: 500 });
  }
  });
}

// DELETE /api/admin/popup-pushes - 删除弹窗
export async function DELETE(request: NextRequest) {
  return withAdminAuth(request, async () => {
  try {
    const supabase = getSupabaseClient();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ success: false, error: '缺少弹窗ID' }, { status: 400 });
    }

    const { error } = await supabase
      .from('popup_pushes')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('删除弹窗失败:', error);
      return NextResponse.json({ success: false, error: '删除弹窗失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('删除弹窗失败:', error);
    return NextResponse.json({ success: false, error: '删除弹窗失败' }, { status: 500 });
  }
  });
}
