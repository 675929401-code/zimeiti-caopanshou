import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
 const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-prebilling-input-'));
 process.env.COMMERCE_DATA_DIR=fixture;
 process.env.SHARED_CONFIGURATION_ENABLED='0';
 Reflect.set(process.env,'NODE_ENV','test');
 let closeDatabase:(()=>void)|undefined;
 const checks:Array<{name:string;evidence:unknown}>=[];
 const check=(name:string,condition:unknown,evidence:unknown)=>{assert.ok(condition,name);checks.push({name,evidence});};
 try{
  const store=await import('../src/commerce/server/store');closeDatabase=()=>{(store.db() as unknown as {close:()=>void}).close();};
  const models=await import('../src/commerce/server/models');
  const providers=await import('../src/commerce/server/providers');
  const jobs=await import('../src/commerce/server/jobs');
  const owner='prebilling-fixture-owner';
  store.put('settings','main-model-source','system',{enabled:false});
  store.put('settings',`main-bind-${owner}`,'system',{mainUserId:'prebilling-fixture-user'});
  const modelId=await models.saveModel({kind:'video',displayName:'Prebilling Fixture',modelName:'fixture-video',protocol:'secure-video',endpoint:'https://provider.example.invalid',apiKey:'fixture-key-never-sent',publicPrice:0,costPrice:0,billingUnit:'per_use',enabled:true,capabilities:{available:true,explicitlyFree:true,nativeDurations:[1],durationOptions:[1],aspectRatios:['9:16'],resolutionOptions:['720p'],maxReferenceImages:2}});
  store.put('settings','defaults','system',{video:modelId});
  const model=await models.selectedModel('video',modelId);
  let submissions=0,lastRequest:{url:string;body:string;idempotencyKey:string}|undefined;
  providers.setCommerceProviderFetchForTesting(async(url,init={})=>{submissions++;const headers=new Headers(init.headers);lastRequest={url,body:String(init.body||''),idempotencyKey:String(headers.get('Idempotency-Key')||'')};return new Response(JSON.stringify({task_id:'fixture-task-1',status:'processing'}),{status:200,headers:{'Content-Type':'application/json'}});});

  const makeJob=(id:string,references:Array<{id:string;slot:string}>=[]):import('../src/commerce/server/jobs').Job=>({id,owner,input:{requestId:crypto.randomUUID(),kind:'video',modelId,prompt:'固定商品主体连续展示。',duration:1,aspectRatio:'9:16',resolution:'720p',references},model,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:1,compiledPrompt:'固定商品主体连续展示。',events:[{at:Date.now(),stage:'validated'},{at:Date.now(),stage:'queued'}]});

  const success=makeJob(crypto.randomUUID());store.put('jobs',success.id,owner,success);await jobs.runJob(success.id,owner);
  const completed=jobs.job(success.id,owner)!;const stages=(completed.events||[]).map(event=>event.stage),inputIndex=stages.indexOf('inputs-ready'),billingIndex=stages.indexOf('billing-committed'),dispatchIndex=stages.indexOf('provider-dispatched');
  check('zero-network fixture reaches exactly one provider submission',submissions===1,{submissions});
  check('provider request uses the frozen custom endpoint',lastRequest?.url==='https://provider.example.invalid/videos',lastRequest);
  check('provider request carries the immutable job idempotency key',lastRequest?.idempotencyKey===success.id,lastRequest);
  check('accepted async receipt leaves the original job processing',completed.status==='processing',{status:completed.status});
  check('accepted async receipt keeps the original provider task id',completed.providerTaskId==='fixture-task-1',{providerTaskId:completed.providerTaskId});
  check('zero-price fixture still persists a billing terminal before dispatch',completed.billing?.status==='zero_price',completed.billing);
  check('provider dispatch timestamp is durable',Number.isFinite(completed.dispatchedAt),{dispatchedAt:completed.dispatchedAt});
  check('input readiness precedes billing and provider dispatch',inputIndex>=0&&inputIndex<billingIndex&&billingIndex<dispatchIndex,{stages});

  const missingAsset=makeJob(crypto.randomUUID(),[{id:crypto.randomUUID(),slot:'product'}]);store.put('jobs',missingAsset.id,owner,missingAsset);await jobs.runJob(missingAsset.id,owner);
  const missingAfter=jobs.job(missingAsset.id,owner)!,missingStages=(missingAfter.events||[]).map(event=>event.stage);
  check('missing owned input fails the original job',missingAfter.status==='failed',{status:missingAfter.status,error:missingAfter.error});
  check('missing owned input reports the exact preflight boundary',/参考素材不存在/.test(String(missingAfter.error)),{error:missingAfter.error});
  check('missing owned input creates no billing state',store.get('billing',missingAsset.id,owner)===undefined,{billing:store.get('billing',missingAsset.id,owner)});
  check('missing owned input never submits to a provider',submissions===1,{submissions});
  check('missing owned input cannot claim readiness or dispatch',!missingStages.includes('inputs-ready')&&!missingStages.includes('billing-committed')&&!missingStages.includes('provider-dispatched'),{stages:missingStages});

  const storedModel=store.get<import('../src/commerce/server/models').Model>('models',modelId,'system')!;store.put('models',modelId,'system',{...storedModel,secret:undefined});
  const missingSecret=makeJob(crypto.randomUUID());store.put('jobs',missingSecret.id,owner,missingSecret);await jobs.runJob(missingSecret.id,owner);
  const secretAfter=jobs.job(missingSecret.id,owner)!,secretStages=(secretAfter.events||[]).map(event=>event.stage);
  check('missing transport secret fails before charge',secretAfter.status==='failed'&&/密钥尚未配置/.test(String(secretAfter.error)),{status:secretAfter.status,error:secretAfter.error});
  check('missing transport secret creates no billing state',store.get('billing',missingSecret.id,owner)===undefined,{billing:store.get('billing',missingSecret.id,owner)});
  check('missing transport secret never submits to a provider',submissions===1,{submissions});
  check('missing transport secret cannot claim complete input readiness',!secretStages.includes('inputs-ready')&&!secretStages.includes('billing-committed')&&!secretStages.includes('provider-dispatched'),{stages:secretStages});

  const jobsSource=await fs.readFile(path.resolve('src/commerce/server/jobs.ts'),'utf8'),depthSource=await fs.readFile(path.resolve('src/commerce/server/depth-video-clones.ts'),'utf8'),depthPreprocessSource=await fs.readFile(path.resolve('src/commerce/server/depth-video-preprocess.ts'),'utf8'),providerSource=await fs.readFile(path.resolve('src/commerce/server/providers.ts'),'utf8');
  check('queued dispatch materializes inputs before wallet charge',jobsSource.indexOf("const prepared=await prepareDispatchPayload(value,executionPermit)")<jobsSource.indexOf("await applyJobBilling(value,'charge',executionPermit)"),{source:'jobs.ts'});
  const refreshStart=jobsSource.indexOf('async function refreshJobWithExecutionLease'),refreshBody=jobsSource.slice(refreshStart);
  check('rolling recovery repeats input and prompt preflight before wallet charge',refreshBody.indexOf('prepareDispatchPayload')<refreshBody.indexOf("applyJobBilling(value,'charge'")&&refreshBody.indexOf('preflightRollingJob')<refreshBody.indexOf("applyJobBilling(value,'charge'"),{source:'jobs.ts'});
  check('depth quote prepares all public media references before quote persistence',depthSource.indexOf('await prepareDepthPublicInputs(owner,snapshot)')<depthSource.indexOf("put('depth-video-quotes'"),{source:'depth-video-clones.ts'});
  check('depth confirmation revalidates public media before job creation',depthSource.indexOf('await prepareDepthPublicInputs(owner,q.input.depthSnapshot)')<depthSource.indexOf('await createJob(owner,q.input'),{source:'depth-video-clones.ts'});
  check('depth clip upload owns a renewable fenced lease',depthPreprocessSource.includes('renewRecordLease(lease')&&depthPreprocessSource.includes('clearInterval(heartbeat)')&&depthPreprocessSource.indexOf("status:'uploaded'")<depthPreprocessSource.lastIndexOf("guard?.()===false"),{source:'depth-video-preprocess.ts'});
  check('provider transport substitution is test-process only',providerSource.includes("process.env.NODE_ENV!=='test'")&&providerSource.includes('setCommerceProviderFetchForTesting'),{source:'providers.ts'});

  providers.setCommerceProviderFetchForTesting();
  const report={schemaVersion:'commerce-prebilling-input-contract/v1',passed:true,result:{total:checks.length,passed:checks.length,failed:0},safety:{networkCalls:0,upstreamProviderSubmissions:0,simulatedProviderSubmissions:submissions,paidGeneration:0,walletDebit:0,productionWrites:0,deployment:0},checks};
  const output=path.resolve('.codex-evidence','commerce-prebilling-input-contract','report.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
  console.log(JSON.stringify({output,...report},null,2));
 }finally{closeDatabase?.();await fs.rm(fixture,{recursive:true,force:true});}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
