import { NextRequest,NextResponse } from "next/server";
import { authorizeAdminCapability,getAdminStepUpToken,hashAdminStepUpToken,readAdminStepUpSnapshot } from "@/lib/server/admin-governance-authority";
import { parsePublication,parsePublicationJson,PublicationFailure,PUBLICATION_ID,PUBLICATION_UUID,requirePublicationDestination } from "@/lib/server/agent-catalog-publication";
import { readReceipt,runPublication,sourceProjection,readPublicationIndex } from "@/lib/server/agent-catalog-publication-service";
import { isPlatformDisplayHost,normalizeDirectHostHeader } from "@/lib/white-label-host";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private,no-store,max-age=0","Vary":"Authorization, Cookie","X-Content-Type-Options":"nosniff"};
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers});
async function authorize(request:NextRequest,write:boolean){
  const auth=await authorizeAdminCapability(request,"backups.manage",{requireStepUp:true,operation:write?"agent_catalog_publication":"agent_catalog_publication_read"});
  if(!auth.ok)return auth;
  const {access,actor,stepUp,maintenanceLock}=auth;
  if(access.adminLevel!=="super_admin"||access.revision<1||!access.integrityValid||!access.profileActive||access.authorityStatus!=="ready"
    || !access.checksum || access.checksum==="legacy-schema-absent" || maintenanceLock?.status!=="ready" || maintenanceLock.enabled || stepUp?.status!=="ready" || !stepUp.sessionId)
    throw new PublicationFailure("CATALOG_OWNER_STEP_UP_REQUIRED",403);
  const required=write?["agents.manage","prompts.view","prompts.edit","models.manage","internal_tools.manage"]:["agents.view","prompts.view","models.manage","internal_tools.manage"];
  if(!required.every(k=>access.permissionKeys.includes(k)))throw new PublicationFailure("CATALOG_PERMISSION_DENIED",403);
  const scopes=await Promise.all(required.map(k=>readAdminStepUpSnapshot(request,actor.userId,k)));
  if(scopes.some(s=>s.status!=="ready"||s.sessionId!==stepUp.sessionId))throw new PublicationFailure("CATALOG_SCOPED_STEP_UP_REQUIRED",403);
  return auth;
}
function failure(error:unknown){return error instanceof PublicationFailure?json({ok:false,code:error.code},error.status):json({ok:false,code:"CATALOG_PUBLICATION_UNAVAILABLE"},503);}
async function body(request:NextRequest){
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new PublicationFailure("CATALOG_JSON_REQUIRED",415);
  const reader=request.body?.getReader();if(!reader)throw new PublicationFailure("CATALOG_BODY_REQUIRED");
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>768*1024){await reader.cancel();throw new PublicationFailure("CATALOG_BODY_TOO_LARGE",413);}chunks.push(value);}
  return parsePublicationJson(Buffer.concat(chunks).toString("utf8"));
}
export async function GET(request:NextRequest){
  try{
    const auth=await authorize(request,false);if(!auth.ok)return auth.response;
    const q=request.nextUrl.searchParams,keys=[...q.keys()].sort().join(",");
    if(keys==="view" && q.get("view")==="index")return json({ok:true,index:await readPublicationIndex(auth.actor.userId,hashAdminStepUpToken(getAdminStepUpToken(request)))});
    if(keys==="requestKey" && PUBLICATION_UUID.test(q.get("requestKey")||""))return json({ok:true,receipt:await readReceipt(auth.actor.userId,q.get("requestKey")!)});
    if(keys!=="agentId,view" || !PUBLICATION_ID.test(q.get("agentId")||"") || !["source","hashes"].includes(q.get("view")||""))throw new PublicationFailure("CATALOG_EXPLICIT_SINGLE_CARD_REQUIRED");
    return json({ok:true,...await sourceProjection(q.get("agentId")!,q.get("view")==="source")});
  }catch(error){return failure(error);}
}
export async function POST(request:NextRequest){
  try{
    const auth=await authorize(request,true);if(!auth.ok)return auth.response;
    if(request.nextUrl.search)throw new PublicationFailure("CATALOG_QUERY_UNSUPPORTED");
    const origin=request.headers.get("origin");
    if(origin){let host:string;try{host=new URL(origin).host;}catch{throw new PublicationFailure("CATALOG_ORIGIN_INVALID",403);}
      if(host!==request.headers.get("host"))throw new PublicationFailure("CATALOG_ORIGIN_INVALID",403);}
    const entry=parsePublication(await body(request));
    if(entry.action==="apply"){
      const host=normalizeDirectHostHeader(request.headers.get("host"));
      requirePublicationDestination(process.env,host);
      if(!isPlatformDisplayHost(host))throw new PublicationFailure("CATALOG_PLATFORM_HOST_REQUIRED",403);
    }
    return json({ok:true,...await runPublication(entry,auth.actor.userId,hashAdminStepUpToken(getAdminStepUpToken(request)))});
  }catch(error){return failure(error);}
}
