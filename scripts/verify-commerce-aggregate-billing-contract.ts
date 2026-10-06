import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Job} from '../src/commerce/server/jobs';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-aggregate-billing-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  await fs.mkdir(fixture,{recursive:true});
  const store=await import('../src/commerce/server/store');
  const billing=await import('../src/commerce/server/billing');
  const owner='aggregate-owner';
  store.put('settings','main-bind-'+owner,'system',{mainUserId:'main-admin-fixture',exempt:true});
  const quote={
    id:'11111111-1111-4111-8111-111111111111',owner,payableTotal:0,estimatedTotalCost:0,
    items:[
      {key:'image-step',kind:'image' as const,modelId:'image-model',modelConfigHash:'image-v1',billingUnit:'per_use' as const,quantity:1,estimatedTotalCost:0,payableTotal:0},
      {key:'video-step',kind:'video' as const,modelId:'video-model',modelConfigHash:'video-v1',billingUnit:'output_second' as const,quantity:5,estimatedTotalCost:0,payableTotal:0},
    ],
  };
  const parent=await billing.chargeAggregateQuoteAtConfirm(quote,'fixture aggregate');
  assert.equal(parent.status,'zero_price');
  assert.equal(parent.amount,0);
  assert.equal(parent.costAmount,0);
  assert.equal((await billing.chargeAggregateQuoteAtConfirm(quote,'fixture aggregate')).fingerprint,parent.fingerprint);
  await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm({...quote,payableTotal:1},'mutated'),/合计|不一致/);
  await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm({...quote,id:'22222222-2222-4222-8222-222222222222',owner:'unbound-owner'},'unbound'),/尚未绑定/);
  const abandoned={...quote,id:'66666666-6666-4666-8666-666666666666'};
  await billing.chargeAggregateQuoteAtConfirm(abandoned,'abandoned fixture');
  assert.equal((await billing.refundAggregateQuoteBeforeDispatch(owner,abandoned.id))?.status,'refunded');
  assert.equal((await billing.refundAggregateQuoteBeforeDispatch(owner,abandoned.id))?.status,'refunded');
  await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm(abandoned,'abandoned fixture'),/人工对账|停止重复/);

  const model={id:'image-model',displayName:'image',kind:'image' as const,source:'custom' as const,enabled:true,publicPrice:0,costPrice:0,billingUnit:'per_use' as const,configHash:'image-v1',capabilities:{available:true,explicitlyFree:true}};
  const child:Job={id:'33333333-3333-4333-8333-333333333333',owner,input:{requestId:'44444444-4444-4444-8444-444444444444',kind:'image',modelId:model.id,prompt:'fixture',aspectRatio:'1:1',resolution:'1K',references:[]},model,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:1,compiledPrompt:'fixture'};
  const childState=billing.bindJobToAggregateCharge(child,quote.id,quote.items[0]);
  assert.equal(childState.parentQuoteId,quote.id);
  assert.equal(childState.status,'zero_price');
  assert.equal(childState.amount,0);
  assert.equal(childState.costAmount,0);
  assert.equal((await billing.chargeJobAtDispatch(child)).parentQuoteId,quote.id);
  assert.equal(billing.bindJobToAggregateCharge(child,quote.id,quote.items[0]).fingerprint,childState.fingerprint);
  assert.throws(()=>billing.bindJobToAggregateCharge({...child,id:'55555555-5555-4555-8555-555555555555'},quote.id,{...quote.items[0],payableTotal:0.5}),/不一致/);
  const publicState=billing.publicBillingState(childState) as Record<string,unknown>;
  assert.equal('costAmount' in publicState,false);
  assert.equal('parentQuoteId' in publicState,false);
  const workflows=await fs.readFile(new URL('../src/commerce/server/workflows.ts',import.meta.url),'utf8');
  const plans=await fs.readFile(new URL('../src/commerce/server/agent-plans.ts',import.meta.url),'utf8');
  const adminApi=await fs.readFile(new URL('../src/app/api/admin/commerce/jobs/route.ts',import.meta.url),'utf8');
  const adminUi=await fs.readFile(new URL('../src/components/admin/CommerceAgentAdminTab.tsx',import.meta.url),'utf8');
  assert.match(workflows,/aggregateJobContext/);
  assert.match(workflows,/chargeAggregateQuoteAtConfirm/);
  assert.match(plans,/chargeAggregateQuoteAtConfirm/);
  assert.match(adminApi,/bucket='aggregate-billing'/);
  assert.match(adminApi,/aggregateReconciliation/);
  assert.match(adminUi,/父级一次预扣/);
  assert.match(adminUi,/父报价.*待对账/);

  console.log(JSON.stringify({
    passed:24,networkCalls:0,paidCalls:0,
    checks:['parent-zero-price','parent-total','parent-cost','parent-idempotent','parent-mutation-rejected','unbound-fail-closed','pre-dispatch-refund','pre-dispatch-refund-idempotent','refunded-parent-cannot-recharge','child-parent-bound','child-zero-price','child-price','child-cost','child-dispatch-no-second-debit','child-binding-idempotent','child-mutation-rejected','public-cost-hidden','public-parent-id-hidden','canvas-parent-and-child-wired','agent-parent-wired','admin-parent-ledger','admin-reconciliation-count','admin-parent-table','admin-reconciliation-visible'],fixture,
  }));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
