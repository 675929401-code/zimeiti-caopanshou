import { VOICE_PAID_TRAINING_ENABLED } from '@/lib/vs/feature-policy';
// 智音工坊授权密钥管理 API（管理员专用）
// 使用 Supabase (PostgreSQL) 替代原有 SQLite
// GET    — 获取所有授权密钥
// POST   — 生成授权密钥（ZY-XXXX-XXXX 格式，默认15次训练）
// PUT    — 更新密钥状态（吊销/重新激活）
// DELETE — 删除密钥
import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth, AuthUser } from '@/lib/api-middleware';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/** 获取所有授权密钥 */
export async function GET(request: NextRequest) {
  return withAdminAuth(request, async (_user: AuthUser) => {
    try {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from('voice_clone_licenses')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // 转换为前端期望的 camelCase 格式
      const mapped = (data || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        licenseKey: row.license_key,
        status: row.status,
        userId: row.user_id,
        speakerId: row.speaker_id,
        voiceType: row.voice_type,
        voiceName: row.voice_name,
        maxTrainings: row.max_trainings,
        usedTrainings: row.used_trainings,
        createdAt: row.created_at,
        activatedAt: row.activated_at,
      }));

      return NextResponse.json({ success: true, data: mapped });
    } catch (error) {
      console.error('[voice-studio licenses] GET error:', error);
      return NextResponse.json({ success: false, message: '获取授权密钥失败' }, { status: 500 });
    }
  });
}

/** 生成授权密钥 */
export async function POST(request: NextRequest) {
  return withAdminAuth(request, async (_user: AuthUser) => {
    if (!VOICE_PAID_TRAINING_ENABLED) return NextResponse.json({ success: false, code: 'VOICE_TRAINING_RETIRED', message: '声音复刻和声音设计已下架，请使用语音合成或音色模仿。' }, { status: 410 });
    try {
      const body = await request.json();
      const maxTrainings = Number(body.maxTrainings) || 15;

      const db = getSupabaseClient();

      // 生成格式: ZY-XXXX-XXXX，确保唯一
      const genSegment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
      let licenseKey = `ZY-${genSegment()}-${genSegment()}`;
      let attempts = 0;
      while (attempts < 5) {
        const { data: existing } = await db
          .from('voice_clone_licenses')
          .select('id')
          .eq('license_key', licenseKey)
          .maybeSingle();
        if (!existing) break;
        licenseKey = `ZY-${genSegment()}-${genSegment()}`;
        attempts++;
      }

      const { data, error } = await db
        .from('voice_clone_licenses')
        .insert({
          license_key: licenseKey,
          status: 'active',
          max_trainings: maxTrainings,
          used_trainings: 0,
        })
        .select()
        .single();

      if (error) throw error;

      return NextResponse.json({
        success: true,
        data: { id: data.id, licenseKey: data.license_key },
        message: '授权密钥生成成功',
      });
    } catch (error) {
      console.error('[voice-studio licenses] POST error:', error);
      return NextResponse.json({ success: false, message: '生成授权密钥失败' }, { status: 500 });
    }
  });
}

/** 更新授权密钥状态 */
export async function PUT(request: NextRequest) {
  return withAdminAuth(request, async (_user: AuthUser) => {
    try {
      const body = await request.json();
      const { id, status } = body;
      if (!VOICE_PAID_TRAINING_ENABLED && status !== 'revoked') return NextResponse.json({ success: false, code: 'VOICE_TRAINING_RETIRED', message: '已下架产品不再启用新授权。' }, { status: 410 });

      if (!id) {
        return NextResponse.json({ success: false, message: '缺少密钥ID' }, { status: 400 });
      }

      const db = getSupabaseClient();
      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (status !== undefined) updateData.status = status;

      const { error } = await db
        .from('voice_clone_licenses')
        .update(updateData)
        .eq('id', id);

      if (error) throw error;

      return NextResponse.json({ success: true, message: '授权密钥更新成功' });
    } catch (error) {
      console.error('[voice-studio licenses] PUT error:', error);
      return NextResponse.json({ success: false, message: '更新授权密钥失败' }, { status: 500 });
    }
  });
}

/** 删除授权密钥 */
export async function DELETE(request: NextRequest) {
  return withAdminAuth(request, async (_user: AuthUser) => {
    try {
      const { searchParams } = new URL(request.url);
      const id = searchParams.get('id');

      if (!id) {
        return NextResponse.json({ success: false, message: '缺少密钥ID' }, { status: 400 });
      }

      const db = getSupabaseClient();
      const { error } = await db
        .from('voice_clone_licenses')
        .delete()
        .eq('id', id);

      if (error) throw error;

      return NextResponse.json({ success: true, message: '授权密钥删除成功' });
    } catch (error) {
      console.error('[voice-studio licenses] DELETE error:', error);
      return NextResponse.json({ success: false, message: '删除授权密钥失败' }, { status: 500 });
    }
  });
}
