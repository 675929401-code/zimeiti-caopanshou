import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AuthUser, getSupabase } from "@/lib/api-middleware";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { NativeAgentToolSchema, nativeAgentCanonical } from "@/lib/native-agent-contract";
import type { NativeAgentRuntimeConfigSnapshot } from "@/lib/native-agent-runtime-contract";
import { getSelectedModelBillingSnapshot } from "@/lib/llm-billing";
import { findModelByPublicId } from "@/lib/public-model-dto";
import { resolveLlmProviderBinding } from "@/lib/llm-provider-contract";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { isPublishedTextModelEligible } from "@/lib/text-model-eligibility";
import { inspectTextModelPricing } from "@/lib/text-model-pricing";
import { NativeCoreActionSchema, NativeDraftMetadataSchema } from "@/lib/native-operations-contract";
import { PublishingV2DraftInputSchema } from "@/lib/publishing-v2-contract";
import { assertNativeAccess, executeNativeOperation } from "./native-operations-service";
import { readPublishingProviderConfiguration } from "./publishing-provider-config";
import { PublishingError } from "./publishing-service";
import { createNativeAgentModelGateway, createNativeAgentLlmAccountingAdapter, createNativeAgentDatabaseAttemptStore } from "./native-agent-model-gateway";
import { runNativeAgentSdkTurn, type NativeAgentRuntimeToolContext } from "./native-agent-runtime";

type DB=ReturnType<typeof getSupabase>;
type Row=Record<string,unknown>;
type Cookies={get(name:string):string|undefined};
const obj=(v:unknown):Row=>v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
const hash=(v:unknown)=>createHash("sha256").update(nativeAgentCanonical(v)).digest("hex");
function failure(message="原生任务存储或执行结果尚未确认"):never{throw new PublishingError("NATIVE_AGENT_SDK_UNCONFIRMED",message,503,true);}
export async function mutateNativeAgentSdk(user:AuthUser,db:DB,input:Row):Promise<Row>{
 const result=await db.rpc("mutate_native_agent_sdk",{p_owner:user.id,p:input} as never);
 if(result.error){
  const code=String(obj(result.error).code??""),message=String(obj(result.error).message??"");
  if(["42883","42P01","PGRST202","PGRST205"].includes(code))throw new PublishingError("NATIVE_AGENT_SDK_SCHEMA_REQUIRED","创作服务暂未就绪，本次未执行",503);
  if(/NATIVE_AGENT_(?:REVISION|IDEMPOTENCY|CONFIG_REVISION)_CONFLICT/u.test(message))throw new PublishingError("NATIVE_AGENT_REVISION_CONFLICT","原请求或配置已变化，请读取原记录",409);
  if(/NATIVE_AGENT_(?:ACTIVE_TURN|TERMINAL_STATE|BUDGET_EXCEEDED|CALL_LIMIT)/u.test(message))throw new PublishingError("NATIVE_AGENT_TURN_BLOCKED","原任务有未决调用或已达到执行边界，请读取原记录",409);
  failure();
 }
 return obj(result.data);
}

