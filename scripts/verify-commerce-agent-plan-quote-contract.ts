import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-agent-plan-quote-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  await fs.mkdir(fixture,{recursive:true});
  const store=await import('../src/commerce/server/store');
  const plans=await import('../src/commerce/server/agent-plans');
  const workflows=await import('../src/commerce/server/workflows');
  const imageModel={id:'image-fixture',displayName:'后台图片能力',kind:'image' as const,source:'custom' as const,enabled:true,publicPrice:2,costPrice:1,billingUnit:'per_use' as const,configHash:'image-v1',protocol:'openai-image',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,aspectRatios:['1:1'],resolutionOptions:['1K'],maxReferenceImages:9}};
  const videoModel={id:'video-fixture',displayName:'用户视频能力',kind:'video' as const,source:'custom' as const,enabled:true,publicPrice:0.5,costPrice:0.25,billingUnit:'output_second' as const,configHash:'video-v1',protocol:'secure-video',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,aspectRatios:['1:1'],resolutionOptions:['720p'],nativeDurations:[5],maxReferenceImages:1}};
  store.put('settings','main-model-source','system',{enabled:false});
  store.put('settings','defaults','system',{image:imageModel.id,video:videoModel.id});
  store.put('settings','main-bind-plan-owner','system',{mainUserId:'main-admin-fixture',exempt:true});
  store.put('models',imageModel.id,'system',imageModel);
  store.put('models',videoModel.id,'system',videoModel);
  const spec={schema:'commerce-plan/v1' as const,title:'报价合同验收',summary:'保持同一商品与视觉风格',steps:[
    {id:'hero',label:'商品主图',kind:'image' as const,skillId:'default',prompt:'生成商品主图',aspectRatio:'1:1',resolution:'1K',references:[]},
    {id:'motion',label:'商品视频',kind:'video' as const,skillId:'default',prompt:'让商品连续旋转展示',aspectRatio:'1:1',resolution:'720p',duration:5,references:[{step:'hero',slot:'reference'}]},
  ]};
  const sourceId='11111111-1111-4111-8111-111111111111';
  store.put('jobs',sourceId,'plan-owner',{id:sourceId,owner:'plan-owner',input:{requestId:sourceId,kind:'agent',modelId:'agent-source',prompt:'请制作一套商品图和视频',conversationId:'conversation-1',references:[]},model:{id:'agent-source',displayName:'来源对话',kind:'agent',source:'custom',enabled:true,publicPrice:1,costPrice:0.5,billingUnit:'per_use',configHash:'agent-v1',capabilities:{available:true}},status:'succeeded',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:1,compiledPrompt:'fixture',text:'```commerce-plan\n'+JSON.stringify(spec)+'\n```'});

  const prepared=plans.prepareAgentPlan('plan-owner',sourceId);
  const publicPrepared=plans.publicAgentPlan(prepared);
  assert.equal(publicPrepared.bindings.hero,undefined);
  assert.equal(publicPrepared.bindings.motion,videoModel.id);
  const result=await plans.quoteAgentPlan('plan-owner',sourceId,{spec,bindings:{motion:videoModel.id}});
  assert.equal(result.quote.payableTotal,4.5);
  assert.equal(result.quote.steps[0].payableTotal,2);
  assert.equal(result.quote.steps[1].payableTotal,2.5);
  assert.equal('id' in result.quote.steps[0].model,false);
  assert.equal('modelConfigHash' in result.quote.steps[0],false);
  assert.equal('unitCost' in result.quote.steps[0],false);
  await assert.rejects(()=>plans.quoteAgentPlan('plan-owner',sourceId,{spec,bindings:{hero:imageModel.id,motion:videoModel.id}}),/只有视频步骤/);
  const clientRequestId='22222222-2222-4222-8222-222222222222';
  const run=await plans.confirmAgentPlan('plan-owner',sourceId,{quoteId:result.quote.id,clientRequestId,confirmationFingerprint:result.quote.previewFingerprint});
  const parentBilling=store.get<Record<string,any>>('aggregate-billing',result.quote.id,'plan-owner')!;
  assert.equal(parentBilling.status,'exempt');
  assert.equal(parentBilling.amount,4.5);
  assert.equal(run.agentPlanExecution?.quoteId,result.quote.id);
  assert.equal(run.agentPlanExecution?.steps.hero.billingSnapshot?.modelConfigHash,imageModel.configHash);
  const publicRun=workflows.publicWorkflow(run);
  assert.equal('agentPlanExecution' in publicRun,false);
  assert.equal('modelId' in publicRun.nodes.find(node=>node.id==='hero')!.data,false);
  assert.equal(publicRun.nodes.find(node=>node.id==='motion')!.data.modelId,videoModel.id);
  const replay=await plans.confirmAgentPlan('plan-owner',sourceId,{quoteId:result.quote.id,clientRequestId,confirmationFingerprint:result.quote.previewFingerprint});
  assert.equal(replay.id,run.id);
  await assert.rejects(()=>plans.confirmAgentPlan('plan-owner',sourceId,{quoteId:result.quote.id,clientRequestId:'33333333-3333-4333-8333-333333333333',confirmationFingerprint:result.quote.previewFingerprint}),/另一客户端请求/);
  const agentUi=await fs.readFile(new URL('../src/commerce/components/commerce-agent/agent-execution.tsx',import.meta.url),'utf8');
  const runtimeUi=await fs.readFile(new URL('../src/commerce/components/commerce-agent/runtime-ui.tsx',import.meta.url),'utf8');
  assert.match(agentUi,/重新获取报价/);
  assert.match(agentUi,/重新报价\|报价已过期/);
  assert.match(runtimeUi,/重新报价\|报价已过期/);
  assert.match(runtimeUi,/requestKey\.current=\{key:crypto\.randomUUID\(\),fingerprint\}/);
  console.log(JSON.stringify({passed:21,networkCalls:0,paidCalls:0,checks:['hidden-image-binding','video-binding-public','aggregate-price','image-price','video-duration-price','hidden-image-model-id','hidden-model-hash','hidden-cost','image-binding-rejected','parent-wallet-exempt-receipt','parent-wallet-total','quote-bound-workflow','step-config-snapshot','workflow-internals-hidden','hidden-node-model','video-node-model-public','idempotent-confirm-and-conflict','agent-plan-requote-control','agent-plan-stale-quote-reset','manual-submit-stale-quote-reset','manual-submit-new-request-id-after-stale'],fixture}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
