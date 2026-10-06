import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

type JsonRecord=Record<string,unknown>;

const checks:string[]=[];
function check(name:string,work:()=>void){work();checks.push(name);}
async function checkAsync(name:string,work:()=>Promise<void>){await work();checks.push(name);}

async function main(){
  const root=path.resolve(import.meta.dirname,'..');
  const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-member-billing-lifecycle-'));
  const moduleRoot=path.join(tempRoot,'module');
  await fs.mkdir(moduleRoot,{recursive:true});
  let networkCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{networkCalls+=1;throw Error('NETWORK_FORBIDDEN_IN_MEMBER_BILLING_VERIFIER');};

  try{
    const productionSource=await fs.readFile(path.join(root,'src/commerce/server/billing.ts'),'utf8');
    const isolatedSource=productionSource
      .replace("from '@/lib/billing'","from './wallet-stub.ts'")
      .replace("from '@/lib/revenue'","from './revenue-stub.ts'")
      .replace("from './store'","from './store-stub.ts'");
    assert.notEqual(isolatedSource,productionSource,'隔离模块替换没有生效');
    await fs.writeFile(path.join(moduleRoot,'billing-under-test.ts'),isolatedSource,'utf8');
    await fs.writeFile(path.join(moduleRoot,'store-stub.ts'),`
      type Row={owner:string;value:unknown};
      const rows=new Map<string,Row>();
      let failChargedWrites={bucket:'billing',count:0};
      const key=(bucket:string,id:string)=>bucket+'\\u0000'+id;
      export function put(bucket:string,id:string,owner:string,value:unknown){
        const row=value as {status?:string};
        if(bucket===failChargedWrites.bucket&&row?.status==='charged'&&failChargedWrites.count>0){failChargedWrites.count-=1;throw Error('FIXTURE_FINAL_RECEIPT_WRITE_FAILED');}
        const existing=rows.get(key(bucket,id));
        if(existing&&existing.owner!==owner)return;
        rows.set(key(bucket,id),{owner,value:structuredClone(value)});
      }
      export function get<T>(bucket:string,id:string,owner:string):T|undefined{
        const row=rows.get(key(bucket,id));return row?.owner===owner?structuredClone(row.value) as T:undefined;
      }
      export function remove(bucket:string,id:string,owner:string){const row=rows.get(key(bucket,id));if(row?.owner===owner)rows.delete(key(bucket,id));}
      export function transaction<T>(work:()=>T){return work();}
      export function __reset(){rows.clear();failChargedWrites={bucket:'billing',count:0};}
      export function __failNextChargedWrite(bucket='billing',count=1){failChargedWrites={bucket,count};}
    `,'utf8');
    await fs.writeFile(path.join(moduleRoot,'wallet-stub.ts'),`
      type Operation={kind:'cash_charge'|'cash_refund';key:string;userId:string;amount:number;balanceAfter:number;operationId:string};
      const balances=new Map<string,number>();
      const operations=new Map<string,Operation>();
      const opKey=(kind:string,key:string)=>kind+':'+key;
      export function __reset(userId='member-main-user',balance=100){balances.clear();operations.clear();balances.set(userId,balance);}
      export function __snapshot(){return {balances:Object.fromEntries(balances),operations:[...operations.values()].map(row=>({...row}))};}
      async function apply(kind:'cash_charge'|'cash_refund',userId:string,amount:number,key:string){
        await Promise.resolve();
        const stable=opKey(kind,key),existing=operations.get(stable);
        if(existing){if(existing.userId!==userId||existing.amount!==amount)throw Error('FIXTURE_IDEMPOTENCY_CONFLICT');return {success:true,balanceAfter:existing.balanceAfter,alreadyFulfilled:true,operationId:existing.operationId};}
        const current=balances.get(userId)??0;
        if(kind==='cash_charge'&&current<amount)return {success:false,balanceAfter:current,error:'INSUFFICIENT_BALANCE'};
        const balanceAfter=kind==='cash_charge'?current-amount:current+amount;
        balances.set(userId,balanceAfter);
        const row={kind,key,userId,amount,balanceAfter,operationId:'fixture-op-'+(operations.size+1)};
        operations.set(stable,row);
        return {success:true,balanceAfter,alreadyFulfilled:false,operationId:row.operationId};
      }
      export async function deductCash(userId:string,amount:number,_description:string,key:string){const result=await apply('cash_charge',userId,amount,key);return {...result,deductedAmount:result.success&&!result.alreadyFulfilled?amount:0};}
      export async function refundCash(userId:string,amount:number,_description:string,key:string){return apply('cash_refund',userId,amount,key);}
    `,'utf8');
    await fs.writeFile(path.join(moduleRoot,'revenue-stub.ts'),`
      type Revenue={userId:string;userRole:'admin'|'student';modelId:string;taskId?:string;costPrice:number;sellingPrice:number;recordType?:string;creditsCharged?:number;cashCharged?:number};
      const rows=new Map<string,Revenue>();
      export function __reset(){rows.clear();}
      export function __snapshot(){return [...rows.values()].map(row=>({...row}));}
      export async function recordRevenue(input:Revenue){
        const key=String(input.taskId||'')+':'+String(input.recordType||'video'),existing=rows.get(key);
        if(existing){if(JSON.stringify(existing)!==JSON.stringify(input))throw Error('FIXTURE_REVENUE_IDEMPOTENCY_CONFLICT');return;}
        rows.set(key,{...input});
      }
    `,'utf8');

    const nonce='?run='+Date.now();
    const billing=await import(pathToFileURL(path.join(moduleRoot,'billing-under-test.ts')).href+nonce);
    const store=await import(pathToFileURL(path.join(moduleRoot,'store-stub.ts')).href);
    const wallet=await import(pathToFileURL(path.join(moduleRoot,'wallet-stub.ts')).href);
    const revenue=await import(pathToFileURL(path.join(moduleRoot,'revenue-stub.ts')).href);
    const owner='ordinary-member-owner',mainUserId='member-main-user';
    const model={id:'member-image-model',displayName:'普通会员图片模型',kind:'image',source:'main',enabled:true,publicPrice:3.2,costPrice:1.1,billingUnit:'per_use',configHash:'member-image-v1',capabilities:{available:true}};
    const makeJob=(id:string,status='running',overrides:JsonRecord={})=>({
      id,owner,input:{requestId:id,kind:'image',modelId:model.id,prompt:'fixture',aspectRatio:'1:1',resolution:'1K',references:[]},
      model:{...model},status,createdAt:1,updatedAt:1,assetIds:[],promptVersion:1,compiledPrompt:'fixture',...overrides,
    });
    const makeAggregateQuote=(id:string)=>({
      id,owner,payableTotal:5,estimatedTotalCost:3,
      items:[
        {key:'image-step',kind:'image',modelId:'member-image-model',modelConfigHash:'member-image-v1',billingUnit:'per_use',quantity:1,estimatedTotalCost:1,payableTotal:2},
        {key:'video-step',kind:'video',modelId:'member-video-model',modelConfigHash:'member-video-v1',billingUnit:'output_second',quantity:3,estimatedTotalCost:2,payableTotal:3},
      ],
    });
    const reset=(balance=100)=>{store.__reset();wallet.__reset(mainUserId,balance);revenue.__reset();store.put('settings','main-bind-'+owner,'system',{mainUserId});};

    reset();
    const successJob=makeJob('10000000-0000-4000-8000-000000000001');
    const charged=await billing.chargeJobAtDispatch(successJob);
    check('ordinary-member-precharge',()=>{assert.equal(charged.status,'charged');assert.equal(charged.amount,3.2);assert.equal(charged.costAmount,1.1);assert.equal(charged.profitAmount,2.1);assert.equal(charged.mainUserId,mainUserId);});
    check('stable-charge-key',()=>assert.equal(charged.chargeKey,`commerce-job-${successJob.id}`));
    await checkAsync('idempotent-charge-replay',async()=>{const replay=await billing.chargeJobAtDispatch(successJob);assert.equal(replay.walletOperationId,charged.walletOperationId);assert.equal(wallet.__snapshot().operations.length,1);});
    await checkAsync('immutable-price-snapshot',async()=>{await assert.rejects(()=>billing.chargeJobAtDispatch({...successJob,model:{...successJob.model,publicPrice:3.3}}),/账务快照与任务内容不一致/);});
    const succeeded={...successJob,status:'succeeded',usage:{costCny:0.9}};
    const settled=await billing.recordJobRevenue(succeeded);
    check('success-revenue-cost-profit',()=>{assert.equal(settled.status,'revenue_recorded');assert.equal(settled.amount,3.2);assert.equal(settled.costAmount,0.9);assert.equal(settled.profitAmount,2.3);});
    check('ordinary-member-revenue-role',()=>{const rows=revenue.__snapshot();assert.equal(rows.length,1);assert.equal(rows[0].userRole,'student');assert.equal(rows[0].cashCharged,3.2);});
    await checkAsync('idempotent-revenue-replay',async()=>{await billing.recordJobRevenue(succeeded);assert.equal(revenue.__snapshot().length,1);});

    reset();
    const concurrentRevenueJob=makeJob('11000000-0000-4000-8000-000000000011');
    await billing.chargeJobAtDispatch(concurrentRevenueJob);
    const concurrentRevenue=await Promise.all([
      billing.recordJobRevenue({...concurrentRevenueJob,status:'succeeded',usage:{costCny:0.4}}),
      billing.recordJobRevenue({...concurrentRevenueJob,status:'succeeded',usage:{costCny:0.8}}),
    ]);
    check('concurrent-revenue-uses-frozen-pending-cost',()=>{assert.ok(concurrentRevenue.every((row:JsonRecord)=>row.status==='revenue_recorded'));const rows=revenue.__snapshot();assert.equal(rows.length,1);assert.equal(rows[0].costPrice,0.4);});

    reset();
    const failedJob=makeJob('20000000-0000-4000-8000-000000000002','running');
    await billing.chargeJobAtDispatch(failedJob);
    const refunded=await billing.refundFailedJob({...failedJob,status:'failed'});
    check('confirmed-failure-refund',()=>{assert.equal(refunded.status,'refunded');assert.equal(wallet.__snapshot().balances[mainUserId],100);assert.equal(wallet.__snapshot().operations.length,2);});
    await checkAsync('idempotent-refund-replay',async()=>{await billing.refundFailedJob({...failedJob,status:'failed'});assert.equal(wallet.__snapshot().operations.length,2);});

    reset();
    const unknownJob=makeJob('30000000-0000-4000-8000-000000000003','unknown');
    await billing.chargeJobAtDispatch({...unknownJob,status:'running'});
    await checkAsync('unknown-keeps-precharge',async()=>{await assert.rejects(()=>billing.refundFailedJob(unknownJob),/只有明确失败/);assert.equal(wallet.__snapshot().balances[mainUserId],96.8);assert.equal(wallet.__snapshot().operations.length,1);});
    const saveFailedJob=makeJob('40000000-0000-4000-8000-000000000004','save_failed',{providerUrl:'https://fixture.invalid/original.png'});
    await billing.chargeJobAtDispatch({...saveFailedJob,status:'running'});
    await checkAsync('save-failed-keeps-precharge',async()=>{await assert.rejects(()=>billing.refundFailedJob(saveFailedJob),/只有明确失败/);assert.equal(wallet.__snapshot().balances[mainUserId],93.6);assert.equal(wallet.__snapshot().operations.length,2);});
    const jobsSource=await fs.readFile(path.join(root,'src/commerce/server/jobs.ts'),'utf8');
    const retrySaveSource=jobsSource.slice(jobsSource.indexOf('export async function recoverSavingJob'));
    check('save-failed-reuses-original-result',()=>{assert.match(retrySaveSource,/current\.providerUrl/);assert.match(retrySaveSource,/complete\(current/);assert.match(jobsSource,/readIdempotentAsset\(value\.owner,assetKey\)/);assert.doesNotMatch(retrySaveSource,/createJob\(/);});
    check('unknown-polls-without-repost',()=>assert.match(jobsSource,/Keep the original request; never dispatch it again on poll failure/));

    reset();
    const recoveryJob=makeJob('50000000-0000-4000-8000-000000000005');
    store.__failNextChargedWrite();
    await checkAsync('post-wallet-local-save-failure-detected',async()=>{await assert.rejects(()=>billing.chargeJobAtDispatch(recoveryJob),/钱包预扣已确认，但本地回执保存失败/);const pending=store.get('billing',recoveryJob.id,owner);assert.equal(pending.status,'charge_pending');assert.equal(wallet.__snapshot().operations.length,1);assert.equal(wallet.__snapshot().balances[mainUserId],96.8);});
    const recovered=await billing.chargeJobAtDispatch(recoveryJob);
    check('stable-key-receipt-recovery',()=>{assert.equal(recovered.status,'charged');assert.equal(recovered.alreadyFulfilled,true);assert.equal(wallet.__snapshot().operations.length,1);assert.equal(wallet.__snapshot().balances[mainUserId],96.8);});

    reset();
    const recoveryRefundJob=makeJob('60000000-0000-4000-8000-000000000006');
    store.__failNextChargedWrite();
    await assert.rejects(()=>billing.chargeJobAtDispatch(recoveryRefundJob),/本地回执保存失败/);
    const recoveredRefund=await billing.refundFailedJob({...recoveryRefundJob,status:'failed'});
    check('pending-charge-resolved-before-refund',()=>{const snapshot=wallet.__snapshot();assert.equal(recoveredRefund.status,'refunded');assert.equal(snapshot.operations.length,2);assert.equal(snapshot.balances[mainUserId],100);});

    reset();
    const concurrentJob=makeJob('70000000-0000-4000-8000-000000000007');
    const concurrent=await Promise.all(Array.from({length:12},()=>billing.chargeJobAtDispatch(concurrentJob)));
    check('concurrent-charge-exactly-once',()=>{assert.equal(concurrent.length,12);assert.ok(concurrent.every((row:JsonRecord)=>row.status==='charged'));assert.equal(wallet.__snapshot().operations.length,1);assert.equal(wallet.__snapshot().balances[mainUserId],96.8);});

    reset();
    const aggregateQuote=makeAggregateQuote('a0000000-0000-4000-8000-000000000001');
    const aggregate=await billing.chargeAggregateQuoteAtConfirm(aggregateQuote,'普通会员父报价');
    check('ordinary-member-aggregate-precharge',()=>{assert.equal(aggregate.status,'charged');assert.equal(aggregate.amount,5);assert.equal(aggregate.costAmount,3);assert.equal(aggregate.profitAmount,2);assert.equal(aggregate.mainUserId,mainUserId);assert.equal(wallet.__snapshot().balances[mainUserId],95);});
    check('stable-aggregate-charge-key',()=>assert.equal(aggregate.chargeKey,`commerce-aggregate-${aggregateQuote.id}`));
    await checkAsync('aggregate-idempotent-replay-and-immutable-snapshot',async()=>{const replay=await billing.chargeAggregateQuoteAtConfirm(aggregateQuote,'普通会员父报价重放');assert.equal(replay.walletOperationId,aggregate.walletOperationId);assert.equal(wallet.__snapshot().operations.length,1);await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm({...aggregateQuote,payableTotal:6},'篡改父报价'),/合计|不一致/);});

    reset();
    const aggregateRecoveryQuote=makeAggregateQuote('a0000000-0000-4000-8000-000000000002');
    store.__failNextChargedWrite('aggregate-billing');
    await checkAsync('aggregate-post-wallet-local-save-failure-detected',async()=>{await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm(aggregateRecoveryQuote,'父报价回执故障'),/父报价钱包预扣已确认，但本地回执保存失败/);const pending=store.get('aggregate-billing',aggregateRecoveryQuote.id,owner);assert.equal(pending.status,'charge_pending');assert.equal(wallet.__snapshot().operations.length,1);assert.equal(wallet.__snapshot().balances[mainUserId],95);});
    const recoveredAggregate=await billing.chargeAggregateQuoteAtConfirm(aggregateRecoveryQuote,'父报价回执恢复');
    check('aggregate-stable-key-receipt-recovery',()=>{assert.equal(recoveredAggregate.status,'charged');assert.equal(recoveredAggregate.alreadyFulfilled,true);assert.equal(wallet.__snapshot().operations.length,1);assert.equal(wallet.__snapshot().balances[mainUserId],95);});

    reset();
    const concurrentAggregateQuote=makeAggregateQuote('a0000000-0000-4000-8000-000000000003');
    const concurrentAggregates=await Promise.all(Array.from({length:12},()=>billing.chargeAggregateQuoteAtConfirm(concurrentAggregateQuote,'父报价并发')));
    check('concurrent-aggregate-charge-exactly-once',()=>{assert.equal(concurrentAggregates.length,12);assert.ok(concurrentAggregates.every((row:JsonRecord)=>row.status==='charged'));assert.equal(wallet.__snapshot().operations.length,1);assert.equal(wallet.__snapshot().balances[mainUserId],95);});

    reset();
    const aggregateRefundQuote=makeAggregateQuote('a0000000-0000-4000-8000-000000000004');
    store.__failNextChargedWrite('aggregate-billing');
    await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm(aggregateRefundQuote,'父报价退款前故障'),/本地回执保存失败/);
    const aggregateRefund=await billing.refundAggregateQuoteBeforeDispatch(owner,aggregateRefundQuote.id);
    check('aggregate-pending-resolved-before-refund',()=>{const snapshot=wallet.__snapshot();assert.equal(aggregateRefund.status,'refunded');assert.equal(snapshot.operations.length,2);assert.equal(snapshot.balances[mainUserId],100);});

    reset(1);
    const insufficientAggregateQuote=makeAggregateQuote('a0000000-0000-4000-8000-000000000005');
    await checkAsync('definite-aggregate-charge-failure-clears-intent',async()=>{await assert.rejects(()=>billing.chargeAggregateQuoteAtConfirm(insufficientAggregateQuote,'余额不足父报价'),/钱包扣费失败/);assert.equal(store.get('aggregate-billing',insufficientAggregateQuote.id,owner),undefined);assert.equal(wallet.__snapshot().operations.length,0);assert.equal(wallet.__snapshot().balances[mainUserId],1);});

    reset();
    const freeJob=makeJob('80000000-0000-4000-8000-000000000008','running',{model:{...model,publicPrice:0,costPrice:0.25,capabilities:{available:true,explicitlyFree:true}}});
    const freeState=await billing.chargeJobAtDispatch(freeJob);
    check('explicit-free-keeps-member-snapshot',()=>{assert.equal(freeState.status,'zero_price');assert.equal(freeState.mainUserId,mainUserId);});
    const freeRevenue=await billing.recordJobRevenue({...freeJob,status:'succeeded'});
    check('explicit-free-revenue-recordable',()=>{assert.equal(freeRevenue.status,'revenue_recorded');assert.equal(revenue.__snapshot().length,1);assert.equal(revenue.__snapshot()[0].userId,mainUserId);});

    reset(1);
    const insufficient=makeJob('90000000-0000-4000-8000-000000000009');
    await checkAsync('definite-charge-failure-clears-intent',async()=>{await assert.rejects(()=>billing.chargeJobAtDispatch(insufficient),/钱包扣费失败/);assert.equal(store.get('billing',insufficient.id,owner),undefined);assert.equal(wallet.__snapshot().operations.length,0);assert.equal(wallet.__snapshot().balances[mainUserId],1);});

    check('network-blocked',()=>assert.equal(networkCalls,0));
    const output={
      schemaVersion:'commerce-member-billing-lifecycle-verification/v1',
      passed:checks.length,
      checks,
      ordinaryMember:true,
      aggregateParent:true,
      isolatedTempData:true,
      networkCalls,
      providerCalls:0,
      paidCalls:0,
      productionDatabasesMutated:0,
      sourceUnderTest:'src/commerce/server/billing.ts',
    };
    await fs.rm(tempRoot,{recursive:true,force:true});
    console.log(JSON.stringify({...output,tempDataRemoved:true}));
  }finally{
    globalThis.fetch=originalFetch;
    await fs.rm(tempRoot,{recursive:true,force:true}).catch(()=>undefined);
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
