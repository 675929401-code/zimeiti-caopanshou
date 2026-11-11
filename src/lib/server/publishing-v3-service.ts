import "server-only";
import { randomUUID } from "node:crypto";
import type { AuthUser,getSupabase } from "@/lib/api-middleware";
import { readMemberPermissionSnapshot } from "./member-permission-authority";
import { PublishingError,publishingRuntimeEnabled } from "./publishing-service";
import { publishingCashContentProof, publishingCashFailure } from './publishing-cash-service';
import { publishingCashV3Content } from '../publishing-cash-content';
import { PublishingProvider,PublishingProviderError,publishingProviderPayloadHash,projectProviderStatus,validatePublishingProviderOptions,type PublishingProviderScope,type PublishingProviderGrant,type PublishingProviderFlowInput } from "./publishing-provider";
import { readPublishingProviderConfiguration,PUBLISHING_OFFICIAL_LINKS } from "./publishing-provider-config";
import { sealPublishingAuthContinuation,openPublishingAuthContinuation,publishingAuthCookieName } from "./publishing-auth-continuation";
import { PublishingV2DraftInputSchema } from "@/lib/publishing-v2-contract";
import { PublishingV3AssetSchema,PublishingV3AuthSessionSchema,PublishingV3BindingSchema,PublishingV3CapabilitiesSchema,PublishingV3EventSchema,PublishingV3IntentSchema,PublishingV3MutationSchema,PublishingV3OperationSchema,PublishingV3PageSchema,PublishingV3StatusSchema,PublishingV3UserActionSchema,preparePublishingV3Content,validatePublishingV3Media,type PublishingV3Action,type PublishingV3Query,type PublishingV3IntentInput } from "@/lib/publishing-v3-contract";
type DB=ReturnType<typeof getSupabase>;type Row=Record<string,unknown>;type Configuration=ReturnType<typeof readPublishingProviderConfiguration>;
const rec=(v:unknown):Row=>v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
const rows=(v:unknown):Row[]=>Array.isArray(v)?v.map(rec):[];const str=(v:unknown)=>typeof v==="string"?v:"";const num=(v:unknown)=>Number(v||0);
const absent=new Set(["42P01","PGRST202","PGRST204","PGRST205"]);
export class PublishingV3Error extends PublishingError {constructor(code:string,message:string,status=400,public operationId?:string,unknown=false){super(code,message,status,unknown);}}
export interface PublishingV3Result { body:unknown; continuation?:{sessionId:string;value:string;expiresAt:string} }
/** Only the server bridge can supply this context. Public action schemas exclude it. */
export interface PublishingV3BridgeContext {bridgeId:string;phase:"sign"|"confirm";dispatchId:string}
const messages:Record<string,[number,string]>={
 PUBLISH_PROVIDER_BUSY:[429,"发布服务正忙，本次尚未领取额度或发送，请稍后继续原确认"],PUBLISH_DISPATCH_EXPIRED:[409,"原发送许可已过期，请核对原记录，不会重新发送"],PUBLISH_OFFICIAL_IDENTITY_CONFLICT:[409,"该官方账号已归属其他会员，请管理员核对"],
 NATIVE_MAIN_BRIDGE_REQUIRED:[409,"请先完成本站素材到官方素材的上传映射"],NATIVE_MAIN_BRIDGE_RESERVED:[409,"此素材已用于官方上传映射，请从原映射记录继续核对"],NATIVE_MAIN_BRIDGE_INVALID:[409,"官方上传映射许可或文件已变化，请核对原映射记录"],
 NATIVE_BRIDGE_MEDIA_RESERVED:[409,"此素材已用于原上传映射，请从原记录继续核对"],NATIVE_BRIDGE_NAMESPACE_CHANGED:[409,"官方连接已变化，请核对原素材映射；未取得新的上传许可"],NATIVE_BRIDGE_PHASE_INVALID:[409,"原上传阶段已有执行记录或尚未具备前序回执，请核对原记录"],NATIVE_BRIDGE_INPUT_INVALID:[400,"官方素材映射参数不符合合同"],NATIVE_BRIDGE_SOURCE_CHANGED:[409,"主站素材已变化，请重新选择并确认"],NATIVE_BRIDGE_NOT_FOUND:[404,"官方素材映射不存在或不属于当前会员"],NATIVE_BRIDGE_PUT_PROOF_INVALID:[409,"上传回执与原文件不一致，请核对原映射"],NATIVE_BRIDGE_HISTORY_IMMUTABLE:[409,"已确认的官方素材映射不能被覆盖"],
 PUBLISH_API_INPUT_INVALID:[400,"官方发布参数不符合合同"],PUBLISH_IDEMPOTENCY_CONFLICT:[409,"请求标识已用于不同内容，请核对原记录"],PUBLISH_REVISION_CONFLICT:[409,"内容或连接已有新版本，请刷新"],PUBLISH_API_BINDING_CHANGED:[409,"官方账号连接已变化，请重新选择"],PUBLISH_API_AUTH_SESSION_INVALID:[409,"授权会话不可继续，请重新授权"],PUBLISH_API_AUTH_SELECTION_INVALID:[400,"只能选择该授权会话返回的账号"],PUBLISH_API_ACCOUNT_ALREADY_OWNED:[409,"该官方账号已绑定其他会员，请核对账号归属"],PUBLISH_API_ASSET_INVALID:[409,"上传素材未核验或与原文件不一致"],PUBLISH_API_OPERATION_NOT_FOUND:[404,"操作不存在或状态已变化"],PUBLISH_API_INTENT_ALREADY_SUBMITTED:[409,"此意图版本已经提交，请查看原记录"],PUBLISH_API_TASK_STATE_INVALID:[409,"当前官方任务状态不支持该操作"],PUBLISH_API_SNAPSHOT_MISMATCH:[409,"发布快照与内容版本不一致，请重新准备"],PUBLISH_API_OUTCOME_UNVERIFIED:[409,"官方结果缺少作品证据，不能确认为成功"],PUBLISH_API_OUTCOME_CONFLICT:[409,"官方回执与已确认事实冲突，请核对原记录"],PUBLISH_ACCESS_DENIED:[403,"当前会员未开通发布中心"],PUBLISH_PERMISSION_UNAVAILABLE:[503,"会员权限暂不可确认"],PUBLISH_EXECUTION_DISABLED:[409,"官方发布尚未开放，可以先完成连接和素材准备"],PUBLISH_NO_QUOTA:[409,"发布执行额度不足"],PUBLISH_ENTITLEMENT_EXPIRED:[409,"发布执行额度已过期"],PUBLISH_ENTITLEMENT_NOT_FOUND:[404,"发布权益不存在"],PUBLISH_PLATFORM_NOT_ALLOWED:[403,"该权益不支持抖音"],PUBLISH_DRAFT_NOT_FOUND:[404,"内容版本不存在或已归档"],
};
function dbFailure(error:unknown):never {const value=rec(error);if(/PUBLISH_CASH_|VIDEO_BUDGET_CASH_RESERVED|WALLET_INSUFFICIENT/.test(str(value.message)))publishingCashFailure(error);if(absent.has(str(value.code)))throw new PublishingV3Error("PUBLISH_API_SCHEMA_NOT_READY","官方发布数据结构尚未初始化",503);const code=Object.keys(messages).find(k=>str(value.message).includes(k));if(code)throw new PublishingV3Error(code,messages[code][1],messages[code][0]);throw new PublishingV3Error("PUBLISH_API_SERVICE_UNAVAILABLE","操作结果暂不可确认，请读取原记录核对",503,undefined,true);}
async function rpc(db:DB,user:AuthUser,cfg:Configuration,input:Row){const result=await db.rpc("mutate_publish_v3_atomic",{p_user_id:user.id,p_input:{...input,connectionId:cfg.namespace}} as never);if(result.error)dbFailure(result.error);return rec(result.data);}
async function access(user:AuthUser){const p=await readMemberPermissionSnapshot(user.id,{knownRole:user.role});if(p.authorityStatus!=="ready"||!p.integrityValid||p.checksum==="legacy-schema-absent")throw new PublishingV3Error("PUBLISH_PERMISSION_UNAVAILABLE","会员权限暂不可确认",503);if(!p.featureNavigationKeys.includes("publish_center"))throw new PublishingV3Error("PUBLISH_ACCESS_DENIED","当前会员未开通发布中心",403);}
async function owned(db:DB,table:string,user:AuthUser,id:string,connection?:string):Promise<Row>{let q=db.from(table).select("*").eq("owner_id",user.id).eq("id",id);if(connection)q=q.eq("connection_id",connection);const result=await q.maybeSingle();if(result.error)dbFailure(result.error);if(!result.data)throw new PublishingV3Error("PUBLISH_API_RECORD_NOT_FOUND","记录不存在或不属于当前会员",404);return rec(result.data);}
function requireConfigured(cfg:Configuration){if(!cfg.apiKey)throw new PublishingV3Error("PROVIDER_NOT_CONFIGURED","官方API尚未配置，请联系管理员",409);}
async function executionGate(db:DB,cfg:Configuration){requireConfigured(cfg);if(!publishingRuntimeEnabled())throw new PublishingV3Error("PUBLISH_EXECUTION_DISABLED","官方发布尚未开放，可以先完成连接和素材准备",409);const result=await db.from("pub_config_versions").select("execution_enabled,enabled_platforms").order("version",{ascending:false}).limit(1).maybeSingle();if(result.error)dbFailure(result.error);if(!result.data||rec(result.data).execution_enabled!==true||!Array.isArray(rec(result.data).enabled_platforms)||(rec(result.data).enabled_platforms as unknown[]).includes("douyin")!==true)throw new PublishingV3Error("PUBLISH_EXECUTION_DISABLED","抖音官方发布尚未开放",409);}
function sessionDto(r:Row){const d=rec(r.display);return PublishingV3AuthSessionSchema.parse({id:r.id,platform:"douyin",state:["prepared","pending","requires_selection"].includes(str(r.state))&&r.expires_at&&Date.parse(str(r.expires_at))<=Date.now()?"expired":r.state,revision:r.revision,expiresAt:r.expires_at??null,createdAt:r.created_at,updatedAt:r.updated_at,...(d.url?{url:d.url}:{}),...(Array.isArray(d.selectableAccounts)?{selectableAccounts:d.selectableAccounts}:{})});}
function bindingDto(r:Row){return PublishingV3BindingSchema.parse({id:r.id,platform:"douyin",platformUid:r.platform_uid,displayName:r.display_name,avatar:r.avatar??null,status:r.status,revision:r.revision,authSessionId:r.auth_session_id,createdAt:r.created_at,updatedAt:r.updated_at});}
function assetDto(r:Row){return PublishingV3AssetSchema.parse({id:r.id,mediaId:r.local_media_id,fileName:r.file_name,mime:r.mime,size:num(r.size),sha256:r.sha256,hashSource:"browser_declared",state:r.state,revision:r.revision,expiresAt:r.expires_at??null,metadata:r.metadata??{},createdAt:r.created_at,updatedAt:r.updated_at});}
function intentDto(r:Row){return PublishingV3IntentSchema.parse({id:r.id,revision:r.revision,payload:r.payload,archived:r.archived,createdAt:r.created_at,updatedAt:r.updated_at});}
function operationDto(r:Row){return PublishingV3OperationSchema.parse({id:r.id,kind:r.kind,subjectId:r.subject_id,requestKey:r.request_key,dispatchState:r.dispatch_state,outcome:r.outcome,revision:r.revision,intentRevision:r.intent_revision??null,snapshotHash:r.snapshot_hash,errorCode:r.error_code??null,workId:r.work_id??null,workLink:r.work_link??null,createdAt:r.created_at,updatedAt:r.updated_at});}
function eventDto(r:Row){return PublishingV3EventSchema.parse({id:r.id,operationId:r.operation_id,kind:r.kind,source:r.source,payload:r.safe_payload,createdAt:r.created_at});}
function provider(user:AuthUser,cfg:Configuration,db:DB,op?:Row,extra:Partial<Record<keyof PublishingProviderScope,ReadonlySet<string>>>={}) {
 requireConfigured(cfg);const request=rec(rec(op?.snapshot).request);const item=rec(Array.isArray(request.items)?request.items[0]:undefined);
 const scope:PublishingProviderScope={ownerId:user.id,accountIds:extra.accountIds??new Set([str(item.accountId)].filter(Boolean)),flowIds:extra.flowIds??new Set([str(op?.flow_id)].filter(Boolean)),recordIds:extra.recordIds??new Set([str(op?.provider_record_id)].filter(Boolean)),taskIds:extra.taskIds??new Set([str(op?.provider_task_id)].filter(Boolean)),authSessionIds:extra.authSessionIds??new Set(),assetIds:extra.assetIds??new Set()};
 return new PublishingProvider({environment:cfg.environment,apiKey:cfg.apiKey,scope,consumeGrant:async(grant:PublishingProviderGrant)=>{
  if(!op||str(op.owner_id)!==user.id||str(op.connection_id)!==cfg.namespace||grant.ownerId!==user.id||grant.operationId!==op.id||grant.kind!==op.grant_kind||grant.subject!==op.grant_subject||grant.payloadHash!==op.provider_request_hash)return false;
  if(op.kind==="publish"||op.kind==="task_change")await executionGate(db,cfg);
  const result=await rpc(db,user,cfg,{action:"consume-grant",operationId:op.id,grantKind:grant.kind,grantSubject:grant.subject,providerRequestHash:grant.payloadHash});
  if(result.consumed===true)Object.assign(op,rec(result.operation));
  return result.consumed===true;
 }});
}
async function existing(db:DB,user:AuthUser,cfg:Configuration,requestKey:string){const result=await db.from("pub3_operations").select("*").eq("owner_id",user.id).eq("request_key",requestKey).maybeSingle();if(result.error)dbFailure(result.error);const op=result.data?rec(result.data):null;if(op&&op.connection_id!==cfg.namespace)throw new PublishingV3Error("PUBLISH_API_CONNECTION_CHANGED","连接凭据已变化，请重新准备操作",409);return op;}
function requestHash(action:unknown,cfg:Configuration){return publishingProviderPayloadHash({connection:cfg.namespace,action});}
async function prepare(db:DB,user:AuthUser,cfg:Configuration,action:Extract<PublishingV3Action,{requestKey:string}>,internal:Row,request:Row,snapshot:Row={},bridge?:PublishingV3BridgeContext){
 const input={...internal,operationId:internal.operationId??randomUUID(),requestKey:action.requestKey,requestHash:requestHash(action,cfg),providerRequestHash:publishingProviderPayloadHash(request),snapshot:{...snapshot,request}};
 if(!bridge)return rec((await rpc(db,user,cfg,input)).operation);
 const result=await db.rpc("mutate_native_media_bridge_atomic",{p_user_id:user.id,p_input:{action:"prepare-v3",requestKey:`native-bridge:${bridge.bridgeId}:prepare-v3:${bridge.phase}`,currentNamespace:cfg.namespace,bridgeId:bridge.bridgeId,phase:bridge.phase,dispatchId:bridge.dispatchId,input:{...input,connectionId:cfg.namespace}}} as never);if(result.error)dbFailure(result.error);return rec(rec(result.data).operation);
}
export async function assertPublishingV3UploadBridge(db:DB,user:AuthUser,cfg:Configuration,action:PublishingV3Action,bridge?:PublishingV3BridgeContext){
 if(action.action!=="upload-sign"&&action.action!=="upload-confirm"){if(bridge)throw new PublishingV3Error("NATIVE_MAIN_BRIDGE_INVALID",messages.NATIVE_MAIN_BRIDGE_INVALID[1],409);return;}
 if(bridge){
  const expectedPhase=action.action==="upload-sign"?"sign":"confirm";
  if(bridge.phase!==expectedPhase)throw new PublishingV3Error("NATIVE_MAIN_BRIDGE_INVALID",messages.NATIVE_MAIN_BRIDGE_INVALID[1],409);
  const found=await db.rpc("read_native_media_bridge_atomic",{p_user_id:user.id,p_input:{action:"invocation",bridgeId:bridge.bridgeId,phase:bridge.phase,dispatchId:bridge.dispatchId,currentNamespace:cfg.namespace}} as never);if(found.error)dbFailure(found.error);
  const value=rec(found.data),snapshot=rec(value.snapshot),phase=rec(value.phase),file=rec(snapshot.file),dto=rec(value.bridge);
  const identity=dto.id===bridge.bridgeId&&dto.connectionCurrent===true&&snapshot.namespace===cfg.namespace&&phase.phase===bridge.phase&&phase.dispatchId===bridge.dispatchId&&phase.operationRequestKey===action.requestKey;
  const fileMatches=action.action==="upload-sign"?snapshot.mediaId===action.mediaId&&file.fileName===action.fileName&&file.mime===action.mime&&num(file.size)===action.size&&file.sha256===action.sha256:phase.assetId===action.assetId;
  if(!identity||!fileMatches)throw new PublishingV3Error("NATIVE_MAIN_BRIDGE_INVALID",messages.NATIVE_MAIN_BRIDGE_INVALID[1],409);return;
 }
 if(action.action==="upload-sign"&&action.fileName.startsWith("native-bridge-"))throw new PublishingV3Error("NATIVE_MAIN_BRIDGE_RESERVED",messages.NATIVE_MAIN_BRIDGE_RESERVED[1],409);
 const mediaId=action.action==="upload-sign"?action.mediaId:str((await owned(db,"pub3_assets",user,action.assetId,cfg.namespace)).local_media_id);
 const reserved=await db.from("pub_native_media_bridges").select("id").eq("owner_id",user.id).eq("namespace",cfg.namespace).eq("media_id",mediaId).limit(1).maybeSingle();if(reserved.error)dbFailure(reserved.error);
 if(reserved.data)throw new PublishingV3Error("NATIVE_MAIN_BRIDGE_RESERVED",messages.NATIVE_MAIN_BRIDGE_RESERVED[1],409);
}
async function recordOperation(db:DB,user:AuthUser,cfg:Configuration,op:Row,outcome:string,extra:Row={}){try{return rec((await rpc(db,user,cfg,{action:"record-operation",operationId:op.id,expectedRevision:op.revision,outcome,...extra})).operation);}catch(error){if(error instanceof PublishingV3Error&&error.code==="PUBLISH_REVISION_CONFLICT")return owned(db,"pub3_operations",user,str(op.id),cfg.namespace);throw error;}}
async function blockCashUnissued(db:DB,user:AuthUser,op:Row):Promise<Row>{
 const result=await db.rpc('block_publish_cash_unissued_atomic',{p_actor:user.id,p_operation:op.id,p_expected_revision:op.revision} as never);
 if(result.error)publishingCashFailure(result.error);return rec(result.data);
}
async function unknown(db:DB,user:AuthUser,cfg:Configuration,op:Row,error:unknown):Promise<never>{
 const latest=await owned(db,"pub3_operations",user,str(op.id),cfg.namespace);
 if(latest.kind==='publish'&&latest.cash_admission_id&&latest.grant_used===false){
  const blocked=await blockCashUnissued(db,user,latest);
  throw new PublishingV3Error('PUBLISH_CASH_NOT_DISPATCHED','本次尚未向平台发出，原执行费用已退回，请核对原记录',409,str(blocked.id));
 }
 // A local disconnect can close a prepared grant before the provider call.
 // Only this exact persisted state proves no grant or remote request was issued.
 try{const current=await owned(db,"pub3_operations",user,str(op.id),cfg.namespace);if(current.dispatch_state==="blocked"&&current.grant_used===false&&!current.provider_record_id&&!current.provider_task_id)throw new PublishingV3Error("NATIVE_ACCOUNT_DISCONNECTED","账号已在本站断开，本次尚未向平台发出；请核对原记录",409,str(op.id));}catch(local){if(local instanceof PublishingV3Error&&local.code==="NATIVE_ACCOUNT_DISCONNECTED")throw local;}
 const code=error instanceof PublishingProviderError?error.code:"PUBLISH_API_OUTCOME_UNKNOWN";try{await recordOperation(db,user,cfg,op,"unknown",{errorCode:code});}catch{/* Do not retry an unknown provider mutation or erase its immutable intent. */}throw new PublishingV3Error("PUBLISH_API_OUTCOME_UNKNOWN","官方操作结果未知，请核对原记录，勿重复提交",503,str(op.id),true);
}
async function dispatch(db:DB,user:AuthUser,cfg:Configuration,op:Row){if(op.kind==="publish"||op.kind==="task_change")await executionGate(db,cfg);return rpc(db,user,cfg,{action:"dispatch",operationId:op.id});}
function expiry(value:unknown):string {const time=typeof value==="number"?value<1e12?value*1000:value:Date.parse(str(value));if(!Number.isFinite(time)||time<=Date.now())throw new PublishingV3Error("PUBLISH_API_AUTH_SESSION_INVALID","官方授权会话已经过期",409);return new Date(time).toISOString();}

