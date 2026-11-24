import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {json,errorResponse} from '@/commerce/server/http';
import {get,put,transaction} from '@/commerce/server/store';
import {defaultAgentPreferences,defaultMediaPreferences,validMediaPreference,type AgentPreferences,type MediaPreferences} from '@/features/commerce-studio/agent-preferences';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const bucket='studio-agent-preferences';
async function ownerId(request:Request){
 const identity=requireIdentity(request);await authorizeCurrentCommerceIdentity(identity);return identity.id;
}
function read(owner:string){return get<AgentPreferences>(bucket,owner,owner)||defaultAgentPreferences;}
export async function GET(request:Request){
 try{return json({preferences:read(await ownerId(request))});}catch(error){return errorResponse(error);}
}
export async function POST(request:Request){
 try{
  sameOrigin(request);const owner=await ownerId(request),text=await request.text();
  if(text.length>1500)throw Error('偏好内容过长');
  const {kind,field,value}=JSON.parse(text);
  if((kind!=='image'&&kind!=='video')||typeof field!=='string'||!Object.hasOwn(defaultMediaPreferences,field)||typeof value!=='string'||!validMediaPreference(kind,field as keyof MediaPreferences,value))throw Error('偏好选项无效');
  const preferences=transaction(()=>{const prev=read(owner),next={...prev,[kind]:{...prev[kind as keyof AgentPreferences],[field]:value}};put(bucket,owner,owner,next);return next;});
  return json({preferences});
 }catch(error){return errorResponse(error);}
}
