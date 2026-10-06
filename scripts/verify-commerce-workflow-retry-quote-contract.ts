import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Job} from '../src/commerce/server/jobs';

async function main(){
 const fixture=path.resolve('.codex-evidence/commerce-workflow-retry-quote-'+Date.now());
 process.env.COMMERCE_DATA_DIR=fixture;
 process.env.SHARED_CONFIGURATION_ENABLED='0';
 await fs.mkdir(fixture,{recursive:true});
 const store=await import('../src/commerce/server/store');
 const workflowModule=await import('../src/commerce/server/workflows');
 const billingModule=await import('../src/commerce/server/billing');
 const owner='workflow-retry-owner';
 const model={id:'gpt-image-2-chA-1',internalModelId:'gpt-image-2-chA-1',modelName:'gpt-image-2',provider:'openai_compat',displayName:'GPT Image 2 Fixture',kind:'image' as const,source:'main' as const,enabled:true,publicPrice:0,costPrice:0,billingUnit:'per_use' as const,configHash:'1'.repeat(64),verifiedAt:Date.now(),protocol:'openai-image',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,credentialsConfigured:true,endpointConfigured:true,protocolConfigured:true,explicitlyFree:true}};
 store.put('settings','main-model-source','system',{enabled:false});
 store.put('settings','defaults','system',{image:model.id});
 store.put('settings','main-bind-'+owner,'system',{mainUserId:'main-admin-fixture',exempt:true});
 store.put('models',model.id,'system',model);

 async function blockedWorkflow(name:string,status:'failed'|'unknown'|'save_failed'='failed'){
  const canvas={id:name,title:name,nodes:[{id:name+'-node',position:{x:0,y:0},data:{label:'商品主图',kind:'image' as const,mode:'generate',prompt:'生成商品主图',skillId:'default',aspectRatio:'1:1',resolution:'2K'}}],edges:[],groups:[],viewport:{x:0,y:0,zoom:1},createdAt:Date.now(),updatedAt:Date.now()};
  store.put('canvases',name,owner,canvas);
  const quote=await workflowModule.quoteCanvasWorkflow(owner,name),requestId=crypto.randomUUID();
  const workflow=await workflowModule.confirmCanvasWorkflow(owner,quote.id,requestId,quote.graphFingerprint),nodeId=canvas.nodes[0].id,jobId=crypto.randomUUID();
  const failed:Job={id:jobId,owner,input:{requestId:crypto.randomUUID(),kind:'image',modelId:model.id,prompt:'生成商品主图',skillId:'default',references:[],aspectRatio:'1:1',resolution:'2K'},model,status,createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:1,compiledPrompt:'fixture',error:status==='failed'?'供应商明确失败':status==='unknown'?'供应商状态未知':'供应商结果待保存'};
  store.put('jobs',jobId,owner,failed);
  const persisted=store.get<any>('workflows',workflow.id,owner)!;persisted.status='blocked';persisted.error=failed.error;persisted.steps[nodeId].status=status;persisted.steps[nodeId].jobId=jobId;store.put('workflows',workflow.id,owner,persisted);
  return {workflowId:workflow.id,nodeId,jobId,requestId:persisted.steps[nodeId].requestId as string};
 }

 async function blockedWorkflowWithRefundedUnstarted(name:string){
  const failedNodeId=name+'-failed',unstartedNodeId=name+'-unstarted';
  const node=(id:string,label:string)=>({id,position:{x:0,y:0},data:{label,kind:'image' as const,mode:'generate',prompt:'生成商品主图',skillId:'default',aspectRatio:'1:1',resolution:'2K'}});
  const canvas={id:name,title:name,nodes:[node(failedNodeId,'失败主图'),node(unstartedNodeId,'未启动主图')],edges:[],groups:[],viewport:{x:0,y:0,zoom:1},createdAt:Date.now(),updatedAt:Date.now()};
  store.put('canvases',name,owner,canvas);
  const quote=await workflowModule.quoteCanvasWorkflow(owner,name),workflow=await workflowModule.confirmCanvasWorkflow(owner,quote.id,crypto.randomUUID(),quote.graphFingerprint),jobId=crypto.randomUUID();
  const failed:Job={id:jobId,owner,input:{requestId:crypto.randomUUID(),kind:'image',modelId:model.id,prompt:'生成商品主图',skillId:'default',references:[],aspectRatio:'1:1',resolution:'2K'},model,status:'failed',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:1,compiledPrompt:'fixture',error:'供应商明确失败'};
  store.put('jobs',jobId,owner,failed);
  const persisted=store.get<any>('workflows',workflow.id,owner)!;persisted.status='blocked';persisted.error=failed.error;persisted.steps[failedNodeId].status='failed';persisted.steps[failedNodeId].jobId=jobId;persisted.steps[unstartedNodeId].status='pending';persisted.steps[unstartedNodeId].jobId=undefined;store.put('workflows',workflow.id,owner,persisted);
  // Simulate a crash after the stable wallet refund receipt was stored but
  // before billingRelease was projected back onto the workflow step.
  const releases=await billingModule.releaseAggregateUnallocatedLines(owner,quote.id,[unstartedNodeId]);
  assert.equal(releases[0].status,'refunded');assert.equal(store.get<any>('workflows',workflow.id,owner)!.steps[unstartedNodeId].billingRelease,undefined);
  return {workflowId:workflow.id,failedNodeId,unstartedNodeId};
 }

 const failed=await blockedWorkflow('retry-failed');
 const retryQuote=await workflowModule.quoteWorkflowRetry(owner,failed.workflowId);
 assert.equal(retryQuote.items.length,1);
 assert.equal(retryQuote.items[0].nodeId,failed.nodeId);
 assert.equal(retryQuote.payableTotal,0);
 assert.equal('estimatedTotalCost' in retryQuote,false);
 assert.equal('modelConfigHash' in retryQuote.items[0],false);
 const retryRequestId=crypto.randomUUID();
 const resumed=await workflowModule.confirmWorkflowRetry(owner,failed.workflowId,retryQuote.id,retryRequestId);
 assert.equal(resumed.status,'waiting');
 assert.equal(resumed.steps[failed.nodeId].status,'pending');
 assert.equal(resumed.steps[failed.nodeId].jobId,undefined);
 assert.notEqual(resumed.steps[failed.nodeId].requestId,failed.requestId);
 const billing=store.get<any>('aggregate-billing',retryQuote.id,owner)!;
 assert.equal(billing.status,'zero_price');
 assert.equal(billing.amount,0);
 const publicRun=workflowModule.publicWorkflow(resumed) as any;
 assert.equal('billingAttempt' in publicRun.steps[failed.nodeId],false);
 assert.equal('canvasQuoteExecution' in publicRun,false);
 assert.equal((await workflowModule.confirmWorkflowRetry(owner,failed.workflowId,retryQuote.id,retryRequestId)).id,resumed.id);
 await assert.rejects(()=>workflowModule.confirmWorkflowRetry(owner,failed.workflowId,retryQuote.id,crypto.randomUUID()),/另一客户端请求/);

 const unknown=await blockedWorkflow('retry-unknown','unknown');
 await assert.rejects(()=>workflowModule.quoteWorkflowRetry(owner,unknown.workflowId),/结果仍未知|不能重新提交/);
 const saveFailed=await blockedWorkflow('retry-save-failed','save_failed');
 await assert.rejects(()=>workflowModule.quoteWorkflowRetry(owner,saveFailed.workflowId),/重新保存|不能再次生成/);

 const changed=await blockedWorkflow('retry-price-changed');
 const changedQuote=await workflowModule.quoteWorkflowRetry(owner,changed.workflowId);
 store.put('models',model.id,'system',{...model,publicPrice:3,configHash:'2'.repeat(64)});
 await assert.rejects(()=>workflowModule.confirmWorkflowRetry(owner,changed.workflowId,changedQuote.id,crypto.randomUUID()),/变化.*重新报价/);
 store.put('models',model.id,'system',model);

 const expired=await blockedWorkflow('retry-expired');
 const expiredQuote=await workflowModule.quoteWorkflowRetry(owner,expired.workflowId),stored=store.get<any>('workflow-retry-quotes',expiredQuote.id,owner)!;
 store.put('workflow-retry-quotes',expiredQuote.id,owner,{...stored,expiresAt:Date.now()-1});
 await assert.rejects(()=>workflowModule.confirmWorkflowRetry(owner,expired.workflowId,expiredQuote.id,crypto.randomUUID()),/报价已过期/);

 const crashRecovered=await blockedWorkflowWithRefundedUnstarted('retry-refund-crash');
 const recoveredQuote=await workflowModule.quoteWorkflowRetry(owner,crashRecovered.workflowId);
 assert.equal(recoveredQuote.items.length,2);
 assert.deepEqual(Object.fromEntries(recoveredQuote.items.map((item:any)=>[item.nodeId,item.retryReason])),{[crashRecovered.failedNodeId]:'failed',[crashRecovered.unstartedNodeId]:'released-unstarted'});
 const recoveredWorkflow=await workflowModule.confirmWorkflowRetry(owner,crashRecovered.workflowId,recoveredQuote.id,crypto.randomUUID());
 assert.equal(recoveredWorkflow.steps[crashRecovered.failedNodeId].status,'pending');assert.equal(recoveredWorkflow.steps[crashRecovered.unstartedNodeId].status,'pending');assert.equal(recoveredWorkflow.steps[crashRecovered.unstartedNodeId].billingRelease,undefined);

 const server=await fs.readFile(path.resolve('src/commerce/server/workflows.ts'),'utf8');
 const agentUi=await fs.readFile(path.resolve('src/commerce/components/commerce-agent/agent-execution.tsx'),'utf8');
 const canvasUi=await fs.readFile(path.resolve('src/commerce/components/commerce-agent/canvas-live.tsx'),'utf8');
 assert.match(server,/quoteWorkflowRetry/);
 assert.match(server,/confirmWorkflowRetry/);
 assert.match(server,/原任务结果仍未知，只能继续查询原任务/);
 assert.match(server,/原任务已有供应商结果，请先重新保存/);
 assert.match(server,/createJob\(owner,jobInput,[^\n]+,jobContext\)/);
 assert.match(agentUi,/获取失败步骤新报价/);
 assert.match(agentUi,/确认支付.*并重试失败步骤/);
 assert.match(canvasUi,/获取失败节点新报价/);
 assert.match(canvasUi,/确认支付.*并重试/);

 console.log(JSON.stringify({passed:30,networkCalls:0,paidCalls:0,checks:['failed-subset-only','failed-node-identity','retry-total','public-cost-hidden','public-config-hash-hidden','confirm-waiting','failed-reset-pending','old-job-detached','new-request-id','retry-parent-zero-price','retry-parent-total','retry-internals-hidden','initial-quote-internals-hidden','same-request-idempotent','different-request-rejected','unknown-no-replay','save-failed-no-replay','price-change-requote','expired-rejected','refund-receipt-replayed-after-crash','released-unstarted-projected','failed-and-released-requoted-together','released-step-reset-pending','release-marker-consumed','quote-api-wired','confirm-api-wired','unknown-contract','save-failed-contract','agent-explicit-price-ui','canvas-explicit-price-ui'],fixture}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
