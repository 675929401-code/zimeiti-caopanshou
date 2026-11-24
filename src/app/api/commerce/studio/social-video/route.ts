import {sameOrigin,requireIdentity} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {advanceSocialVideo,quoteSocialVideo,socialHistory,socialCover} from '@/commerce/server/social-video';
import {errorResponse,json} from '@/commerce/server/http';
export const runtime='nodejs';
export const maxDuration=150;
export async function GET(req:Request){try{const user=requireIdentity(req);await authorizeCurrentCommerceIdentity(user);return json({jobs:socialHistory(user.id)});}catch(e){return errorResponse(e);}}
export async function POST(req:Request){try{sameOrigin(req);const user=requireIdentity(req),account=await authorizeCurrentCommerceIdentity(user);const data=await req.json();
 if(data.action==='quote'&&typeof data.source==='string'&&data.source.length<=1500)return json({job:await quoteSocialVideo(user.id,data.source,data.skill==='multi-download')});
 if(data.action==='cover'&&typeof data.id==='string'&&/^[\da-f-]{36}$/.test(data.id))return json({asset:await socialCover(user.id,data.id)});
 if(['confirm','refresh'].includes(data.action)&&typeof data.id==='string'&&/^[\da-f-]{36}$/.test(data.id))return json({job:await advanceSocialVideo(user.id,account,data.id,data.action==='confirm')});
 return json({error:'作品解析操作无效'},400);
}catch(e){return errorResponse(e);}}

