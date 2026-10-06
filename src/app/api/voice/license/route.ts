import { VOICE_PAID_TRAINING_ENABLED } from '@/lib/vs/feature-policy';
// 用户端授权密钥 API
// GET  — 查询当前用户的密钥状态（有效密钥 + 剩余训练次数）
// POST — 激活密钥（将密钥绑定到当前用户）
import { NextRequest, NextResponse } from 'next/server';
import { withAuth, AuthUser } from '@/lib/api-middleware';
import { getSupabaseClient } from '@/storage/database/supabase-client';

/** 查询当前用户的密钥状态 */
export async function GET(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    try {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from('voice_clone_licenses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const licenses = (data || []) as Record<string, unknown>[];
      // 找到有效密钥（status=active 且有剩余训练次数）
      const activeLicense = licenses.find(
        (l) => l.status === 'active' && Number(l.used_trainings) < Number(l.max_trainings)
      );

      return NextResponse.json({
        success: true,
        data: {
          hasActiveLicense: !!activeLicense,
          activeLicense: activeLicense
            ? {
                id: activeLicense.id,
                licenseKey: activeLicense.license_key,
                maxTrainings: Number(activeLicense.max_trainings),
                usedTrainings: Number(activeLicense.used_trainings),
                remaining: Number(activeLicense.max_trainings) - Number(activeLicense.used_trainings),
                voiceType: activeLicense.voice_type,
                voiceName: activeLicense.voice_name,
                speakerId: activeLicense.speaker_id,
              }
            : null,
          allLicenses: licenses.map((l: Record<string, unknown>) => ({
            id: l.id,
            licenseKey: l.license_key,
            status: l.status,
            maxTrainings: l.max_trainings,
            usedTrainings: l.used_trainings,
            voiceType: l.voice_type,
            voiceName: l.voice_name,
            createdAt: l.created_at,
            activatedAt: l.activated_at,
          })),
        },
      });
    } catch (e) {
      console.error('[voice/license] GET error:', e);
      return NextResponse.json(
        { success: false, message: '查询密钥状态失败: ' + (e as Error).message },
        { status: 500 }
      );
    }
  });
}

/** 激活密钥 — 将密钥绑定到当前用户 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    if (!VOICE_PAID_TRAINING_ENABLED) return NextResponse.json({ success: false, code: 'VOICE_TRAINING_RETIRED', message: '声音复刻和声音设计已下架，请使用语音合成或音色模仿。' }, { status: 410 });
    try {
      const body = await request.json();
      const licenseKey = (body.licenseKey || '').trim().toUpperCase();

      if (!licenseKey) {
        return NextResponse.json(
          { success: false, message: '请输入密钥' },
          { status: 400 }
        );
      }

      const db = getSupabaseClient();

      // 1. 查找密钥
      const { data: license, error: findError } = await db
        .from('voice_clone_licenses')
        .select('*')
        .eq('license_key', licenseKey)
        .single();

      if (findError || !license) {
        return NextResponse.json(
          { success: false, message: '密钥不存在，请检查输入' },
          { status: 404 }
        );
      }

      // 2. 检查密钥状态
      if (license.status === 'revoked') {
        return NextResponse.json(
          { success: false, message: '此密钥已被吊销，请联系管理员' },
          { status: 403 }
        );
      }

      if (license.status === 'used') {
        return NextResponse.json(
          { success: false, message: '此密钥已用完所有训练次数' },
          { status: 403 }
        );
      }

      // 3. 检查是否已被其他用户绑定
      if (license.user_id && license.user_id !== user.id) {
        return NextResponse.json(
          { success: false, message: '此密钥已被其他用户激活' },
          { status: 403 }
        );
      }

      // 4. 检查用户是否已有其他有效密钥（一个用户同时只能有一个有效密钥）
      if (!license.user_id) {
        const { data: existingActive } = await db
          .from('voice_clone_licenses')
          .select('id, license_key')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .neq('id', license.id)
          .maybeSingle();

        if (existingActive) {
          return NextResponse.json(
            {
              success: false,
              message: `您已有一个有效密钥（${existingActive.license_key}），请先用完再激活新密钥`,
            },
            { status: 409 }
          );
        }
      }

      // 5. 绑定密钥到用户
      const { error: updateError } = await db
        .from('voice_clone_licenses')
        .update({
          user_id: user.id,
          activated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', license.id)
        .is('user_id', null); // CAS 防并发

      if (updateError) throw updateError;

      return NextResponse.json({
        success: true,
        message: '密钥激活成功！您现在可以使用声音复刻和声音设计功能了',
        data: {
          licenseKey: license.license_key,
          maxTrainings: license.max_trainings,
          usedTrainings: license.used_trainings,
          remaining: license.max_trainings - license.used_trainings,
        },
      });
    } catch (e) {
      console.error('[voice/license] POST error:', e);
      return NextResponse.json(
        { success: false, message: '激活密钥失败: ' + (e as Error).message },
        { status: 500 }
      );
    }
  });
}