async function syncAuth(db:DB,user:AuthUser,cfg:Configuration,session:Row){
 if(!session.provider_session_id||Date.parse(str(session.expires_at))<=Date.now())return session;
 const p=provider(user,cfg,db,undefined,{authSessionIds:new Set([str(session.provider_session_id)])});
 const status=await p.readAuthorizationStatus("douyin",str(session.provider_session_id));
 const display:Row={...(rec(session.display).url?{url:rec(session.display).url}:{})};
 if(status.requiresSelection)display.selectableAccounts=(status.selectableAccounts??[]).filter(x=>x.platform==="douyin").map(x=>({platformUid:x.platformUid,displayName:x.displayName,...(x.account?{account:x.account}:{})}));
 let accounts:Row[]=[];
 if(status.status==="completed"){
  accounts=(status.accounts??[]).filter(x=>x.platform==="douyin").map(x=>({accountId:x.accountId,platform:"douyin",platformUid:x.platformUid,displayName:x.displayName,...(x.avatarUrl?{avatar:x.avatarUrl}:{})}));
  if(!accounts.length){const ids=status.accountIds??(status.accountId?[status.accountId]:[]);const scoped=provider(user,cfg,db,undefined,{accountIds:new Set(ids)});for(const accountId of ids){const a=await scoped.readAccount(accountId);if(a.type==="douyin"&&a.uid)accounts.push({accountId:a.id,platform:"douyin",platformUid:a.uid,displayName:a.nickname||a.account||a.uid,...(a.avatar?{avatar:a.avatar}:{})});}}
  if(!accounts.length)throw new PublishingV3Error("PUBLISH_API_AUTH_SESSION_INVALID","官方完成状态尚未给出可核验账号，请稍后读取原会话",409);
 }
 return rec((await rpc(db,user,cfg,{action:"sync-auth",sessionId:session.id,providerSessionId:session.provider_session_id,state:status.status==="completed"?"completed":status.requiresSelection?"requires_selection":status.status,display,accounts})).session);
}

