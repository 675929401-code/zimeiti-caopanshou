// GET/POST/PUT/DELETE /api/admin/voice-list — 管理声音库
import { NextRequest, NextResponse } from 'next/server';
import { getAllVoices, addVoice, updateVoice, deleteVoice } from '@/lib/voice-studio/store';
import type { VoiceModel } from '@/lib/voice-studio/types';
import { withAdminAuth } from '@/lib/api-middleware';

/** GET: 获取声音列表 */
export async function GET(request: NextRequest): Promise<Response> {
  return withAdminAuth(request, async () => {
  try {
    const voices = getAllVoices();
    return NextResponse.json({ success: true, message: '获取成功', data: voices });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `获取声音异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** POST: 添加声音 */
export async function POST(request: NextRequest): Promise<Response> {
  return withAdminAuth(request, async () => {
  try {
    const body = await request.json();
    const voice = addVoice(body);
    return NextResponse.json({ success: true, message: '添加成功', data: voice });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `添加声音异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** PUT: 更新声音 */
export async function PUT(request: NextRequest): Promise<Response> {
  return withAdminAuth(request, async () => {
  try {
    const body = await request.json();
    const { id, ...patch } = body as VoiceModel & { id: string };
    if (!id) {
      return NextResponse.json({ success: false, message: '缺少声音 ID' }, { status: 400 });
    }
    const updated = updateVoice(id, patch);
    if (!updated) {
      return NextResponse.json({ success: false, message: '声音不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: '更新成功', data: updated });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `更新声音异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}

/** DELETE: 删除声音 */
export async function DELETE(request: NextRequest): Promise<Response> {
  return withAdminAuth(request, async () => {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, message: '缺少声音 ID' }, { status: 400 });
    }
    const ok = deleteVoice(id);
    if (!ok) {
      return NextResponse.json({ success: false, message: '声音不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: '删除成功' });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, message: `删除声音异常: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  });
}
