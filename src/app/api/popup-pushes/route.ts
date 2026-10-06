import { NextRequest, NextResponse } from 'next/server';
import { executeSql } from '@/lib/sql-exec';
import { uuidToString } from '@/lib/sql-exec';
import { authorizeToken, getTokenFromHeaders } from '@/lib/auth';
import { normalizePopupDismissBehavior } from '@/lib/popup-push-domain';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Authorization, Cookie',
};

// GET /api/popup-pushes - 获取当前用户应看到的弹窗
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ success: true, popups: [] }, { headers: PRIVATE_HEADERS });
    }
    const authorization = await authorizeToken(token);
    if (!authorization.ok) {
      return NextResponse.json(
        {
          success: false,
          popups: [],
          error: authorization.error,
          code: authorization.code,
        },
        { status: authorization.status, headers: PRIVATE_HEADERS },
      );
    }
    const { userId, role: userRole } = authorization.actor;
    const memberStatus = 'active';

    // 查数据库获取用户 member_status
    let actualMemberStatus = memberStatus;
    try {
      const userResult = await executeSql<{ member_status: string }>(
        `SELECT member_status FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      if (userResult.length > 0) {
        actualMemberStatus = userResult[0]?.member_status || 'inactive';
      }
    } catch {
      // 降级到默认值
    }

    // 获取所有启用的弹窗
    const allPopups = await executeSql<{
      id: string; title: string; content: string;
      wechat_id: string; wechat_label: string; wechat_note: string;
      show_cami_entry: boolean; show_trial_plans: boolean;
      target_audience: string; dismiss_behavior: string; priority: number;
    }>(
      `SELECT id, title, content, wechat_id, wechat_label, wechat_note,
        show_cami_entry, show_trial_plans, target_audience, dismiss_behavior, priority
      FROM popup_pushes WHERE is_enabled = true ORDER BY priority DESC, created_at DESC`
    );

    // 根据目标受众过滤
    const popups = allPopups.filter(p => {
      switch (p.target_audience) {
        case 'all_users': return true;
        case 'inactive_members': return actualMemberStatus === 'inactive' || actualMemberStatus === 'expired';
        case 'active_members': return actualMemberStatus === 'active';
        case 'non_admin': return userRole !== 'admin';
        default: return true;
      }
    }).map(p => ({
      ...p,
      id: uuidToString(p.id),
      is_enabled: true,
      dismiss_behavior: normalizePopupDismissBehavior(p.dismiss_behavior),
    }));

    return NextResponse.json({ success: true, popups }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    console.error('获取弹窗推送失败:', error);
    return NextResponse.json(
      { success: false, popups: [], error: '弹窗配置暂时不可用' },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
