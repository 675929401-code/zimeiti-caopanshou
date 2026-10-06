import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-rolling-worker-'));
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  let closeDatabase:(()=>void)|undefined;
  try{
    const store=await import('../src/commerce/server/store');
    closeDatabase=()=>{(store.db() as unknown as {close:()=>void}).close();};
    const assets=await import('../src/commerce/server/assets');
    const jobsModule=await import('../src/commerce/server/jobs');
    const rolling=await import('../src/commerce/server/rolling-video');
    const worker=await import('../src/commerce/server/rolling-video-worker');
    const ordinary=await import('../src/commerce/server/ordinary-worker');
    const {storageManager}=await import('../src/storage/object');
    const {resolveFfmpegExecutable}=await import('../src/lib/video-postprocess');
    type Job=import('../src/commerce/server/jobs').Job;

    const owner='rolling-worker-owner';
    const model={id:'rolling-video-fixture',displayName:'Rolling Video Fixture',kind:'video' as const,source:'custom' as const,publicPrice:0,costPrice:0,billingUnit:'per_use' as const,configHash:'rolling-video-fixture-v1',capabilities:{available:true,explicitlyFree:true,nativeDurations:[1],durationOptions:[1],aspectRatios:['9:16'],resolutionOptions:['720p'],maxReferenceImages:2},protocol:'secure-video',endpoint:'https://provider.invalid',modelName:'fixture',enabled:true};
    store.put('settings','main-model-source','system',{enabled:false});
    store.put('settings','defaults','system',{video:model.id});
    store.put('settings','main-bind-'+owner,'system',{mainUserId:'rolling-worker-fixture-user'});
    store.put('models',model.id,'system',model);

    const now=Date.now();
    const firstLease=worker.claimCommerceRollingLease('lease-fixture',owner,'worker-a',now,100);
    assert(firstLease);
    assert.equal(worker.claimCommerceRollingLease('lease-fixture',owner,'worker-a',now+25,100),null,'同一 Worker 的重入调用也不得重新 fencing 活跃任务');
    assert.equal(worker.claimCommerceRollingLease('lease-fixture',owner,'worker-b',now+50,100),null,'第二 Worker 不得抢占未过期租约');
    assert.equal(worker.renewCommerceRollingLease(firstLease!,now+60,100),true);
    assert.equal(worker.claimCommerceRollingLease('lease-fixture',owner,'worker-b',now+120,100),null,'续租后仍不得被第二 Worker 抢占');
    const replacementLease=worker.claimCommerceRollingLease('lease-fixture',owner,'worker-b',now+161,100);assert(replacementLease,'原 Worker 断电且租约过期后必须可恢复');
    assert.equal(worker.commerceRollingLeaseIsCurrent(firstLease!,now+161),false,'新 token 生效后旧 worker 必须立即失去数据库写权限');
    assert.equal(worker.releaseCommerceRollingLease(firstLease!),false,'旧 worker 不得释放新 worker 的租约');
    assert.equal(worker.releaseCommerceRollingLease(replacementLease!),true);
    const afterRelease=worker.claimCommerceRollingLease('lease-fixture',owner,'worker-c',now+162,100);assert(afterRelease);assert(afterRelease!.token>replacementLease!.token,'释放后必须保留 tombstone，token 不得归零');

    const recoveryOwner='rolling-worker-recovery-owner';
    const freshDirect=directJob('fresh-direct',recoveryOwner,model,now-10_000);
    store.put('jobs',freshDirect.id,recoveryOwner,freshDirect);
    store.put('billing',freshDirect.id,recoveryOwner,billingState(freshDirect,'charge_pending',now-10_000));
    assert.equal(jobsModule.claimStaleUndispatchedCommerceJob(freshDirect.id,recoveryOwner,now,60_000),undefined,'正常扣款租约内的任务不得被后台抢占');

    const dispatchedDirect=directJob('dispatched-direct',recoveryOwner,model,now-120_000);
    dispatchedDirect.dispatchedAt=now-119_000;
    store.put('jobs',dispatchedDirect.id,recoveryOwner,dispatchedDirect);
    store.put('billing',dispatchedDirect.id,recoveryOwner,billingState(dispatchedDirect,'charged',now-120_000));
    assert.equal(jobsModule.claimStaleUndispatchedCommerceJob(dispatchedDirect.id,recoveryOwner,now,60_000),undefined,'已触达供应商的任务绝不能重置后重派');

    const staleDirect=directJob('stale-direct',recoveryOwner,model,now-120_000);
    store.put('jobs',staleDirect.id,recoveryOwner,staleDirect);
    store.put('billing',staleDirect.id,recoveryOwner,billingState(staleDirect,'charged',now-120_000));
    const recoveryClaims=await Promise.all([
      Promise.resolve().then(()=>jobsModule.claimStaleUndispatchedCommerceJob(staleDirect.id,recoveryOwner,now,60_000)),
      Promise.resolve().then(()=>jobsModule.claimStaleUndispatchedCommerceJob(staleDirect.id,recoveryOwner,now,60_000)),
    ]);
    assert.equal(recoveryClaims.filter(Boolean).length,1,'双 Worker 竞争只能有一个 CAS 恢复原任务');
    assert.equal(jobsModule.job(staleDirect.id,recoveryOwner)?.status,'queued');
    assert.equal(jobsModule.job(staleDirect.id,recoveryOwner)?.undispatchedRecovery?.attempt,1);

    const concurrentParent=parentJob('concurrent-parent',owner,model,'running',[1,1]);
    store.put('jobs',concurrentParent.id,owner,concurrentParent);
    let entered=0;
    let releaseFirst!:()=>void;
    const gate=new Promise<void>((resolve)=>{releaseFirst=resolve;});
    const first=worker.processCommerceRollingJob(concurrentParent.id,owner,'worker-a',{skipWorkflowSync:true,processor:async()=>{entered++;await gate;return jobsModule.job(concurrentParent.id,owner);}});
    while(entered===0)await new Promise((resolve)=>setTimeout(resolve,5));
    const second=await worker.processCommerceRollingJob(concurrentParent.id,owner,'worker-b',{skipWorkflowSync:true,processor:async()=>{entered++;return jobsModule.job(concurrentParent.id,owner);}});
    assert.equal(second,undefined,'双 Worker 同时扫描时只允许一个推进父任务');
    releaseFirst();
    await first;
    assert.equal(entered,1);

    const unknownParent=parentJob('unknown-parent',owner,model,'running',[1,1]);
    store.put('jobs',unknownParent.id,owner,unknownParent);
    const childInput={requestId:rolling.rollingRequestId(unknownParent.id,0),kind:'video' as const,modelId:model.id,prompt:rolling.compileSegmentPrompt(unknownParent.input.prompt,1,2,0,1,2,false,false),duration:1,aspectRatio:'9:16',resolution:'720p',references:[],rollingChild:true,rollingParentJobId:unknownParent.id,rollingSegmentIndex:0};
    const unknownChild=await jobsModule.createJob(owner,childInput,undefined,{rollingParentId:unknownParent.id,segmentIndex:0});
    unknownChild.status='unknown';
    unknownChild.error='原供应商提交结果待确认';
    jobsModule.persistJob(unknownChild);
    const unknownStored=jobsModule.job(unknownParent.id,owner)!;
    unknownStored.status='unknown';
    unknownStored.updatedAt=Date.now()-6_000;
    unknownStored.rollingState={childIds:[unknownChild.id],segmentIndex:0,segmentAssetIds:[],tailFrameAssetIds:[]};
    store.put('jobs',unknownStored.id,owner,unknownStored);
    const unknownJobsBefore=jobsModule.jobs(owner).length;
    await worker.processCommerceRollingJob(unknownStored.id,owner,'worker-unknown',{skipWorkflowSync:true});
    const unknownAfter=jobsModule.job(unknownStored.id,owner)!;
    assert.equal(unknownAfter.status,'unknown');
    assert.deepEqual(unknownAfter.rollingState?.childIds,[unknownChild.id]);
    assert.equal(jobsModule.jobs(owner).length,unknownJobsBefore,'unknown 恢复只能核对原 child，不能创建替代任务');

    const firstClip=await videoFixture(fixture,'first','blue',resolveFfmpegExecutable());
    const secondClip=await videoFixture(fixture,'second','green',resolveFfmpegExecutable());
    const firstAsset=await assets.storeAsset(owner,await fs.readFile(firstClip),'video/mp4','segment-1.mp4','generated','child-1');
    const secondAsset=await assets.storeAsset(owner,await fs.readFile(secondClip),'video/mp4','segment-2.mp4','generated','child-2');
    const savingChild=childJob('saving-child',owner,model,'saving-parent',0,'');savingChild.status='saving';savingChild.assetIds=[];savingChild.providerUrl='https://provider.invalid/original-result.mp4';savingChild.updatedAt=Date.now()-10_000;
    const savedResult=await assets.storeAsset(owner,await fs.readFile(firstClip),'video/mp4','saving-child.mp4','generated',savingChild.id,undefined,`job-result:${savingChild.id}`);
    store.put('jobs',savingChild.id,owner,savingChild);
    await ordinary.reconcileCommerceOrdinaryBatch({now:Date.now(),candidates:[{kind:'job',id:savingChild.id,owner,updatedAt:savingChild.updatedAt}]});
    const savingRecovered=jobsModule.job(savingChild.id,owner)!;assert.equal(savingRecovered.status,'succeeded');assert.deepEqual(savingRecovered.assetIds,[savedResult.id]);
    const restitchParent=parentJob('restitch-parent',owner,model,'save_failed',[1,1]);
    const childOne=childJob('restitch-child-1',owner,model,restitchParent.id,0,firstAsset.id);
    const childTwo=childJob('restitch-child-2',owner,model,restitchParent.id,1,secondAsset.id);
    restitchParent.rollingState={childIds:[childOne.id,childTwo.id],segmentIndex:2,segmentAssetIds:[firstAsset.id,secondAsset.id],tailFrameAssetIds:[],restitchAttempts:0};
    store.put('jobs',childOne.id,owner,childOne);
    store.put('jobs',childTwo.id,owner,childTwo);
    store.put('jobs',restitchParent.id,owner,restitchParent);
    const jobsBeforeRestitch=jobsModule.jobs(owner).length;
    const assetsBeforeRestitch=store.list('assets',owner).length;
    const recovered=await worker.processCommerceRollingJob(restitchParent.id,owner,'worker-restitch',{forceRestitch:true,skipWorkflowSync:true});
    assert.equal(recovered?.status,'succeeded');
    assert.equal(recovered?.assetIds.length,1);
    assert.equal(jobsModule.jobs(owner).length,jobsBeforeRestitch,'restitch 不得创建或重生任何子任务');
    assert.equal(store.list('assets',owner).length,assetsBeforeRestitch+1,'restitch 只新增一个父成片资产');
    const finalAssetId=recovered!.assetIds[0];
    const replay=await worker.processCommerceRollingJob(restitchParent.id,owner,'worker-restitch-replay',{forceRestitch:true,skipWorkflowSync:true});
    assert.equal(replay?.assetIds[0],finalAssetId,'成功 restitch 的幂等重放必须返回原父成片');
    assert.equal(store.list('assets',owner).length,assetsBeforeRestitch+1,'幂等重放不得再次拼接或保存资产');
    assert.equal(jobsModule.jobs(owner).length,jobsBeforeRestitch);

    const cleanupParent=parentJob('cleanup-parent',owner,model,'succeeded',[1,1]);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
    const tail=await assets.storeAsset(owner,png,'image/png','rolling-tail.png','generated',cleanupParent.id,{kind:'rolling-tail',parentJobId:cleanupParent.id,segmentIndex:0});
    tail.providerReferenceKey='commerce-provider-reference/image/fixture/tail.png';
    tail.providerReferenceProvider='tencent_cos';
    store.put('assets',tail.id,owner,tail);
    cleanupParent.rollingState={childIds:[],segmentIndex:2,segmentAssetIds:[],tailFrameAssetIds:[tail.id],temporaryAssetsCleanupStatus:'pending'};
    store.put('jobs',cleanupParent.id,owner,cleanupParent);
    const originalDelete=storageManager.delete.bind(storageManager);
    const remoteDeletes:Array<{key:string;provider?:string}>=[];
    try{
      storageManager.delete=async(key,provider)=>{remoteDeletes.push({key,provider});return false;};
      await rolling.cleanupRollingTailAssets(cleanupParent,owner);
      const failedCleanup=jobsModule.job(cleanupParent.id,owner)!;
      assert.equal(failedCleanup.status,'succeeded','尾帧清理失败不得把已交付成片改成失败');
      assert.equal(failedCleanup.rollingState?.temporaryAssetsCleanupStatus,'failed');
      assert(assets.readAsset(tail.id,owner),'远端删除失败时必须保留本地资产身份供重试');
      storageManager.delete=async(key,provider)=>{remoteDeletes.push({key,provider});return true;};
      await rolling.cleanupRollingTailAssets(failedCleanup,owner);
      const completedCleanup=jobsModule.job(cleanupParent.id,owner)!;
      assert.equal(completedCleanup.rollingState?.temporaryAssetsCleanupStatus,'complete');
      assert.deepEqual(completedCleanup.rollingState?.tailFrameAssetIds,[]);
      assert.equal(assets.readAsset(tail.id,owner),undefined);
      assert.deepEqual(remoteDeletes,[
        {key:tail.providerReferenceKey,provider:'tencent_cos'},
        {key:tail.providerReferenceKey,provider:'tencent_cos'},
      ]);
    }finally{
      storageManager.delete=originalDelete;
    }

    const routeSource=await fs.readFile(path.resolve('src/app/api/commerce/jobs/route.ts'),'utf8');
    const runtimeSource=await fs.readFile(path.resolve('src/lib/media-queue-worker-runtime.ts'),'utf8');
    assert.match(routeSource,/!\w+\.input\.rollingPlan/u,'浏览器 GET 必须跳过滚动父任务推进');
    assert.match(runtimeSource,/startCommerceRollingWorker/u,'独立媒体 Worker 必须启动 Commerce 滚动执行器');
    console.log(JSON.stringify({passed:true,checks:39,doubleWorkerAdvanceCount:entered,doubleWorkerRecoveryClaims:recoveryClaims.filter(Boolean).length,unknownChildId:unknownChild.id,savingChildId:savingChild.id,restitchParentId:restitchParent.id,finalAssetId,temporaryTailRemoteDeleteAttempts:remoteDeletes.length,providerSubmissions:0,walletWrites:0,databaseSchemaChanges:0}));
  }finally{
    closeDatabase?.();
    await fs.rm(fixture,{recursive:true,force:true});
  }
}

