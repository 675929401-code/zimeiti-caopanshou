import { NextRequest } from 'next/server';
import { generateAudio, SeedAudioParams } from '@/lib/seed-audio-1.0';
import { errorResponse, successResponse } from '@/lib/response';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      textPrompt,
      audioData, audioUrl, speaker,
      references,
      imageData, imageUrl,
      audioConfig,
    } = body;

    if (!textPrompt || typeof textPrompt !== 'string' || textPrompt.trim().length === 0) {
      return errorResponse('text_prompt 不能为空', 'INVALID_PARAM', 400);
    }

    const params: SeedAudioParams = {
      textPrompt: textPrompt.trim(),
      audioData,
      audioUrl,
      speaker,
      references,
      imageData,
      imageUrl,
      audioConfig,
    };

    const result = await generateAudio(params);

    return successResponse({
      audioUrl: result.audioUrl,
      duration: result.duration,
      originalDuration: result.originalDuration,
      subtitles: result.subtitles,
      logId: result.logId,
    });
  } catch (err: any) {
    return errorResponse(err.message || '音频生成失败', 'GENERATE_ERROR', 500);
  }
}
