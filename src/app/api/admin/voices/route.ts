// 声音管理 API
// GET    /api/admin/voices       列表（支持筛选）
// POST   /api/admin/voices       新增
// PATCH  /api/admin/voices       更新（body 带 id）
// DELETE /api/admin/voices       删除（body 带 id 或 ?id=xxx）
import { NextRequest, NextResponse } from 'next/server';
import type { ApiResponse, VoiceModel, TTSEngine, Language, VoiceCategory } from '@/lib/types';
import {
  getAllVoices,
  searchVoices,
  addVoice,
  updateVoice,
  deleteVoice,
} from '@/lib/store';
import { withAdminAuth } from '@/lib/api-middleware';

/** 列表 / 搜索 */
export async function GET(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const { searchParams } = new URL(req.url);
    const keyword = searchParams.get('keyword') || undefined;
    const engine = searchParams.get('engine') as TTSEngine | null;
    const language = searchParams.get('language') as Language | null;
    const category = searchParams.get('category') as VoiceCategory | null;

    const list = keyword || engine || language || category
      ? searchVoices({
          keyword: keyword || undefined,
          engine: engine || undefined,
          language: language || undefined,
          category: category || undefined,
        })
      : getAllVoices();

    return NextResponse.json({ success: true, data: list, message: `共 ${list.length} 个声音` });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}

/** 新增声音 */
export async function POST(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const body = (await req.json()) as Omit<VoiceModel, 'id' | 'createdAt' | 'updatedAt'>;
    if (!body.name || !body.engine || !body.speakerId) {
      return NextResponse.json(
        { success: false, message: '缺少必填字段: name / engine / speakerId' },
        { status: 400 },
      );
    }
    const created = addVoice(body);
    return NextResponse.json({ success: true, data: created, message: '声音已添加' });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}

/** 更新声音 */
export async function PATCH(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const body = (await req.json()) as { id: string } & Partial<VoiceModel>;
    if (!body.id) {
      return NextResponse.json({ success: false, message: '缺少 id' }, { status: 400 });
    }
    const updated = updateVoice(body.id, body);
    if (!updated) {
      return NextResponse.json({ success: false, message: '声音不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: updated, message: '已更新' });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}

/** 删除声音 */
export async function DELETE(req: NextRequest): Promise<Response> {
  return withAdminAuth(req, async () => {
  try {
    const { searchParams } = new URL(req.url);
    let id: string | null | undefined = searchParams.get('id');
    if (!id) {
      const body = (await req.json()) as { id?: string };
      id = body.id;
    }
    if (!id) {
      return NextResponse.json({ success: false, message: '缺少 id' }, { status: 400 });
    }
    const ok = deleteVoice(id);
    if (!ok) {
      return NextResponse.json({ success: false, message: '声音不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: null, message: '已删除' });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `服务器异常: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  });
}
