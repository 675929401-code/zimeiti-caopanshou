import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const cache=new Map();let externalCalls=0;
const forbidden=()=>{externalCalls++;throw Error('UNEXPECTED_EXTERNAL_CALL');};
const load=file=>{
  if(cache.has(file))return cache.get(file);
  const module={exports:{}};cache.set(file,module.exports);
  const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const require=name=>{
    if(name==='@/lib/generated-image-client-delivery')return {projectGeneratedImageClientReceipt:value=>value ? forbidden() : null,resolveGeneratedImageClientDelivery:forbidden};
    assert.ok(name.startsWith('@/lib/'),'UNEXPECTED_MODULE');
    return load('src/lib/'+name.slice('@/lib/'.length)+'.ts');
  };
  vm.runInNewContext(compiled,{module,exports:module.exports,require,crypto:crypto.webcrypto,URLSearchParams,AbortController,setTimeout,clearTimeout,Date,Error,console},{filename:file});
  return module.exports;
};
const {runCoverGeneration}=load('src/lib/cover-generation-attempt.ts');
const plan={planVersion:2,title:'先做10分钟',subtitle:'',aspectRatio:'3:4',outputSpec:{aspectRatio:'3:4',width:1080,height:1440,format:'png'},
  animationStyleId:'pixar-3d',layoutTemplateId:'gaoding-cover-workbench',coverModeId:'cartoon',materialSourceId:'text',subjectModeId:'semantic',titleStyle:{x:.08,y:.07,width:.84,scale:1,color:'#FFF1B8'}};
const task={id:'cover-workbench-fixture',prepareOperationId:'00000000-0000-4000-8000-000000000001',ratio:'3:4',title:plan.title,subtitle:'',prompt:'fixture prompt',briefText:'每天先做10分钟。',source:'生成',createdAt:'2026-11-06T00:00:00.000Z',taskNo:1,status:'running',renderPlan:plan};
const receipt={success:true,completed:true,activeAttempt:null,backgroundAssetId:'fixture-background',result:{status:'completed',persisted:true,cloudStored:true,
  assetId:'fixture-cover',historyRecordId:'fixture-history',key:'fixture/cover.png',url:'/api/storage/files/fixture-cover/content',sourceAssetId:'fixture-background',
  outputKind:'cover-composition',renderedText:{title:plan.title,subtitle:''},planVersion:2,outputSpec:plan.outputSpec,titleStyle:plan.titleStyle,width:1080,height:1440,sourceWidth:1536,sourceHeight:2048}};
