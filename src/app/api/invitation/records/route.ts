import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import type { SupabaseClient } from '@supabase/supabase-js';

const RECORD_PAGE_SIZE = 500;
const USER_BATCH_SIZE = 150;

async function fetchAllInvitationRecords(database: SupabaseClient, inviterId: string) {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += RECORD_PAGE_SIZE) {
    const result = await database
      .from('invitation_records')
      .select('id, inviter_id, invitee_id, invitee_activated, invited_at, activated_at')
      .eq('inviter_id', inviterId)
      .order('invited_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + RECORD_PAGE_SIZE - 1);
    if (result.error) throw result.error;
    const page = (result.data || []) as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < RECORD_PAGE_SIZE) return rows;
  }
}

// GET /api/invitation/records - 获取我的邀请记录
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: '无效的登录状态' }, { status: 401 });
    }

    const database = getSupabaseClient();
    const [recordsArr, totalResult, activatedResult] = await Promise.all([
      fetchAllInvitationRecords(database, payload.userId),
      database
        .from('invitation_records')
        .select('id', { count: 'exact', head: true })
        .eq('inviter_id', payload.userId),
      database
        .from('invitation_records')
        .select('id', { count: 'exact', head: true })
        .eq('inviter_id', payload.userId)
        .eq('invitee_activated', true),
    ]);
    if (totalResult.error || activatedResult.error) {
      throw totalResult.error || activatedResult.error;
    }

    // 获取被邀请人信息；分批避免大型 .in() 过滤器超过 URL 限制。
    const inviteeIds = Array.from(new Set(
      recordsArr.map((record) => String(record.invitee_id || '')).filter(Boolean),
    ));

    const inviteeMap: Record<string, { display_name: string; phone: string; member_status: string }> = {};

    for (let offset = 0; offset < inviteeIds.length; offset += USER_BATCH_SIZE) {
      const inviteesResult = await database
        .from('users')
        .select('id, display_name, phone, member_status')
        .in('id', inviteeIds.slice(offset, offset + USER_BATCH_SIZE));
      if (inviteesResult.error) throw inviteesResult.error;

      for (const user of (inviteesResult.data || []) as Array<Record<string, unknown>>) {
        inviteeMap[String(user.id || '')] = {
          display_name: String(user.display_name || '未知用户'),
          phone: String(user.phone || ''),
          member_status: String(user.member_status || 'inactive'),
        };
      }
    }

    const enrichedRecords = recordsArr.map((r) => ({
      id: String(r.id || ''),
      invitee: inviteeMap[String(r.invitee_id || '')] || { display_name: '未知用户', phone: '', member_status: 'inactive' },
      invitee_activated: r.invitee_activated === true,
      invited_at: String(r.invited_at || ''),
      activated_at: r.activated_at ? String(r.activated_at) : null,
    }));

    // 统计数据
    const totalInvited = Number(totalResult.count || 0);
    const activatedCount = Number(activatedResult.count || 0);

    return NextResponse.json({
      success: true,
      records: enrichedRecords,
      stats: { totalInvited, activatedCount },
    });
  } catch (err) {
    console.error('Fetch invitation records error:', err);
    return NextResponse.json({ error: '实时邀请记录暂时不可用' }, { status: 503 });
  }
}
