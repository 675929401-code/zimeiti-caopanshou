// 获取已启用的服务卡片（前端下拉菜单用）
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    success: false,
    available: false,
    code: 'VOICE_SERVICE_CATALOG_RETIRED',
    message: '旧语音服务目录已停用，请使用当前音色与定价目录。',
    data: [],
    replacementRoutes: ['/api/voice/list', '/api/voice/pricing'],
  }, {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}
