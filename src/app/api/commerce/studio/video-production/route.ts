import {requireIdentity, sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {errorResponse,json} from '@/commerce/server/http';
import {memberVideoProduction} from '@/commerce/server/member-video-production';

export const runtime='nodejs';
export async function POST(request:Request) {
  try {
    sameOrigin(request);
    const user=requireIdentity(request);
    await authorizeCurrentCommerceIdentity(user);
    return json(await memberVideoProduction(user.id,await request.json()));
  } catch(error) {return errorResponse(error);}
}
