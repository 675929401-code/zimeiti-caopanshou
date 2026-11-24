import { createHash } from 'node:crypto';
import { requireIdentity, sameOrigin } from '@/commerce/server/auth';
import { authorizeCurrentCommerceIdentity } from '@/commerce/server/main-account-access';
import { publicAsset, storeAsset } from '@/commerce/server/assets';
import { arrangePdf, readPdf, maxPdfBytes } from '@/commerce/server/pdf-pages';
import { json, errorResponse } from '@/commerce/server/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = requireIdentity(request);
    await authorizeCurrentCommerceIdentity(user);
    if (Number(request.headers.get('content-length')) > maxPdfBytes + 64 * 1024) return json({error:'文件合计超过 24 MB'}, 413);
    const form = await request.formData();
    const files = form.getAll('file');
    if (!files.length || files.length > 12 || !files.every((v): v is File => v instanceof File)) return json({error:'请选择 1 至 12 份 PDF'}, 400);
    if (files.reduce((sum,file)=>sum+file.size,0) > maxPdfBytes) return json({error:'文件合计超过 24 MB'}, 413);
    const action = form.get('action');
    if (action !== 'inspect' && action !== 'export') return json({error:'请选择 PDF 处理方式'}, 400);
    const docs = [];
    for (const file of files) docs.push(await readPdf(file));
    if (action === 'inspect') return json({pages:docs.map(doc=>doc.getPageCount())});
    const selections = form.getAll('pages');
    if (selections.length !== files.length || !selections.every((v): v is string=>typeof v==='string'&&v.length<=3000)) return json({error:'请为每个文件指定有效页序'},400);
    const { bytes, count } = await arrangePdf(docs, selections);
    const title = String(form.get('name')||'整理文档').replace(/\.pdf$/i,'').replace(/[\\/:*?"<>|\p{Cc}]/gu,'_').trim().slice(0,100)||'整理文档';
    const key = 'pdf-pages/' + createHash('sha256').update(title).update('\0').update(bytes).digest('hex');
    const asset = await storeAsset(user.id,bytes,'application/pdf',title+'.pdf','generated',undefined,undefined,key);
    return json({asset:publicAsset(asset),pages:count});
  } catch (error) { return errorResponse(error); }
}
