import {setDiscoveryLiked} from '../../../../../../../../commerce/server/discovery';
import {discoveryMutationOwner,discoveryBody,discoveryError} from '../../../../../../../../commerce/server/discovery-http';
import {json} from '../../../../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const owner=discoveryMutationOwner(request),body=await discoveryBody(request);return json(await setDiscoveryLiked(owner,(await params).id,body.liked));}catch(e){return discoveryError(e);}}
