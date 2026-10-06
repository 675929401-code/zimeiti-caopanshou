import {identity} from '../../../../../../commerce/server/auth';
import {discoveryHome} from '../../../../../../commerce/server/discovery';
import {discoveryError} from '../../../../../../commerce/server/discovery-http';
import {json} from '../../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{return json(await discoveryHome(identity(request)?.id));}catch(e){return discoveryError(e);}}
