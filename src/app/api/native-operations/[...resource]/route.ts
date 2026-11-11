import { after,NextRequest,NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { NATIVE_CSRF_HEADER } from "@/lib/native-operations-contract";
import { PublishingError,publishingFailure,readPublishingJson } from "@/lib/server/publishing-service";
import { PublishingV3Error } from "@/lib/server/publishing-v3-service";
import { assertNativeAccess,executeNativeOperation,mintNativeCsrf,NATIVE_CSRF_COOKIE,readNativeHostSession,verifyNativeCsrf } from "@/lib/server/native-operations-service";
import { publishingAuthCookieName } from "@/lib/server/publishing-auth-continuation";
import { readNativePublishingAsset } from "@/lib/server/native-operations-asset";
import { executeNativeAgentOperation } from "@/lib/server/native-agent-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{resource:string[]}>};
const headers={"Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff"};
function localHttp(request:NextRequest){const url=new URL(request.url);return url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname);}
function nativeFailure(error:unknown){const failure=publishingFailure(error);return NextResponse.json({code:failure.body.code??"NATIVE_SERVICE_UNAVAILABLE",data:null,message:failure.body.error??"主站服务暂不可用",...(failure.body.outcome?{outcome:failure.body.outcome}:{}),...(error instanceof PublishingV3Error&&error.operationId?{operationId:error.operationId}:{})},{status:failure.status,headers});}
function requireOrigin(request:NextRequest){const source=request.headers.get("origin");if(!source||request.headers.get("sec-fetch-site")==="cross-site")throw new PublishingError("NATIVE_CSRF_REJECTED","请求来源校验失败",403);let url:URL;try{url=new URL(source);}catch{throw new PublishingError("NATIVE_CSRF_REJECTED","请求来源校验失败",403);}if(url.host.toLowerCase()!==String(request.headers.get("host")||"").toLowerCase()||url.protocol!=="https:"&&!(["127.0.0.1","localhost","[::1]"].includes(url.hostname)&&url.protocol==="http:"))throw new PublishingError("NATIVE_CSRF_REJECTED","请求来源校验失败",403);}
async function handle(request:NextRequest,context:Context){
 const rawSession=request.cookies.get("auth_token")?.value;
 if(!rawSession||request.headers.has("authorization"))return NextResponse.json({code:"SESSION_EXPIRED",data:null,message:"请先登录主站"},{status:401,headers});
 try{
  const response=await withAuth(request,async(user,db)=>{
   const {resource}=await context.params;const path=resource.join("/");
   const assetRead=resource.length===3&&resource[0]==="assets"&&resource[2]==="content"&&request.method==="GET";
   if(!(path==="session"&&request.method==="GET")&&!assetRead&&request.headers.get("x-native-actor-id")!==user.id)throw new PublishingError("NATIVE_ACTOR_CHANGED","主站登录会员已变化，请重新打开工作台",409);
   const permission=await assertNativeAccess(user);const permissionBinding=`${user.role}:${permission.revision}:${permission.checksum}`;
   if(request.method!=="GET"){requireOrigin(request);if(!verifyNativeCsrf(user.id,rawSession,request.headers.get(NATIVE_CSRF_HEADER)||"",request.cookies.get(NATIVE_CSRF_COOKIE)?.value||"",permissionBinding))throw new PublishingError("NATIVE_CSRF_REJECTED","页面验证已过期，请刷新后继续",403);}
   if(path==="session"&&request.method==="GET"){if(new URL(request.url).search)throw new PublishingError("NATIVE_INPUT_INVALID","会话入口不接受查询参数",400);const prior=request.cookies.get(NATIVE_CSRF_COOKIE)?.value??"";const token=verifyNativeCsrf(user.id,rawSession,prior,prior,permissionBinding)?prior:mintNativeCsrf(user.id,rawSession,permissionBinding),data=await readNativeHostSession(user,db,token);const out=NextResponse.json({code:0,data,message:""},{headers});out.cookies.set(NATIVE_CSRF_COOKIE,token,{httpOnly:true,secure:!localHttp(request),sameSite:"strict",path:"/api/native-operations",expires:new Date(Number(token.split(".")[1]))});return out;}
   if(resource.length===3&&resource[0]==="assets"&&resource[2]==="content"&&request.method==="GET"){if(new URL(request.url).search)throw new PublishingError("NATIVE_INPUT_INVALID","素材入口不接受地址参数",400);return readNativePublishingAsset(request,user,db,resource[1]);}
   if(resource[0]==="agent"){
    const result=await executeNativeAgentOperation(user,db,request.method,resource,new URL(request.url).searchParams,request.method==="GET"||request.method==="DELETE"&&!request.headers.has("content-type")?undefined:await readPublishingJson(request),new URL(request.url).origin,{get:name=>request.cookies.get(name)?.value},{headers:request.headers,signal:request.signal});
    // Start the durable runner before returning its live SSE response. Registering
    // a callback here would defer generation until that response had closed.
    if(result.continuation){const work=result.continuation();after(work);}
    return result.response??NextResponse.json({code:0,data:result.data,message:""},{headers});
   }
   const result=await executeNativeOperation(user,db,request.method,resource,new URL(request.url).searchParams,request.method==="GET"||request.method==="DELETE"&&!request.headers.has("content-type")?undefined:await readPublishingJson(request),new URL(request.url).origin,{get:name=>request.cookies.get(name)?.value});
   if(result.work){const work=result.work();after(work);}
   const out=NextResponse.json({code:0,data:result.data,message:""},{headers});
   if(result.continuation){const c=result.continuation;out.cookies.set(publishingAuthCookieName(c.sessionId),c.value,{httpOnly:true,secure:!localHttp(request),sameSite:"strict",path:"/api/native-operations",expires:new Date(c.expiresAt)});}return out;
  });
  if(response.status===401||response.status===403||response.status===503){const body=await response.clone().json().catch(()=>null);if(body&&typeof body==="object"&&!("data" in body))return NextResponse.json({code:response.status===401?"SESSION_EXPIRED":body.code??"NATIVE_SERVICE_UNAVAILABLE",data:null,message:body.error??"主站登录状态暂不可确认"},{status:response.status,headers});}
  return response;
 }catch(error){return nativeFailure(error);}
}
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const PATCH=handle;
export const DELETE=handle;
