import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {imageRevisions,quoteImageRevision} from '../../../../commerce/server/image-revisions';
import {json,errorResponse} from '../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=requireIdentity(request);return json(imageRevisions(user.id,new URL(request.url).searchParams.get('jobId')||''));}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request),body=await request.json();if(body.action==='quote')return json({quote:await quoteImageRevision(user.id,body.jobId,body.prompt,body.imageReferenceDocument)});if(body.action==='confirm')throw Error('请通过统一任务接口确认报价');throw Error('图片编辑操作无效');}catch(e){return errorResponse(e);}}
