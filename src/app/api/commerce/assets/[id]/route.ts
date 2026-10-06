import {requireIdentity,sameOrigin} from '../../../../../commerce/server/auth';
import {assetBytes,readAsset,mutateAsset,type Asset} from '../../../../../commerce/server/assets';
import {errorResponse,json} from '../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
const CERTIFIED_GROUPS=new Set(['certified_real','virtual_human']);
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const user=requireIdentity(request);const {id}=await params;const asset=readAsset(id,user.id);if(!asset)return new Response('Not found',{status:404});const bytes=await assetBytes(asset);const headers:Record<string,string>={'Content-Type':asset.type,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};if(new URL(request.url).searchParams.has('download'))headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`;const range=request.headers.get('range');if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match)return new Response(null,{status:416});const start=match[1]?Number(match[1]):Math.max(0,bytes.length-Number(match[2]));const end=match[1]?(match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1):bytes.length-1;if(start>end||start>=bytes.length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.length}`,'Content-Length':String(end-start+1)}});return new Response(new Uint8Array(bytes.subarray(start,end+1)),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)}});}return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Length':String(bytes.length)}});}catch(e){return errorResponse(e);}}
// 人脸认证声明（对标260节"图片节点人脸认证"本地实现）：人工声明+资产分组，非供应商生物认证。
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){try{
  sameOrigin(request);const user=requireIdentity(request);const {id}=await params;
  const asset=readAsset(id,user.id);if(!asset)return new Response('Not found',{status:404});
  const body=await request.json().catch(()=>({})) as {asset_group?:unknown;usage_declaration?:unknown};
  const group:Asset['assetGroupId']=body.asset_group===undefined?undefined:(body.asset_group===null?null:String(body.asset_group) as Exclude<Asset['assetGroupId'],null|undefined>);
  if(group!==undefined&&group!==null&&!CERTIFIED_GROUPS.has(group))return json({error:'无效的资产分组'},400);
  const declaration=body.usage_declaration===undefined?undefined:String(body.usage_declaration||'').slice(0,200);
  const updated=await mutateAsset(user.id,id,current=>{if(!current.type.startsWith('image/'))throw Error('人脸认证仅支持图片素材');return {...current,...(group!==undefined?{assetGroupId:group}:{}),...(declaration!==undefined?{usageDeclaration:declaration}:{}),updatedAt:Date.now()};});
  const g=updated.assetGroupId||null;
  return json({id,assetGroupId:g,certified:g==='certified_real',usageDeclaration:updated.usageDeclaration??null,
    message:g==='certified_real'?'已标记为认证真人素材（人工声明），可用于视频生成引用':'资产分组已更新'});
}catch(e){return errorResponse(e);}}
