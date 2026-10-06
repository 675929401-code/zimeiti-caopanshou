import { NextRequest } from 'next/server';
import { synthesizeSpeech, splitLongText, localizeError, TtsAudioParams, TtsAdditions } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';
import { getResourceIdBySpeaker, getDefaultModelBySpeaker } from '@/lib/voices-data';
import { deductBalance, estimateCost, getPricingConfig, checkBalance } from '@/lib/billing';

// 范围限制：火山官方 speech_rate/loudness_rate 范围 -50~100
function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const {
    text,
    ssml,
    speaker,
    speaker2,
    text2,
    model,
    mode = 'single',
    pitch,
    speed,          // 旧字段兼容（-12~12）→ 自动放大到 -50~100
    volume,         // 旧字段兼容
    speechRate,     // 新字段（-50~100）
    loudnessRate,   // 新字段（-50~100）
    format = 'mp3',
    sampleRate = 24000,
    bitRate,
    emotion,
    emotionScale,
    enableSubtitle,
    enableTimestamp,
    // additions 高级参数
    contextTexts,
    sectionId,
    explicitLanguage,
    explicitDialect,
    silenceDuration,
    enableLanguageDetector,
    disableMarkdownFilter,
    disableEmojiFilter,
    enableLatexTn,
    latexParser,
    maxLengthToFilterParenthesis,
    enableAigcWatermark,
    useCache,
    useSegmentCache,
    muteCutThreshold,
    muteCutRemainMs,
    voiceId,
    resourceId: customResourceId,
    autoSplit = false,
  } = body;

  try {
    // --- 参数校验 ---
    if (!text && !ssml) {
      return errorResponse('text 或 ssml 参数不能为空', 'VALIDATION_ERROR', 400);
    }
    if (!speaker || typeof speaker !== 'string') {
      return errorResponse('speaker 参数不能为空', 'VALIDATION_ERROR', 400);
    }
    if (text && text.length > 5000 && !autoSplit) {
      return errorResponse('文本长度超过5000字符，请开启 autoSplit 自动切分', 'VALIDATION_ERROR', 400);
    }

    // 双人模式校验
    if (mode === 'dual') {
      if (!speaker2 || !text2) {
        return errorResponse('双人模式需要 speaker2 和 text2 参数', 'VALIDATION_ERROR', 400);
      }
    }

    // 自动判断 resource_id（如果用户没指定，按 speaker 前缀判断）
    const resourceId = customResourceId || getResourceIdBySpeaker(speaker);

    // 自动判断默认 model（uranus 用 standard，saturn/ICL 用 expressive）
    const defaultModel = model || getDefaultModelBySpeaker(speaker);

    // 参数范围校验（火山官方范围：speech_rate/loudness_rate = -50~100，pitch = -12~12）
    const safePitch = clamp(Number(pitch) || 0, -12, 12);

    // 兼容旧字段：如果传的是 speed/volume（-12~12），自动放大
    let finalSpeechRate: number;
    let finalLoudnessRate: number;
    if (speechRate !== undefined) {
      finalSpeechRate = clamp(Number(speechRate) || 0, -50, 100);
    } else if (speed !== undefined) {
      // 旧字段 -12~12 → 新字段 -50~100（线性映射）
      finalSpeechRate = clamp(Math.round((Number(speed) || 0) * (100 / 12)), -50, 100);
    } else {
      finalSpeechRate = 0;
    }
    if (loudnessRate !== undefined) {
      finalLoudnessRate = clamp(Number(loudnessRate) || 0, -50, 100);
    } else if (volume !== undefined) {
      finalLoudnessRate = clamp(Math.round((Number(volume) || 0) * (100 / 12)), -50, 100);
    } else {
      finalLoudnessRate = 0;
    }

    // 构造 audio_params
    const audioParams: TtsAudioParams = {
      format: format as TtsAudioParams['format'],
      sample_rate: Number(sampleRate) as TtsAudioParams['sample_rate'],
      speech_rate: finalSpeechRate,
      loudness_rate: finalLoudnessRate,
    };
    if (bitRate !== undefined) audioParams.bit_rate = Number(bitRate);
    if (emotion) audioParams.emotion = emotion;
    if (emotionScale !== undefined) audioParams.emotion_scale = clamp(Number(emotionScale), 1, 5);
    if (enableSubtitle !== undefined) audioParams.enable_subtitle = Boolean(enableSubtitle);
    if (enableTimestamp !== undefined) audioParams.enable_timestamp = Boolean(enableTimestamp);

    // 构造 additions
    const additions: TtsAdditions = {};
    if (contextTexts && Array.isArray(contextTexts) && contextTexts.length > 0) {
      additions.context_texts = contextTexts;
    }
    // 双人模式自动生成 section_id 关联上下文
    if (mode === 'dual') {
      additions.section_id = sectionId || `dual_${Date.now()}`;
    } else if (sectionId) {
      additions.section_id = sectionId;
    }
    if (explicitLanguage) additions.explicit_language = explicitLanguage;
    if (explicitDialect) additions.explicit_dialect = explicitDialect;
    if (silenceDuration !== undefined) additions.silence_duration = clamp(Number(silenceDuration), 0, 30000);
    if (enableLanguageDetector !== undefined) additions.enable_language_detector = Boolean(enableLanguageDetector);
    if (disableMarkdownFilter !== undefined) additions.disable_markdown_filter = Boolean(disableMarkdownFilter);
    if (disableEmojiFilter !== undefined) additions.disable_emoji_filter = Boolean(disableEmojiFilter);
    if (enableLatexTn !== undefined) {
      additions.enable_latex_tn = Boolean(enableLatexTn);
      if (latexParser) additions.latex_parser = 'v2';
    }
    if (maxLengthToFilterParenthesis !== undefined) {
      additions.max_length_to_filter_parenthesis = clamp(Number(maxLengthToFilterParenthesis), 0, 100);
    }
    if (enableAigcWatermark !== undefined) additions.aigc_watermark = Boolean(enableAigcWatermark);
    if (useCache !== undefined || useSegmentCache !== undefined) {
      additions.cache_config = {
        text_type: 1,
        use_cache: useCache !== undefined ? Boolean(useCache) : true,
        use_segment_cache: useSegmentCache !== undefined ? Boolean(useSegmentCache) : true,
      };
    }
    if (muteCutThreshold) additions.mute_cut_threshold = String(muteCutThreshold);
    if (muteCutRemainMs) additions.mute_cut_remain_ms = String(muteCutRemainMs);

    let audioUrl = '';
    let duration = 0;
    let tokensUsed = 0;
    let subtitles: Array<{ text: string; startMs: number; endMs: number }> | undefined;
    let logId: string | undefined;

    if (mode === 'dual') {
      // 双人对话模式：用 section_id 关联两段合成，火山服务端会保持上下文一致性
      const dualText1 = `@音频1 ${text}`;
      const dualText2 = `@音频2 ${text2}`;
      const dualSectionId = additions.section_id!;

      // 第一段
      const result1 = await synthesizeSpeech({
        text: dualText1,
        speaker,
        model: defaultModel,
        resourceId,
        audioParams,
        additions: { ...additions, section_id: dualSectionId },
        pitch: safePitch,
      });
      // 第二段（同 section_id）
      const result2 = await synthesizeSpeech({
        text: dualText2,
        speaker: speaker2,
        model: defaultModel,
        resourceId: getResourceIdBySpeaker(speaker2),
        audioParams,
        additions: { ...additions, section_id: dualSectionId },
        pitch: safePitch,
      });

      audioUrl = result2.audioUrl || result1.audioUrl;
      duration = (result1.duration || 0) + (result2.duration || 0);
      tokensUsed = (result1.tokensUsed || 0) + (result2.tokensUsed || 0);
      logId = result2.logId || result1.logId;
    } else if (autoSplit && text && text.length > 4500) {
      // 长文本自动切分
      const segments = splitLongText(text, 4500);
      let allSubtitles: Array<{ text: string; startMs: number; endMs: number }> = [];
      let totalDuration = 0;
      let lastUrl = '';
      let totalTokens = 0;
      const segSectionId = sectionId || `longtext_${Date.now()}`;

      for (let i = 0; i < segments.length; i++) {
        const segResult = await synthesizeSpeech({
          text: segments[i],
          speaker,
          model: defaultModel,
          resourceId,
          audioParams,
          additions: { ...additions, section_id: segSectionId },
          pitch: safePitch,
        });
        lastUrl = segResult.audioUrl || lastUrl;
        totalDuration += segResult.duration || 0;
        totalTokens += segResult.tokensUsed || 0;
        if (segResult.subtitles) {
          // 修正时间戳偏移
          allSubtitles = allSubtitles.concat(
            segResult.subtitles.map(s => ({ ...s, startMs: s.startMs + totalDuration * 1000 - (segResult.duration || 0) * 1000 }))
          );
        }
        logId = segResult.logId;
      }
      audioUrl = lastUrl;
      duration = totalDuration;
      tokensUsed = totalTokens;
      subtitles = allSubtitles.length > 0 ? allSubtitles : undefined;
    } else {
      // 单人单段模式
      const result = await synthesizeSpeech({
        text,
        ssml,
        speaker,
        model: defaultModel,
        resourceId,
        audioParams,
        additions: Object.keys(additions).length > 0 ? additions : undefined,
        pitch: safePitch,
      });
      audioUrl = result.audioUrl;
      duration = result.duration;
      tokensUsed = result.tokensUsed || 0;
      subtitles = result.subtitles;
      logId = result.logId;
    }

    // 创建任务记录 — 优先 JWT，其次 x-user-id（主站内部调用）
    const authUser = await getUserFromRequest(request);
    let effectiveUserId = authUser?.userId || null;
    // 主站内部调用时通过 x-user-id 头传用户ID
    const xUserId = request.headers.get('x-user-id');
    if (!effectiveUserId && xUserId) {
      effectiveUserId = xUserId;
    }
    const fullText = mode === 'dual' ? `${text}\n---\n${text2}` : (text || ssml || '');
    const job = await prisma.tTSJob.create({
      data: {
        userId: effectiveUserId || null,
        voiceId: voiceId || null,
        text: fullText,
        model: defaultModel,
        mode,
        params: JSON.stringify({
          speaker, speaker2, resourceId,
          pitch: safePitch, speechRate: finalSpeechRate, loudnessRate: finalLoudnessRate,
          format, sampleRate, emotion, emotionScale,
          enableSubtitle, enableTimestamp,
          contextTexts, sectionId: additions.section_id,
          explicitLanguage, explicitDialect,
          autoSplit, mode,
        }),
        status: 'completed',
        audioUrl,
        duration,
        tokensUsed,
        completedAt: new Date(),
      },
    });

    // 更新 TTSJob 中的 charCount 和 cost（合并到一次更新）
    const charCount = fullText.length;

    // 扣费逻辑 — 优先调用主站 API 扣 cash_balance，其次扣本地余额
    let billingInfo: { cost?: number; balance?: number; billingError?: string } | undefined;
    if (effectiveUserId) {
      // 先用 voice-platform 自己的计费系统计算费用
      const deductResult = await deductBalance(
        effectiveUserId,
        charCount,
        job.id,
        `TTS合成扣费 (${charCount}字符, ${speaker})`,
        'seed-tts-2.0',
      );

      if (deductResult.success) {
        billingInfo = { cost: deductResult.cost, balance: deductResult.balance };

        // 同时调用主站扣费 API（扣 cash_balance，best-effort）
        try {
          const mainSiteUrl = process.env.MAIN_SITE_API_URL || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:5000';
          const siteApiKey = process.env.SITE_API_KEY?.trim() ?? '';
          const mainRes = await fetch(`${mainSiteUrl}/api/voice/billing/deduct`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Site-API-Key': siteApiKey,
            },
            body: JSON.stringify({
              userId: effectiveUserId,
              amount: deductResult.cost,
              description: `智音工坊 TTS合成 (${charCount}字符)`,
              charCount,
              model: 'seed-tts-2.0',
            }),
          });
          if (!mainRes.ok) {
            console.warn('[voice-platform] 主站扣费API调用失败:', await mainRes.json().catch(() => mainRes.status));
          }
        } catch (err) {
          console.warn('[voice-platform] 主站扣费API网络错误:', err);
        }
      } else {
        billingInfo = { billingError: deductResult.error };
      }
    }

    return successResponse({
      audioUrl,
      duration,
      jobId: job.id,
      tokensUsed,
      subtitles,
      logId,
      billing: billingInfo,
    }, billingInfo?.billingError ? '语音合成成功（扣费失败，请联系管理员）' : '语音合成成功');

  } catch (error: any) {
    // 记录失败日志
    try {
      const authUser = await getUserFromRequest(request);
      await prisma.tTSJob.create({
        data: {
          userId: authUser?.userId || null,
          text: body.text || body.ssml || '',
          model: body.model || getDefaultModelBySpeaker(body.speaker || ''),
          mode: body.mode || 'single',
          params: JSON.stringify(body),
          status: 'failed',
          error: error.message,
        },
      });
    } catch { /* ignore */ }

    return errorResponse(localizeError(error), 'TTS_ERROR', 500);
  }
}
