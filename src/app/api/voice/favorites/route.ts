import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-middleware';
import { getSupabase } from '@/lib/api-middleware';

const MAX_FAVORITES = 100;

// GET - 获取当前用户的收藏音色列表
export async function GET(req: NextRequest) {
  return withAuth(req, async (user) => {
    try {
      const supabase = getSupabase();

      const { data, error } = await (supabase as any)
        .from('voice_favorites')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[voice-favorites] 查询失败:', error);
        return NextResponse.json({ error: '查询收藏失败' }, { status: 500 });
      }

      return NextResponse.json({
        favorites: data || [],
        count: data?.length || 0,
        max: MAX_FAVORITES,
      });
    } catch (err) {
      console.error('[voice-favorites] GET error:', err);
      return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
  });
}

// POST - 添加收藏
export async function POST(req: NextRequest) {
  return withAuth(req, async (user) => {
    try {
      const supabase = getSupabase();
      const body = await req.json();
      const { voice_id, voice_name, engine, gender, language, style_tags, is_cloned, clone_id } = body;

      if (!voice_id || !voice_name || !engine) {
        return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
      }

      const { data, error } = await (supabase as any).rpc('save_voice_favorite_atomic', {
        p_user_id: user.id, p_voice_id: String(voice_id), p_voice_name: String(voice_name), p_engine: String(engine),
        p_gender: gender || null, p_language: language || null,
        p_style_tags: Array.isArray(style_tags) ? style_tags.map(String).slice(0,20) : [], p_is_cloned: !!is_cloned, p_clone_id: clone_id || null,
      });
      if (error) {
        const limited = error.message.includes('VOICE_FAVORITE_LIMIT');
        return NextResponse.json({ error: limited ? '最多收藏100个音色，请先取消部分收藏' : '收藏尚未保存，请稍后重试', code: limited ? 'FAVORITE_LIMIT' : 'FAVORITE_SAVE_FAILED' }, { status: limited ? 400 : 503 });
      }
      return NextResponse.json(data);
    } catch (err) {
      console.error('[voice-favorites] POST error:', err);
      return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
  });
}

// DELETE - 取消收藏
export async function DELETE(req: NextRequest) {
  return withAuth(req, async (user) => {
    try {
      const supabase = getSupabase();
      const { searchParams } = new URL(req.url);
      const favoriteId = searchParams.get('id');
      const voiceId = searchParams.get('voice_id');
      const engine = searchParams.get('engine');

      let query = (supabase as any).from('voice_favorites').delete().eq('user_id', user.id);

      if (favoriteId) {
        query = query.eq('id', favoriteId);
      } else if (voiceId && engine) {
        query = query.eq('voice_id', voiceId).eq('engine', engine);
      } else {
        return NextResponse.json({ error: '缺少删除条件' }, { status: 400 });
      }

      const { error } = await query;

      if (error) {
        console.error('[voice-favorites] 删除失败:', error);
        return NextResponse.json({ error: '取消收藏失败' }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    } catch (err) {
      console.error('[voice-favorites] DELETE error:', err);
      return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
  });
}
