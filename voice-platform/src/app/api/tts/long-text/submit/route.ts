import { NextRequest } from 'next/server';
import { submitLongTextTask, TtsAudioParams, TtsAdditions, localizeError } from '@/lib/volcengine';
import { getResourceIdBySpeaker, getDefaultModelBySpeaker } from '@/lib/voices-data';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';
import { checkBalance } from '@/lib/billing';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const {
    text, speaker, model,
    speechRate = 0, loudnessRate = 0,
    format = 'mp3', sampleRate = 24000,
    emotion, emotionScale, enableTimestamp,
    contextTexts, sectionId,
    explicitLanguage, explicitDialect,
    silenceDuration, enableLanguageDetector,
    disableMarkdownFilter, disableEmojiFilter,
    resourceId: customResourceId,
  } = body;

  if (!text) return errorResponse('text 参数不能为空', 'VALIDATION_ERROR', 400);
  if (!speaker) return errorResponse('speaker 参数不能为空', 'VALIDATION_ERROR', 400);
  if (text.length > 100000) return errorResponse('文本长度超过10万字限制', 'VALIDATION_ERROR', 400);

  try {
    // 余额检查
    const authUser = await getUserFromRequest(request);
    if (authUser) {
      const balanceCheck = await checkBalance(authUser.userId, text.length);
      if (!balanceCheck.sufficient) {
        return errorResponse(`余额不足，当前余额 ${balanceCheck.balance.toFixed(2)} 元，本次需消耗约 ${text.length} 字`, 'INSUFFICIENT_BALANCE', 402);
      }
    }

    const resourceId = customResourceId || getResourceIdBySpeaker(speaker);
    const defaultModel = model || getDefaultModelBySpeaker(speaker);

    const audioParams: TtsAudioParams = {
      format, sample_rate: Number(sampleRate) as 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000,
      speech_rate: Number(speechRate), loudness_rate: Number(loudnessRate),
    };
    if (emotion) audioParams.emotion = emotion;
    if (emotionScale !== undefined) audioParams.emotion_scale = Number(emotionScale);
    if (enableTimestamp !== undefined) audioParams.enable_timestamp = Boolean(enableTimestamp);

    const additions: TtsAdditions = {};
    if (contextTexts && Array.isArray(contextTexts) && contextTexts.length > 0) additions.context_texts = contextTexts;
    if (sectionId) additions.section_id = sectionId;
    if (explicitLanguage) additions.explicit_language = explicitLanguage;
    if (explicitDialect) additions.explicit_dialect = explicitDialect;
    if (silenceDuration !== undefined) additions.silence_duration = Number(silenceDuration);
    if (enableLanguageDetector !== undefined) additions.enable_language_detector = Boolean(enableLanguageDetector);
    if (disableMarkdownFilter !== undefined) additions.disable_markdown_filter = Boolean(disableMarkdownFilter);
    if (disableEmojiFilter !== undefined) additions.disable_emoji_filter = Boolean(disableEmojiFilter);

    const result = await submitLongTextTask({
      text, speaker,
      model: defaultModel,
      resourceId,
      audioParams,
      additions: Object.keys(additions).length > 0 ? additions : undefined,
      uid: authUser?.userId || 'web_user',
    });

    // 记录任务
    await prisma.tTSJob.create({
      data: {
        userId: authUser?.userId || null,
        text,
        model: defaultModel,
        mode: 'long_text',
        params: JSON.stringify({ speaker, resourceId, taskId: result.taskId, charCount: text.length }),
        status: 'pending',
      },
    });

    return successResponse({
      taskId: result.taskId,
      taskStatus: result.taskStatus,
      reqTextLength: result.reqTextLength,
      message: '长文本任务已提交，请轮询查询结果',
    }, '任务提交成功');
  } catch (error: any) {
    return errorResponse(localizeError(error), 'TTS_ERROR', 500);
  }
}
