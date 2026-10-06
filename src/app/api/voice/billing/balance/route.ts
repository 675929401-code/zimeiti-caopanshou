import { NextRequest, NextResponse } from 'next/server';
import { getServerSecret, safeCompareSecret } from '@/lib/server-secrets';

function getDb() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSupabaseClient } = require('@/storage/database/supabase-client');
  return getSupabaseClient();
}

/**
 * GET /api/voice/billing/balance?user_id=xxx
 * 智音工坊调用此接口查询主站用户的现金余额。
 * 需要 X-Site-API-Key 头进行服务间认证。
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('X-Site-API-Key');
    const expectedKey = getServerSecret('SITE_API_KEY', 'zyuani8-voice-studio-secret-2026');
    if (!safeCompareSecret(apiKey, expectedKey)) {
      return NextResponse.json({ error: '认证失败' }, { status: 401 });
    }

    const userId = request.nextUrl.searchParams.get('user_id');
    if (!userId) {
      return NextResponse.json({ error: '缺少 user_id' }, { status: 400 });
    }

    const db = getDb();
    const { data, error } = await db
      .from('users')
      .select('cash_balance')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return NextResponse.json({ success: true, balance: 0 });
    }

    const balance = (data as Record<string, unknown>).cash_balance as number || 0;
    return NextResponse.json({ success: true, balance });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
