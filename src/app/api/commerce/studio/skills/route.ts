import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {json,errorResponse} from '@/commerce/server/http';
import {readSkillLibrary,changeSkill} from '@/features/commerce-studio/member-skill-store';

export const runtime='nodejs';
export const dynamic='force-dynamic';
async function owner(request:Request){
  const identity=requireIdentity(request);
  await authorizeCurrentCommerceIdentity(identity);
  return identity.id;
}
export async function GET(request:Request){
  try{return json(readSkillLibrary(await owner(request)));}catch(error){return errorResponse(error);}
}
export async function POST(request:Request){
  try{
    sameOrigin(request);
    const member=await owner(request),body=await request.text();
    if(body.length>10000)throw Error('技能资料过大');
    return json(changeSkill(member,JSON.parse(body)));
  }catch(error){return errorResponse(error);}
}
