// 管理员 — 服务卡片 CRUD
import { NextRequest, NextResponse } from 'next/server';
import { getAllServiceCards, createCard, updateCard, deleteCard } from '@/lib/voice-studio/service-store';
import type { ServiceCard, TTSEngine } from '@/lib/voice-studio/types';
import { withAdminAuth } from '@/lib/api-middleware';

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

/** 获取所有服务卡片（含禁用） */
export async function GET(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const cards = getAllServiceCards();
    return NextResponse.json({ success: true, data: cards.map(publicCard) });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `获取服务卡片异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** 创建服务卡片 */
export async function POST(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const body = await req.json();
    const card = createCard({
      name: body.name || '新服务',
      engineType: (body.engineType as TTSEngine) || 'volcano',
      serviceType: body.serviceType || 'both',
      apiKey: replacementApiKey(body.apiKey) || '',
      extraConfig: body.extraConfig || {},
      costPrice: body.costPrice ?? 0,
      retailPrice: body.retailPrice ?? 0,
      isDefault: body.isDefault ?? false,
      enabled: body.enabled ?? true,
      sortOrder: body.sortOrder ?? 0,
    });
    return NextResponse.json({ success: true, data: publicCard(card) });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `创建服务卡片异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** 更新服务卡片 */
export async function PUT(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const body = await req.json();
    const { id, ...patch } = body;
    if (!id) return NextResponse.json({ success: false, message: '缺少 id' }, { status: 400 });
    if (replacementApiKey(patch.apiKey) === undefined) delete patch.apiKey;
    else patch.apiKey = replacementApiKey(patch.apiKey);
    const card = updateCard(id, patch);
    if (!card) return NextResponse.json({ success: false, message: '卡片不存在' }, { status: 404 });
    return NextResponse.json({ success: true, data: publicCard(card) });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `更新服务卡片异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** 删除服务卡片 */
export async function DELETE(req: NextRequest) {
  return withAdminAuth(req, async () => {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, message: '缺少 id' }, { status: 400 });
    const ok = deleteCard(id);
    if (!ok) return NextResponse.json({ success: false, message: '卡片不存在' }, { status: 404 });
    return NextResponse.json({ success: true, message: '删除成功' });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `删除服务卡片异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}