async function publishSnapshot(db:DB,user:AuthUser,cfg:Configuration,intent:Row,flowId:string){
 const input=rec(intent.payload) as PublishingV3IntentInput;
 const binding=await owned(db,"pub3_account_bindings",user,str(intent.binding_id),cfg.namespace);
 if(binding.status!=="active"||binding.revision!==intent.binding_revision)throw new PublishingV3Error("PUBLISH_API_BINDING_CHANGED","官方账号连接已变化，请重新选择",409);
 const v=await db.from("pub2_draft_versions").select("payload").eq("user_id",user.id).eq("draft_id",str(intent.draft_id)).eq("version",num(intent.draft_version)).maybeSingle();if(v.error)dbFailure(v.error);if(!v.data)throw new PublishingV3Error("PUBLISH_DRAFT_NOT_FOUND","内容版本不存在",404);
 const draft=PublishingV2DraftInputSchema.parse(rec(v.data).payload);
 const assets:Row[]=[];for(const assetId of input.assetIds)assets.push(await owned(db,"pub3_assets",user,assetId,cfg.namespace));
 if(assets.some(a=>a.state!=="ready"||a.expires_at&&Date.parse(str(a.expires_at))<=Date.now()))throw new PublishingV3Error("PUBLISH_API_ASSET_INVALID","素材尚未核验或已经过期",409);
 const selected=input.mediaIds.map(mediaId=>{const media=draft.media.find(m=>m.id===mediaId);const matches=assets.filter(a=>a.local_media_id===mediaId);if(!media||matches.length!==1)throw new PublishingV3Error("PUBLISH_API_ASSET_INVALID","每个选中素材需要且只能对应一个已核验官方素材",409);const asset=matches[0];if(num(asset.size)!==media.size||asset.mime!==media.type||media.hash&&asset.sha256!==media.hash)throw new PublishingV3Error("PUBLISH_API_ASSET_INVALID","素材与内容版本不一致",409);return {media,asset};});
 const coverMatches=input.coverMediaId?assets.filter(a=>a.local_media_id===input.coverMediaId):[];const cover=coverMatches[0];
 if(input.coverMediaId&&coverMatches.length!==1)throw new PublishingV3Error("PUBLISH_API_ASSET_INVALID","封面需要且只能对应一个已核验官方素材",409);
 if(assets.some(a=>!input.mediaIds.includes(str(a.local_media_id))&&input.coverMediaId!==a.local_media_id))throw new PublishingV3Error("PUBLISH_API_ASSET_INVALID","请移除未选中的额外官方素材",409);
 const content=preparePublishingV3Content({title:input.titleOverride??draft.title,body:input.bodyOverride??draft.body,topics:input.topicsOverride??draft.topics,options:input.options});
 const errors=validatePublishingV3Media(draft.contentType,selected.map(({media,asset})=>({...media,size:num(asset.size),type:str(asset.mime),duration:num(rec(asset.metadata).duration)||undefined})),cover?{fileName:str(cover.file_name),type:str(cover.mime),size:num(cover.size)}:undefined);
 if(content.errors.length||errors.length)throw new PublishingV3Error("PUBLISH_API_INPUT_INVALID",[...content.errors,...errors].join("；"),400);
 const p=provider(user,cfg,db,undefined,{accountIds:new Set([str(binding.provider_account_id)])});const caps=await p.readCapabilities();const cap=caps.find(c=>c.platform==="douyin");
 if(!cap||rec(cap.capabilities.publish).supported!==true||!validatePublishingProviderOptions(cap.optionSchema,input.options))throw new PublishingV3Error("PUBLISH_API_CAPABILITY_UNAVAILABLE","官方当前能力不支持这些发布参数",409);
 const request:PublishingProviderFlowInput={flowId,publishAt:input.publishAt??new Date().toISOString(),content:{title:content.title,body:content.body,media:selected.map(({asset})=>({url:str(asset.public_url)})),...(cover?{cover:{url:str(cover.public_url)}}:{})},items:[{platform:"douyin",accountId:str(binding.provider_account_id),option:input.options}]};
 return {request,draft,intent:input,binding:{id:binding.id,revision:binding.revision,providerAccountId:binding.provider_account_id,platformUid:binding.platform_uid},assets:assets.map(a=>({id:a.id,mediaId:a.local_media_id,size:num(a.size),mime:a.mime,sha256:a.sha256,providerAssetId:a.provider_asset_id,publicUrl:a.public_url,metadata:a.metadata??{}}))};
}

