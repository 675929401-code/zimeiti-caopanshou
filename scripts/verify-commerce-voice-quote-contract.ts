import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-voice-quote-'));process.env.COMMERCE_DATA_DIR=fixture;Reflect.set(process.env,'NODE_ENV','test');
  let close:(()=>void)|undefined,networkCalls=0,chargeAttempts=0,credential='credential-a',evidenceEnabled=true,lossPrice=false,failNextCharge=false;const checks:string[]=[];
  const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);};
  const originalFetch=globalThis.fetch;globalThis.fetch=(async()=>{networkCalls++;throw Error('NETWORK_FORBIDDEN');}) as typeof fetch;
  try{
    const store=await import('../src/commerce/server/store');close=()=>{(store.db() as unknown as {close:()=>void}).close();};
    const bridge=await import('../src/commerce/server/voice-bridge');const jobs=await import('../src/commerce/server/voice-jobs');
    bridge.setCommerceVoiceBridgeForTesting({
      catalog:()=>[{id:'voice-a',adminId:'voice-a',name:'测试音色',speakerId:'speaker-a',engine:'volcano',isActive:true,language:'zh',gender:'female'}],
      pricing:(characters,modelId)=>({charCount:characters,pricing:{id:'price-a',name:'TTS',modelId,totalPrice:1,totalChars:1000,costPrice:0.01,unit:'千字符',profitMargin:100,isActive:true},sellPriceRmb:lossPrice?0.01:0.02,costPriceRmb:0.01+(lossPrice?0.01:0),profitRmb:lossPrice?-0.01:0.01,creditsToCharge:1}),
      providerSnapshot:async()=>({configured:true,source:'test',bindingId:'provider-a',credentialFingerprint:credential}),
      executor:async()=>({bytes:Buffer.from('ID3fixture'),type:'audio/mpeg',providerTaskId:'mock'}),
      acceptanceEvidence:fingerprint=>evidenceEnabled?{schema:'commerce-voice-acceptance/v1',fingerprint,status:'published',evidenceHash:'a'.repeat(64),providerTaskId:'acceptance-task',resultSha256:'b'.repeat(64),testedAt:1,publishedAt:2,publishedBy:'admin'}:undefined,
    });
    const charged=new Map<string,string>();
    jobs.setCommerceVoiceBillingForTesting({charge:(async(_user:string,_amount:number,_label:string,key:string)=>{chargeAttempts++;if(failNextCharge){failNextCharge=false;return {success:false,error:'余额不足'};}const previous=charged.get(key);if(previous)return {success:true,deductedAmount:0,balanceAfter:99,alreadyFulfilled:true,operationId:previous};charged.set(key,`cash-${charged.size+1}`);return {success:true,deductedAmount:0.02,balanceAfter:99,operationId:charged.get(key)};}) as never,refund:(async()=>({success:true,balanceAfter:99})) as never,revenue:(async()=>undefined) as never});
    const owner='voice-quote-owner';store.put('settings',`main-bind-${owner}`,'system',{mainUserId:'main-user',mainRole:'user',exempt:false});
    const quote=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'这是一段确定性语音报价。',parameters:{speedRatio:1.1,pitch:1,emotion:'happy',format:'mp3',sampleRate:24000}});
    const exposed=jobs.publicVoiceQuote(quote),encoded=JSON.stringify(exposed);
    check('quote freezes exact cash price',quote.input.payableTotal===0.02&&exposed.payableTotal===0.02);
    check('quote freezes model provider and config identities',Boolean(quote.input.modelId&&quote.input.providerModelId&&quote.input.providerResourceId&&quote.input.configHash));
    check('quote freezes text hash and parameters',quote.input.textHash.length===64&&quote.input.parameters.speedRatio===1.1);
    check('quote has bounded ttl',quote.expiresAt-quote.createdAt===10*60_000);
    check('public quote omits plaintext',!encoded.includes(quote.input.text));
    const first=await jobs.confirmVoice(owner,quote.id,'voice-request-0001','main-user');const second=await jobs.confirmVoice(owner,quote.id,'voice-request-0001','main-user');
    check('confirm is idempotent',first.id===second.id&&jobs.voiceJobs(owner).length===1);
    check('cash wallet is charged once',chargeAttempts===1&&charged.size===1);
    check('confirmed task becomes durable queued work',second.status==='queued'&&second.billingState==='charged');
    await assert.rejects(()=>jobs.confirmVoice(owner,quote.id,'voice-request-different','main-user'),/另一确认请求/);check('confirmed quote rejects a different client request id',chargeAttempts===1);
    const drift=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'配置变化必须重新报价。'});credential='credential-b';await assert.rejects(()=>jobs.confirmVoice(owner,drift.id,'voice-request-0002','main-user'),/配置已变化/);check('configuration drift blocks confirmation',chargeAttempts===1);
    credential='credential-a';const expired=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'过期报价不能扣费。'});store.put('voice-quotes',expired.id,owner,{...expired,expiresAt:Date.now()-1});await assert.rejects(()=>jobs.confirmVoice(owner,expired.id,'voice-request-0003','main-user'),/已过期/);check('expired quote blocks cash and provider',chargeAttempts===1);
    evidenceEnabled=false;const gated=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'验收证据未发布时只允许报价。'});await assert.rejects(()=>jobs.confirmVoice(owner,gated.id,'voice-request-0004','main-user'),/验收|证据/);const gatedCatalog=await bridge.commerceVoiceCatalog();check('missing acceptance evidence keeps voice visible but generation gated',gatedCatalog[0]?.available===true&&gatedCatalog[0]?.generationReady===false&&chargeAttempts===1);
    evidenceEnabled=true;lossPrice=true;await assert.rejects(()=>jobs.quoteVoice(owner,{voiceId:'voice-a',text:'售价低于成本必须关闭。'}),/成本价|售价/);const lossCatalog=await bridge.commerceVoiceCatalog();check('price below cost fails closed in quote and catalog',lossCatalog[0]?.priceConfigured===false);lossPrice=false;
    const pendingQuote=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'扣费失败后只允许显式重试。'});failNextCharge=true;await assert.rejects(()=>jobs.confirmVoice(owner,pendingQuote.id,'voice-request-0005','main-user'),/扣费失败/);const pending=jobs.voiceJobs(owner).find(value=>value.quoteId===pendingQuote.id)!;const attemptsAtFailure=chargeAttempts;await jobs.runVoiceJob(pending.id,owner);await jobs.recoverVoiceJobs(owner,8,Date.now()+60_000);check('worker recovery never retries a pending wallet charge',pending.status==='billing_pending'&&chargeAttempts===attemptsAtFailure);
    await assert.rejects(()=>jobs.confirmVoice(owner,pendingQuote.id,'voice-request-changed','main-user'),/另一确认请求/);const retried=await jobs.confirmVoice(owner,pendingQuote.id,'voice-request-0005','main-user');check('same quote and client request explicitly retry one idempotent charge',retried.status==='queued'&&retried.billingState==='charged'&&chargeAttempts===attemptsAtFailure+1&&charged.size===2);
    const wrongBindingQuote=await jobs.quoteVoice(owner,{voiceId:'voice-a',text:'钱包身份错配必须拒绝。'});await assert.rejects(()=>jobs.confirmVoice(owner,wrongBindingQuote.id,'voice-request-0006','another-main-user'),/钱包已经变化/);check('cookie main account is pinned through task creation',chargeAttempts===attemptsAtFailure+1);
    const source=await fs.readFile(path.resolve('src/commerce/server/voice-jobs.ts'),'utf8');check('commerce voice never calls the credit lifecycle',!source.includes('credit_charge')&&!source.includes('beginVoiceGenerationAtomic')&&!source.includes('/api/voice/tts'));
    check('zero-cost contract made no network call',networkCalls===0);
    const report={schemaVersion:'commerce-voice-quote-contract/v1',passed:true,result:{total:checks.length,passed:checks.length,failed:0},safety:{networkCalls,simulatedWalletChargeAttempts:chargeAttempts,walletCashDebits:charged.size,creditDebits:0,providerSubmissions:0,paidGeneration:0,productionWrites:0,deployment:0},checks};
    const output=path.resolve('.codex-evidence','commerce-voice-quote-contract','report.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify({output,...report},null,2));
  }finally{globalThis.fetch=originalFetch;close?.();await fs.rm(fixture,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
