import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-hot-video-remix-'));
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  const originalFetch=globalThis.fetch;
  let networkCalls=0;
  const providerCalls=0,walletDebits=0,browserWrites=0;
  globalThis.fetch=async()=>{networkCalls++;throw Error('NETWORK_FORBIDDEN_IN_HOT_VIDEO_REMIX_TEST');};
  const checks:string[]=[];
  const check=async(name:string,work:()=>unknown|Promise<unknown>)=>{await work();checks.push(name);};
  let closeDatabase:(()=>void)|undefined;
  try{
    const {resolveFfmpegExecutable}=await import('../src/lib/video-postprocess');
    const ffmpeg=path.resolve(resolveFfmpegExecutable());
    process.env.COMMERCE_FFMPEG_PATH=ffmpeg;
    const store=await import('../src/commerce/server/store');
    closeDatabase=()=>{(store.db() as unknown as {close:()=>void}).close();};
    const assets=await import('../src/commerce/server/assets');
    const remix=await import('../src/commerce/server/hot-video-remix');
    const owner='hot-video-remix-contract-owner';

    const sourceWithAudio=path.join(fixture,'source-audio.mp4');
    const sourceSilent=path.join(fixture,'source-silent.mp4');
    const bgmFile=path.join(fixture,'bgm.wav');
    fixtureCommand(ffmpeg,['-f','lavfi','-i','color=c=royalblue:s=360x640:r=24:d=3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-shortest','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',sourceWithAudio]);
    fixtureCommand(ffmpeg,['-f','lavfi','-i','color=c=seagreen:s=640x360:r=24:d=3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-an','-movflags','+faststart',sourceSilent]);
    fixtureCommand(ffmpeg,['-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1','-c:a','pcm_s16le',bgmFile]);

    const sourceA=await assets.storeAsset(owner,await fs.readFile(sourceWithAudio),'video/mp4','source-audio.mp4');
    const sourceB=await assets.storeAsset(owner,await fs.readFile(sourceSilent),'video/mp4','source-silent.mp4');
    const bgm=await assets.storeAsset(owner,await fs.readFile(bgmFile),'audio/wav','continuous-bgm.wav');
    const requestId='10000000-0000-4000-8000-000000000001';
    const quote=await remix.quoteHotVideoRemix(owner,{action:'quote',requestId,sourceAssetIds:[sourceA.id,sourceB.id],bgmAssetId:bgm.id,targetDuration:2.4,aspectRatio:'9:16',preserveSourceAudio:true,bgmVolume:0.2} as never);
    await check('quote exposes stable id aliases',()=>{assert.equal(quote.id,quote.quoteId);assert.match(quote.id,/^[a-f0-9-]{36}$/);});
    await check('quote freezes owned source hashes',()=>{assert.deepEqual(quote.sourceSnapshots.map(value=>value.sha256),[sourceA.sha256,sourceB.sha256]);assert.equal(quote.bgmSnapshot?.sha256,bgm.sha256);});
    await check('quote probes source audio tracks',()=>{assert.equal(quote.sourceSnapshots[0].hasAudio,true);assert.equal(quote.sourceSnapshots[1].hasAudio,false);assert.equal(quote.bgmSnapshot?.hasAudio,true);});
    await check('quote freezes deterministic clip plan',()=>{assert.equal(quote.clipPlan.length,2);assert.equal(round(quote.clipPlan.reduce((sum,value)=>sum+value.duration,0)),2.4);assert.deepEqual(quote.clipPlan.map(value=>value.order),[0,1]);});
    await check('quote is explicitly zero fee local execution',()=>{assert.deepEqual(quote.pricing,{currency:'CNY',payableTotal:0,estimatedTotalCost:0,billingUnit:'local_free'});assert.deepEqual(quote.execution,{engine:'local-ffmpeg',networkRequired:false,walletRequired:false});});
    await check('quote replay keeps frozen identity without repeating ffmpeg probes',async()=>{process.env.COMMERCE_FFMPEG_PATH=path.join(fixture,'forbidden-repeat-probe.exe');try{const replay=await remix.quoteHotVideoRemix(owner,{requestId,sourceAssetIds:[sourceA.id,sourceB.id],bgmAssetId:bgm.id,targetDuration:2.4,aspectRatio:'9:16',preserveSourceAudio:true,bgmVolume:0.2});assert.equal(replay.id,quote.id);assert.equal(replay.inputFingerprint,quote.inputFingerprint);}finally{process.env.COMMERCE_FFMPEG_PATH=ffmpeg;}});
    await check('same request id rejects changed quote content before probing',async()=>{process.env.COMMERCE_FFMPEG_PATH=path.join(fixture,'forbidden-changed-probe.exe');try{await assert.rejects(()=>remix.quoteHotVideoRemix(owner,{requestId,sourceAssetIds:[sourceA.id,sourceB.id],bgmAssetId:bgm.id,targetDuration:2.5,aspectRatio:'9:16',preserveSourceAudio:true,bgmVolume:0.2}),/不同内容/);}finally{process.env.COMMERCE_FFMPEG_PATH=ffmpeg;}});
    const manualQuote=await remix.quoteHotVideoRemix(owner,{requestId:'10000000-0000-4000-8000-000000000003',sourceAssetIds:[sourceA.id,sourceB.id],clips:[{assetId:sourceA.id,start:0.4,duration:1.1},{assetId:sourceB.id,start:0.2,duration:1.3}],targetDuration:2.4,aspectRatio:'9:16',preserveSourceAudio:true});
    await check('manual quote freezes exact ordered clip selections',()=>{assert.deepEqual(manualQuote.clipPlan,[{assetId:sourceA.id,start:0.4,duration:1.1,order:0},{assetId:sourceB.id,start:0.2,duration:1.3,order:1}]);});
    await check('manual quote rejects non-positive clip duration',async()=>{await assert.rejects(()=>remix.quoteHotVideoRemix(owner,{requestId:'10000000-0000-4000-8000-000000000004',sourceAssetIds:[sourceA.id],clips:[{assetId:sourceA.id,start:0,duration:0}],targetDuration:2,aspectRatio:'9:16',preserveSourceAudio:true}),/截取区间无效/);});
    await check('manual quote rejects total duration mismatch',async()=>{await assert.rejects(()=>remix.quoteHotVideoRemix(owner,{requestId:'10000000-0000-4000-8000-000000000005',sourceAssetIds:[sourceA.id,sourceB.id],clips:[{assetId:sourceA.id,start:0,duration:1},{assetId:sourceB.id,start:0,duration:1}],targetDuration:2.4,aspectRatio:'9:16',preserveSourceAudio:true}),/总时长必须等于成片时长/);});

    const firstConfirm=remix.confirmHotVideoRemix(owner,quote.quoteId);
    const secondConfirm=remix.confirmHotVideoRemix(owner,quote.quoteId);
    await check('confirm creates one durable queued job',()=>{assert.equal(firstConfirm.created,true);assert.equal(firstConfirm.job.status,'queued');});
    await check('confirm is idempotent',()=>{assert.equal(secondConfirm.created,false);assert.equal(secondConfirm.job.id,firstConfirm.job.id);assert.equal(remix.listHotVideoRemixes(owner).length,1);});
    const secondActive=remix.confirmHotVideoRemix(owner,manualQuote.quoteId),limitedQuote=await remix.quoteHotVideoRemix(owner,{requestId:'10000000-0000-4000-8000-000000000006',sourceAssetIds:[sourceA.id],targetDuration:2,aspectRatio:'9:16',preserveSourceAudio:true});
    await check('per-owner active task limit prevents local ffmpeg exhaustion',async()=>{assert.equal(secondActive.job.status,'queued');await assert.rejects(async()=>remix.confirmHotVideoRemix(owner,limitedQuote.quoteId),/当前已有 2 个/);const record=remix.readHotVideoRemix(secondActive.job.id,owner)!;record.status='failed';store.put(remix.HOT_VIDEO_REMIX_JOB_BUCKET,record.id,owner,record);});
    await check('active source deletion is fenced',async()=>{await assert.rejects(()=>assets.deleteAsset(owner,sourceA.id),/任务引用|不能删除/);assert.ok(assets.readAsset(sourceA.id,owner));});
    await check('active bgm deletion is fenced',async()=>{await assert.rejects(()=>assets.deleteAsset(owner,bgm.id),/任务引用|不能删除/);assert.ok(assets.readAsset(bgm.id,owner));});
    const pendingOutput=await assets.storeAsset(owner,await fs.readFile(sourceWithAudio),'video/mp4','pending-remix-output.mp4','generated',firstConfirm.job.id);
    await check('active remix output deletion is fenced',async()=>{await assert.rejects(()=>assets.deleteAsset(owner,pendingOutput.id),/运行或保存/);assert.ok(assets.readAsset(pendingOutput.id,owner));});

    const completed=await remix.runHotVideoRemix(firstConfirm.job.id,owner);
    await check('local ffmpeg run succeeds',()=>{assert.equal(completed.status,'succeeded');assert.equal(completed.progress,100);assert.ok(completed.resultAsset);});
    await check('output is durable and owned by job',async()=>{assert.equal(completed.resultAsset?.jobId,completed.id);assert.equal(completed.resultAsset?.type,'video/mp4');assert.ok(await assets.assertAssetIntegrity(assets.readAsset(completed.resultAsset!.id,owner)!));});
    await check('output duration and dimensions match quote',()=>{assert.ok(Math.abs(completed.resultProbe!.duration-2.4)<=0.35);assert.equal(completed.resultProbe?.width,720);assert.equal(completed.resultProbe?.height,1280);});
    await check('continuous bgm result has audio',()=>{assert.equal(completed.resultProbe?.hasAudio,true);assert.ok(completed.events.some(value=>value.stage==='bgm-mixed'));});
    await check('execution records deterministic stages',()=>{for(const stage of ['sources-verified','clips-normalized','concatenated','asset-saved','succeeded'])assert.ok(completed.events.some(value=>value.stage===stage));});

    const assetCountBeforeReplay=store.list('assets',owner).length;
    const completedReplay=await remix.runHotVideoRemix(firstConfirm.job.id,owner);
    await check('succeeded replay returns same result asset',()=>{assert.equal(completedReplay.resultAsset?.id,completed.resultAsset?.id);assert.equal(store.list('assets',owner).length,assetCountBeforeReplay);});

    const staleQuote=await remix.quoteHotVideoRemix(owner,{requestId:'10000000-0000-4000-8000-000000000002',sourceAssetIds:[sourceA.id],targetDuration:2,aspectRatio:'1:1',preserveSourceAudio:false});
    const staleConfirmed=remix.confirmHotVideoRemix(owner,staleQuote.quoteId);
    const staleRecord=remix.readHotVideoRemix(staleConfirmed.job.id,owner)!;
    staleRecord.status='running';staleRecord.updatedAt=Date.now()-120_000;
    store.put(remix.HOT_VIDEO_REMIX_JOB_BUCKET,staleRecord.id,owner,staleRecord);
    const activeLease=store.claimRecordLease(remix.HOT_VIDEO_REMIX_LEASE_BUCKET,staleRecord.id,owner,'active-contract-worker',Date.now(),60_000)!;
    await check('stale recovery cannot steal an active lease',()=>{assert.equal(remix.recoverStaleHotVideoRemix(staleRecord.id,owner,Date.now(),60_000),false);assert.equal(remix.readHotVideoRemix(staleRecord.id,owner)?.status,'running');});
    const workRoot=path.join(fixture,'hot-video-remix-work'),staleWork=path.join(workRoot,`${staleRecord.id}-20000000-0000-4000-8000-000000000001`),freshWork=path.join(workRoot,`${staleRecord.id}-20000000-0000-4000-8000-000000000002`),unownedWork=path.join(workRoot,'do-not-delete-unowned-name');
    await fs.mkdir(staleWork,{recursive:true});await fs.mkdir(freshWork,{recursive:true});await fs.mkdir(unownedWork,{recursive:true});const old=new Date(Date.now()-2*60*60_000);await fs.utimes(staleWork,old,old);await fs.utimes(unownedWork,old,old);
    await check('workdir sweeper preserves a running job with a live lease',async()=>{const result=await remix.sweepHotVideoRemixWorkdirs(Date.now(),60_000);assert.equal(result.removed,0);assert.ok(await fs.stat(staleWork));});
    store.releaseRecordLease(activeLease);
    await check('workdir sweeper removes only stale owned scratch directories',async()=>{const result=await remix.sweepHotVideoRemixWorkdirs(Date.now(),60_000);assert.equal(result.removed,1);await assert.rejects(()=>fs.stat(staleWork));assert.ok(await fs.stat(freshWork));assert.ok(await fs.stat(unownedWork));});
    await check('stale running job returns to original queue identity',()=>{assert.equal(remix.recoverStaleHotVideoRemix(staleRecord.id,owner,Date.now(),60_000),true);const recovered=remix.readHotVideoRemix(staleRecord.id,owner)!;assert.equal(recovered.status,'queued');assert.equal(recovered.id,staleRecord.id);assert.equal(recovered.recoveryAttempts,1);});
    const terminalStale=remix.readHotVideoRemix(staleRecord.id,owner)!;terminalStale.status='failed';terminalStale.updatedAt=Date.now();store.put(remix.HOT_VIDEO_REMIX_JOB_BUCKET,terminalStale.id,owner,terminalStale);

    await check('public DTO excludes ownership and lease internals',()=>{for(const dto of [quote,completed,...remix.listHotVideoRemixes(owner)])assertPublicDto(dto);});
    await check('terminal jobs release source deletion guard',async()=>{await assets.deleteAsset(owner,sourceA.id);assert.equal(assets.readAsset(sourceA.id,owner),undefined);});
    await check('route schedules list get and confirm through after',async()=>{const source=await fs.readFile(path.resolve('src/app/api/commerce/hot-video-remix/route.ts'),'utf8');assert.match(source,/requireIdentity\(request\)/);assert.match(source,/sameOrigin\(request\)/);assert.match(source,/after\(async\(\)=>/);assert.match(source,/body\.action==='quote'/);assert.match(source,/body\.action==='confirm'/);});
    await check('studio exposes automatic and exact manual clip modes',async()=>{const source=await fs.readFile(path.resolve('src/commerce/components/commerce-agent/hot-video-remix-studio.tsx'),'utf8');assert.match(source,/type ClipMode='automatic'\|'manual'/);assert.match(source,/自动均分/);assert.match(source,/手动片段/);assert.match(source,/clipMode==='manual'\?\{clips:manualClips\}:\{\}/);assert.match(source,/value\?\.trim\(\)\?Number\(value\):Number\.NaN/);assert.match(source,/Math\.abs\(manualTotal-targetDuration\)>0\.02/);assert.match(source,/min=\{0\.1\}/);assert.doesNotMatch(source,/语义拆分|场景识别|多变体/);});
    await check('service owns durable fencing heartbeat cleanup and bounded local concurrency',async()=>{const source=await fs.readFile(path.resolve('src/commerce/server/hot-video-remix.ts'),'utf8');const worker=await fs.readFile(path.resolve('src/commerce/server/ordinary-worker.ts'),'utf8');assert.match(source,/claimRecordLease\(/);assert.match(source,/renewRecordLease\(/);assert.match(source,/recordLeaseIsCurrent\(/);assert.match(source,/readIdempotentAsset\(/);assert.match(source,/HOT_VIDEO_REMIX_PROBE_BUCKET/);assert.match(source,/MAX_ACTIVE_PER_OWNER=2/);assert.match(source,/sweepHotVideoRemixWorkdirs/);assert.match(source,/finally\{[\s\S]*fs\.rm\(work/);assert.match(worker,/HOT_VIDEO_CONCURRENCY=2/);assert.doesNotMatch(source,/from ['"].*(?:billing|wallet|providers)['"]/);});
    await check('no billing records were created',()=>{const count=Number(store.db().prepare("SELECT COUNT(*) AS count FROM records WHERE bucket LIKE '%billing%' OR bucket LIKE '%wallet%'").get()?.count||0);assert.equal(count,0);});
    await check('no network provider wallet or browser write activity occurred',()=>{assert.equal(networkCalls,0);assert.equal(providerCalls,0);assert.equal(walletDebits,0);assert.equal(browserWrites,0);});

    console.log(JSON.stringify({schemaVersion:'commerce-hot-video-remix-contract/v1',passed:checks.length,checks,safety:{networkCalls,providerCalls,walletDebits,browserWrites,paidGeneration:0,productionWrites:0,deployment:0},output:{duration:completed.resultProbe?.duration,hasAudio:completed.resultProbe?.hasAudio,width:completed.resultProbe?.width,height:completed.resultProbe?.height},fixtureRemoved:true}));
  }finally{
    globalThis.fetch=originalFetch;
    closeDatabase?.();
    await fs.rm(fixture,{recursive:true,force:true}).catch(()=>undefined);
  }
}

function fixtureCommand(executable:string,args:string[]){
  const result=spawnSync(executable,['-hide_banner','-nostdin','-y',...args],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||'FFmpeg fixture generation failed');
}

function round(value:number){return Math.round(value*1_000_000)/1_000_000;}

function assertPublicDto(value:unknown){
  const forbidden=new Set(['owner','holder','token','lease','leaseToken','localPath','workDir','idempotencyKey']);
  const visit=(current:unknown)=>{
    if(Array.isArray(current)){for(const item of current)visit(item);return;}
    if(!current||typeof current!=='object')return;
    for(const [key,item] of Object.entries(current as Record<string,unknown>)){assert.equal(forbidden.has(key),false,`public DTO leaked ${key}`);visit(item);}
  };
  visit(value);
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
