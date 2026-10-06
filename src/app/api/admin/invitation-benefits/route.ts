import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseClient } from '@/storage/database/supabase-client';

// GET /api/admin/invitation-benefits - 获取所有福利推送（管理员）
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== 'admin') {
      return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
    }

    const { data: benefits, error } = await supabase
      .from('invitation_benefits')
      .select('id, title, content, is_active, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch invitation benefits error:', error);
      return NextResponse.json({ error: '获取福利推送失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true, benefits: benefits || [] });
  } catch (err) {
    console.error('Fetch invitation benefits error:', err);
    return NextResponse.json({ error: '获取福利推送失败' }, { status: 500 });
  }
}

// POST /api/admin/invitation-benefits - 发布邀请福利（管理员）
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== 'admin') {
      return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
    }

    const body = await request.json();
    const { title, content } = body;

    if (!content) {
      return NextResponse.json({ error: '福利内容不能为空' }, { status: 400 });
    }

    const { data: benefit, error } = await supabase
      .from('invitation_benefits')
      .insert({ title: title || '邀请福利', content, is_active: true })
      .select('id, title, content, is_active, created_at, updated_at')
      .single();

    if (error) {
      console.error('Create invitation benefit error:', error);
      return NextResponse.json({ error: '发布福利失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true, benefit });
  } catch (err) {
    console.error('Create invitation benefit error:', err);
    return NextResponse.json({ error: '发布福利失败' }, { status: 500 });
  }
}

// PUT /api/admin/invitation-benefits - 更新邀请福利（管理员）
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== 'admin') {
      return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
    }

    const body = await request.json();
    const { id, title, content, is_active } = body;

    if (!id) {
      return NextResponse.json({ error: '缺少福利ID' }, { status: 400 });
    }

    const updateObj: Record<string, unknown> = {};
    if (title !== undefined && title !== null) updateObj.title = title;
    if (content !== undefined && content !== null) updateObj.content = content;
    if (is_active !== undefined && is_active !== null) updateObj.is_active = is_active;

    if (Object.keys(updateObj).length === 0) {
      return NextResponse.json({ error: '没有更新内容' }, { status: 400 });
    }
    updateObj.updated_at = new Date().toISOString();

    const { data: benefit, error } = await supabase
      .from('invitation_benefits')
      .update(updateObj)
      .eq('id', id)
      .select('id, title, content, is_active, created_at, updated_at')
      .single();

    if (error) {
      console.error('Update invitation benefit error:', error);
      return NextResponse.json({ error: '更新福利失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true, benefit });
  } catch (err) {
    console.error('Update invitation benefit error:', err);
    return NextResponse.json({ error: '更新福利失败' }, { status: 500 });
  }
}

// DELETE /api/admin/invitation-benefits - 删除邀请福利（管理员）
export async function DELETE(request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== 'admin') {
      return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: '缺少福利ID' }, { status: 400 });
    }

    const { error } = await supabase
      .from('invitation_benefits')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Delete invitation benefit error:', error);
      return NextResponse.json({ error: '删除福利失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Delete invitation benefit error:', err);
    return NextResponse.json({ error: '删除福利失败' }, { status: 500 });
  }
}
