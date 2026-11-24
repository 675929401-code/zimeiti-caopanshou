import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {generateMemberSlides} from '@/commerce/server/member-slides';
import {json,errorResponse} from '@/commerce/server/http';

export const runtime='nodejs';

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const member=requireIdentity(request);
    await authorizeCurrentCommerceIdentity(member);
    if(Number(request.headers.get('content-length'))>350_000)return json({error:'演示稿描述过大'},413);
    const text=await request.text();
    if(text.length>100_000)return json({error:'最多支持 100000 个字符'},413);
    let value;
    try{value=JSON.parse(text);}catch{return json({error:'请输入有效的演示稿 JSON'},400);}
    return json(await generateMemberSlides(member.id,value));
  }catch(error){return errorResponse(error);}
}
