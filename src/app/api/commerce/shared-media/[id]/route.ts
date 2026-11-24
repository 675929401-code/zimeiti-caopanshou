import { sharedMediaBytes } from '../../../../../commerce/server/shared-media';
import { errorResponse } from '../../../../../commerce/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 平台共享素材：内容为平台上传的展示物料（图标/封面/演示），资产身份为随机 UUID 且内容不可变，
// 可安全公开缓存；与会员私有素材（/api/commerce/assets，按 owner 隔离）完全分开。
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const found = await sharedMediaBytes(id);
    if (!found) return new Response('Not found', { status: 404 });
    const { asset, bytes } = found;
    const headers: Record<string, string> = {
      'Content-Type': asset.type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
      const end = match[1] ? (match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1) : bytes.length - 1;
      if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Length': String(bytes.length) } });
  } catch (error) { return errorResponse(error); }
}