export async function mutatePublishingV3(user:AuthUser,db:DB,action:PublishingV3Action,cookies:{get(name:string):string|undefined},bridge?:PublishingV3BridgeContext):Promise<PublishingV3Result>{
 await access(user);const cfg=readPublishingProviderConfiguration();requireConfigured(cfg);
 await assertPublishingV3UploadBridge(db,user,cfg,action,bridge);
 if(action.action==="save-intent"){
  const {action:_action,id,expectedRevision,...payload}=action;void _action;
  const result=await rpc(db,user,cfg,{action:"save-intent",...(id?{intentId:id}:{}),expectedRevision,payload});return {body:PublishingV3MutationSchema.parse({ok:true,intent:intentDto(rec(result.intent))})};
 }
 if(action.action==="reconcile")return {body:PublishingV3MutationSchema.parse({ok:true,operation:operationDto(await reconcile(db,user,cfg,await owned(db,"pub3_operations",user,action.operationId,cfg.namespace)))})};
 let op=await existing(db,user,cfg,action.requestKey);
 if(op&&op.request_hash!==requestHash(action,cfg))throw new PublishingV3Error("PUBLISH_IDEMPOTENCY_CONFLICT","请求标识已用于不同内容",409,str(op.id));
 if(action.action==="start-auth"){
  if(!op){const sessionId=randomUUID();op=await prepare(db,user,cfg,action,{action:"prepare-auth",sessionId},{type:"douyin",correlationId:sessionId,callbackUrl:null});}
  const dispatchResult=await dispatch(db,user,cfg,op);op=rec(dispatchResult.operation);
  if(dispatchResult.shouldSend!==true)return {body:PublishingV3MutationSchema.parse({ok:true,session:sessionDto(await owned(db,"pub3_auth_sessions",user,str(op.subject_id),cfg.namespace)),operation:operationDto(op),alreadyFulfilled:true})};
  try {const p=provider(user,cfg,db,op);const result=await p.startAuthorization("douyin",str(op.subject_id),str(op.id));const expiresAt=expiry(result.expiresAt);const raw=p.takeAuthorizationCookie(result.sessionId);const recorded=await rpc(db,user,cfg,{action:"record-auth",operationId:op.id,providerSessionId:result.sessionId,expiresAt,display:{url:result.url}});return {body:PublishingV3MutationSchema.parse({ok:true,session:sessionDto(rec(recorded.session)),operation:operationDto(rec(recorded.operation))}),...(raw?{continuation:{sessionId:str(op.subject_id),value:sealPublishingAuthContinuation({ownerId:user.id,localSessionId:str(op.subject_id),providerSessionId:result.sessionId,expiresAt,cookie:raw,environment:cfg.environment},cfg.apiKey!),expiresAt}}:{})};}catch(error){return unknown(db,user,cfg,op,error);}
 }
 if(action.action==="select-auth"){
  const session=await owned(db,"pub3_auth_sessions",user,action.sessionId,cfg.namespace);
  if(!op)op=await prepare(db,user,cfg,action,{action:"prepare-select",sessionId:session.id,expectedRevision:action.expectedRevision},{accounts:action.accounts});
  const ticket=cookies.get(publishingAuthCookieName(action.sessionId));if(!ticket)throw new PublishingV3Error("AUTH_RESTART_REQUIRED","此授权需要重新打开原授权会话",409,str(op.id));
  let raw:string;try{raw=openPublishingAuthContinuation(ticket,{ownerId:user.id,localSessionId:action.sessionId,providerSessionId:str(session.provider_session_id),environment:cfg.environment},cfg.apiKey!);}catch{throw new PublishingV3Error("AUTH_RESTART_REQUIRED","授权连接已失效，请重新开始授权",409,str(op.id));}
  const d=await dispatch(db,user,cfg,op);op=rec(d.operation);if(d.shouldSend!==true)return {body:{ok:true,session:sessionDto(await syncAuth(db,user,cfg,session)),operation:operationDto(op),alreadyFulfilled:true}};
  try{const p=provider(user,cfg,db,op,{authSessionIds:new Set([str(session.provider_session_id)])});p.restoreAuthorizationCookie(str(session.provider_session_id),raw);await p.selectAuthorizationAccounts(str(session.provider_session_id),action.accounts,str(op.id));op=await recordOperation(db,user,cfg,op,"waiting");return {body:{ok:true,session:sessionDto(await syncAuth(db,user,cfg,session)),operation:operationDto(op)}};}catch(error){return unknown(db,user,cfg,op,error);}
 }
 if(action.action==="upload-sign"){
  if(!op){const assetId=randomUUID();op=await prepare(db,user,cfg,action,{action:"prepare-upload",assetId,asset:{mediaId:action.mediaId,fileName:action.fileName,mime:action.mime,size:action.size,sha256:action.sha256}},{filename:action.fileName,size:action.size,type:"publishMedia"},{},bridge);}
  const d=await dispatch(db,user,cfg,op);op=rec(d.operation);if(d.shouldSend!==true)return {body:{ok:true,asset:assetDto(await owned(db,"pub3_assets",user,str(op.subject_id),cfg.namespace)),operation:operationDto(op),alreadyFulfilled:true}};
  try{const result=await provider(user,cfg,db,op).startAssetUpload({filename:action.fileName,size:action.size},str(op.id));const saved=await rpc(db,user,cfg,{action:"record-asset",operationId:op.id,providerAssetId:result.id,publicUrl:result.url});return {body:PublishingV3MutationSchema.parse({ok:true,asset:assetDto(rec(saved.asset)),operation:operationDto(rec(saved.operation)),upload:{assetId:str(op.subject_id),url:result.uploadUrl,method:"PUT",mime:action.mime}})};}catch(error){return unknown(db,user,cfg,op,error);}
 }
 if(action.action==="upload-confirm"){
  const asset=await owned(db,"pub3_assets",user,action.assetId,cfg.namespace);if(asset.state==="ready")return {body:{ok:true,asset:assetDto(asset),alreadyFulfilled:true}};
  if(!op)op=await prepare(db,user,cfg,action,{action:"prepare-confirm",assetId:asset.id},{assetId:asset.provider_asset_id},{},bridge);
  const d=await dispatch(db,user,cfg,op);op=rec(d.operation);if(d.shouldSend!==true)return {body:{ok:true,asset:assetDto(await owned(db,"pub3_assets",user,action.assetId,cfg.namespace)),operation:operationDto(op),alreadyFulfilled:true}};
  try{const result=await provider(user,cfg,db,op,{assetIds:new Set([str(asset.provider_asset_id)])}).confirmAssetUpload(str(asset.provider_asset_id),str(op.id));if(result.size!==num(asset.size)||result.mimeType!==asset.mime||result.url!==asset.public_url)throw new PublishingV3Error("PUBLISH_API_ASSET_INVALID","官方素材实际大小、格式或地址与声明不一致",409);const saved=await rpc(db,user,cfg,{action:"record-asset",operationId:op.id,providerAssetId:result.id,publicUrl:result.url,size:result.size,mime:result.mimeType,metadata:result.metadata??{}});return {body:PublishingV3MutationSchema.parse({ok:true,asset:assetDto(rec(saved.asset)),operation:operationDto(rec(saved.operation))})};}catch(error){return unknown(db,user,cfg,op,error);}
 }
 if(action.action==="submit"){
  await executionGate(db,cfg);
  if(!op){const intent=await owned(db,"pub3_intents",user,action.intentId);if(intent.revision!==action.intentRevision)throw new PublishingV3Error("PUBLISH_REVISION_CONFLICT","发布意图已有新版本",409);const flowId=randomUUID();const snap=await publishSnapshot(db,user,cfg,intent,flowId);const funding=action.funding?{funding:action.funding,cashContentCanonical:await publishingCashContentProof(action.funding,snap.intent.bindingId,'official',publishingCashV3Content(snap.draft,snap.intent))}:{entitlementId:action.entitlementId};op=await prepare(db,user,cfg,action,{action:"submit",intentId:intent.id,intentRevision:intent.revision,...funding,flowId},rec(snap.request),{draft:snap.draft,intent:snap.intent,binding:snap.binding,assets:snap.assets});}
  const d=await dispatch(db,user,cfg,op);op=rec(d.operation);if(d.shouldSend!==true)return {body:{ok:true,operation:operationDto(op),alreadyFulfilled:true}};
  try{const flow=await provider(user,cfg,db,op).createPublishFlow(rec(op.snapshot).request as PublishingProviderFlowInput,str(op.id));const record=flow.tasks[0];if(!record)throw new PublishingV3Error("PUBLISH_API_OUTCOME_UNVERIFIED","官方未返回可核对记录",503);op=await storeProviderRecord(db,user,cfg,op,record);return {body:{ok:true,operation:operationDto(op)}};}catch(error){return unknown(db,user,cfg,op,error);}
 }
 if(action.action==="task-change"){
  await executionGate(db,cfg);const parent=await owned(db,"pub3_operations",user,action.operationId,cfg.namespace);
  if(!op)op=await prepare(db,user,cfg,action,{action:"prepare-change",parentOperationId:parent.id,expectedRevision:action.expectedRevision,change:action.change},{taskId:parent.provider_task_id,action:action.change,publishAt:action.publishAt??null});
  const d=await dispatch(db,user,cfg,op);op=rec(d.operation);if(d.shouldSend!==true)return {body:{ok:true,operation:operationDto(op),alreadyFulfilled:true}};
  try{await provider(user,cfg,db,op,{taskIds:new Set([str(parent.provider_task_id)])}).changeTask(str(parent.provider_task_id),action.change,str(op.id),action.publishAt);op=await reconcileTaskChange(db,user,cfg,op,parent);return {body:{ok:true,operation:operationDto(op)}};}catch(error){return unknown(db,user,cfg,op,error);}
 }
 throw new PublishingV3Error("PUBLISH_API_INPUT_INVALID","未知官方操作",400);
}

