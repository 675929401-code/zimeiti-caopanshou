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

// POST - 恢复已删除的智能体
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const { agentId } = await request.json();
    if (!agentId) {
      return NextResponse.json({ error: '智能体ID不能为空' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { error } = await client
      .from('agents')
      .update({ deleted_at: null })
      .eq('id', agentId);

    if (error) {
      return NextResponse.json({ error: `恢复智能体失败: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: '已恢复智能体' });
  } catch (err) {
    console.error('Restore agent error:', err);
    return NextResponse.json({ error: '恢复智能体失败' }, { status: 500 });
  }
}

// DELETE - 永久删除智能体
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('id');

    if (!agentId) {
      return NextResponse.json({ error: '智能体ID不能为空' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { error } = await client.from('agents').delete().eq('id', agentId);

    if (error) {
      return NextResponse.json({ error: `永久删除失败: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: '已永久删除' });
  } catch (err) {
    console.error('Permanent delete error:', err);
    return NextResponse.json({ error: '永久删除失败' }, { status: 500 });
  }
}
