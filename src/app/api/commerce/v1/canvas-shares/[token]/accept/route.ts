import {requireIdentity,sameOrigin} from '../../../../../../../commerce/server/auth';
import {acceptCanvasShare} from '../../../../../../../commerce/server/canvas-sharing';
import {shareError} from '../../../../../../../commerce/server/canvas-share-http';
import {json} from '../../../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:Promise<{token:string}>}){try{sameOrigin(request);const user=requireIdentity(request);return json(await acceptCanvasShare(user.id,(await params).token));}catch(e){return shareError(e);}}

