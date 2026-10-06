import {sameOrigin,requireIdentity} from '../../../../../commerce/server/auth';
import {assetGroups,createAssetGroup} from '../../../../../commerce/server/asset-groups';
import {json,errorResponse} from '../../../../../commerce/server/http';

export async function GET(request:Request){try{const user=requireIdentity(request);return json({groups:assetGroups(user.id)});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const body=await request.json();const group=createAssetGroup(user.id,String(body.name||''),Array.isArray(body.assetIds)?body.assetIds:[]);return json({group},201);}catch(e){return errorResponse(e);}}