type ProviderRecord={id:string;status?:number;platformWorkId?:string;workLink?:string;publishTime?:string};
async function storeProviderRecord(db:DB,user:AuthUser,cfg:Configuration,op:Row,record:ProviderRecord){
 let state=projectProviderStatus(record.status);if(state==="published"&&!record.platformWorkId&&!record.workLink)state="unknown";
 const allowed=["waiting","publishing","queued","platform_scheduled","awaiting_user_action","published","failed","cancelled","unknown"];if(!allowed.includes(state))state="unknown";
 // Fixed upstream47e5 flow.service/task.service use the same PublishRecord id
 // for publish record and task mutation; context.taskId is a different field.
 return recordOperation(db,user,cfg,op,state,{recordId:record.id,taskId:record.id,...(state==="published"&&record.platformWorkId?{workId:record.platformWorkId}:{}),...(state==="published"&&record.workLink?{workLink:record.workLink}:{})});
}
async function reconcileTaskChange(db:DB,user:AuthUser,cfg:Configuration,op:Row,parent?:Row){
 const original=parent??await owned(db,"pub3_operations",user,str(op.subject_id),cfg.namespace);
 if(original.kind!=="publish"||!original.provider_record_id)throw new PublishingV3Error("PUBLISH_API_TASK_STATE_INVALID","原发布记录尚未确认",409,str(op.id));
 // Read only. An acknowledgement of a command does not prove its effect.
 const record=await provider(user,cfg,db,original).readPublishRecord(str(original.provider_record_id));
 const storedParent=await storeProviderRecord(db,user,cfg,original,record);
 const request=rec(rec(op.snapshot).request);const state=projectProviderStatus(record.status);const actualTime=Date.parse(record.publishTime??"");
 const compatible=storedParent.outcome===state&&storedParent.provider_record_id===record.id;
 const verified=compatible&&(request.action==="cancel"?state==="cancelled":request.action==="reschedule"?Number.isFinite(actualTime)&&actualTime===Date.parse(str(request.publishAt))&&["waiting","queued","platform_scheduled"].includes(state):request.action==="publish-now"&&Number.isFinite(actualTime)&&actualTime>=Date.parse(str(op.created_at))-5000&&actualTime<=Date.now()+5000&&["queued","publishing","awaiting_user_action","published"].includes(state));
 return recordOperation(db,user,cfg,op,verified?(request.action==="cancel"?"cancelled":"waiting"):"unknown",verified?{}:{errorCode:"PUBLISH_API_CHANGE_NOT_CONFIRMED"});
}
async function reconcile(db:DB,user:AuthUser,cfg:Configuration,op:Row){
 if(op.dispatch_state==="blocked"&&op.grant_used===false&&!op.provider_record_id&&!op.provider_task_id)return op;
 if(op.kind==='publish'&&op.cash_admission_id&&op.grant_used===false)return blockCashUnissued(db,user,op);
 if(op.kind==="task_change")return reconcileTaskChange(db,user,cfg,op);
 if(op.kind!=="publish"||!op.flow_id)return op;
 const p=provider(user,cfg,db,op);try{if(op.provider_record_id)return storeProviderRecord(db,user,cfg,op,await p.readPublishRecord(str(op.provider_record_id)));const flow=await p.readPublishFlow(str(op.flow_id));if(flow.tasks.length!==1)throw new PublishingV3Error("PUBLISH_API_OUTCOME_UNVERIFIED","官方流水记录尚不完整",503,str(op.id),true);return storeProviderRecord(db,user,cfg,op,flow.tasks[0]);}catch(error){if(error instanceof PublishingV3Error)throw error;throw new PublishingV3Error("PUBLISH_API_RECONCILIATION_UNKNOWN","官方暂未确认原流水；未找到记录不代表未发送，请勿重发",503,str(op.id),true);}
}

