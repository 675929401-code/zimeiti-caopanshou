// 音槽授权管理 API（管理员专用）
// POST — 授权/取消授权用户购买音槽
import { NextRequest, NextResponse } from 'next/server';
import { executeSql } from '@/lib/sql-exec';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, 'member_permissions.manage', {
    requireStepUp: true,
    operation: 'voice_nest_member_authorization',
  });
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const targetUserId = body.userId;
    const authorized = body.authorized === true;

    if (!targetUserId) {
      return NextResponse.json(
        { success: false, message: '缺少目标用户ID' },
        { status: 400 }
      );
    }

    const sql = `
        UPDATE users
        SET voice_clone_authorized = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, username, voice_clone_authorized
      `;
    const rows = await executeSql(sql, [authorized, targetUserId]);

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        { success: false, message: '用户不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: authorized ? '已授权用户购买音槽' : '已取消用户音槽授权',
      data: {
        userId: rows[0].id,
        username: rows[0].username,
        authorized: rows[0].voice_clone_authorized,
      },
    });
  } catch (e) {
    console.error('[voice/nest/authorize] error:', e);
    return NextResponse.json(
      { success: false, message: '授权操作失败: ' + (e as Error).message },
      { status: 500 }
    );
  }
}

// 查询所有待授权用户列表（管理员用）
export async function GET(request: NextRequest) {
  const memberAccess = await authorizeAdminCapability(request, 'members.view', {
    operation: 'voice_nest_member_list',
  });
  if (!memberAccess.ok) return memberAccess.response;
  const billingAccess = await authorizeAdminCapability(request, 'billing.view', {
    operation: 'voice_nest_member_balance_list',
  });
  if (!billingAccess.ok) return billingAccess.response;

  try {
    const sql = `
        SELECT id, username, email, voice_clone_authorized, cash_balance, created_at
        FROM users
        WHERE role != 'admin'
        ORDER BY created_at DESC
        LIMIT 100
      `;
    const rows = await executeSql(sql, []);

    return NextResponse.json({
      success: true,
      data: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        username: r.username,
        email: r.email,
        authorized: r.voice_clone_authorized || false,
        cashBalance: r.cash_balance || 0,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    console.error('[voice/nest/authorize] GET error:', e);
    return NextResponse.json(
      { success: false, message: '查询失败: ' + (e as Error).message },
      { status: 500 }
    );
  }
}
