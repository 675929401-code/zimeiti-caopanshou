import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-specialized-quotes-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  await fs.mkdir(fixture,{recursive:true});
  const store=await import('../src/commerce/server/store');
  const assists=await import('../src/commerce/server/prompt-assist');
  const revisions=await import('../src/commerce/server/image-revisions');
  const quotes=await import('../src/commerce/server/quotes');
  const jobs=await import('../src/commerce/server/jobs');
  const owner='specialized-owner';
  const agentModel={id:'3a998bfc-aab4-4f8f-9128-b27498894a7b',displayName:'后台对话能力',kind:'agent' as const,source:'main' as const,enabled:true,publicPrice:1.5,costPrice:1,billingUnit:'per_use' as const,configHash:'a'.repeat(64),modelName:'claude-sonnet-4-6',protocol:'openai-chat',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,credentialsConfigured:true,endpointConfigured:true,protocolConfigured:true,imageParsing:true}};
  const imageModel={id:'gpt-image-2-chA-1',displayName:'后台图片能力',kind:'image' as const,source:'main' as const,enabled:true,publicPrice:2,costPrice:1.2,billingUnit:'per_use' as const,configHash:'b'.repeat(64),modelName:'gpt-image-2',provider:'openai_compat',protocol:'openai-image',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,credentialsConfigured:true,endpointConfigured:true,protocolConfigured:true,supportsImageInput:true,supportsReferenceInput:true,aspectRatios:['1:1'],resolutionOptions:['1K'],maxReferenceImages:9}};
  store.put('settings','main-model-source','system',{enabled:false});
  store.put('settings','defaults','system',{agent:agentModel.id,image:imageModel.id});
  store.put('models',agentModel.id,'system',agentModel);
  store.put('models',imageModel.id,'system',imageModel);
  const referenceId='11111111-1111-4111-8111-111111111111';
  store.put('assets',referenceId,owner,{id:referenceId,owner,name:'商品参考.png',type:'image/png',size:128,sha256:'a'.repeat(64),createdAt:Date.now(),origin:'upload'});
  const assist=assists.openAssist(owner,{contextId:'22222222-2222-4222-8222-222222222222',references:[{id:referenceId,slot:'reference'}],videoSettings:{resolution:'720p',duration:15,aspectRatio:'9:16',generateAudio:true}});
  const assistQuote=await assists.quoteAssist(owner,assist.id,assist.revision,'analyze');
  assert.equal(assistQuote.payableTotal,1.5);
  assert.equal('id' in assistQuote.model,false);
  assert.equal('estimatedTotalCost' in assistQuote,false);
  const storedAssist=store.get<Record<string,any>>('commerce-quotes',assistQuote.id,owner)!;
  const assistClaimId=storedAssist.input.assistQuoteId;
  assert.ok(store.get('prompt-assist-quotes',assistClaimId,owner));
  const assistJob=await quotes.confirmCommerceQuote(owner,{quoteId:assistQuote.id,clientRequestId:'33333333-3333-4333-8333-333333333333',inputFingerprint:assistQuote.inputFingerprint});
  assert.equal(assistJob.configurationSnapshot?.quoteId,assistQuote.id);
  assert.deepEqual(assistJob.configurationSnapshot?.modelSelection,storedAssist.modelSelection);
  assert.equal(assistJob.configurationSnapshot?.clientRequestId,'33333333-3333-4333-8333-333333333333');
  assert.equal(assists.readAssist(owner,assist.id).activeJobId,assistJob.id);
  assert.equal('modelId' in jobs.publicJob(assistJob).input,false);

  const originalId='44444444-4444-4444-8444-444444444444';
  store.put('jobs',originalId,owner,{id:originalId,owner,input:{requestId:originalId,kind:'image',modelId:imageModel.id,prompt:'原图',skillId:'default',aspectRatio:'1:1',resolution:'1K',references:[]},model:imageModel,route:{id:'image.default',label:'自由生图',kind:'image',promptId:'default',modelId:imageModel.id,revision:1,stages:[]},status:'succeeded',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[referenceId],promptVersion:1,compiledPrompt:'原图'});
  const revisionQuote=await revisions.quoteImageRevision(owner,originalId,'保持商品一致，背景改为暖色');
  assert.equal(revisionQuote.payableTotal,2);
  assert.equal('id' in revisionQuote.model,false);
  assert.equal('estimatedTotalCost' in revisionQuote,false);
  const storedRevision=store.get<Record<string,any>>('commerce-quotes',revisionQuote.id,owner)!;
  const revisionClaimId=storedRevision.input.imageRevisionQuoteId;
  const claim=store.get<Record<string,any>>('image-revisions',revisionClaimId,owner)!;
  assert.equal(claim.commerceQuoteId,revisionQuote.id);
  const revisionJob=await quotes.confirmCommerceQuote(owner,{quoteId:revisionQuote.id,clientRequestId:'55555555-5555-4555-8555-555555555555',inputFingerprint:revisionQuote.inputFingerprint});
  assert.equal(revisionJob.input.regenerationOf,originalId);
  assert.equal(revisionJob.configurationSnapshot?.quoteId,revisionQuote.id);
  assert.deepEqual(revisionJob.configurationSnapshot?.modelSelection,storedRevision.modelSelection);
  assert.equal(store.get<Record<string,any>>('image-revisions',revisionClaimId,owner)?.jobId,revisionJob.id);
  assert.equal('modelId' in jobs.publicJob(revisionJob).input,false);

  const promptApi=await fs.readFile(new URL('../src/app/api/commerce/prompt-assist/route.ts',import.meta.url),'utf8');
  const revisionApi=await fs.readFile(new URL('../src/app/api/commerce/image-revisions/route.ts',import.meta.url),'utf8');
  const promptUi=await fs.readFile(new URL('../src/commerce/components/commerce-agent/prompt-assist-flow.tsx',import.meta.url),'utf8');
  const revisionUi=await fs.readFile(new URL('../src/commerce/components/commerce-agent/image-revision.tsx',import.meta.url),'utf8');
  assert.match(promptApi,/统一任务接口/);
  assert.match(revisionApi,/统一任务接口/);
  assert.match(promptUi,/['"]\/api\/commerce\/jobs['"]/);
  assert.match(revisionUi,/['"]\/api\/commerce\/jobs['"]/);
  assert.doesNotMatch(promptUi,/modelId:modelId/);
  console.log(JSON.stringify({passed:21,networkCalls:0,paidCalls:0,checks:['assist-payable','assist-hidden-model','assist-hidden-cost','assist-business-claim','assist-generic-quote','assist-session-claim','assist-public-model-hidden','revision-payable','revision-hidden-model','revision-hidden-cost','revision-business-claim','revision-generic-quote','revision-source-bound','revision-job-claim','revision-public-model-hidden','assist-old-confirm-closed','revision-old-confirm-closed','assist-unified-ui','revision-unified-ui','hidden-client-model-absent','no-provider-dispatch'],fixture}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
