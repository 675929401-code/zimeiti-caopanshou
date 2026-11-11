import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import type { AuthUser } from "../src/lib/api-middleware";
import type { NativeCoreAction } from "../src/lib/native-operations-contract";
type Row=Record<string,unknown>;
const rec=(v:unknown):Row=>v&&typeof v==="object"?v as Row:{};
const owner="00000000-0000-4000-8000-000000000001",draftId="00000000-0000-4000-8000-000000000002",mediaId="00000000-0000-4000-8000-000000000003",assetId="00000000-0000-4000-8000-000000000004",collectionId="00000000-0000-4000-8000-000000000005";
const user:AuthUser={id:owner,email:"fixture@invalid.example",role:"student"};
let save:typeof import("../src/lib/server/native-operations-service").saveNativeMaterial;
let refresh:typeof import("../src/lib/server/native-operations-service").refreshNativePublishingRecord;
let status:typeof import("../src/lib/server/native-operations-service").nativePublishingRecordStatus;
const originalFetch=globalThis.fetch;let escapedNetwork=0;
before(async()=>{
 // Every runtime dependency exercised below is injected. Any accidental HTTP
 // escapes fail locally; no environment file, DPAPI reader or DB is invoked.
 globalThis.fetch=async()=>{escapedNetwork++;throw new Error("UNEXPECTED_NETWORK_ESCAPE");};
 const actual=await import("../src/lib/server/native-operations-service");save=actual.saveNativeMaterial;refresh=actual.refreshNativePublishingRecord;status=actual.nativePublishingRecordStatus;
});
after(()=>{globalThis.fetch=originalFetch;assert.equal(escapedNetwork,0);});
function materialFixture(existing:boolean){
 const media={id:mediaId,role:"image",fileName:"fixture.png",type:"image/png",size:1024,lastModified:0,hash:"a".repeat(64),source:"local_file",requiresReselection:true};
 const payload={schemaVersion:2,collectionId,contentType:"image",title:"旧标题",body:"正文",topics:[],media:[media],targets:[]};
 const nativeMeta={schemaVersion:1,media:[{mediaId,assetId}],coverMediaId:null,accountTypes:[],maxUseCountByAccountType:{}};
 const stamp="2026-11-10T00:00:00.000Z";
 let current:Row|null=existing?{id:draftId,user_id:owner,revision:1,archived:false,created_at:stamp,updated_at:stamp}:null;
 let receipt:Row|null=null,writes=0,attempts=0,configurationReads=0;const versions=new Map<number,unknown>(existing?[[1,payload]]:[]);
 const db={
  from(table:string){const filters:Row={};const read=(single:boolean)=>{let data:unknown=null;
   if(table==="pub_native_core_requests")data=receipt&&filters.owner_id===owner?receipt:null;
   else if(table==="pub2_drafts")data=current;
   else if(table==="pub2_draft_versions")data={payload:versions.get(Number(filters.version))};
   else if(table==="pub_native_draft_meta")data={revision:1,payload:nativeMeta};
   else if(table==="pub_native_media_usage_refs")data=[];
   else if(table==="pub3_assets")data={id:assetId,owner_id:owner,connection_id:"fixture",local_media_id:mediaId,file_name:media.fileName,mime:media.type,size:1024,sha256:media.hash,state:"ready",metadata:{}};
   else throw new Error(`UNEXPECTED_TABLE_${table}`);
   return {data:single?data:Array.isArray(data)?data:[data],error:null};
  };const builder:Row={};Object.assign(builder,{select:()=>builder,eq:(k:string,v:unknown)=>{filters[k]=v;return builder;},order:()=>builder,limit:()=>builder,maybeSingle:async()=>read(true),single:async()=>read(true),then:(resolve:(reply:unknown)=>unknown)=>Promise.resolve(read(false)).then(resolve)});return builder;},
  async rpc(name:string){assert.equal(name,"read_native_usage_facts");return {data:[{draftId,confirmedUses:0,browserReportedUses:0,unknownUses:0,usageFingerprint:"f".repeat(64)}],error:null};},
 };
 const mutate=async(_db:unknown,_user:AuthUser,action:NativeCoreAction)=>{
  attempts++;if(receipt)return rec(receipt.result);assert.equal(action.action,"save-native-draft");if(action.action!=="save-native-draft"||action.save.action!=="save-draft"||action.save.base.action!=="save-draft")throw new Error("UNEXPECTED_MUTATION");
  writes++;current={id:draftId,user_id:owner,revision:existing?2:1,archived:false,created_at:stamp,updated_at:stamp,payload:action.save.base.draft};versions.set(Number(current.revision),action.save.base.draft);
  const {requestKey,...stored}=action;void requestKey;const result={base:{kind:"draft",row:current},metadata:action.save.metadata,metadataRevision:existing?2:1};receipt={request_payload:stored,result};
  throw new Error("STUB_COMMITTED_RESPONSE_LOST");
 };
 const dependencies={configuration:()=>{configurationReads++;if(receipt)throw new Error("REPLAY_MUST_NOT_READ_CURRENT_NAMESPACE");return {namespace:"fixture"};},mutate,project:async(_db:unknown,_user:AuthUser,row:Row)=>({id:row.id,revision:row.revision,payload:row.payload})};
 return {db:db as never,dependencies,stats:()=>({writes,attempts,configurationReads}),receipt:()=>receipt};
}
test("actual material save restores an acknowledged-old update after commit response loss",async()=>{
 const fixture=materialFixture(true),request={requestKey:"native-update-lost-ack",expectedRevision:1,expectedMetadataRevision:1,title:"已修改标题"};
 await assert.rejects(save(fixture.db,user,request,"https://host.example",draftId,fixture.dependencies),/STUB_COMMITTED_RESPONSE_LOST/);
 const result=rec(await save(fixture.db,user,request,"https://host.example",draftId,fixture.dependencies));assert.equal(result.revision,2);assert.equal(rec(result.payload).title,"已修改标题");assert.deepEqual(fixture.stats(),{writes:1,attempts:2,configurationReads:1});
 await assert.rejects(save(fixture.db,user,{...request,title:"同键异标题"},"https://host.example",draftId,fixture.dependencies),error=>rec(error).code==="PUBLISH_IDEMPOTENCY_CONFLICT");assert.equal(fixture.stats().writes,1);assert.equal(fixture.stats().attempts,2);
 for(const mediaList of [[{url:`/api/native-operations/assets/${collectionId}/content`,type:"img"}],[{url:`/api/native-operations/assets/${assetId}/content`,type:"img",nativeMediaEntryId:collectionId}]])await assert.rejects(save(fixture.db,user,{...request,mediaList},"https://host.example",draftId,fixture.dependencies),error=>rec(error).code==="PUBLISH_IDEMPOTENCY_CONFLICT");assert.equal(fixture.stats().writes,1);
});
test("actual create replay normalizes zero revision and omitted cover/default metadata",async()=>{
 const fixture=materialFixture(false),request={requestKey:"native-create-lost-ack",groupId:collectionId,type:"article",title:"新稿",mediaList:[{url:`/api/native-operations/assets/${assetId}/content`,type:"img"}]};
 await assert.rejects(save(fixture.db,user,request,"https://host.example",undefined,fixture.dependencies),/STUB_COMMITTED_RESPONSE_LOST/);
 const result=rec(await save(fixture.db,user,request,"https://host.example",undefined,fixture.dependencies));assert.equal(result.revision,1);assert.equal(rec(result.payload).title,"新稿");assert.deepEqual(fixture.stats(),{writes:1,attempts:2,configurationReads:1});
 const absolute={...request,mediaList:[{url:`https://host.example/api/native-operations/assets/${assetId}/content`,type:"img"}]};assert.equal(rec(await save(fixture.db,user,absolute,"https://host.example",undefined,fixture.dependencies)).revision,1);assert.equal(fixture.stats().writes,1);
});
function recordDb(operation:Row){return {from(table:string){assert.equal(table,"pub3_operations");const filters:Row={};const builder:Row={};Object.assign(builder,{select:()=>builder,eq:(key:string,value:unknown)=>{filters[key]=value;return builder;},maybeSingle:async()=>({data:filters.owner_id===operation.owner_id&&filters.id===operation.id?operation:null,error:null})});return builder;},rpc(){throw new Error("READ_PATH_MUST_NOT_DISPATCH_OR_CONSUME");}} as never;}
test("actual owner record refresh observes waiting handoff then published without issuing a permit",async()=>{
 const operation:Row={id:draftId,owner_id:owner,kind:"publish",connection_id:"fixture",dispatch_state:"settled",grant_used:true,outcome:"awaiting_user_action",provider_record_id:"fixed-record"};let gets=0;
 const reply=await refresh(recordDb(operation),user,draftId,{configuration:()=>({namespace:"fixture"}),reconcile:async(_db,actor,id)=>{assert.equal(actor.id,owner);assert.equal(id,draftId);gets++;operation.outcome="published";operation.work_link="https://www.douyin.com/video/fixture";return {};}});
 assert.equal(gets,1);assert.equal(reply?.nativeReconciliationState,"observed");assert.equal(status(operation),1);
});
test("record refresh failure preserves non-success and never retries a mutation",async()=>{
 const operation:Row={id:draftId,owner_id:owner,kind:"publish",connection_id:"fixture",grant_used:true,outcome:"awaiting_user_action"};let gets=0;
 const reply=await refresh(recordDb(operation),user,draftId,{configuration:()=>({namespace:"fixture"}),reconcile:async()=>{gets++;throw new Error("STUB_PROVIDER_GET_UNAVAILABLE");}});
 assert.equal(gets,1);assert.equal(reply?.nativeReconciliationState,"unavailable");assert.equal(status(operation),8);assert.equal(operation.outcome,"awaiting_user_action");
});
test("foreign, blocked and previous-namespace records cannot start provider observations",async()=>{
 const operation:Row={id:draftId,owner_id:owner,kind:"publish",connection_id:"fixture",grant_used:true,outcome:"waiting"};let gets=0,configReads=0;
 const dependencies={configuration:()=>{configReads++;return {namespace:"fixture"};},reconcile:async()=>{gets++;return {};}};
 assert.equal(await refresh(recordDb(operation),{...user,id:assetId},draftId,dependencies),null);assert.equal(configReads,0);
 operation.grant_used=false;operation.dispatch_state="blocked";assert.equal((await refresh(recordDb(operation),user,draftId,dependencies))?.nativeReconciliationState,"blocked");
 operation.grant_used=true;operation.dispatch_state="unknown";operation.connection_id="previous";assert.equal((await refresh(recordDb(operation),user,draftId,dependencies))?.nativeConnectionCurrent,false);assert.equal(gets,0);
});
