import {requireIdentity,sameOrigin} from '../../../../../commerce/server/auth';
import {downloadResult,storeAsset} from '../../../../../commerce/server/assets';
import {json,errorResponse} from '../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const body=await request.json();if(typeof body.url!=='string'||!body.url.startsWith('https://')||!['image','video','audio'].includes(body.kind))throw Error('请填写公开 HTTPS 图片或视频地址');const media=await downloadResult(body.url,body.kind);const asset=await storeAsset(user.id,media.bytes,media.type,String(body.name||`导入素材.${media.type.split('/')[1]}`));return json({id:asset.id});}catch(e){return errorResponse(e);}}
