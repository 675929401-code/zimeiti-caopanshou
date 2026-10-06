// GET/PUT /api/admin/voice-config — 引擎配置管理
import { NextRequest, NextResponse } from 'next/server';
import { getAllEngineConfigs, saveEngineConfig, getEngineConfig } from '@/lib/voice-studio/store';
import { testEngineConnection } from '@/lib/voice-studio/tts/router';
import { ENGINE_CONFIGS } from '@/lib/voice-studio/engines';
import type { TTSEngine, StoredEngineConfig } from '@/lib/voice-studio/types';
import { withAdminAuth } from '@/lib/api-middleware';

const MASKED_SECRET = /^(?:[*•●·]+|已配置)$/u;
function replacementApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && !MASKED_SECRET.test(trimmed) ? trimmed : undefined;
}
function publicConfig(config: StoredEngineConfig) {
  const { apiKey, ...safe } = config;
  return { ...safe, apiKeyConfigured: Boolean(String(apiKey || '').trim()) };
}

/** GET: 获取所有引擎配置 */
export async function GET(request: NextRequest): Promise<Response> {
  return withAdminAuth(request, async () => {
  try {
    const configs = getAllEngineConfigs();
    // 合并元信息
    const result = configs.map((c) => ({
      ...publicConfig(c),
      meta: ENGINE_CONFIGS[c.engine],
    }));
    return NextResponse.json({ success: true, message: '获取成功', data: result });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `获取配置异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** PUT: 保存引擎配置 */
export async function PUT(request: NextRequest): Promise<Response> {
  return withAdminAuth(request, async () => {
  try {
    const body = (await request.json()) as StoredEngineConfig & { action?: string };
    const existing = getEngineConfig(body.engine);
    const effectiveApiKey = replacementApiKey(body.apiKey) ?? existing?.apiKey ?? '';

    // 连接测试
    if (body.action === 'test') {
      // 先保存配置
      saveEngineConfig({ engine: body.engine, apiKey: effectiveApiKey, extraConfig: body.extraConfig, enabled: body.enabled });
      const result = await testEngineConnection(body.engine, { ...body, apiKey: effectiveApiKey });
      return NextResponse.json({
        success: result.success,
        message: result.message,
        data: { success: result.success, message: result.message },
      });
    }

    // 保存配置
    const saved = saveEngineConfig({
      engine: body.engine,
      apiKey: effectiveApiKey,
      extraConfig: body.extraConfig || {},
      enabled: body.enabled ?? true,
    });
    return NextResponse.json({ success: true, message: '保存成功', data: publicConfig(saved) });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `保存配置异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}
