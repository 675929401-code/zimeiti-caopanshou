import { NextRequest, NextResponse } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import { deleteSharedMedia, listSharedMedia, storeSharedMedia } from '@/commerce/server/shared-media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, { requiredPermissions: ['agents.view'], operation: 'commerce_media_view' });
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ ok: true, media: listSharedMedia() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : '读取失败' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, { mutation: true, requiredPermissions: ['agents.manage'], stepUpPermissions: ['agents.manage'], operation: 'commerce_media_upload' });
  if ('response' in auth) return auth.response;
  try {
    if (Number(request.headers.get('content-length')) > 151 * 1024 * 1024) throw Error('文件超过 150 MB');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw Error('请选择文件');
    const media = await storeSharedMedia(Buffer.from(await file.arrayBuffer()), file.type, file.name);
    return NextResponse.json({ ok: true, media }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : '上传失败' }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, { mutation: true, requiredPermissions: ['agents.manage'], stepUpPermissions: ['agents.manage'], operation: 'commerce_media_delete' });
  if ('response' in auth) return auth.response;
  try {
    const { id } = await request.json();
    await deleteSharedMedia(String(id || ''));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : '删除失败' }, { status: 400 });
  }
}