function parentJob(id:string,owner:string,model:Record<string,unknown>,status:JobStatus,segments:number[]){
  const now=Date.now();
  return {id,owner,input:{requestId:`00000000-0000-4000-8000-${id.padEnd(12,'0').slice(0,12)}`,kind:'video',modelId:String(model.id),prompt:'固定商品主体，连续生成。',duration:segments.reduce((sum,value)=>sum+value,0),aspectRatio:'9:16',resolution:'720p',rollingPlan:{segments}},model,configurationSnapshot:{releaseId:'fixture',releaseVersion:1,manifestSha256:'fixture',promptVersionId:'video.generate',promptVersion:1,knowledgeVersionIds:[],routeVersionId:'video.generate',routeVersion:1,modelConfigHash:String(model.configHash)},status,createdAt:now,updatedAt:now,assetIds:[],promptVersion:1,compiledPrompt:'fixture rolling prompt'} as unknown as import('../src/commerce/server/jobs').Job;
}

type JobStatus=import('../src/commerce/server/jobs').Job['status'];

function directJob(id:string,owner:string,model:Record<string,unknown>,startedAt:number){
  const value=parentJob(id,owner,model,'running',[1]);
  delete value.input.rollingPlan;
  value.startedAt=startedAt;
  value.updatedAt=startedAt;
  return value;
}

