import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
assert.equal(process.version,'v24.19.0');
function load(file,deps={},globals={}) {
 const module={exports:{}};
 const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 runInNewContext(output,{module,exports:module.exports,URL,Headers,Response,AbortSignal,Date,Buffer,console,setTimeout,clearTimeout,structuredClone,process:{env:{}},require:n=>{if(n in deps)return deps[n];throw Error('Unmocked '+n)},...globals});return module.exports;
}
const notReady={ready:false,code:'H3_PROVIDER_DELIVERY_MIGRATION_NOT_READY',missingDependencies:['autodl_h3_finalize_video_provider_url']};
const probe={probeAutodlH3ProviderDeliveryReadiness:async()=>notReady};
let calls=[];let responseStatus=206;
const signed=(id,seconds=600)=>`http://127.0.0.1:16011/v1/files/${id}?expires=${Math.floor(Date.now()/1000)+seconds}&sig=${'a'.repeat(64)}`;
const fetchMock=async(url,init)=>{calls.push({url:String(url),init});if(String(url).includes('/v1/jobs/'))return Response.json({id:'h3_abcd',task_id:'h3_abcd',object:'video.generation',model:'minimax-h3-turbo',status:'completed',data:[{url:signed('h3_abcd')}]});return new Response('x',{status:responseStatus});};
const self=load('src/lib/autodl-h3-selfhost.ts',{'node:crypto':crypto,'./autodl-h3-activation-profile':{AUTODL_H3_VIDEO_RESOLUTION_LABELS:{},AUTODL_H3_VIDEO_RESOLUTION_TIERS:[]}},{fetch:fetchMock});
const endpoint=self.AUTODL_H3_SELFHOST_VIDEO_ENDPOINT;
await self.fetchAutodlH3SelfhostResult(signed('h3_abcd'),endpoint,{headers:{Range:'bytes=0-0',Accept:'video/*',Authorization:'do-not-forward','X-Target':'evil'}});
assert.equal(calls[0].init.headers.get('range'),'bytes=0-0');assert.equal(calls[0].init.headers.get('accept'),'video/*');assert.equal(calls[0].init.headers.get('authorization'),null);assert.equal(calls[0].init.headers.get('x-target'),null);
for(const range of ['bytes=9-2','bytes=0-1,3-4','bytes=-0','bytes=9999999999999999-'])await assert.rejects(self.fetchAutodlH3SelfhostResult(signed('h3_abcd'),endpoint,{headers:{Range:range}}));
calls=[];await assert.rejects(self.fetchAutodlH3SelfhostResult(signed('h3_abcd',-10),endpoint));assert.equal(calls.length,0);
const owned={kind:'video',expectedJobId:'h3_abcd',apiKey:'fixture-only'};
responseStatus=404;const expired=await self.fetchAutodlH3SelfhostResult(signed('h3_abcd',-10),endpoint,{ownedResultRecovery:owned});assert.equal(expired.response.status,404);assert.equal(calls.length,2);assert.ok(calls[0].url.includes('/jobs/h3_abcd'));assert.ok(calls.every(c=>c.init.method==='GET'));
calls=[];await assert.rejects(self.fetchAutodlH3SelfhostResult(signed('h3_abcd',-10),endpoint,{ownedResultRecovery:{...owned,expectedJobId:'h3_other'}}));assert.equal(calls.length,0);
await assert.rejects(self.recoverAutodlH3SelfhostOwnedResultUrl(signed('h3_abcd',-10),endpoint,owned,{fetchImpl:async()=>Response.json({id:'h3_wrong'})}));
let claims=0,power=0,dispatch=0,transitions=0;
const lifecycle=load('src/lib/autodl-h3-lifecycle.ts',{'node:crypto':crypto,'@/storage/database/supabase-client':{getSupabaseAdminClient:()=>{throw Error('DB forbidden')}},'@/lib/autodl-h3-provider-delivery-readiness':probe,'@/lib/autodl-h3-selfhost':self});
const ctrl=new lifecycle.AutodlH3LifecycleController({store:{claimNextJob:()=>{claims++},claimUnknownDispatchJob:()=>{claims++},updateInstanceState:()=>{transitions++}},instanceClient:{powerOn:()=>{power++}},dispatcher:{dispatch:()=>{dispatch++}},config:{}});
assert.equal((await ctrl.requestPowerOn({})).action,'not_ready');assert.equal((await ctrl.dispatchNextJob({})).action,'not_ready');assert.equal(await ctrl.recoverUnknownDispatch({}),null);assert.equal(claims+power+dispatch+transitions,0);
assert.equal(lifecycle.isStableAutodlH3ResultAssetUrl(signed('h3_abcd')),false);assert.equal(lifecycle.isAutodlH3ProviderDeliveryResultUrl(signed('h3_abcd',-10),'h3_abcd'),true);assert.equal(lifecycle.isAutodlH3ProviderDeliveryResultUrl(signed('h3_abcd'),'h3_other'),false);assert.equal(lifecycle.isAutodlH3ProviderDeliveryResultUrl(signed('h3_abcd').replace('127.0.0.1','127.0.0.2'),'h3_abcd'),false);
const route=readFileSync('src/app/api/video/generate/route.ts','utf8');const gate=route.slice(route.indexOf('      const deliveryReadiness ='),route.indexOf('      let stableInputAssets:'));
const vmModule={exports:{}};let reserve=0;
runInNewContext(`module.exports=async()=>{${gate};reserve();}`,{module:vmModule,probeAutodlH3ProviderDeliveryReadiness:probe.probeAutodlH3ProviderDeliveryReadiness,NextResponse:{json:(body,init)=>({body,status:init.status})},reserve:()=>reserve++});const blocked=await vmModule.exports();assert.equal(blocked.status,503);assert.equal(blocked.body.task_submitted,false);assert.equal(reserve,0);
console.log(JSON.stringify({passed:true,scope:'actual helper/controller and extracted API gate VM; zero network, zero DB, zero model',checks:['missing RPC blocks reservation/power/claim/dispatch/recovery POST','expired TTL refresh GET only; actual source404 preserved','Range/Accept allowed; other headers stripped','wrong job/origin rejected; terminal scoped URL retained']},null,2));
const scopedDbCalls=[];const mapping=load('src/lib/autodl-h3-owned-result.ts',{'@/storage/database/supabase-client':{getSupabaseAdminClient:()=>({from:()=>{const q={select:()=>q,eq:(key,value)=>{scopedDbCalls.push([key,value]);return q},maybeSingle:async()=>({data:{upstream_task_id:'h3_abcd'}})};return q}})}});
assert.equal(await mapping.resolveOwnedAutodlH3VideoResultJobId({id:'video1',user_id:'user1',model_id:'model1',task_id_external:'h3q_'+'a'.repeat(40)}),'h3_abcd');assert.deepEqual(scopedDbCalls.map(x=>x[0]),['video_task_internal_id','user_id','public_task_id','model_id']);
const unbound=load('src/lib/autodl-h3-owned-result.ts',{'@/storage/database/supabase-client':{getSupabaseAdminClient:()=>({from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:{message:'unavailable'}})};return q}})}});await assert.rejects(unbound.resolveOwnedAutodlH3VideoResultJobId({id:'v',user_id:'u',model_id:'m',task_id_external:'h3q_'+'a'.repeat(40)}));
const prodSource=readFileSync('src/lib/autodl-h3-production-runtime.ts','utf8');const start=prodSource.indexOf('  const submit = async (job:');const end=prodSource.indexOf('\n  return {',start);const submitText=prodSource.slice(start,end).replace('const submit =','module.exports =');const submitModule={exports:{}};let generateCalls=0,assetReads=0;
runInNewContext(ts.transpileModule(submitText,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:submitModule,canSubmit:()=>true,options:{providerDeliveryReadiness:async()=>notReady},resolveQueuedAssets:()=>assetReads++,generate:()=>generateCalls++});await assert.rejects(submitModule.exports({}),/DELIVERY_NOT_READY/);assert.equal(generateCalls+assetReads,0);
console.log('Additional binding and actual dispatcher submit VM checks passed');
let retryCalls=[];
function retrySelf(statuses,jobStatus=200){return load('src/lib/autodl-h3-selfhost.ts',{'node:crypto':crypto,'./autodl-h3-activation-profile':{}},{fetch:async(url,init)=>{retryCalls.push({url:String(url),init});if(String(url).includes('/jobs/'))return jobStatus===200?Response.json({id:'h3_abcd',object:'video.generation',model:'minimax-h3-turbo',status:'completed',data:[{url:signed('h3_abcd')}]}):new Response(null,{status:jobStatus});return new Response(null,{status:statuses.shift()});}})}
retryCalls=[];assert.equal((await retrySelf([410,200]).fetchAutodlH3SelfhostResult(signed('h3_abcd'),endpoint,{ownedResultRecovery:owned})).response.status,200);assert.equal(retryCalls.length,3);
retryCalls=[];await assert.rejects(retrySelf([410,410]).fetchAutodlH3SelfhostResult(signed('h3_abcd'),endpoint,{ownedResultRecovery:owned}),/源状态未知/);assert.equal(retryCalls.length,3);
retryCalls=[];assert.equal((await retrySelf([],404).fetchAutodlH3SelfhostResult(signed('h3_abcd',-10),endpoint,{ownedResultRecovery:owned})).response.status,404);assert.equal(retryCalls.length,1);
retryCalls=[];await assert.rejects(retrySelf([],403).fetchAutodlH3SelfhostResult(signed('h3_abcd',-10),endpoint,{ownedResultRecovery:owned}));assert.equal(retryCalls.length,1);
console.log('In-flight expiry410 recovery and unknown-vs-confirmed source state checks passed');
const readiness=load('src/lib/autodl-h3-provider-delivery-readiness.ts',{'@/lib/production-database-readiness':{probeProductionDatabaseReadiness:async()=>{throw Error('No live metadata')}}});const metadata={state:'ready',missingRpcs:[],missingRpcArguments:[],missingTables:[],missingColumns:[]};assert.equal(readiness.evaluateAutodlH3ProviderDeliveryReadiness({...metadata,missingRpcs:['autodl_h3_provider_delivery_v1_ready']}).ready,false);assert.equal((await readiness.probeAutodlH3ProviderDeliveryReadiness()).ready,false);
let imageFetches=0;let imageStored={deliveryMode:'provider_url',provider:'autodl_h3_selfhost',apiEndpoint:'http://127.0.0.1:16011/v1',providerUrl:signed('h3_image')};
const imageDeps={'@/lib/safe-fetch':{safeFetch:()=>{throw Error('External network forbidden')},SafeFetchError:class extends Error{}},'@/lib/autodl-h3-selfhost':{...self,fetchAutodlH3SelfhostResult:async(url,ep,init)=>{imageFetches++;assert.equal(init.ownedResultRecovery.expectedJobId,'h3_image');return {response:new Response(null,{status:200}),finalUrl:signed('h3_image')}},readAutodlH3SelfhostResult:async()=>({buffer:Buffer.from('x'),contentType:'image/png'})},'@/lib/generated-media-delivery':{providerMediaUrl:x=>x},'@/lib/provider-secret':{resolveProviderSecret:()=> 'fixture-only'},'@/storage/database/supabase-client':{getSupabaseAdminClient:()=>({from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{response:imageStored}})};return q}})}};
const image=load('src/lib/image-provider-delivery.ts',imageDeps);assert.equal((await image.readProviderImage({...imageStored},false,{recordId:'r',userId:'u'})).contentType,'image/png');assert.equal(imageFetches,1);const expectedImage={...imageStored};imageStored={...imageStored,providerUrl:signed('h3_other')};await assert.rejects(image.readProviderImage(expectedImage,false,{recordId:'r',userId:'u'}));assert.equal(imageFetches,1);console.log('Image owner-row binding and schema-marker absence tests passed');
for(const payload of [
 {id:'h3_abcd',object:'image.generation',model:'minimax-h3-turbo',status:'completed',data:[{url:signed('h3_abcd')}]},
 {id:'h3_abcd',object:'video.generation',model:'other-model',status:'completed',data:[{url:signed('h3_abcd')}]},
 {id:'h3_abcd',object:'video.generation',model:'minimax-h3-turbo',status:'completed',data:[{url:signed('h3_other')}]},
 {id:'h3_abcd',object:'video.generation',model:'minimax-h3-turbo',status:'completed',data:[{url:signed('h3_abcd',-10)}]},
 {id:'h3_abcd',object:'video.generation',model:'minimax-h3-turbo',status:'completed',data:[{url:signed('h3_abcd').replace('127.0.0.1','example.invalid')}]},
]) await assert.rejects(self.recoverAutodlH3SelfhostOwnedResultUrl(signed('h3_abcd',-10),endpoint,owned,{fetchImpl:async()=>Response.json(payload)}));
await assert.rejects(self.recoverAutodlH3SelfhostOwnedResultUrl(signed('h3_abcd',-10),endpoint,owned,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://example.invalid/'}})}));
await assert.rejects(self.recoverAutodlH3SelfhostOwnedResultUrl(signed('h3_abcd',-10),endpoint,owned,{fetchImpl:async()=>{throw Error('fixture timeout')}}));
console.log('Refresh kind/model/job/new TTL/origin/redirect/timeout negatives passed');
