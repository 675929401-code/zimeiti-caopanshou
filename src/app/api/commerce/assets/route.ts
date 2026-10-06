import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '../../../../commerce/server/main-account-access';
import {assets,deleteAsset,storeAsset,readAsset,publicAsset} from '../../../../commerce/server/assets';
import {json,errorResponse} from '../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=requireIdentity(request);await authorizeCurrentCommerceIdentity(user);return json({assets:assets(user.id).map(publicAsset)});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);await authorizeCurrentCommerceIdentity(user);if(Number(request.headers.get('content-length'))>151*1024*1024)throw Error('文件超过 150 MB');const form=await request.formData();const file=form.get('file');if(!(file instanceof File))throw Error('请选择文件');const asset=await storeAsset(user.id,Buffer.from(await file.arrayBuffer()),file.type,file.name);return json({asset:publicAsset(asset)});}catch(e){return errorResponse(e);}}
export async function DELETE(request:Request){try{sameOrigin(request);const user=requireIdentity(request);await authorizeCurrentCommerceIdentity(user);const {id}=await request.json();if(!readAsset(id,user.id))throw Error('素材不存在');await deleteAsset(user.id,id);return json({ok:true});}catch(e){return errorResponse(e);}}
