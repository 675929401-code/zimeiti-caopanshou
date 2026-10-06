import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root=process.cwd(), cache=new Map();let posted,claims=0,finalizations=0,localLlmRouteCalls=0;
class FixtureHistoryError extends Error{constructor(code,message,status=503){super(message);this.code=code;this.status=status;}}
class FixtureAccessError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const stubs={
 '@/lib/short-drama/readiness':{assertShortDramaReadyForPaidModelCall:async()=>{}},
 '@/lib/short-drama/paid-request-idempotency':{requireShortDramaPaidRequestId:()=> 'fixture-system-contract-0001'},
 '@/lib/short-drama/text-model-selection':{selectShortDramaTextModel:async()=>({id:'fixture-current',displayName:'Fixture'})},
 '@/lib/short-drama/idempotency':{hashShortDramaRequest:()=> 'a'.repeat(64)},
 '@/lib/short-drama/permissions':{
  ShortDramaAccessError:FixtureAccessError,
  authorizeShortDramaRequest:async()=>({userId:'fixture-user',db:{}}),
 },
 '@/lib/short-drama/general-script-history':{
  GeneralScriptHistoryError:FixtureHistoryError,
  normalizeGeneralScriptHistorySurface:value=>value||'api',
  GeneralScriptHistoryRepository:class{
   async claim(){claims+=1;return {action:'execute',record:{id:'fixture',state:'submitted',result:null,billingSnapshot:{}}};}
   async finalize(input){assert.equal(input.state,'succeeded');assert.equal(input.billingSnapshot.state,'settled');finalizations+=1;}
  },
 },
};
function load(filename){
 const absolute=path.resolve(root,filename);if(cache.has(absolute))return cache.get(absolute);
 if(absolute.endsWith('.json'))return JSON.parse(readFileSync(absolute,'utf8'));
 const exports={};cache.set(absolute,exports);
 const context={exports,Request,Response,URL,console,process:{env:{}},fetch:async(url,options)=>{
 assert.equal(new URL(url).pathname,'/api/llm');posted=JSON.parse(options.body);
  localLlmRouteCalls+=1;
  const contract=load('src/lib/short-drama/general-script-contract.ts');
  const fixtures=load('src/lib/short-drama/general-script-fixtures.ts');
  const input=contract.parseGeneralScriptRequest(raw);
  return Response.json({choices:[{message:{content:JSON.stringify(fixtures.createGeneralScriptFixture(input))}}],_billing:{operation_id:'llm:fixture-system-contract-0001:answer',credits_charged:0,already_fulfilled:false}});
 },require(spec){if(stubs[spec])return stubs[spec];let file=spec.startsWith('@/')?path.join(root,'src',spec.slice(2)):path.resolve(path.dirname(absolute),spec);if(!/\.(json|ts)$/.test(file))file+='.ts';return load(file);}};
 vm.runInNewContext(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,context);return exports;
}
let raw;const handler=load('src/app/api/short-drama/script/route.ts').POST;
for(const profile of ['general-script','drama-script','pet-silent-narration']){
 raw={profile:{id:profile,version:'1.0.0'},operation:'generate',settings:{creationMode:'original',targetAudience:'all_ages',tone:'warm',customTone:'',genre:'短剧',animationStyle:'3D',videoSize:'16:9',episodesToGenerate:1,totalEpisodes:1,isFinale:true},content:{title:'fixture',brief:'仅本地验证既有系统合同传递',sourceMaterial:'',requirements:'一集'},rewriteEpisodeNumbers:[],rewriteInstruction:''};
 const response=await handler(new Request('http://127.0.0.1/api/short-drama/script',{method:'POST',headers:{authorization:'Bearer fixture-local-only','content-type':'application/json'},body:JSON.stringify(raw)}));
 const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
 const profileConfig=load('src/lib/short-drama/general-script-profile.ts').getGeneralScriptPromptProfile(profile);
 assert.equal(posted.system_prompt,profileConfig.systemPrompt);
 assert.equal(posted.messages.find(m=>m.role==='system').content,posted.system_prompt);
 assert.equal(body.result.schemaVersion,'general-script-result.v1');assert.equal(body.executionMode,'real');
}
assert.equal(claims,3);assert.equal(finalizations,3);assert.equal(localLlmRouteCalls,3);
const contract=load('src/lib/short-drama/general-script-contract.ts');
const llm=load('src/lib/short-drama/general-script-llm.ts');
const fixture=load('src/lib/short-drama/general-script-fixtures.ts');
const request=contract.parseGeneralScriptRequest({...raw,profile:{id:'general-script',version:'1.0.0'}});
const result=fixture.createGeneralScriptFixture(request);
result.summary.animationStyle='模型对风格的补充描述';
const bound=llm.bindGeneralScriptRequestSettings(request,result);
assert.equal(contract.validateGeneralScriptResultForRequest(request,bound).summary.animationStyle,request.settings.animationStyle);
assert.equal(bound.episodes,result.episodes);assert.equal(bound.characters,result.characters);
assert.equal(result.summary.animationStyle,'模型对风格的补充描述');
assert.throws(()=>contract.validateGeneralScriptResultForRequest(request,{...bound,profileId:'drama-script'}));
assert.throws(()=>contract.validateGeneralScriptResultForRequest(request,{...bound,episodes:[...bound.episodes,...bound.episodes]}));
assert.throws(()=>contract.validateGeneralScriptResultForRequest(request,{...bound,characters:[]}));
console.log(JSON.stringify({passed:true,actualRouteProfiles:3,requestMetadataBinding:true,storyAndAssetGuards:3,historyClaims:claims,historyFinalizations:finalizations,localLlmRouteCalls,providerCalls:0,databaseWrites:0}));
