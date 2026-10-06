import {identity} from '../../../../../../../commerce/server/auth';
import {discoveryItem} from '../../../../../../../commerce/server/discovery';
import {discoveryError} from '../../../../../../../commerce/server/discovery-http';
import {json} from '../../../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{return json(await discoveryItem((await params).id,identity(request)?.id));}catch(e){return discoveryError(e);}}
