import {directorCatalog} from '../../../../../commerce/server/director-catalog';
import {primePublishedCommerceConfiguration} from '../../../../../commerce/server/configuration-platform';
import {json,errorResponse} from '../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(){try{
 // The baseline director cards remain useful for drafting when no shared
 // release is current. Quote and dispatch routes keep their fail-closed gates.
 await primePublishedCommerceConfiguration({required:false});
 return json({directors:directorCatalog()});
}catch(e){return errorResponse(e);}}