export async function readPublishingV3(user:AuthUser,db:DB,query:PublishingV3Query):Promise<PublishingV3Result>{
 await access(user);const cfg=readPublishingProviderConfiguration();
 if(query.resource==="status"){
  const r=await db.from("pub3_operations").select("id",{head:true}).eq("owner_id",user.id).limit(1);if(r.error&&!absent.has(r.error.code))dbFailure(r.error);const schemaReady=!r.error;let enabled=false;try{await executionGate(db,cfg);enabled=schemaReady;}catch{/* Explicit unconfigured/closed state only. */}
  return {body:PublishingV3StatusSchema.parse({schemaReady,configured:cfg.configured,environment:cfg.environment,executionEnabled:enabled,authorizationEnabled:schemaReady&&cfg.configured,platform:"douyin",message:cfg.configured?enabled?"官方发布连接已就绪":"可先连接官方账号并准备素材，发布执行尚未开放":"官方API尚未配置，可通过官方入口了解服务",links:PUBLISHING_OFFICIAL_LINKS})};
 }
 if(query.resource==="capabilities"){if(!cfg.configured)return {body:{configured:false,platforms:[]}};const caps=await provider(user,cfg,db).readCapabilities();return {body:PublishingV3CapabilitiesSchema.parse({configured:true,platforms:caps.filter(c=>c.platform==="douyin").map(c=>({platform:"douyin",name:c.displayName["zh-CN"]||"抖音",publishSupported:rec(c.capabilities.publish).supported===true,contentTypes:["image","video"],maxImages:12,maxImageBytes:20*1024**2,maxVideoBytes:100*1024**2,maxVideoDurationSeconds:900,maxTitle:30,maxBody:1000,maxTotal:1000,maxTopics:5}))})};}
 if(query.resource==="auth-session"&&query.id){const session=await owned(db,"pub3_auth_sessions",user,query.id,cfg.namespace);return {body:sessionDto(await syncAuth(db,user,cfg,session))};}
 if(query.resource==="user-action"){
  const op=await owned(db,"pub3_operations",user,query.operationId??query.id??"",cfg.namespace);if(op.outcome!=="awaiting_user_action"||!op.provider_record_id)throw new PublishingV3Error("PUBLISH_API_TASK_STATE_INVALID","当前记录无需用户接力或尚未确认",409,str(op.id));const action=await provider(user,cfg,db,op).readUserAction(str(op.provider_record_id));return {body:PublishingV3UserActionSchema.parse({operationId:op.id,shortLink:action.shortLink,schemeUrl:action.schemeUrl,expiresAt:action.expiresAt&&Number.isFinite(Date.parse(action.expiresAt))?new Date(action.expiresAt).toISOString():null})};
 }
 const map={"auth-session":["pub3_auth_sessions",sessionDto],bindings:["pub3_account_bindings",bindingDto],assets:["pub3_assets",assetDto],intents:["pub3_intents",intentDto],operations:["pub3_operations",operationDto],events:["pub3_events",eventDto]} as const;
 if(!(query.resource in map))throw new PublishingV3Error("PUBLISH_API_INPUT_INVALID","未知资源",400);const [table,project]=map[query.resource as keyof typeof map];let q=db.from(table).select("*",{count:"exact"}).eq("owner_id",user.id).order("created_at",{ascending:false}).order("id",{ascending:false});
 if(["bindings","assets","auth-session"].includes(query.resource))q=q.eq("connection_id",cfg.namespace);if(query.id)q=q.eq("id",query.id);if(query.requestKey&&query.resource==="operations")q=q.eq("request_key",query.requestKey);if(query.operationId&&query.resource==="events")q=q.eq("operation_id",query.operationId);
 const r=await q.range((query.page-1)*query.pageSize,query.page*query.pageSize-1);if(r.error)dbFailure(r.error);const total=r.count??0;return {body:PublishingV3PageSchema.parse({resource:query.resource,page:query.page,pageSize:query.pageSize,total,hasMore:query.page*query.pageSize<total,items:rows(r.data).map(row=>project(row))})};
}
