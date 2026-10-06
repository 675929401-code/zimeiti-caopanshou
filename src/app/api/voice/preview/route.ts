import { readVoiceCatalog } from '@/lib/voice-studio/catalog';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { withAuth } from '@/lib/api-middleware';
import { getClientIP } from '@/lib/security-edge';
import { findVoiceBySpeakerId } from '@/lib/vs/voices-data';
import { cachedVoicePreview, voicePreviewProviderIdentity } from '@/lib/server/voice-preview-cache';
import { resolvePreviewApiKey, synthesizeConfiguredVoicePreview, PreviewRateLimitError } from '@/lib/server/voice-preview-synthesis';
import { resolveVoicePreviewText } from '@/lib/vs/preview-texts';

const PREVIEW_WINDOW_MS = 60_000;
const PREVIEW_USER_LIMIT = 6;
const PREVIEW_IP_LIMIT = 24;
const SPEAKER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/u;

type PreviewRateBucket = { timestamps: number[] };
const previewRateGlobal = globalThis as typeof globalThis & {
  __voicePreviewRateBuckets?: Map<string, PreviewRateBucket>;
};
const previewRateBuckets = previewRateGlobal.__voicePreviewRateBuckets
  || (previewRateGlobal.__voicePreviewRateBuckets = new Map<string, PreviewRateBucket>());

function consumePreviewRateLimit(key: string, limit: number) {
  const now = Date.now();
  const bucket = previewRateBuckets.get(key) || { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < PREVIEW_WINDOW_MS);
  if (bucket.timestamps.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.timestamps[0] + PREVIEW_WINDOW_MS - now) / 1000));
    previewRateBuckets.set(key, bucket);
    return { allowed: false, retryAfter };
  }
  bucket.timestamps.push(now);
  previewRateBuckets.set(key, bucket);

  // Bound stale identities in long-running processes without adding a timer to
  // the route module. A distributed limiter is still required for multi-node
  // deployments; this closes the current single-process abuse path.
  if (previewRateBuckets.size > 5_000) {
    for (const [bucketKey, candidate] of previewRateBuckets) {
      if (candidate.timestamps.every((timestamp) => now - timestamp >= PREVIEW_WINDOW_MS)) {
        previewRateBuckets.delete(bucketKey);
      }
    }
  }
  return { allowed: true, retryAfter: 0 };
}

function enforcePreviewRateLimit(userId: string, ip: string) {
  const ipResult = consumePreviewRateLimit(`ip:${ip || 'unknown'}`, PREVIEW_IP_LIMIT);
  if (!ipResult.allowed) return ipResult;
  return consumePreviewRateLimit(`user:${userId}`, PREVIEW_USER_LIMIT);
}

/**
 * 登录用户固定文案试听（不扣用户余额，但会产生供应商成本）
 * POST /api/voice/preview
 * Body: { speakerId: string, category?: string, engine?: string }
 */
export const POST = async (req: NextRequest) => withAuth(req, async (user) => {
  try {
    const ipLimit = consumePreviewRateLimit('read-ip:' + getClientIP(req), 2400);
    const rateLimit = ipLimit.allowed ? consumePreviewRateLimit('read-user:' + user.id, 180) : ipLimit;
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: '试听请求过于频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } },
      );
    }

    const body = await req.json();
    const speakerId = typeof body?.speakerId === 'string' ? body.speakerId.trim() : '';
    const category = typeof body?.category === 'string' ? body.category.trim() : '';

    if (!SPEAKER_ID_PATTERN.test(speakerId)) {
      return NextResponse.json({ success: false, error: 'speakerId 格式无效' }, { status: 400 });
    }

    const catalogVoice = readVoiceCatalog(true).find(v=>v.speakerId===speakerId);
    if(catalogVoice && !catalogVoice.isActive)return NextResponse.json({success:false,error:'该音色已下架，请选择其他音色。'},{status:409});
    if (!catalogVoice) {
      const owned = await getSupabaseClient().from('voice_training_authorization_jobs').select('id').eq('user_id',user.id).eq('provider_speaker_id',speakerId).eq('status','completed').limit(1);
      if(owned.error || !owned.data?.length) return NextResponse.json({success:false,error:'音色不存在或不属于当前账号'},{status:404});
    }
    // 只允许服务端固定演示文案；客户端不能借试听入口合成任意文本。
    const previewText = resolveVoicePreviewText(category);

    // 获取火山引擎 API Key
    const apiKey = await resolvePreviewApiKey();

    if (!apiKey) {
      return NextResponse.json({
        success: false,
        message: '试听服务尚未在统一配置中心启用',
        previewMode: true,
      }, { status: 503 });
    }

    console.log(`[Preview] speaker=${speakerId}, text="${previewText}" (${previewText.length} chars)`);

    const voiceInfo = findVoiceBySpeakerId(speakerId);
    const cached = await cachedVoicePreview({ speakerId, text: previewText, providerIdentity: voicePreviewProviderIdentity(apiKey, voiceInfo?.resourceId), ownerId: voiceInfo ? null : user.id }, async () => {
    const allowance = enforcePreviewRateLimit(user.id, getClientIP(req));
    if (!allowance.allowed) throw new PreviewRateLimitError(allowance.retryAfter);
    return synthesizeConfiguredVoicePreview(speakerId, previewText, apiKey);
    });
    const result = cached.audio;

    // 日志：音频数据大小，便于排查截断问题
    const audioLen = result.audioUrl.startsWith('data:') ? result.audioUrl.length : result.audioUrl.length;
    console.log(`[Preview] OK speaker=${speakerId}, audioUrl length=${audioLen}, duration=${result.duration}`);

    return NextResponse.json({
      success: true,
      previewMode: true,
      cacheHit: cached.cacheHit,
      data: {
        audioUrl: result.audioUrl,
        duration: result.duration,
        text: previewText,
        speakerId,
      },
    });
  } catch (e: unknown) {
    if (e instanceof PreviewRateLimitError) return NextResponse.json({ success: false, error: '新音色试听正在准备，请稍后再试；已加载音色仍可试听' }, { status: 429, headers: { 'Retry-After': String(e.retryAfter) } });
    const diagnostic = e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240);
    console.error('[VoicePreview] synthesis failed:', diagnostic);
    return NextResponse.json({ success: false, error: '试听合成失败，请稍后重试' }, { status: 502 });
  }
});
