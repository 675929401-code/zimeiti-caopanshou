// 引擎配置管理 API
// GET    /api/admin/config       获取全部引擎配置
// POST   /api/admin/config       新增/更新单个引擎配置（upsert）
// PUT    /api/admin/config       批量更新
import { NextRequest, NextResponse } from 'next/server';
import type { ApiResponse, StoredEngineConfig, TTSEngine } from '@/lib/types';
import { getAllEngineConfigs, getEngineConfig, saveEngineConfig } from '@/lib/store';
import { testEngineConnection } from '@/lib/tts/router';
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

/** 获取所有引擎配置 */
export async function GET(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const list = getAllEngineConfigs();
    return NextResponse.json({ success: true, data: list.map(publicConfig), message: `共 ${list.length} 个引擎配置` });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}

/** 新增/更新单个引擎配置（upsert），可带 test=true 触发连接测试 */
export async function POST(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const body = (await req.json()) as StoredEngineConfig & { test?: boolean };
    if (!body.engine) {
      return NextResponse.json({ success: false, message: '缺少 engine 字段' }, { status: 400 });
    }
    const existing = getEngineConfig(body.engine);
    const effectiveApiKey = replacementApiKey(body.apiKey) ?? existing?.apiKey ?? '';
    // 如果带 test=true，先测试连接
    if (body.test) {
      const testResult = await testEngineConnection(body.engine as TTSEngine, {
        engine: body.engine,
        apiKey: effectiveApiKey,
        extraConfig: body.extraConfig || {},
        enabled: body.enabled,
      });
      if (!testResult.success) {
        return NextResponse.json({ success: false, message: testResult.message }, { status: 400 });
      }
    }
    const saved = saveEngineConfig({
      engine: body.engine,
      apiKey: effectiveApiKey,
      extraConfig: body.extraConfig || {},
      enabled: body.enabled ?? true,
      costPrice: body.costPrice,
      retailPrice: body.retailPrice,
    });
    return NextResponse.json({ success: true, data: publicConfig(saved), message: '保存成功' });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}

/** 批量更新 */
export async function PUT(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const body = (await req.json()) as StoredEngineConfig[];
    const saved: StoredEngineConfig[] = [];
    for (const cfg of body) {
      if (!cfg.engine) continue;
      const existing = getEngineConfig(cfg.engine);
      saved.push(
        saveEngineConfig({
          engine: cfg.engine,
          apiKey: replacementApiKey(cfg.apiKey) ?? existing?.apiKey ?? '',
          extraConfig: cfg.extraConfig || {},
          enabled: cfg.enabled ?? true,
          costPrice: cfg.costPrice,
          retailPrice: cfg.retailPrice,
        }),
      );
    }
    return NextResponse.json({ success: true, data: saved.map(publicConfig), message: `批量保存 ${saved.length} 项` });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}
