import { NextRequest,NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { PublishingV3ActionSchema,PublishingV3QuerySchema } from "@/lib/publishing-v3-contract";
import { publishingFailure,readPublishingJson,PublishingError } from "@/lib/server/publishing-service";
import { mutatePublishingV3,readPublishingV3,PublishingV3Error,type PublishingV3Result } from "@/lib/server/publishing-v3-service";
import { publishingAuthCookieName } from "@/lib/server/publishing-auth-continuation";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store, max-age=0"};
function response(result:PublishingV3Result,request:NextRequest){const out=NextResponse.json(result.body,{headers});if(result.continuation){const continuation=result.continuation;const url=new URL(request.url);const localHttp=url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname);out.cookies.set(publishingAuthCookieName(continuation.sessionId),continuation.value,{httpOnly:true,secure:!localHttp,sameSite:"strict",path:"/api/publish-center/v3",expires:new Date(continuation.expiresAt)});}return out;}
function failure(error:unknown){const result=publishingFailure(error);return NextResponse.json({...result.body,...(error instanceof PublishingV3Error&&error.operationId?{operationId:error.operationId}:{})},{status:result.status,headers});}
export async function GET(request:NextRequest){try{return await withAuth(request,async(user,db)=>{const query=PublishingV3QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!query.success)throw new PublishingError("PUBLISH_API_INPUT_INVALID","官方资源查询参数无效",400);return response(await readPublishingV3(user,db,query.data),request);});}catch(error){return failure(error);}}
export async function POST(request:NextRequest){try{return await withAuth(request,async(user,db)=>{const action=PublishingV3ActionSchema.safeParse(await readPublishingJson(request));if(!action.success)throw new PublishingError("PUBLISH_API_INPUT_INVALID","官方发布操作参数不符合合同",400);return response(await mutatePublishingV3(user,db,action.data,{get:name=>request.cookies.get(name)?.value}),request);});}catch(error){return failure(error);}}
