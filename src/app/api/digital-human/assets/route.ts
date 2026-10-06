import { NextRequest, NextResponse } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';

export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  const ids = request.nextUrl.searchParams.getAll('id');
  if (!ids.length || ids.length > 3) return NextResponse.json({ error: '请选择 1–3 个素材' }, { status: 400 });
  try {
    const assets = await Promise.all(ids.map(id => ownedDigitalHumanAsset(auth.user.userId, id)));
    return NextResponse.json({ assets }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (cause) {
    if (cause instanceof Error && /^(请上传|人物视频|配音音频)/u.test(cause.message)) return NextResponse.json({ error: '配音已生成，但时长或文件大小超出数字人上传范围。请按所选模型的要求调整文案，原配音保留在智音工坊。' }, { status: 422 });
    return NextResponse.json({ error: '素材暂时无法读取，请稍后重试' }, { status: 404 });
  }
}
