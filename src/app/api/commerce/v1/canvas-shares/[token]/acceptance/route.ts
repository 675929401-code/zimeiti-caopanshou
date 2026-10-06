import {requireIdentity} from '../../../../../../../commerce/server/auth';
import {readCanvasShareAcceptance} from '../../../../../../../commerce/server/canvas-sharing';
import {shareError} from '../../../../../../../commerce/server/canvas-share-http';
import {json} from '../../../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{token:string}>}){try{const user=requireIdentity(request);return json(readCanvasShareAcceptance(user.id,(await params).token));}catch(e){return shareError(e);}}

