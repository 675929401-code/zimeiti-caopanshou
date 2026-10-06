import { NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// GET /api/invitation/benefits - 获取邀请福利（公开接口）
export async function GET() {
  try {
    const { data: benefits, error } = await getSupabaseClient()
      .from('invitation_benefits')
      .select('id, title, content, is_active, created_at, updated_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    return NextResponse.json({ success: true, benefits: benefits || [] });
  } catch (err) {
    console.error('Fetch invitation benefits error:', err);
    return NextResponse.json(
      { error: '邀请福利暂时不可用', code: 'REALTIME_DATA_UNAVAILABLE' },
      { status: 503 },
    );
  }
}
