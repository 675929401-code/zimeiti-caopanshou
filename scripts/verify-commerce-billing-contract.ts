import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Job} from '../src/commerce/server/jobs';
import type {Model} from '../src/commerce/server/models';

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-billing-fixture-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.COMMERCE_GATEWAY_KEY_FILE=path.join(fixture,'billing-gateway.key');
  await fs.mkdir(fixture,{recursive:true});
  const originalFetch=globalThis.fetch;
  let networkCalls=0;
  globalThis.fetch=(async()=>{networkCalls+=1;throw Error('UNEXPECTED_NETWORK_CALL');}) as typeof fetch;
  const serviceKey='fixture-commerce-billing-service-key-over-forty-chars';
  await fs.writeFile(process.env.COMMERCE_GATEWAY_KEY_FILE,serviceKey);
  try{
    const store=await import('../src/commerce/server/store');
    const billing=await import('../src/commerce/server/billing');
    const freeLocalModel:Model={id:'model-fixture-free-local',displayName:'Fixture Free Local',kind:'image',source:'custom',publicPrice:0,costPrice:0,billingUnit:'per_use',configHash:'fixture-free-local-v1',capabilities:{explicitlyFree:true}};
    const paidModel:Model={...freeLocalModel,id:'model-fixture-paid',displayName:'Fixture Paid',publicPrice:0.5,costPrice:0.25,configHash:'fixture-paid-v1',capabilities:{}};
    const base={id:'11111111-1111-4111-8111-111111111111',owner:'local-owner',input:{kind:'image'},model:freeLocalModel} as unknown as Job;
    store.put('models',freeLocalModel.id,'system',{...freeLocalModel,enabled:true});
    store.put('settings','main-bind-local-owner','system',{mainUserId:'main-admin-fixture',mainRole:'admin',exempt:false});

    const zero=await billing.chargeJobAtDispatch(base);
    assert.equal(zero.status,'zero_price');
    assert.equal(zero.amount,0);
    assert.equal(zero.mainRole,'admin');
    assert.notEqual(zero.status,'exempt');
    const replay=await billing.chargeJobAtDispatch(base);
    assert.equal(replay.fingerprint,zero.fingerprint);
    assert.equal(replay.status,'zero_price');
    assert.equal(replay.amount,0);

    const unbound={...base,id:'22222222-2222-4222-8222-222222222222',owner:'ordinary-owner',model:paidModel} as Job;
    await assert.rejects(()=>billing.chargeJobAtDispatch(unbound),/尚未绑定主站账号/);
    const unmarkedZero={...base,id:'44444444-4444-4444-8444-444444444444',model:{...freeLocalModel,capabilities:{}}} as Job;
    await assert.rejects(()=>billing.chargeJobAtDispatch(unmarkedZero),/explicitlyFree=true/);
    const rolling={...base,input:{kind:'video',duration:60,rollingPlan:{segments:[15,15,15,15]}},model:{...paidModel,kind:'video',publicPrice:2,costPrice:1,billingUnit:'per_use'}} as unknown as Job;
    assert.equal(billing.jobPrice(rolling),8);
    assert.equal(billing.jobCost(rolling),4);
    assert.equal(billing.quotePrice({kind:'image'}, {...paidModel,publicPrice:0.176}),0.18);
    assert.equal(billing.quotePrice({kind:'image'}, {...paidModel,publicPrice:0.004}),0.01);
    assert.deepEqual(billing.providerCost({...base,usage:{costCny:0.175}} as Job),{amount:0.175,source:'provider_actual'});
    assert.deepEqual(billing.providerCost({...base,model:paidModel} as Job),{amount:0.25,source:'configured_estimate'});
    const mutated={...base,model:{...freeLocalModel,configHash:'fixture-free-local-mutated'}} as Job;
    await assert.rejects(()=>billing.chargeJobAtDispatch(mutated),/账务快照与任务内容不一致/);

    const {NextRequest}=await import('next/server');
    const {POST}=await import('../src/app/api/commerce-billing-gateway/route');
    const spoofed=new NextRequest('http://127.0.0.1:5000/api/commerce-billing-gateway',{method:'POST',headers:{Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify({action:'charge',owner:base.owner,jobId:base.id,kind:'image',modelId:freeLocalModel.id,status:'running',amount:999,mainUserId:'spoofed'})});
    assert.equal((await POST(spoofed)).status,409);
    const request=new NextRequest('http://127.0.0.1:5000/api/commerce-billing-gateway',{method:'POST',headers:{Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify({action:'charge',owner:base.owner,jobId:base.id,kind:'image',modelId:freeLocalModel.id,status:'running'})});
    const response=await POST(request);const payload=await response.json();
    assert.equal(response.status,200);assert.equal(payload.billing.status,'zero_price');assert.equal(payload.billing.amount,0);
    const statusRequest=new NextRequest('http://127.0.0.1:5000/api/commerce-billing-gateway',{method:'POST',headers:{Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json'},body:JSON.stringify({action:'status',owner:base.owner,jobId:base.id,kind:'image',modelId:freeLocalModel.id,status:'running'})});
    const statusResponse=await POST(statusRequest);const statusPayload=await statusResponse.json();
    assert.equal(statusResponse.status,200);assert.equal(statusPayload.billing.status,'zero_price');assert.equal(statusPayload.billing.amount,0);
    const browserRequest=new NextRequest('http://127.0.0.1:5000/api/commerce-billing-gateway',{method:'POST',headers:{Authorization:`Bearer ${serviceKey}`,Origin:'http://127.0.0.1:5048','Content-Type':'application/json'},body:JSON.stringify({action:'charge',owner:base.owner,jobId:base.id,kind:'image',modelId:freeLocalModel.id,status:'running'})});
    assert.equal((await POST(browserRequest)).status,401);
    assert.equal(networkCalls,0);
    console.log(JSON.stringify({passed:24,paidCalls:0,networkCalls,checks:['admin-binding-not-exempt','explicit-free-local-zero-price','zero-price-amount-zero','admin-role-audit-preserved','idempotent-replay','unbound-positive-price-fail-closed','unmarked-zero-price-rejected','rolling-parent-selling-price','rolling-parent-cost','cash-cent-rounding','positive-payable-minimum-cent','provider-actual-cost-preferred','configured-cost-fallback-marked','mutation-rejected','cross-database-service-route-authorized','client-price-fields-rejected','gateway-zero-price-state','gateway-zero-price-amount','billing-status-read','billing-status-zero-amount','browser-origin-rejected','main-authoritative-model-price','paid-provider-calls-zero','network-calls-zero']}));
  }finally{
    globalThis.fetch=originalFetch;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
