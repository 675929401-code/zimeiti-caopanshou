import { requireIdentity, sameOrigin } from '@/commerce/server/auth';
import { authorizeCurrentCommerceIdentity } from '@/commerce/server/main-account-access';
import { json, errorResponse } from '@/commerce/server/http';
import { projectList, loadProject, changeProject } from '@/features/commerce-studio/project-store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function owner(request:Request){const identity=requireIdentity(request);await authorizeCurrentCommerceIdentity(identity);return identity.id;}
export async function GET(request:Request) {
  try {const id= new URL(request.url).searchParams.get('projectId'),user=await owner(request);
    return json(id?loadProject(user,id):{projects:projectList(user)});
  } catch(error){return errorResponse(error);}
}
export async function POST(request:Request) {
  try {sameOrigin(request);const user=await owner(request);
    const body=await request.text();if(body.length>20000)throw Error('项目资料过大');
    return json(changeProject(user,JSON.parse(body)));
  } catch(error){return errorResponse(error);}
}
