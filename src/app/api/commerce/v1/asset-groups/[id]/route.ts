import {sameOrigin,requireIdentity} from '../../../../../../commerce/server/auth';
import {assetGroup,updateAssetGroup,deleteAssetGroup} from '../../../../../../commerce/server/asset-groups';
import {json,errorResponse} from '../../../../../../commerce/server/http';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const user=requireIdentity(request);const {id}=await params;const group=assetGroup(id,user.id);if(!group)return json({error:'分组不存在'},404);return json({group});}catch(e){return errorResponse(e);}}
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){try{sameOrigin(request);const user=requireIdentity(request);const {id}=await params;const body=await request.json();const group=updateAssetGroup(id,user.id,{name:body.name,attachAssetIds:body.attachAssetIds,removeAssetIds:body.removeAssetIds});return json({group});}catch(e){return errorResponse(e);}}
export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){try{sameOrigin(request);const user=requireIdentity(request);const {id}=await params;deleteAssetGroup(id,user.id);return json({ok:true});}catch(e){return errorResponse(e);}}
