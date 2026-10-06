import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {json,errorResponse} from '../../../../commerce/server/http';
import {queryAssetLibrary,saveAssetFolder,deleteAssetFolder,updateLibraryAssets} from '../../../../commerce/server/asset-library';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=requireIdentity(request);return json(queryAssetLibrary(user.id,new URL(request.url).searchParams));}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request),body=await request.json();return json({folder:saveAssetFolder(user.id,body)});}catch(e){return errorResponse(e);}}
export async function PATCH(request:Request){try{sameOrigin(request);const user=requireIdentity(request);return json({assets:await updateLibraryAssets(user.id,await request.json())});}catch(e){return errorResponse(e);}}
export async function DELETE(request:Request){try{sameOrigin(request);const user=requireIdentity(request),{id}=await request.json();deleteAssetFolder(user.id,id);return json({ok:true});}catch(e){return errorResponse(e);}}
