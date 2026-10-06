import { NextRequest, NextResponse } from 'next/server';
import { withAuth, AuthUser } from '@/lib/api-middleware';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { toUserVoiceDto, type UserVoiceRecord } from '@/lib/vs/user-voice-dto';

const MAX_VOICES_PER_TYPE = 10;

function privateNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/** GET /api/voice/user-voices — 获取用户的音色列表 */
export async function GET(request: NextRequest) {
  try {
    const response = await withAuth(request, async (user: AuthUser) => {
      const db = getSupabaseClient();
      const { searchParams } = new URL(request.url);
      const voiceType = searchParams.get('type'); // 'clone' | 'design' | null (all)

      // Read only the portable columns guaranteed by the forward migration. The
      // public DTO never exposes user_id or the provider-specific source payload.
      const { data, error } = await db
        .from('user_voices')
        .select('id,voice_type,voice_name,speaker_id,language,source_info,created_at,updated_at')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error || !Array.isArray(data)) {
        return NextResponse.json({
          success: false,
          error: '账号音色暂时无法读取，请稍后重试',
          code: 'VOICE_USER_CATALOG_UNAVAILABLE',
        }, { status: 503 });
      }

      const allRecords = data as UserVoiceRecord[];
      const visibleRecords = voiceType === 'clone' || voiceType === 'design'
        ? allRecords.filter(item => item.voice_type === voiceType)
        : allRecords;
      const cloneCount = allRecords.filter(item => item.voice_type === 'clone').length;
      const designCount = allRecords.filter(item => item.voice_type === 'design').length;

      return NextResponse.json({
        success: true,
        voices: visibleRecords.map(toUserVoiceDto),
        limits: {
          clone: { used: cloneCount, max: MAX_VOICES_PER_TYPE },
          design: { used: designCount, max: MAX_VOICES_PER_TYPE },
        },
      });
    });
    return privateNoStore(response);
  } catch {
    return privateNoStore(NextResponse.json({
      success: false,
      error: '账号音色暂时无法读取，请稍后重试',
      code: 'VOICE_USER_CATALOG_UNAVAILABLE',
    }, { status: 503 }));
  }
}

/**
 * POST is intentionally closed. User voices are materialized only by the
 * server-side training lifecycle after a completed, owner-bound provider job.
 * Accepting a client supplied speakerId here would turn catalog persistence
 * into an authorization bypass.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async () => NextResponse.json({
    success: false,
    code: 'VOICE_USER_CATALOG_WRITE_FORBIDDEN',
    error: '个人音色只能由已完成的音色训练任务自动写入。',
  }, { status: 410 }));
}

/** DELETE /api/voice/user-voices — 删除用户音色 */
export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    const db = getSupabaseClient();
    const { searchParams } = new URL(request.url);
    const voiceId = searchParams.get('id');

    if (!voiceId) {
      return NextResponse.json({
        success: false,
        error: '请选择要删除的音色',
        code: 'VOICE_ID_REQUIRED',
      }, { status: 400 });
    }

    // 软删除
    const { error } = await db
      .from('user_voices')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', voiceId)
      .eq('user_id', user.id);

    if (error) {
      return NextResponse.json({
        success: false,
        error: '音色暂时无法删除，请稍后重试',
        code: 'VOICE_USER_DELETE_FAILED',
      }, { status: 503 });
    }
    return NextResponse.json({ success: true });
  });
}
