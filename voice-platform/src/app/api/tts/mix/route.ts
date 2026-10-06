import { NextRequest } from 'next/server';
import { synthesizeMixSpeech, localizeError } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';
import { deductBalance } from '@/lib/billing';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const {
    text,
    speakers, // Array<{ sourceSpeaker: string; mixFactor: number }>
    format = 'mp3',
    sampleRate = 24000,
    speechRate = 0,
    loudnessRate = 0,
  } = body;

  if (!text) return errorResponse('text 参数不能为空', 'VALIDATION_ERROR', 400);
  if (!speakers || !Array.isArray(speakers) || speakers.length < 2) {
    return errorResponse('混音需要至少2个音色', 'VALIDATION_ERROR', 400);
  }
  if (speakers.length > 3) {
    return errorResponse('混音最多支持3个音色', 'VALIDATION_ERROR', 400);
  }

  // 验证 mix_factor 之和 = 1
  const factorSum = speakers.reduce((sum: number, s: any) => sum + Number(s.mixFactor || 0), 0);
  if (Math.abs(factorSum - 1) > 0.001) {
    return errorResponse(`混音因子之和必须为1，当前为${factorSum.toFixed(3)}`, 'VALIDATION_ERROR', 400);
  }

  try {
    const result = await synthesizeMixSpeech({
      text,
      speakers: speakers.map((s: any) => ({
        sourceSpeaker: s.sourceSpeaker,
        mixFactor: Number(s.mixFactor),
      })),
      audioParams: {
        format,
        sample_rate: Number(sampleRate) as 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000,
        speech_rate: Number(speechRate),
        loudness_rate: Number(loudnessRate),
      },
    });

    // 记录任务 + 扣费
    const authUser = await getUserFromRequest(request);
    let billingInfo: { cost?: number; balance?: number; billingError?: string } | undefined;

    const job = await prisma.tTSJob.create({
      data: {
        userId: authUser?.userId || null,
        text,
        model: 'mix_speaker',
        mode: 'mix',
        params: JSON.stringify({ speakers, format, sampleRate }),
        status: 'completed',
        audioUrl: result.audioUrl,
        duration: result.duration,
        completedAt: new Date(),
      },
    });

    if (authUser) {
      const deductResult = await deductBalance(
        authUser.userId, text.length, job.id,
        `混音TTS扣费 (${text.length}字符, ${speakers.length}音色混合)`,
        'seed-tts-1.0',
      );
      if (deductResult.success) {
        billingInfo = { cost: deductResult.cost, balance: deductResult.balance };
      } else {
        billingInfo = { billingError: deductResult.error };
      }
    }

    return successResponse({
      audioUrl: result.audioUrl,
      duration: result.duration,
      jobId: job.id,
      billing: billingInfo,
    }, '混音合成成功');
  } catch (error: any) {
    return errorResponse(localizeError(error), 'TTS_ERROR', 500);
  }
}
