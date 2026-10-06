import { NextRequest } from 'next/server';
import { synthesizeSpeechSSE, TtsAudioParams, TtsAdditions } from '@/lib/volcengine';
import { getResourceIdBySpeaker, getDefaultModelBySpeaker } from '@/lib/voices-data';
import { getUserFromRequest } from '@/lib/auth';
import { estimateCost, deductBalance } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const {
    text, ssml, speaker, model,
    pitch = 0, speechRate = 0, loudnessRate = 0,
    format = 'mp3', sampleRate = 24000,
    emotion, emotionScale,
    enableSubtitle,
    contextTexts, sectionId,
    explicitLanguage, explicitDialect,
    silenceDuration, enableLanguageDetector,
    disableMarkdownFilter, disableEmojiFilter, enableLatexTn,
    resourceId: customResourceId,
    skipBilling,
  } = body;

  if (!text && !ssml) {
    return new Response(JSON.stringify({ error: 'text 或 ssml 参数不能为空' }), { status: 400 });
  }
  if (!speaker) {
    return new Response(JSON.stringify({ error: 'speaker 参数不能为空' }), { status: 400 });
  }

  try {
    // 扣费逻辑：登录用户且未跳过扣费时执行
    const contentText = text || (typeof ssml === 'string' ? ssml : '');
    const charCount = contentText.length;
    let billingError: string | null = null;

    if (!skipBilling) {
      const authUser = await getUserFromRequest(request);
      if (authUser) {
        // 直接使用 deductBalance（内部会计算费用并检查余额）
        const deduct = await deductBalance(authUser.userId, charCount, `sse-${Date.now()}`, `SSE流式合成 ${speaker}`);
        if (!deduct.success) {
          return new Response(JSON.stringify({ error: deduct.error || '余额不足' }), {
            status: 402,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    if (billingError) {
      return new Response(JSON.stringify({ error: billingError }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const resourceId = customResourceId || getResourceIdBySpeaker(speaker);

    const audioParams: TtsAudioParams = {
      format,
      sample_rate: Number(sampleRate) as 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000,
      speech_rate: Number(speechRate),
      loudness_rate: Number(loudnessRate),
    };
    if (emotion) audioParams.emotion = emotion;
    if (emotionScale !== undefined) audioParams.emotion_scale = Number(emotionScale);
    if (enableSubtitle !== undefined) audioParams.enable_subtitle = Boolean(enableSubtitle);

    const additions: TtsAdditions = {};
    if (contextTexts && Array.isArray(contextTexts) && contextTexts.length > 0) additions.context_texts = contextTexts;
    if (sectionId) additions.section_id = sectionId;
    if (explicitLanguage) additions.explicit_language = explicitLanguage;
    if (explicitDialect) additions.explicit_dialect = explicitDialect;
    if (silenceDuration !== undefined) additions.silence_duration = Number(silenceDuration);
    if (enableLanguageDetector !== undefined) additions.enable_language_detector = Boolean(enableLanguageDetector);
    if (disableMarkdownFilter !== undefined) additions.disable_markdown_filter = Boolean(disableMarkdownFilter);
    if (disableEmojiFilter !== undefined) additions.disable_emoji_filter = Boolean(disableEmojiFilter);
    if (enableLatexTn !== undefined) additions.enable_latex_tn = Boolean(enableLatexTn);

    const stream = await synthesizeSpeechSSE({
      text, ssml, speaker,
      model: model || getDefaultModelBySpeaker(speaker),
      resourceId,
      audioParams,
      additions: Object.keys(additions).length > 0 ? additions : undefined,
      pitch: Number(pitch),
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
