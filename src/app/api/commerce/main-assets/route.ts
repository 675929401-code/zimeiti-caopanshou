import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '../../../../commerce/server/main-account-access';
import {json,errorResponse} from '../../../../commerce/server/http';
import {mainAssetBridge,parseMainAssetImportRequest,parseMainAssetListInput,publicImportedAsset} from '../../../../commerce/server/main-asset-bridge';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request){
 try{
  const identity=requireIdentity(request);
  const current=await authorizeCurrentCommerceIdentity(identity);
  return json(await mainAssetBridge.list(current.mainUserId,parseMainAssetListInput(new URL(request.url).searchParams)));
 }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
 try{
  sameOrigin(request);
  const identity=requireIdentity(request);
  const current=await authorizeCurrentCommerceIdentity(identity);
  if(Number(request.headers.get('content-length'))>4096)throw Error('主站素材导入参数过大');
  const text=await request.text();if(Buffer.byteLength(text,'utf8')>4096)throw Error('主站素材导入参数过大');
  const input=parseMainAssetImportRequest(JSON.parse(text));
  const asset=await mainAssetBridge.importOne(identity.id,current.mainUserId,input.id);
  return json({asset:publicImportedAsset(asset)});
 }catch(error){return errorResponse(error);}
}
