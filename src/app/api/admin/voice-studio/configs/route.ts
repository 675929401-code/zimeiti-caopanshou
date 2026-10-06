import { NextResponse } from 'next/server';
import { queryAll } from '@/lib/voice-studio/db';
import { withAdminAuth } from '@/lib/api-middleware';
import { inspectVolcanoVoiceProviderConfig } from '@/lib/server/voice-provider-config';

/** 获取非敏感引擎元数据与统一供应商配置状态。 */
export async function GET(request: Request) {
  return withAdminAuth(request, async () => {
  try {
    const configs = queryAll(
      'SELECT id, name, modelId, resourceId, isActive FROM ModelConfig ORDER BY sort ASC'
    ) as Record<string, unknown>[];
    const providerConfig = await inspectVolcanoVoiceProviderConfig();
    return NextResponse.json({
      success: true,
      data: configs,
      providerConfig,
      credentialManagedBy: 'unified-provider-config',
    });
  } catch (error) {
    console.error('[voice-studio configs] GET error:', error);
    return NextResponse.json({ success: false, message: '获取配置失败' }, { status: 500 });
  }
  });
}