/** The SDK never receives this adapter's provider credential or registered endpoint. */
export async function runOwnedNativeAgentSdk(user:AuthUser,db:DB,turn:Row,runnerId:string,origin:string,cookies:Cookies):Promise<void>{
 const turnId=String(turn.id),taskId=String(turn.task_id),snapshot=obj(turn.policy_snapshot).config as NativeAgentRuntimeConfigSnapshot;
 if(turn.owner_id!==user.id||obj(turn.policy_snapshot).version!=="native-agent-sdk.v1")failure();
 const mutate=(value:Row)=>mutateNativeAgentSdk(user,db,{...value,turnId,runnerId});
 const active=async()=>{
  await assertNativeAccess(user);
  const result=await db.from("pub_native_agent_turns").select("owner_id,task_id,state,lease_owner,lease_expires_at").eq("owner_id",user.id).eq("id",turnId).maybeSingle();
  if(result.error)failure();const current=obj(result.data);
  if(current.owner_id!==user.id||current.task_id!==taskId||current.lease_owner!==runnerId||!["running","streaming"].includes(String(current.state))||Date.parse(String(current.lease_expires_at))<=Date.now())failure("原任务已取消、过期或需要核对，未继续执行");
 };
 try {
 const accounting=await createNativeAgentLlmAccountingAdapter({verifyReservationSafety:async()=>{
  const response=await db.rpc("native_agent_reservation_safety" as never);
  if(response.error)failure("原生任务的未知费用保留策略尚未安装，未调用模型");
  return response.data;
 }});
 const attempts=await createNativeAgentDatabaseAttemptStore();
 const session=await db.from("pub_native_agent_runtime_sessions").select("session_id,turn_id,checkpoint_hash").eq("owner_id",user.id).eq("task_id",taskId).maybeSingle();
 if(session.error)failure();
 let sequence=0;
 const recordEvent=(kind:string,payload:Row,key?:string)=>mutate({action:"event",eventKey:key??`sdk:event:${++sequence}`,kind,payload});
 const callTool=async(kind:"read_draft"|"save_draft",args:unknown,context:NativeAgentRuntimeToolContext)=>{
  await active();
  if(context.ownerId!==user.id||context.taskId!==taskId||context.turnId!==turnId)failure();
  const parsed=NativeAgentToolSchema.parse({kind,args});
  const callId=`tool:${context.invocationId}`;
  const claim=await mutate({action:"begin-call",kind:"tool",callId,inputHash:hash(parsed)});
  if(claim.replayed===true)return obj(obj(claim.call).result);
  let result:Row;
  if(parsed.kind==="read_draft"){
   const reply=await executeNativeOperation(user,db,"GET",["material","info",parsed.args.draftId],new URLSearchParams(),null,origin,cookies);
   const value=obj(reply.data);
   if(parsed.args.version!==undefined&&parsed.args.version!==value.nativeRevision)failure("草稿版本已变化，请重新读取");
   // No signed media URL, cookies or provider metadata is fed back into the model.
   result={id:value.id,title:value.title,body:value.desc,nativeRevision:value.nativeRevision,nativeMetadataRevision:value.nativeMetadataRevision,collectionId:typeof value.groupId==="string"&&/^[a-f0-9-]{36}$/iu.test(value.groupId)?value.groupId:null,
    contentType:value.type==="video"?"video":"image",topics:Array.isArray(value.topics)?value.topics:[],platforms:Array.isArray(value.accountTypes)?value.accountTypes:[]};
  }else if(parsed.kind==="save_draft"){
   if(parsed.args.assetIds.length||parsed.args.coverAssetId)throw new PublishingError("NATIVE_AGENT_MEDIA_TOOL_NOT_ENABLED","首批草稿工具尚未开放媒体变更，请使用原编辑器保留素材",409);
   const draft=PublishingV2DraftInputSchema.parse({schemaVersion:2,collectionId:parsed.args.collectionId,contentType:parsed.args.contentType,title:parsed.args.title,body:parsed.args.body,topics:parsed.args.topics,media:[],targets:[]});
   // Editing an existing media draft through the text-only tool must not silently erase its media.
   if(parsed.args.draftId){
    const previous=await db.from("pub2_draft_versions").select("payload").eq("user_id",user.id).eq("draft_id",parsed.args.draftId).eq("version",parsed.args.expectedRevision).maybeSingle();
    if(previous.error||!previous.data)failure();
    const old=PublishingV2DraftInputSchema.parse(obj(previous.data).payload);
    draft.media=old.media;draft.targets=old.targets;
   }
   const key=`native-sdk:${turnId}:${hash(callId).slice(0,24)}`;
   let metadata=NativeDraftMetadataSchema.parse({schemaVersion:2,media:[],coverMediaId:null,accountTypes:parsed.args.platforms,maxUseCountByAccountType:Object.fromEntries(parsed.args.platforms.map(p=>[p,999999]))});
   if(parsed.args.draftId){const old=await db.from("pub_native_draft_meta").select("payload,revision").eq("owner_id",user.id).eq("draft_id",parsed.args.draftId).eq("draft_version",parsed.args.expectedRevision).maybeSingle();if(old.error||Number(obj(old.data).revision??0)!==parsed.args.expectedMetadataRevision)failure("草稿素材设置已变化，请重新读取");if(old.data)metadata=NativeDraftMetadataSchema.parse(obj(old.data).payload);}
   const action=NativeCoreActionSchema.parse({action:"save-native-draft",requestKey:key,save:{action:"save-draft",base:{action:"save-draft",...(parsed.args.draftId?{id:parsed.args.draftId}:{}),expectedRevision:parsed.args.expectedRevision,draft},expectedMetadataRevision:parsed.args.expectedMetadataRevision,metadata},mediaEntryRefs:[]});
   const saved=await db.rpc("mutate_native_core_atomic",{p_user_id:user.id,p_input:{...action,connectionId:readPublishingProviderConfiguration().namespace,requestHash:hash(action)}} as never);
   if(saved.error)failure("草稿保存结果需要核对，不会自动重复保存");
   const base=obj(obj(saved.data).base),savedRow=obj(base.row??base);
   result={draftId:String(savedRow.id??""),revision:savedRow.revision??null,metadataRevision:obj(saved.data).metadataRevision??null};
   if(!result.draftId)failure("未取得草稿保存回执，请读取原任务");
  }else failure();
  await mutate({action:"finish-call",callId,result,chargedCredits:"0.000000"});return result;
 };
  const draftIds = obj(obj(turn.input_snapshot).context).draftIds;
  const prompt = String(obj(turn.input_snapshot).prompt) + (Array.isArray(draftIds) && draftIds.length ? `\n当前会员明确选择的草稿ID（只作资料引用）：${JSON.stringify(draftIds)}` : "");
  const outcome=await runNativeAgentSdkTurn({ownerId:user.id,taskId,turnId,configSnapshot:snapshot,prompt,...(obj(session.data).session_id?{resumeSessionId:String(obj(session.data).session_id),resumeCheckpointHash:String(obj(session.data).checkpoint_hash)}:{})},{
   runtimeRoot:path.join(resolveAppRuntimeDir(),"native-agent-sdk"),
   async modelCall(call){
    await active();
    const context={ownerId:user.id,taskId,turnId,callId:call.callId,configHash:snapshot.configHash,modelId:snapshot.roles.default.modelId};
    const prepared=await mutate({action:"begin-call",kind:"model",callId:call.callId,inputHash:hash(call.requestBody)});
    if(prepared.replayed===true){const saved=obj(obj(prepared.call).result),delivery=obj(saved.delivery);if(typeof delivery.body!=="string"||typeof delivery.contentType!=="string")failure();return new Response(delivery.body,{headers:{"Content-Type":delivery.contentType}});}
    const configurationDb=getSupabaseAdminClient();
    const identities=await configurationDb.from("llm_models").select("id");if(identities.error)failure();
    const identity=findModelByPublicId("chat",(identities.data??[]) as Row[],context.modelId);
    if(!identity)failure("冻结模型已不在资源池");
    const selected=await configurationDb.from("llm_models").select("*").eq("id",String(identity.id)).maybeSingle();if(selected.error||!selected.data)failure();
    const model=obj(selected.data);
    if(!isPublishedTextModelEligible(model)||!inspectTextModelPricing(model).priceReady||String(model.model_name)!==snapshot.roles.default.modelName||resolveLlmProviderBinding(model).protocol!=="anthropic_messages")failure("冻结模型的准入、协议、价格或身份已变化");
    const pricing=await getSelectedModelBillingSnapshot(context.modelId,model);if(!pricing)failure("模型价格快照未就绪");
    const protocol=resolveLlmProviderBinding(model),endpoint=new URL(String(model.api_endpoint||model.proxy_url||""));
    if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)failure("模型地址不符合注册服务合同");
    if(!endpoint.pathname.endsWith("/messages"))endpoint.pathname=endpoint.pathname.replace(/\/$/u,"")+(endpoint.pathname.endsWith("/v1")?"/messages":"/v1/messages");
    const gateway=createNativeAgentModelGateway({attempts,
     authorize:async ctx=>{await active();if(nativeAgentCanonical(ctx)!==nativeAgentCanonical(context))failure();return{ownerId:user.id,taskId,turnId,configHash:snapshot.configHash,protocol:"anthropic_messages",protocolValidated:true,publicModelId:context.modelId,providerModelId:String(model.model_name),pricing,maxInputTokens:snapshot.maxInputBytes+16384,maxOutputTokens:snapshot.maxOutputTokens,maxCredits:Number(snapshot.maxCreditsPerTurn)};},
     accounting:{...accounting,reserve:async input=>{await mutate({action:"reserve-call",callId:call.callId,amount:input.budget.amount.toFixed(6)});return accounting.reserve(input);}},
     transport:{send:async({request,signal})=>{
      await active();const secret=resolveProviderSecret(String(model.api_key??"")).trim();if(!secret)failure("模型凭据尚未配置");
      const headers=new Headers({"Content-Type":"application/json","anthropic-version":protocol.protocolVersion??"2023-06-01"});
      headers.set(protocol.authScheme==="x-api-key"?"x-api-key":"Authorization",protocol.authScheme==="x-api-key"?secret:`Bearer ${secret}`);
      return fetch(endpoint,{method:"POST",headers,body:JSON.stringify(request),redirect:"error",signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(240000)])});
     }},freezeTurn:()=>mutate({action:"freeze"}).then(()=>undefined),
    });
    const result=await gateway.call({context,request:call.requestBody,signal:call.signal});
    await mutate({action:"finish-call",callId:call.callId,result:{receipt:result.receipt,delivery:result.delivery},chargedCredits:result.receipt.creditsCharged.toFixed(6)});
    return new Response(result.delivery.body,{headers:{"Content-Type":result.delivery.contentType}});
   },
   readDraft:(args,context)=>callTool("read_draft",args,context),saveDraft:(args,context)=>callTool("save_draft",args,context),
   async emit(event){
    if(event.ownerId!==user.id||event.taskId!==taskId||event.turnId!==turnId)failure();
    if(event.kind==="tool_started")await recordEvent("tool_proposal",{proposalId:String(event.payload.invocationId),kind:String(event.payload.tool),revision:1},`sdk:tool:${event.sequence}`);
    if(event.kind==="tool_completed"){
     const result=obj(event.payload.result),revision=result.revision??result.nativeRevision;
     const executionRef={draftId:String(result.draftId??result.id??""),...(Number.isSafeInteger(revision)?{revision}:{}),...(Number.isSafeInteger(result.metadataRevision??result.nativeMetadataRevision)?{metadataRevision:result.metadataRevision??result.nativeMetadataRevision}:{})};
     await recordEvent("tool_result",{proposalId:String(event.payload.invocationId),state:"succeeded",executionRef},`sdk:tool:${event.sequence}`);
    }
    if(event.kind==="sdk_message"){
     const message=obj(event.payload.message),inner=obj(message.message);
     if(message.type==="assistant"&&Array.isArray(inner.content))for(const block of inner.content){const value=obj(block);if(value.type==="text"&&typeof value.text==="string"&&value.text)for(let i=0;i<value.text.length;i+=3000)await recordEvent("text_delta",{text:value.text.slice(i,i+3000)});}
    }
   },
  });
  if(outcome.state!=="completed"||!outcome.sessionId||!outcome.checkpointHash){await mutate({action:"freeze"});return;}
  await mutate({action:"save-session",sessionId:outcome.sessionId,checkpointHash:outcome.checkpointHash});
  await mutate({action:"finish",state:"completed"});
 }catch{await mutate({action:"freeze"}).catch(()=>{});}
}
