import {sameOrigin,requireIdentity} from '../../../../../../../commerce/server/auth';
import {updateAssetGroup} from '../../../../../../../commerce/server/asset-groups';
import {json,errorResponse} from '../../../../../../../commerce/server/http';

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{sameOrigin(request);const user=requireIdentity(request);const {id}=await params;const body=await request.json();if(!Array.isArray(body.assetIds))throw Error('缺少素材列表');const group=updateAssetGroup(id,user.id,{attachAssetIds:body.assetIds});return json({group});}catch(e){return errorResponse(e);}}