const identity={clientIdempotencyKey:'coverwb_completed_recovery_fixture',clientTraceId:'coverwb_completed_recovery_fixture'};
const payload={prompt:task.prompt,modelId:'pm_fixture_image',mode:'local',style:'cartoon',aspectRatio:'3:4',resolution:'2K',coverText:'',referenceImageUrls:[],referenceUsage:'general',historySurface:'cover-studio'};
const cases=[];
for(const scenario of ['completed','missing-persistence','wrong-title','wrong-source','wrong-output','cancelled','failed']){
  const value=structuredClone(receipt);
  if(scenario==='missing-persistence')value.result.persisted=false;
  if(scenario==='wrong-title')value.result.renderedText.title='other title';
  if(scenario==='wrong-source')value.result.sourceAssetId='other-background';
  if(scenario==='wrong-output')value.result.width=999;
  if(['cancelled','failed'].includes(scenario)){value.completed=false;value.state=scenario;delete value.result;}
  const memory=new Map();const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  const calls=[],states=[];
  const result=await runCoverGeneration({userId:'fixture-user-'+scenario,token:'fixture-token',storage,recovery:true,identity,task,
    fetcher:async(url,init)=>{calls.push({url,method:init.method});assert.equal(init.method,'GET');const u=new URL(url,'http://fixture.local');assert.equal(u.pathname,'/api/cover/attempt');assert.equal(u.searchParams.get('clientIdempotencyKey'),identity.clientIdempotencyKey);assert.equal(u.searchParams.get('clientTraceId'),identity.clientTraceId);return Response.json(value);},onState:s=>states.push(s)});
  assert.equal(calls.length,1);
  if(scenario==='completed'){
    assert.equal(result.state.pending,null);assert.equal(result.state.history[0].assetId,'fixture-cover');assert.equal(result.state.history[0].historyRecordId,'fixture-history');
    assert.equal(result.state.history[0].cloudStored,true);assert.equal(result.state.history[0].status,'done');assert.ok(states.length>0);
  }else assert.equal(result.state.history.length,0,scenario+' must not be declared saved');
  cases.push(scenario);
}
assert.equal(externalCalls,0);
for(const scenario of ['native-completed','native-overlay-receipt','native-wrong-version','native-fake-verified','native-rendered-claim']){
  const nativePlan=structuredClone(plan);nativePlan.textRendering={mode:'native',version:'cover-text-rendering/1'};nativePlan.outputSpec.fit='contain';
  const nativeTask={...task,renderPlan:nativePlan};const value=structuredClone(receipt);
  value.result.outputSpec=nativePlan.outputSpec;value.result.textRendering=nativePlan.textRendering;
  value.result.requestedText={title:nativePlan.title,subtitle:''};value.result.textVerification='unverified';delete value.result.renderedText;
  if(scenario==='native-overlay-receipt')delete value.result.textRendering;
  if(scenario==='native-wrong-version')value.result.textRendering={mode:'native',version:'future'};
  if(scenario==='native-fake-verified')value.result.textVerification='verified';
  if(scenario==='native-rendered-claim')value.result.renderedText={title:nativePlan.title,subtitle:''};
  const memory=new Map();const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  let reads=0;
  const result=await runCoverGeneration({userId:'fixture-user-'+scenario,token:'fixture-token',storage,recovery:true,identity,task:nativeTask,
    fetcher:async(url,init)=>{reads++;assert.equal(init.method,'GET');assert.equal(new URL(url,'http://fixture.local').pathname,'/api/cover/attempt');return Response.json(value);},onState:()=>{}});
  assert.equal(reads,1);
  if(scenario==='native-completed'){
    assert.equal(result.state.pending,null);assert.equal(result.state.history[0].status,'done');
    assert.equal(result.state.history[0].renderPlan.textRendering.mode,'native');assert.equal(result.state.history[0].textVerification,'unverified');
  }else assert.equal(result.state.history.length,0,scenario+' must remain unconfirmed');
  cases.push(scenario);
}
{
  const memory=new Map();const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  const calls=[];
  const restored=await runCoverGeneration({userId:'fixture-claim-completed',token:'fixture-token',storage,identity,task,payload,onState:()=>{},
    fetcher:async(url,init)=>{calls.push({url,method:init.method});assert.equal(url,'/api/cover/attempt');assert.equal(init.method,'POST');assert.equal(JSON.parse(init.body).action,'claim');return Response.json(receipt);}});
  assert.equal(calls.length,1);assert.equal(restored.state.history[0].status,'done');assert.equal(restored.state.pending,null);
  cases.push('claim completed receipt is accepted before activeAttempt or current render readiness, with no dispatch');
}
{
  const memory=new Map();const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  let claims=0,dispatches=0,readinessReads=0;
  const activeAttempt={...identity,state:'claimed',updatedAt:Date.now(),task,dispatchInput:payload,canDispatch:true,requiresReferenceReupload:false};
  const fetcher=async(url,init)=>{
    if(url.startsWith('/api/cover/render')){readinessReads++;return Response.json({ready:false});}
    assert.ok(url.startsWith('/api/cover/attempt'));
    if(init.method==='POST'){const body=JSON.parse(init.body);if(body.action==='claim')claims++;else{dispatches++;assert.fail('Unready claimed order cannot dispatch');}}
    return Response.json({success:true,completed:false,activeAttempt});
  };
  const first=await runCoverGeneration({userId:'fixture-unready',token:'fixture-token',storage,identity,task,payload,fetcher,onState:()=>{}});
  assert.ok(first.state.pending);assert.ok(first.message.includes('尚未提交生图'));
  const recovered=await runCoverGeneration({userId:'fixture-unready',token:'fixture-token',storage,recovery:true,identity,task,payload,fetcher,onState:()=>{}});
  assert.ok(recovered.state.pending);assert.ok(recovered.message.includes('查询不会提交图片'));
  assert.equal(claims,1);assert.equal(dispatches,0);assert.equal(readinessReads,1);
  cases.push('initial readiness blocks dispatch; subsequent claimed recovery is query-only even when RAM retains a dispatch payload');
}
console.log(JSON.stringify({passed:true,checks:cases.length,cases,providerCalls:0,liveDatabaseCalls:0,livePostRequests:0,evidence:'Actual runCoverGeneration and composition/ownership DTO parsers; HTTP GET/claim responses and browser storage are fixtures. Completed replay never dispatches; unready claimed recovery also never dispatches.'},null,2));
