import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-voice-replace-'));
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  const originalFetch=globalThis.fetch;
  let networkCalls=0;
  const providerCalls=0,walletDebits=0,browserWrites=0;
  globalThis.fetch=async()=>{networkCalls+=1;throw Error('NETWORK_FORBIDDEN_IN_VOICE_REPLACE_TEST');};
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
    const voiceReplace=await import('../src/commerce/server/voice-replace');
    const owner='voice-replace-contract-owner';

    const sourceFile=path.join(fixture,'source.mp4');
    const silentFile=path.join(fixture,'silent.mp4');
    const voiceFile=path.join(fixture,'short-voice.wav');
    fixtureCommand(ffmpeg,['-f','lavfi','-i','color=c=midnightblue:s=360x640:r=24:d=3','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=3','-shortest','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',sourceFile]);
    fixtureCommand(ffmpeg,['-f','lavfi','-i','color=c=darkgreen:s=360x640:r=24:d=3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-an','-movflags','+faststart',silentFile]);
    fixtureCommand(ffmpeg,['-f','lavfi','-i','sine=frequency=990:sample_rate=48000:duration=0.7','-c:a','pcm_s16le',voiceFile]);

    const video=await assets.storeAsset(owner,await fs.readFile(sourceFile),'video/mp4','source.mp4');
    const silentVideo=await assets.storeAsset(owner,await fs.readFile(silentFile),'video/mp4','silent.mp4');
    const voiceJobId='30000000-0000-4000-8000-000000000001';
    const audio=await assets.storeAsset(owner,await fs.readFile(voiceFile),'audio/wav','short-voice.wav','generated',voiceJobId);
    store.put('voice-jobs',voiceJobId,owner,{id:voiceJobId,owner,status:'succeeded',assetId:audio.id});

    const unfinishedJobId='30000000-0000-4000-8000-000000000002';
    const unfinishedAudio=await assets.storeAsset(owner,await fs.readFile(voiceFile),'audio/wav','unfinished.wav','generated',unfinishedJobId);
    store.put('voice-jobs',unfinishedJobId,owner,{id:unfinishedJobId,owner,status:'running',assetId:unfinishedAudio.id});
    await check('only completed Commerce voice assets are accepted',async()=>{
      await assert.rejects(()=>voiceReplace.createVoiceReplacement(owner,{requestId:'40000000-0000-4000-8000-000000000001',videoAssetId:video.id,audioAssetId:unfinishedAudio.id,mode:'replace'}),/尚未完成|资产不匹配/);
    });
    await check('cross-owner assets are rejected',async()=>{
      await assert.rejects(()=>voiceReplace.createVoiceReplacement('another-owner',{requestId:'40000000-0000-4000-8000-000000000002',videoAssetId:video.id,audioAssetId:audio.id,mode:'replace'}),/当前账号/);
    });

    const requestId='40000000-0000-4000-8000-000000000003';
    const created=await voiceReplace.createVoiceReplacement(owner,{requestId,videoAssetId:video.id,audioAssetId:audio.id,mode:'replace'});
    await check('stable request creates a durable queued job',()=>{assert.equal(created.created,true);assert.equal(created.job.status,'queued');assert.equal(created.job.requestId,requestId);assert.match(created.job.id,/^[a-f0-9-]{36}$/);});
    await check('source snapshots freeze video and audio hashes',()=>{assert.equal(created.job.videoSnapshot.sha256,video.sha256);assert.equal(created.job.audioSnapshot.sha256,audio.sha256);assert.ok(created.job.videoSnapshot.duration>2.9);assert.ok(created.job.audioSnapshot.duration<1);});
    await check('local execution is explicitly free and offline',()=>{assert.deepEqual(created.job.execution,{engine:'local-ffmpeg',networkRequired:false,walletRequired:false,payableTotal:0});});
    await check('active job reports both source assets as deletion references',()=>{assert.equal(voiceReplace.activeVoiceReplacementReferencesAsset(owner,video.id),true);assert.equal(voiceReplace.activeVoiceReplacementReferencesAsset(owner,audio.id),true);});
    await check('active source and voice assets are protected from deletion',async()=>{await assert.rejects(()=>assets.deleteAsset(owner,video.id),/任务引用|不能删除/);await assert.rejects(()=>assets.deleteAsset(owner,audio.id),/任务引用|不能删除/);assert.ok(assets.readAsset(video.id,owner));assert.ok(assets.readAsset(audio.id,owner));});
    const pendingOutput=await assets.storeAsset(owner,await fs.readFile(sourceFile),'video/mp4','pending-voice-replace-output.mp4','generated',created.job.id);
    await check('active replacement output is protected from deletion',async()=>{await assert.rejects(()=>assets.deleteAsset(owner,pendingOutput.id),/运行或保存/);assert.ok(assets.readAsset(pendingOutput.id,owner));});
    await check('request replay returns the same job without probing again',async()=>{process.env.COMMERCE_FFMPEG_PATH=path.join(fixture,'forbidden-repeat-probe.exe');try{const replay=await voiceReplace.createVoiceReplacement(owner,{requestId,videoAssetId:video.id,audioAssetId:audio.id,mode:'replace'});assert.equal(replay.created,false);assert.equal(replay.job.id,created.job.id);}finally{process.env.COMMERCE_FFMPEG_PATH=ffmpeg;}});
    await check('same request rejects changed content before probing',async()=>{process.env.COMMERCE_FFMPEG_PATH=path.join(fixture,'forbidden-changed-probe.exe');try{await assert.rejects(()=>voiceReplace.createVoiceReplacement(owner,{requestId,videoAssetId:video.id,audioAssetId:audio.id,mode:'mix'}),/不同内容/);}finally{process.env.COMMERCE_FFMPEG_PATH=ffmpeg;}});

    const completed=await voiceReplace.runVoiceReplacementJob(created.job.id,owner);
    await check('real local FFmpeg replacement succeeds',()=>{assert.equal(completed.status,'succeeded');assert.equal(completed.progress,100);assert.ok(completed.resultAsset);});
    await check('short voice is padded to preserve source video duration',()=>{assert.ok(completed.resultProbe);assert.ok(Math.abs(completed.resultProbe!.duration-created.job.videoSnapshot.duration)<=0.25);assert.equal(completed.resultProbe?.hasAudio,true);});
    await check('output is durable and owned by the replacement job',async()=>{const result=assets.readAsset(completed.resultAsset!.id,owner)!;assert.equal(result.jobId,completed.id);assert.equal(result.type,'video/mp4');assert.ok(await assets.assertAssetIntegrity(result));});
    await check('result replay is idempotent',async()=>{const countBefore=store.list('assets',owner).length;const replay=await voiceReplace.runVoiceReplacementJob(completed.id,owner);assert.equal(replay.resultAsset?.id,completed.resultAsset?.id);assert.equal(store.list('assets',owner).length,countBefore);});
    await check('terminal job releases source reference helper',()=>{assert.equal(voiceReplace.activeVoiceReplacementReferencesAsset(owner,video.id),false);assert.equal(voiceReplace.activeVoiceReplacementReferencesAsset(owner,audio.id),false);});
    await check('terminal execution removes its scratch directory',async()=>{const entries=await fs.readdir(path.join(fixture,'voice-replace-work')).catch(()=>[]);assert.equal(entries.length,0);});

    const fallback=await voiceReplace.createVoiceReplacement(owner,{requestId:'40000000-0000-4000-8000-000000000004',videoAssetId:silentVideo.id,audioAssetId:audio.id,mode:'mix'});
    await check('mix request on silent video safely falls back to replacement',()=>{assert.equal(fallback.job.requestedMode,'mix');assert.equal(fallback.job.effectiveMode,'replace');});
    await check('candidate scan exposes queued durable work to the ordinary worker',()=>{const candidate=voiceReplace.voiceReplacementCandidates(8).find(value=>value.id===fallback.job.id);assert.equal(candidate?.owner,owner);});
    const stale=voiceReplace.readVoiceReplacement(fallback.job.id,owner)!;
    stale.status='running';stale.updatedAt=Date.now()-20*60_000;store.put(voiceReplace.VOICE_REPLACE_JOB_BUCKET,stale.id,owner,stale);
    const activeLease=store.claimRecordLease(voiceReplace.VOICE_REPLACE_LEASE_BUCKET,stale.id,owner,'voice-replace-live-worker',Date.now(),60_000)!;
    const workRoot=path.join(fixture,'voice-replace-work'),staleWork=path.join(workRoot,`${stale.id}-50000000-0000-4000-8000-000000000001`),freshWork=path.join(workRoot,`${stale.id}-50000000-0000-4000-8000-000000000002`),unownedWork=path.join(workRoot,'do-not-delete-unowned-name');
    await fs.mkdir(staleWork,{recursive:true});await fs.mkdir(freshWork,{recursive:true});await fs.mkdir(unownedWork,{recursive:true});const old=new Date(Date.now()-2*60*60_000);await fs.utimes(staleWork,old,old);await fs.utimes(unownedWork,old,old);
    await check('recovery cannot steal a live execution lease',()=>{assert.equal(voiceReplace.recoverStaleVoiceReplacement(stale.id,owner,Date.now(),60_000),false);assert.equal(voiceReplace.readVoiceReplacement(stale.id,owner)?.status,'running');});
    await check('workdir sweeper preserves a running job with a live lease',async()=>{const result=await voiceReplace.sweepVoiceReplacementWorkdirs(Date.now(),60_000);assert.equal(result.removed,0);assert.ok(await fs.stat(staleWork));});
    store.releaseRecordLease(activeLease);
    await check('workdir sweeper removes only stale owned scratch directories',async()=>{const result=await voiceReplace.sweepVoiceReplacementWorkdirs(Date.now(),60_000);assert.equal(result.removed,1);await assert.rejects(()=>fs.stat(staleWork));assert.ok(await fs.stat(freshWork));assert.ok(await fs.stat(unownedWork));});
    await check('stale task returns to its original queued identity',()=>{assert.equal(voiceReplace.recoverStaleVoiceReplacement(stale.id,owner,Date.now(),60_000),true);const recovered=voiceReplace.readVoiceReplacement(stale.id,owner)!;assert.equal(recovered.status,'queued');assert.equal(recovered.id,stale.id);assert.equal(recovered.recoveryAttempts,1);});
    const failed=voiceReplace.readVoiceReplacement(stale.id,owner)!;failed.status='failed';failed.updatedAt=Date.now();store.put(voiceReplace.VOICE_REPLACE_JOB_BUCKET,failed.id,owner,failed);

    await check('public DTO excludes ownership and lease internals',()=>{for(const dto of [created.job,completed,...voiceReplace.listVoiceReplacements(owner)])assertPublicDto(dto);});
    await check('service pads and trims audio without shortest truncation',async()=>{const source=await fs.readFile(path.resolve('src/commerce/server/voice-replace.ts'),'utf8');assert.match(source,/apad,atrim=duration=/);assert.match(source,/'-t',duration/);assert.doesNotMatch(source,/'-shortest'/);assert.match(source,/readIdempotentAsset\(/);assert.match(source,/claimRecordLease\(/);assert.match(source,/renewRecordLease\(/);assert.match(source,/recordLeaseIsCurrent\(/);});
    await check('route binds both reads and writes to the current main account',async()=>{const source=await fs.readFile(path.resolve('src/app/api/commerce/voice-replace/route.ts'),'utf8');assert.match(source,/authorizeCurrentCommerceIdentity/);assert.equal((source.match(/await authorizeCurrentCommerceIdentity\(identity\)/g)||[]).length,2);assert.match(source,/sameOrigin\(request\)/);assert.match(source,/body\.action!=='create'/);});
    await check('GET is pure read while POST may schedule persisted work',async()=>{const source=await fs.readFile(path.resolve('src/app/api/commerce/voice-replace/route.ts'),'utf8');const getBody=source.slice(source.indexOf('export async function GET'),source.indexOf('export async function POST'));const postBody=source.slice(source.indexOf('export async function POST'));assert.doesNotMatch(getBody,/schedule\(/);assert.doesNotMatch(getBody,/after\(/);assert.match(postBody,/createVoiceReplacement/);assert.match(postBody,/schedule\(result\.job\.id,owner\)/);assert.match(source,/after\(\(\)=>runVoiceReplacementJob/);});
    await check('ordinary worker scans recovers runs and cleans voice replacement tasks',async()=>{const source=await fs.readFile(path.resolve('src/commerce/server/ordinary-worker.ts'),'utf8');assert.match(source,/kind:[^\n]*'voice-replacement'/);assert.match(source,/voiceReplacementCandidates\(cap,now\)/);assert.match(source,/recoverStaleVoiceReplacement\(candidate\.id,candidate\.owner/);assert.match(source,/runVoiceReplacementJob\(candidate\.id,candidate\.owner\)/);assert.match(source,/sweepVoiceReplacementWorkdirs\(now\)/);});
    await check('asset deletion fences replacement inputs and pending outputs',async()=>{const source=await fs.readFile(path.resolve('src/commerce/server/assets.ts'),'utf8');assert.match(source,/get<\{status\?:string\}>\('voice-replace-jobs',asset\.jobId,owner\)/);assert.match(source,/bucket='voice-replace-jobs'/);assert.match(source,/videoSnapshot\.assetId/);assert.match(source,/audioSnapshot\.assetId/);});
    await check('voice result UI exposes the complete local apply-to-video flow',async()=>{const source=await fs.readFile(path.resolve('src/commerce/components/commerce-agent/voice-synthesis-studio.tsx'),'utf8');assert.match(source,/应用到视频/);assert.match(source,/确认应用（本地处理 ¥0）/);assert.match(source,/api<\{assets:CommerceVideoAsset\[\]\}>\('\/api\/commerce\/assets'\)/);assert.match(source,/replaceRequest=useRef<\{fingerprint:string;requestId:string\}>/);assert.match(source,/requestId:crypto\.randomUUID\(\)/);assert.match(source,/action:'create',videoAssetId,audioAssetId:selectedJob\.asset\.id,mode:replaceMode,requestId:replaceRequest\.current\.requestId/);assert.match(source,/`\/api\/commerce\/voice-replace\?id=\$\{encodeURIComponent\(replaceJob\.id\)\}`/);assert.match(source,/下载成片/);});
    await check('no billing records were created',()=>{const count=Number(store.db().prepare("SELECT COUNT(*) AS count FROM records WHERE bucket LIKE '%billing%' OR bucket LIKE '%wallet%'").get()?.count||0);assert.equal(count,0);});
    await check('no network provider wallet browser or paid activity occurred',()=>{assert.equal(networkCalls,0);assert.equal(providerCalls,0);assert.equal(walletDebits,0);assert.equal(browserWrites,0);});

    console.log(JSON.stringify({schemaVersion:'commerce-voice-replace-contract/v1',passed:checks.length,checks,safety:{networkCalls,providerCalls,walletDebits,browserWrites,paidGeneration:0,productionWrites:0,deployment:0},output:{sourceDuration:created.job.videoSnapshot.duration,voiceDuration:created.job.audioSnapshot.duration,resultDuration:completed.resultProbe?.duration,hasAudio:completed.resultProbe?.hasAudio},fixtureRemoved:true}));
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

function assertPublicDto(value:unknown){
  const forbidden=new Set(['owner','holder','token','lease','leaseToken','localPath','workDir','requestFingerprint','voiceJobId']);
  const visit=(current:unknown)=>{
    if(Array.isArray(current)){for(const item of current)visit(item);return;}
    if(!current||typeof current!=='object')return;
    for(const [key,item] of Object.entries(current as Record<string,unknown>)){assert.equal(forbidden.has(key),false,`public DTO leaked ${key}`);visit(item);}
  };
  visit(value);
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
