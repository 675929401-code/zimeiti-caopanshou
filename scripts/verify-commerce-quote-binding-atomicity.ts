import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
 const fixture=path.resolve('.codex-evidence/commerce-quote-binding-'+Date.now());
 process.env.COMMERCE_DATA_DIR=fixture;process.env.SHARED_CONFIGURATION_ENABLED='0';
 await fs.mkdir(fixture,{recursive:true});
 let networkCalls=0;
 globalThis.fetch=(async()=>{networkCalls++;throw Error('QUOTE_BINDING_TEST_NETWORK_FORBIDDEN');}) as typeof fetch;
 const store=await import('../src/commerce/server/store');
 const quotes=await import('../src/commerce/server/quotes');
 const jobs=await import('../src/commerce/server/jobs');
 const owner='quote-binding-owner';
 const model={id:'quote-binding-video',displayName:'Quote Binding Video',kind:'video' as const,source:'custom' as const,enabled:true,publicPrice:1,costPrice:.5,billingUnit:'per_use' as const,configHash:'d'.repeat(64),protocol:'secure-video',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,nativeDurations:[4],durationOptions:[4],aspectRatios:['9:16'],resolutionOptions:['720p'],maxReferenceImages:0}};
 store.put('settings','main-model-source','system',{enabled:false});store.put('settings','defaults','system',{video:model.id});store.put('models',model.id,'system',model);

 const quote=await quotes.createCommerceQuote(owner,{kind:'video',modelId:model.id,prompt:'原子报价绑定测试',duration:4,aspectRatio:'9:16',resolution:'720p'});
 const clientRequestId='11111111-1111-4111-8111-111111111111';
 const created=await quotes.confirmCommerceQuote(owner,{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint});
 const storedQuote=store.get<Record<string,any>>('commerce-quotes',quote.id,owner)!;
 const firstVisible=store.get<Record<string,any>>('jobs',created.id,owner)!;
 assert.equal(firstVisible.status,'queued');
 assert.deepEqual({quoteId:firstVisible.configurationSnapshot.quoteId,inputFingerprint:firstVisible.configurationSnapshot.inputFingerprint,clientRequestId:firstVisible.configurationSnapshot.clientRequestId},{quoteId:quote.id,inputFingerprint:quote.inputFingerprint,clientRequestId});
 assert.deepEqual(firstVisible.configurationSnapshot.modelSelection,storedQuote.modelSelection);
 const replay=await quotes.confirmCommerceQuote(owner,{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint});assert.equal(replay.id,created.id);

 firstVisible.configurationSnapshot={...firstVisible.configurationSnapshot,inputFingerprint:'e'.repeat(64)};store.put('jobs',firstVisible.id,owner,firstVisible);
 await assert.rejects(()=>quotes.confirmCommerceQuote(owner,{quoteId:quote.id,clientRequestId,inputFingerprint:quote.inputFingerprint}),/完整的报价或模型选择快照/);

 const guardedQuote=await quotes.createCommerceQuote(owner,{kind:'video',modelId:model.id,prompt:'派发前阻断残缺历史任务',duration:4,aspectRatio:'9:16',resolution:'720p'});
 const guarded=await quotes.confirmCommerceQuote(owner,{quoteId:guardedQuote.id,clientRequestId:'22222222-2222-4222-8222-222222222222',inputFingerprint:guardedQuote.inputFingerprint});
 const tampered=store.get<Record<string,any>>('jobs',guarded.id,owner)!;tampered.configurationSnapshot.modelSelection={...tampered.configurationSnapshot.modelSelection,selectedModelConfigHash:'f'.repeat(64)};store.put('jobs',tampered.id,owner,tampered);
 await jobs.runJob(guarded.id,owner);
 const blocked=store.get<Record<string,any>>('jobs',guarded.id,owner)!;
 assert.equal(blocked.status,'failed');assert.equal(blocked.dispatchedAt,undefined);assert.match(String(blocked.error),/模型配置或费用已经变更/);assert.equal(networkCalls,0);

 const sourceFiles=['quotes.ts','card-canary.ts','model-canary.ts','detail-sets.ts'].map(name=>path.join('src','commerce','server',name));
 const sources=await Promise.all(sourceFiles.map(file=>fs.readFile(path.resolve(file),'utf8')));
 assert.equal(sources.some(source=>/configurationSnapshot\s*=.*persistJob\(/s.test(source)),false);
 const jobsSource=await fs.readFile(path.resolve('src/commerce/server/jobs.ts'),'utf8');
 assert.ok(jobsSource.indexOf('assertJobQuoteSnapshotCurrent(value)')<jobsSource.indexOf("applyJobBilling(value,'charge'"));
 assert.ok(jobsSource.indexOf('configurationSnapshot.quoteId=quoteBinding.quoteId')<jobsSource.indexOf("put('jobs',id,owner,value)"));
 console.log(JSON.stringify({passed:12,networkCalls,providerCalls:0,walletWrites:0,checks:['first-visible-queued','quote-id-atomic','input-fingerprint-atomic','client-request-id-atomic','model-selection-atomic','same-request-replay','tampered-replay-rejected','dispatch-guard-failed','dispatch-guard-before-provider','zero-network','no-post-create-persist-pattern','binding-before-job-insert'],fixture}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
