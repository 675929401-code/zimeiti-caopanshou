import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-voice-admin-reconcile-'));
  process.env.COMMERCE_DATA_DIR=fixture;Reflect.set(process.env,'NODE_ENV','test');
  let close:(()=>void)|undefined,refunds=0,revenues=0,providerCalls=0;const checks:string[]=[];
  const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);};
  try{
    const store=await import('../src/commerce/server/store');close=()=>{(store.db() as unknown as {close:()=>void}).close();};
    const bridge=await import('../src/commerce/server/voice-bridge');const jobs=await import('../src/commerce/server/voice-jobs');const assets=await import('../src/commerce/server/assets');
    bridge.setCommerceVoiceBridgeForTesting({
      catalog:()=>[{id:'voice-a',adminId:'voice-a',name:'测试音色',speakerId:'speaker-a',engine:'volcano',isActive:true}],
      pricing:(characters,modelId)=>({charCount:characters,pricing:{id:'p',name:'TTS',modelId,totalPrice:1,totalChars:1000,costPrice:0.01,unit:'千字符',profitMargin:100,isActive:true},sellPriceRmb:0.02,costPriceRmb:0.01,profitRmb:0.01,creditsToCharge:1}),
      providerSnapshot:async()=>({configured:true,source:'test',credentialFingerprint:'fixed'}),
      acceptanceEvidence:fingerprint=>({schema:'commerce-voice-acceptance/v1',fingerprint,status:'published',evidenceHash:'a'.repeat(64),providerTaskId:'acceptance',resultSha256:'b'.repeat(64),testedAt:1,publishedAt:2,publishedBy:'admin'}),
      executor:async()=>{providerCalls++;throw Error('PROVIDER_FORBIDDEN');},
    });
    jobs.setCommerceVoiceBillingForTesting({charge:(async()=>({success:true,deductedAmount:0.02,balanceAfter:10,operationId:'cash'})) as never,refund:(async()=>{refunds++;return {success:true,balanceAfter:10};}) as never,revenue:(async()=>{revenues++;}) as never});
    const owner='voice-admin-owner';store.put('settings',`main-bind-${owner}`,'system',{mainUserId:'main-user',mainRole:'user',exempt:false});let request=0;
    const unknown=async(label:string)=>{const quote=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:label});const job=await jobs.confirmVoice(owner,quote.id,`admin-reconcile-${String(++request).padStart(4,'0')}`,'main-user');store.put('voice-jobs',job.id,owner,{...job,status:'submission_unknown',dispatch:{state:'unknown',attemptId:`attempt-${request}`,startedAt:1}});return jobs.requestVoiceReconciliation(owner,job.id);};

    const success=await unknown('成功对账');const source=await assets.storeAsset(owner,Buffer.concat([Buffer.from('ID3'),Buffer.alloc(64)]),'audio/mpeg','verified-result.mp3');
    const successResolved=await jobs.resolveVoiceReconciliation({owner,id:success.id,resolvedBy:'admin-user',outcome:'success',evidence:{source:'provider-console',result:'succeeded',checkedAt:'2026-09-25T00:00:00Z'},providerTaskId:'provider-success-1',resultAssetId:source.id,actualCostAmount:0.01});
    check('success evidence binds a verified audio asset and records revenue',successResolved.status==='succeeded'&&successResolved.billingState==='revenue_recorded'&&Boolean(successResolved.assetId)&&revenues===1&&refunds===0);
    check('success resolution stores hashes instead of raw evidence',Boolean(successResolved.reconciliation?.evidenceHash)&&!JSON.stringify(successResolved).includes('provider-console'));
    await assert.rejects(()=>jobs.resolveVoiceReconciliation({owner,id:success.id,resolvedBy:'admin-user',outcome:'success',evidence:{result:'succeeded'},providerTaskId:'provider-success-1',resultAssetId:source.id}),/对账状态/);check('terminal success cannot be resolved twice',revenues===1);

    const failed=await unknown('失败对账');const failedResolved=await jobs.resolveVoiceReconciliation({owner,id:failed.id,resolvedBy:'admin-user',outcome:'failed',evidence:{source:'provider-console',result:'failed',code:'TASK_NOT_FOUND'},providerTaskId:'provider-failed-1',actualCostAmount:0});
    check('confirmed provider failure reaches refunded terminal state',failedResolved.status==='failed'&&failedResolved.billingState==='refunded'&&refunds===1);
    check('provider is never called by reconciliation',providerCalls===0);

    const noRequestQuote=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'未申请不能处理'});const noRequest=await jobs.confirmVoice(owner,noRequestQuote.id,'admin-reconcile-9999','main-user');store.put('voice-jobs',noRequest.id,owner,{...noRequest,status:'submission_unknown'});await assert.rejects(()=>jobs.resolveVoiceReconciliation({owner,id:noRequest.id,resolvedBy:'admin-user',outcome:'failed',evidence:{result:'failed'},providerTaskId:'provider-failed-2'}),/尚未进入/);check('admin cannot skip the user reconciliation request state',refunds===1);
    const route=await fs.readFile(path.resolve('src/app/api/admin/commerce/voice-reconciliation/route.ts'),'utf8');check('admin route requires authenticated mutation and explicit terminal action',route.includes('requireCommerceAdmin(request,true)')&&route.includes("'resolve-success'")&&route.includes("'resolve-failed'"));
    const report={schemaVersion:'commerce-voice-admin-reconciliation/v1',passed:true,result:{total:checks.length,passed:checks.length,failed:0},safety:{providerCalls,networkCalls:0,simulatedRefunds:refunds,simulatedRevenueRecords:revenues,paidGeneration:0,productionWrites:0,deployment:0},checks};
    const output=path.resolve('.codex-evidence','commerce-voice-admin-reconciliation','report.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify({output,...report},null,2));
  }finally{close?.();await fs.rm(fixture,{recursive:true,force:true});}
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
