// 服务卡片管理 API
// GET    /api/admin/services        获取全部卡片
// POST   /api/admin/services        新建卡片
// PATCH  /api/admin/services        更新卡片
// DELETE /api/admin/services?id=xxx  删除卡片
import { NextRequest, NextResponse } from 'next/server';
import { getAllServiceCards, createCard, updateCard, deleteCard } from '@/lib/service-store';
import { withAdminAuth } from '@/lib/api-middleware';
import type { ServiceCard } from '@/lib/types';

const MASKED_SECRET = /^(?:[*•●·]+|已配置)$/u;
function replacementApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && !MASKED_SECRET.test(trimmed) ? trimmed : undefined;
}
function publicCard(card: ServiceCard) {
  const { apiKey, ...safe } = card;
  return { ...safe, apiKeyConfigured: Boolean(String(apiKey || '').trim()) };
}

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const list = getAllServiceCards();
    return NextResponse.json({ success: true, data: list.map(publicCard), message: `共 ${list.length} 个服务卡片` });
  } catch (err) {
    return NextResponse.json({ success: false, message: `服务器异常: ${(err as Error).message}` }, { status: 500 });
  }
  });
}

export async function POST(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const body = await req.json();
    if (!body.name || !body.engineType) {
      return NextResponse.json({ success: false, message: '缺少名称或引擎类型' }, { status: 400 });
    }
    const card = createCard({
      name: body.name,
      engineType: body.engineType,
      serviceType: body.serviceType || 'both',
      apiKey: replacementApiKey(body.apiKey) || '',
      extraConfig: body.extraConfig || {},
      costPrice: body.costPrice || 0,
      retailPrice: body.retailPrice || 0,
      isDefault: body.isDefault || false,
      enabled: body.enabled ?? true,
      sortOrder: body.sortOrder ?? 99,
    });
    return NextResponse.json({ success: true, data: publicCard(card), message: '卡片创建成功' });
  } catch (err) {
    return NextResponse.json({ success: false, message: `服务器异常: ${(err as Error).message}` }, { status: 500 });
  }
  });
}

export async function PATCH(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const body = await req.json();
    const { id, ...patch } = body;
    if (!id) {
      return NextResponse.json({ success: false, message: '缺少卡片ID' }, { status: 400 });
    }
    if (replacementApiKey(patch.apiKey) === undefined) delete patch.apiKey;
    else patch.apiKey = replacementApiKey(patch.apiKey);
    const card = updateCard(id, patch);
    if (!card) {
      return NextResponse.json({ success: false, message: '卡片不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: publicCard(card), message: '更新成功' });
  } catch (err) {
    return NextResponse.json({ success: false, message: `服务器异常: ${(err as Error).message}` }, { status: 500 });
  }
  });
}

export async function DELETE(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, message: '缺少卡片ID' }, { status: 400 });
    }
    const ok = deleteCard(id);
    if (!ok) {
      return NextResponse.json({ success: false, message: '卡片不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: '删除成功' });
  } catch (err) {
    return NextResponse.json({ success: false, message: `服务器异常: ${(err as Error).message}` }, { status: 500 });
  }
  });
}
