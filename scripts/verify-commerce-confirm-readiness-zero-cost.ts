import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-confirm-readiness-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  await fs.mkdir(fixture,{recursive:true});

  const cache=((globalThis as unknown as {commerceConfigurationCache?:{value?:unknown;checkedAt:number}}).commerceConfigurationCache??={checkedAt:0});
  cache.value={paidJobsReady:false};
  cache.checkedAt=Date.now();
  let networkCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{networkCalls++;throw Error('付费配置未就绪时禁止钱包或供应商网络调用');}) as typeof fetch;

  try{
    const store=await import('../src/commerce/server/store');
    const quotes=await import('../src/commerce/server/quotes');
    const plans=await import('../src/commerce/server/agent-plans');
    const details=await import('../src/commerce/server/detail-sets');
    const workflows=await import('../src/commerce/server/workflows');
    const owner='confirm-readiness-owner',expiresAt=Date.now()+60_000;

    const quoteId=randomUUID(),quoteClientId=randomUUID(),inputFingerprint='ordinary-quote-fingerprint';
    store.put('commerce-quotes',quoteId,owner,{schema:'commerce-quote/v1',id:quoteId,owner,operationId:'agent.default',input:{kind:'agent',modelId:'fixture-agent',prompt:'fixture'},inputFingerprint,modelId:'fixture-agent',modelDisplayName:'Fixture Agent',modelConfigHash:'fixture-agent-v1',billingUnit:'per_use',quantity:1,unitCost:1,estimatedTotalCost:1,unitPrice:2,payableTotal:2,profitAmount:1,profitRate:100,currency:'CNY',createdAt:Date.now(),expiresAt,status:'quoted'});

    const planId=randomUUID(),planQuoteId=randomUUID(),planClientId=randomUUID();
    const spec={schema:'commerce-plan/v1',title:'fixture',summary:'fixture',steps:[]};
    store.put('agent-plans',planId,owner,{id:planId,owner,sourceJobId:randomUUID(),spec,createdAt:Date.now(),updatedAt:Date.now(),bindings:{}});
    store.put('agent-plan-quotes',planQuoteId,owner,{schema:'commerce-agent-plan-quote/v1',id:planQuoteId,owner,planId,previewFingerprint:'preview',fingerprint:'plan-quote-fingerprint',spec,bindings:{},steps:[{stepId:'image',label:'主图',kind:'image',modelId:'fixture-image',modelDisplayName:'Fixture Image',operationId:'image.default',modelConfigHash:'fixture-image-v1',billingUnit:'per_use',quantity:1,unitCost:1,estimatedTotalCost:1,unitPrice:2,payableTotal:2,references:[]}],payableTotal:2,estimatedTotalCost:1,profitAmount:1,currency:'CNY',createdAt:Date.now(),expiresAt,status:'quoted'});

    const detailQuoteId=randomUUID();
    store.put('detail-set-quotes',detailQuoteId,owner,{id:detailQuoteId,owner,sessionId:randomUUID(),revision:1,stage:'analyze',contentFingerprint:'detail-fingerprint',modelId:'fixture-agent',modelName:'Fixture Agent',modelConfigHash:'fixture-agent-v1',modelFingerprint:'fixture-agent-fingerprint',routeFingerprint:'detail-route',billingUnit:'per_use',quantity:1,unitCost:1,estimatedCost:1,unitPrice:2,estimatedPrice:2,profitAmount:1,expiresAt});

    const canvasQuoteId=randomUUID(),canvasClientId=randomUUID(),graphFingerprint='canvas-graph-fingerprint';
    store.put('canvas-workflow-quotes',canvasQuoteId,owner,{version:1,id:canvasQuoteId,owner,canvasId:randomUUID(),graphFingerprint,executionMode:'generation',createdAt:Date.now(),expiresAt,currency:'CNY',estimatedTotalCost:1,payableTotal:2,profitAmount:1,status:'quoted',items:[{nodeId:'image-node',label:'主图',kind:'image',operationId:'image.default',modelId:'fixture-image',modelName:'Fixture Image',modelConfigHash:'fixture-image-v1',billingUnit:'per_use',quantity:1,unitCost:1,estimatedTotalCost:1,unitPrice:2,payableTotal:2}]});

    await assert.rejects(()=>quotes.confirmCommerceQuote(owner,{quoteId,clientRequestId:quoteClientId,inputFingerprint}),/COMMERCE_CONFIG_PAID_JOBS_NOT_READY/);
    await assert.rejects(()=>plans.confirmAgentPlan(owner,planId,{quoteId:planQuoteId,clientRequestId:planClientId,confirmationFingerprint:'preview'}),/COMMERCE_CONFIG_PAID_JOBS_NOT_READY/);
    await assert.rejects(()=>details.confirmDetailSet(owner,detailQuoteId),/COMMERCE_CONFIG_PAID_JOBS_NOT_READY/);
    await assert.rejects(()=>workflows.confirmCanvasWorkflow(owner,canvasQuoteId,canvasClientId,graphFingerprint),/COMMERCE_CONFIG_PAID_JOBS_NOT_READY/);

    assert.equal(store.list('jobs',owner).length,0);
    assert.equal(store.list('workflows',owner).length,0);
    assert.equal(store.list('detail-set-runs',owner).length,0);
    assert.equal(store.list('aggregate-billing',owner).length,0);
    assert.equal(store.list('billing',owner).length,0);
    assert.equal(networkCalls,0);

    const existingJobId=randomUUID(),consumedQuoteId=randomUUID(),consumedQuoteClientId=randomUUID();
    store.put('jobs',existingJobId,owner,{id:existingJobId,owner,input:{requestId:existingJobId,kind:'agent',modelId:'fixture-agent',prompt:'existing'},model:{id:'fixture-agent',displayName:'Fixture Agent',kind:'agent',source:'custom',enabled:true,publicPrice:2,costPrice:1,billingUnit:'per_use',configHash:'fixture-agent-v1',capabilities:{available:true}},status:'queued',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:1,compiledPrompt:'existing'});
    store.put('commerce-quotes',consumedQuoteId,owner,{schema:'commerce-quote/v1',id:consumedQuoteId,owner,inputFingerprint:'consumed-fingerprint',clientRequestId:consumedQuoteClientId,jobId:existingJobId,expiresAt,status:'consumed'});
    assert.equal((await quotes.confirmCommerceQuote(owner,{quoteId:consumedQuoteId,clientRequestId:consumedQuoteClientId,inputFingerprint:'consumed-fingerprint'})).id,existingJobId);

    const existingWorkflowId=randomUUID(),consumedPlanQuoteId=randomUUID(),consumedPlanClientId=randomUUID();
    store.put('workflows',existingWorkflowId,owner,{id:existingWorkflowId,owner,canvasId:randomUUID(),title:'existing',nodes:[],edges:[],createdAt:Date.now(),updatedAt:Date.now(),status:'succeeded',steps:{}});
    store.put('agent-plan-quotes',consumedPlanQuoteId,owner,{id:consumedPlanQuoteId,owner,planId,workflowId:existingWorkflowId,clientRequestId:consumedPlanClientId,expiresAt,status:'consumed'});
    assert.equal((await plans.confirmAgentPlan(owner,planId,{quoteId:consumedPlanQuoteId,clientRequestId:consumedPlanClientId})).id,existingWorkflowId);

    const consumedDetailQuoteId=randomUUID();
    store.put('detail-set-quotes',consumedDetailQuoteId,owner,{id:consumedDetailQuoteId,owner,sessionId:randomUUID(),jobId:existingJobId,expiresAt});
    assert.equal((await details.confirmDetailSet(owner,consumedDetailQuoteId)).jobId,existingJobId);

    const consumedCanvasQuoteId=randomUUID(),consumedCanvasClientId=randomUUID();
    store.put('canvas-workflow-quotes',consumedCanvasQuoteId,owner,{id:consumedCanvasQuoteId,owner,graphFingerprint:'consumed-canvas-fingerprint',workflowId:existingWorkflowId,clientRequestId:consumedCanvasClientId,expiresAt,status:'consumed'});
    assert.equal((await workflows.confirmCanvasWorkflow(owner,consumedCanvasQuoteId,consumedCanvasClientId,'consumed-canvas-fingerprint')).id,existingWorkflowId);
    assert.equal(store.list('jobs',owner).length,1);
    assert.equal(store.list('workflows',owner).length,1);
    assert.equal(store.list('aggregate-billing',owner).length,0);
    assert.equal(store.list('billing',owner).length,0);
    assert.equal(networkCalls,0);

    console.log(JSON.stringify({passed:16,networkCalls,walletCalls:0,providerCalls:0,newJobsBeforeReadiness:0,newWorkflowsBeforeReadiness:0,checks:['ordinary-confirm-gated','agent-plan-confirm-gated','detail-confirm-gated','canvas-confirm-gated','no-job-created','no-workflow-created','no-detail-run-created','no-aggregate-wallet-write','no-job-wallet-write','no-network-call','ordinary-consumed-idempotent','agent-plan-consumed-idempotent','detail-consumed-idempotent','canvas-consumed-idempotent','idempotent-no-wallet-write','idempotent-no-network-call'],fixture}));
  }finally{
    globalThis.fetch=originalFetch;
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