function billingState(value:import('../src/commerce/server/jobs').Job,status:'charge_pending'|'charged',updatedAt:number){
  return {schema:'commerce-billing/v1',jobId:value.id,owner:value.owner,fingerprint:'fixture',status,amount:0,costAmount:0,profitAmount:0,costSource:'configured_estimate',chargeKey:`commerce-job-${value.id}`,refundKey:`commerce-job-${value.id}-refund`,mainUserId:'rolling-worker-fixture-user',updatedAt};
}

function childJob(id:string,owner:string,model:Record<string,unknown>,parentId:string,index:number,assetId:string){
  const now=Date.now();
  return {id,owner,input:{requestId:`10000000-0000-4000-8000-${id.padEnd(12,'0').slice(0,12)}`,kind:'video',modelId:String(model.id),prompt:'segment',duration:1,aspectRatio:'9:16',resolution:'720p',rollingChild:true,rollingParentJobId:parentId,rollingSegmentIndex:index},model,status:'succeeded',createdAt:now,updatedAt:now,assetIds:[assetId],promptVersion:1,compiledPrompt:'segment'} as unknown as import('../src/commerce/server/jobs').Job;
}

async function videoFixture(directory:string,name:string,color:string,ffmpeg:string){
  const output=path.join(directory,`${name}.mp4`);
  const generated=spawnSync(ffmpeg,['-hide_banner','-nostdin','-y','-f','lavfi','-i',`color=c=${color}:s=160x160:r=12:d=1`,'-c:v','mpeg4','-pix_fmt','yuv420p','-movflags','+faststart',output],{encoding:'utf8',windowsHide:true});
  assert.equal(generated.status,0,generated.stderr||'video fixture generation failed');
  return output;
}

void main().catch((error)=>{console.error(error);process.exitCode=1;});
