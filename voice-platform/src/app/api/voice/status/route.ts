import { NextRequest } from 'next/server';
import { getVoiceStatus, VOICE_STATUS_MAP, MODEL_TYPE_MAP } from '@/lib/volcengine';
import { successResponse, errorResponse } from '@/lib/response';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const speakerId = searchParams.get('speakerId');
    const customSpeakerId = searchParams.get('customSpeakerId');

    // 参数校验
    if (!speakerId) {
      return errorResponse('speakerId 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    // 查询音色状态
    const result = await getVoiceStatus(
      speakerId,
      customSpeakerId || undefined
    );

    // 转换状态信息为可读格式
    const speakerStatus = result.speakerStatus.map((s) => ({
      modelType: s.modelType,
      modelName: MODEL_TYPE_MAP[s.modelType] || `Unknown(${s.modelType})`,
      demoAudio: s.demoAudio || null,
    }));

    return successResponse({
      speakerId,
      status: result.status,
      statusName: VOICE_STATUS_MAP[result.status] || `Unknown(${result.status})`,
      speakerStatus,
      language: result.language,
      createTime: result.createTime,
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '查询音色状态失败',
      'VOICE_STATUS_ERROR',
      500
    );
  }
}
