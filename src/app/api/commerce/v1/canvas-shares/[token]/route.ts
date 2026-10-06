import {readPublicCanvasShare} from '../../../../../../commerce/server/canvas-sharing';
import {shareError,shareHeaders} from '../../../../../../commerce/server/canvas-share-http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}){try{return Response.json(readPublicCanvasShare((await params).token),{headers:shareHeaders});}catch(e){return shareError(e);}}

