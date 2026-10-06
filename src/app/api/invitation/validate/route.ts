import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// POST /api/invitation/validate - 验证邀请码
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { code } = body;

    if (!code) {
      return NextResponse.json({ error: '请输入邀请码' }, { status: 400 });
    }

    const database = getSupabaseClient();
    const result = await database
      .from('invitation_codes')
      .select('id, code, is_used, user_id')
      .eq('code', String(code).toUpperCase().trim())
      .maybeSingle();
    if (result.error) throw result.error;

    if (!result.data) {
      return NextResponse.json({ valid: false, error: '邀请码不存在' }, { status: 200 });
    }

    const inviteCode = result.data as Record<string, unknown>;
    if (!inviteCode || inviteCode.is_used === true || inviteCode.is_used === 't' || inviteCode.is_used === 'true') {
      return NextResponse.json({ valid: false, error: '邀请码已被使用' }, { status: 200 });
    }

    const ownerId = inviteCode.user_id ? String(inviteCode.user_id) : null;
    return NextResponse.json({ valid: true, codeId: String(inviteCode.id || ''), ownerId });
  } catch (err) {
    console.error('Validate invitation code error:', err);
    return NextResponse.json({ error: '实时邀请码服务暂时不可用' }, { status: 503 });
  }
}
