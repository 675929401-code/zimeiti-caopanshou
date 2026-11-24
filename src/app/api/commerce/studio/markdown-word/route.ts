import { createHash } from 'node:crypto';
import { requireIdentity, sameOrigin } from '@/commerce/server/auth';
import { authorizeCurrentCommerceIdentity } from '@/commerce/server/main-account-access';
import { WORD_DOCUMENT_TYPE, publicAsset, storeAsset } from '@/commerce/server/assets';
import { markdownToWord } from '@/commerce/server/markdown-word';
import { json, errorResponse } from '@/commerce/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = requireIdentity(request);
    await authorizeCurrentCommerceIdentity(user);
    if (Number(request.headers.get('content-length')) > 650_000) return json({ error: '文档超过大小限制' }, 413);
    const { text, name } = await request.json();
    if (typeof text !== 'string') return json({ error: '请输入 Markdown 正文' }, 400);
    const title = String(name || '转换文档').replace(/\.(md|markdown|docx)$/i, '').replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim().slice(0, 100) || '转换文档';
    const bytes = markdownToWord(text);
    const key = 'markdown-word/' + createHash('sha256').update(title).update('\0').update(bytes).digest('hex');
    const asset = await storeAsset(user.id, bytes, WORD_DOCUMENT_TYPE, title + '.docx', 'generated', undefined, undefined, key);
    return json({ asset: publicAsset(asset) });
  } catch (error) { return errorResponse(error); }
}