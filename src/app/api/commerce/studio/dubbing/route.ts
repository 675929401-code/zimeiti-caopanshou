import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {advanceDub,dubHistory,quoteDub} from '@/commerce/server/dubbing';
import {isDubSkill} from '@/commerce/shared/dubbing';
import {json,errorResponse} from '@/commerce/server/http';
export const runtime='nodejs';
export const maxDuration=600;
export async function GET(request:Request){try{const u=requireIdentity(request);await authorizeCurrentCommerceIdentity(u);const skill=new URL(request.url).searchParams.get('skill')||'';if(!isDubSkill(skill))return json({error:'请选择配音技能'},400);return json({jobs:dubHistory(u.id,skill)});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const u=requireIdentity(request),acct=await authorizeCurrentCommerceIdentity(u),b=await request.json();
 if(b.action==='quote'&&typeof b.assetId==='string'&&typeof b.srt==='string'&&b.srt.length<=15000&&isDubSkill(b.skill))return json({job:await quoteDub(u.id,b)});
 if(['confirm','refresh'].includes(b.action)&&typeof b.id==='string'&&/^[\da-f-]{36}$/.test(b.id))return json({job:await advanceDub(u.id,acct,b.id,b.action==='confirm')});
 return json({error:'配音请求无效'},400);
}catch(e){return errorResponse(e);}}
