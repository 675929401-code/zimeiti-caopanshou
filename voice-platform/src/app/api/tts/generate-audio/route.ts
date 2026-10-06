import { NextRequest } from 'next/server';
import { generateAudio } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { textPrompt, references, format, pitchRate, speechRate } = body;

  try {
    if (!textPrompt || typeof textPrompt !== 'string') {
      return errorResponse('textPrompt 参数不能为空', 'VALIDATION_ERROR', 400);
    }
    if (textPrompt.length > 3000) {
      return errorResponse('textPrompt 长度不能超过3000字符', 'VALIDATION_ERROR', 400);
    }

    const result = await generateAudio({ textPrompt, references, format, pitchRate, speechRate });
    const authUser = await getUserFromRequest(request);

    await prisma.tTSJob.create({
      data: {
        userId: authUser?.userId || null,
        text: textPrompt,
        model: 'seed-audio-1.0',
        params: JSON.stringify({ format, pitchRate, speechRate }),
        status: 'completed',
        audioUrl: result.audioUrl,
        duration: result.duration,
        completedAt: new Date(),
      },
    });

    return successResponse({ audioUrl: result.audioUrl, duration: result.duration }, '音频生成成功');
  } catch (error: any) {
    // 记录失败
    try {
      const authUser = await getUserFromRequest(request);
      await prisma.tTSJob.create({
        data: {
          userId: authUser?.userId || null,
          text: body.textPrompt || '',
          model: 'seed-audio-1.0',
          status: 'failed',
          error: error.message,
        },
      });
    } catch { /* ignore */ }

    return errorResponse(error.message || '音频生成失败', 'AUDIO_GENERATION_ERROR', 500);
  }
}
