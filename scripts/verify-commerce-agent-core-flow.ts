import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {Workflow} from '../src/commerce/server/workflows';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-agent-core-flow-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  process.env.MAIN_MODEL_ORIGIN='http://commerce-agent-core.fixture';
  process.env.NEXT_PUBLIC_SUPABASE_URL='';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='';
  process.env.SUPABASE_SERVICE_ROLE_KEY='';
  await fs.mkdir(fixture,{recursive:true});

  const agentModel={id:'main-agent-fixture',displayName:'后台对话能力',kind:'agent' as const,source:'main' as const,publicPrice:0,costPrice:0,billingUnit:'per_use' as const,configHash:'agent-core-v1',capabilities:{available:true,executionSupported:true,imageParsing:true,explicitlyFree:true}};
  const imageModel={id:'main-image-fixture',displayName:'后台图片能力',kind:'image' as const,source:'main' as const,publicPrice:0,costPrice:0,billingUnit:'per_use' as const,configHash:'image-core-v1',capabilities:{available:true,executionSupported:true,supportsReferenceInput:true,aspectRatios:['1:1'],resolutionOptions:['1K'],maxReferenceImages:9,explicitlyFree:true}};
  const productPng=await sharp({create:{width:64,height:64,channels:4,background:{r:33,g:113,b:181,alpha:1}}}).png().toBuffer();
  const generatedPng=await sharp({create:{width:1024,height:1024,channels:4,background:{r:245,g:170,b:38,alpha:1}}}).png().toBuffer();
  const plan={
    schema:'commerce-plan/v1' as const,
    title:'商品主视觉与细节图',
    summary:'保持同一蓝色商品、暖色商业棚拍和真实材质',
    sharedContext:{product:'蓝色商品',style:'暖色商业棚拍',constraints:['不改变商品颜色和标识']},
    steps:[
      {id:'hero',label:'商品主视觉',kind:'image' as const,skillId:'default',prompt:'生成蓝色商品主视觉',aspectRatio:'1:1',resolution:'1K',references:[{source:1,slot:'reference'}]},
      {id:'detail',label:'商品细节图',kind:'image' as const,skillId:'default',prompt:'沿用主视觉生成商品细节图',aspectRatio:'1:1',resolution:'1K',references:[{step:'hero',slot:'reference'},{source:1,slot:'reference'}]},
    ],
  };
  let agentInvocations=0,imageInvocations=0,unexpectedFetches=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.origin!==process.env.MAIN_MODEL_ORIGIN||url.pathname!=='/api/commerce-model-gateway'){
      unexpectedFetches++;
      return new Response(JSON.stringify({error:'fixture blocks external network'}),{status:503,headers:{'content-type':'application/json'}});
    }
    if((init?.method||'GET')==='GET'){
      const kind=url.searchParams.get('kind');
      return Response.json({models:kind==='agent'?[agentModel]:kind==='image'?[imageModel]:[]});
    }
    const body=JSON.parse(String(init?.body||'{}')) as {kind?:string;messages?:unknown[]};
    if(body.kind==='agent'){
      agentInvocations++;
      const text=agentInvocations===1?'已记录商品颜色、标识和暖色棚拍要求。':`已按最新要求整理为可编辑计划。\n\`\`\`commerce-plan\n${JSON.stringify(plan)}\n\`\`\``;
      return Response.json({status:'success',result:{text,usage:{costCny:0.42}}});
    }
    if(body.kind==='image'){
      imageInvocations++;
      return Response.json({status:'success',result:{url:'data:image/png;base64,'+generatedPng.toString('base64'),usage:{costCny:0.8}}});
    }
    return Response.json({status:'failed',error:'fixture kind unsupported'});
  };

  try{
    const store=await import('../src/commerce/server/store');
    const assets=await import('../src/commerce/server/assets');
    const jobs=await import('../src/commerce/server/jobs');
    const quotes=await import('../src/commerce/server/quotes');
    const plans=await import('../src/commerce/server/agent-plans');
    const workflows=await import('../src/commerce/server/workflows');
    await fs.writeFile(path.join(store.runtimeDir(),'main-gateway.key'),'fixture-main-gateway-key');
    const owner='agent-core-owner',conversationId='agent-core-conversation';
    store.put('settings','main-model-source','system',{enabled:true});
    store.put('settings','defaults','system',{agent:agentModel.id,image:imageModel.id});
    store.put('settings','main-bind-'+owner,'system',{mainUserId:'main-admin-fixture',mainRole:'admin',exempt:false});
    const sourceAsset=await assets.storeAsset(owner,productPng,'image/png','product.png');

    async function quoteConfirmRun(prompt:string){
      const quote=await quotes.createCommerceQuote(owner,{kind:'agent',modelId:'client-model-must-be-ignored',prompt,conversationId,references:[{id:sourceAsset.id,slot:'product'}]});
      assert.equal('id' in quote.model,false);
      const clientRequestId=crypto.randomUUID();
      const created=await quotes.confirmCommerceQuote(owner,{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint});
      const replay=await quotes.confirmCommerceQuote(owner,{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint});
      assert.equal(replay.id,created.id);
      await jobs.runJob(created.id,owner);
      return jobs.job(created.id,owner)!;
    }

    const first=await quoteConfirmRun('这是一件蓝色商品，请保持颜色、标识和暖色商业棚拍。');
    assert.equal(first.status,'succeeded');
    assert.match(first.text||'',/已记录商品颜色/);
    const second=await quoteConfirmRun('继续，根据刚才确认的要求制作主视觉和细节图计划。');
    assert.equal(second.status,'succeeded');
    assert.equal(second.conversationContext?.messages.length,3);
    assert.equal(second.conversationContext?.messages[1].role,'assistant');
    assert.match(second.compiledPrompt,/刚才确认的要求/);

    const prepared=plans.prepareAgentPlan(owner,second.id);
    assert.equal(prepared.spec.steps.length,2);
    const edited={...prepared.spec,summary:prepared.spec.summary+'；细节图突出边缘质感',steps:prepared.spec.steps.map(step=>step.id==='detail'?{...step,prompt:step.prompt+'，突出边缘质感'}:step)};
    const quoted=await plans.quoteAgentPlan(owner,second.id,{spec:edited,bindings:{}});
    assert.equal(quoted.quote.payableTotal,0);
    assert.equal(quoted.quote.steps.length,2);
    const confirmationId=crypto.randomUUID();
    const workflow=await plans.confirmAgentPlan(owner,second.id,{quoteId:quoted.quote.id,clientRequestId:confirmationId,confirmationFingerprint:quoted.quote.previewFingerprint});
    const workflowReplay=await plans.confirmAgentPlan(owner,second.id,{quoteId:quoted.quote.id,clientRequestId:confirmationId,confirmationFingerprint:quoted.quote.previewFingerprint});
    assert.equal(workflowReplay.id,workflow.id);
    await workflows.advanceWorkflow(workflow.id,owner);
    const finished=store.get<Workflow>('workflows',workflow.id,owner)!;
    if(finished.status!=='succeeded')throw Error(`agent workflow did not succeed: ${finished.error||JSON.stringify(finished.steps)}`);
    assert.equal(finished.status,'succeeded');
    assert.equal(finished.steps.hero.status,'succeeded');
    assert.equal(finished.steps.detail.status,'succeeded');
    assert.ok(finished.steps.hero.output?.assets.length);
    assert.ok(finished.steps.detail.output?.assets.length);
    assert.notEqual(finished.steps.hero.output?.assets[0].id,finished.steps.detail.output?.assets[0].id);
    assert.equal(imageInvocations,2);
    assert.equal(assets.assets(owner).filter(asset=>asset.source==='generated').length,2);
    assert.equal(jobs.jobs(owner).filter(item=>item.status==='succeeded').length,4);
    assert.equal(jobs.conversation(conversationId,owner)?.messages.length,4);

    const publicWorkflow=workflows.publicWorkflow(finished);
    assert.equal('agentPlanExecution' in publicWorkflow,false);
    assert.equal('modelId' in publicWorkflow.nodes.find(node=>node.id==='hero')!.data,false);
    const publicSecond=jobs.publicJob(second);
    assert.equal('compiledPrompt' in publicSecond,false);
    assert.equal('conversationContext' in publicSecond,false);
    assert.equal('modelId' in publicSecond.input,false);
    assert.equal('id' in publicSecond.model,false);

    await workflows.advanceWorkflow(workflow.id,owner);
    assert.equal(imageInvocations,2);
    assert.equal(unexpectedFetches,4,'only the four intentionally blocked revenue writes may leave the fixture gateway');
    const evidence={
      schema:'commerce-agent-core-flow/v1',createdAt:new Date().toISOString(),fixture,
      passed:29,providerRequests:0,paidCalls:0,mockedMainGatewayCalls:{agent:agentInvocations,image:imageInvocations},
      externalNetworkCalls:0,blockedUnexpectedFetches:unexpectedFetches,
      sourceJobIds:[first.id,second.id],workflowId:finished.id,generatedAssetIds:assets.assets(owner).filter(asset=>asset.source==='generated').map(asset=>asset.id),
      checks:['server-quote','hidden-agent-model','quote-confirm-replay','image-reference','multi-turn-snapshot','editable-plan','aggregate-quote','dependency-order','two-image-executions','stable-assets','job-history','conversation-history','workflow-replay','private-prompt-hidden','hidden-non-video-model','no-duplicate-generation'],
    };
    await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
  }finally{
    globalThis.fetch=originalFetch;
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
