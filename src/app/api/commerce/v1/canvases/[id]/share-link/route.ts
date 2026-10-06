import {requireIdentity,sameOrigin} from '../../../../../../../commerce/server/auth';
import {readCanvasShare,publishCanvasShare,revokeCanvasShare} from '../../../../../../../commerce/server/canvas-sharing';
import {shareError} from '../../../../../../../commerce/server/canvas-share-http';
import {json} from '../../../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){try{const user=requireIdentity(request);return json(readCanvasShare(user.id,(await params).id));}catch(e){return shareError(e);}}
export async function POST(request:Request,{params}:Context){try{sameOrigin(request);const user=requireIdentity(request);const text=await request.text();if(text.length>2000)throw Error('分享参数过大');const body=JSON.parse(text);return json(await publishCanvasShare(user.id,(await params).id,body.expected_revision));}catch(e){return shareError(e);}}
export async function DELETE(request:Request,{params}:Context){try{sameOrigin(request);const user=requireIdentity(request);return json(revokeCanvasShare(user.id,(await params).id));}catch(e){return shareError(e);}}

