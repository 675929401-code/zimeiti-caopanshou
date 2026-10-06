import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-quote-fixture-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  await fs.mkdir(fixture,{recursive:true});
  const store=await import('../src/commerce/server/store');
  const billing=await import('../src/commerce/server/billing');
  const quotes=await import('../src/commerce/server/quotes');
  const jobs=await import('../src/commerce/server/jobs');
  const rolling=await import('../src/commerce/server/rolling-video');
  const model={
    id:'video-fixture',displayName:'Video Fixture',kind:'video' as const,source:'custom' as const,enabled:true,
    publicPrice:2,costPrice:1,billingUnit:'per_use' as const,configHash:'c'.repeat(64),verifiedAt:Date.now(),
    protocol:'secure-video',endpoint:'https://example.invalid',capabilities:{available:true,nativeDurations:[15],durationOptions:[15],aspectRatios:['9:16'],resolutionOptions:['720p'],maxReferenceImages:2},
  };
  store.put('settings','main-model-source','system',{enabled:false});
  store.put('settings','defaults','system',{video:model.id});
  store.put('models',model.id,'system',model);

  assert.deepEqual(rolling.planSegments(60,[4,5,6,7,8,9,10,11,12,13,14,15]),[15,15,15,15]);
  assert.deepEqual(rolling.planSegments(20,[4,5,6,7,8,9,10,11,12,13,14,15]),[10,10]);
  assert.deepEqual(rolling.planSegments(20,[8,10]),[10,10]);
  assert.equal(rolling.planSegments(25,[8,10]),null);

  const planned={kind:'video' as const,duration:60,rollingPlan:{segments:[15,15,15,15]}};
  assert.equal(billing.billingQuantity(planned,model),4);
  assert.equal(billing.quotePrice(planned,model),8);
  assert.equal(billing.quoteCost(planned,model),4);
  assert.equal(billing.billingQuantity(planned,{billingUnit:'output_second'}),60);
  assert.equal(jobs.jobOwnsWalletCharge({input:{...planned,requestId:'11111111-1111-4111-8111-111111111111',modelId:model.id,prompt:'parent'}}),true);
  assert.equal(jobs.jobOwnsWalletCharge({input:{...planned,requestId:'11111111-1111-4111-8111-111111111112',modelId:model.id,prompt:'child',rollingChild:true}}),false);

  const input={kind:'video',modelId:model.id,prompt:'固定商品主体，连续展示四段。',duration:60,aspectRatio:'9:16',resolution:'720p'};
  const quote=await quotes.createCommerceQuote('quote-owner',input);
  assert.deepEqual({quantity:quote.quantity,payableTotal:quote.payableTotal,billingUnit:quote.billingUnit},{quantity:4,payableTotal:8,billingUnit:'per_use'});
  assert.equal('unitCost' in quote,false);
  assert.equal('modelConfigHash' in quote,false);
  await assert.rejects(()=>quotes.createCommerceQuote('quote-owner',{...input,amount:0}),/无权指定|不支持/);

  const clientRequestId='22222222-2222-4222-8222-222222222222';
  const created=await quotes.confirmCommerceQuote('quote-owner',{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint});
  assert.deepEqual(created.input.rollingPlan?.segments,[15,15,15,15]);
  assert.equal(created.configurationSnapshot?.quoteId,quote.id);
  assert.equal(created.configurationSnapshot?.clientRequestId,clientRequestId);
  assert.deepEqual(created.configurationSnapshot?.modelSelection,store.get<Record<string,any>>('commerce-quotes',quote.id,'quote-owner')?.modelSelection);
  const replay=await quotes.confirmCommerceQuote('quote-owner',{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint});
  assert.equal(replay.id,created.id);
  await assert.rejects(()=>quotes.confirmCommerceQuote('quote-owner',{quoteId:quote.id,clientRequestId:'33333333-3333-4333-8333-333333333333',inputFingerprint:quote.inputFingerprint}),/另一客户端请求/);
  console.log(JSON.stringify({passed:19,paidCalls:0,checks:['current-model-four-by-fifteen','balanced-twenty-second-plan','discrete-duration-plan','unsupported-discrete-total-rejected','per-use-segment-quantity','per-use-aggregate-price','per-use-aggregate-cost','per-second-duration-quantity','parent-owns-wallet-charge','rolling-child-does-not-own-wallet-charge','server-route-model','sixty-second-plan','public-cost-hidden','public-hash-hidden','client-amount-rejected','quote-confirmed','job-snapshot-bound','same-client-idempotent','different-client-rejected'],fixture}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
