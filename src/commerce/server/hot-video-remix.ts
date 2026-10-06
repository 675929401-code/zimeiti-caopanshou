import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  claim,
  claimRecordLease,
  db,
  get,
  list,
  put,
  recordLeaseIsCurrent,
  releaseRecordLease,
  renewRecordLease,
  runtimeDir,
  transaction,
  type DurableRecordLease,
} from './store';
import {
  assetBytes,
  assertAssetIntegrity,
  publicAsset,
  readAsset,
  readIdempotentAsset,
  storeAsset,
  type Asset,
  type PublicAsset,
} from './assets';
import {runFFmpeg} from './media-tools';

export const HOT_VIDEO_REMIX_QUOTE_BUCKET='hot-video-remix-quotes';
export const HOT_VIDEO_REMIX_JOB_BUCKET='hot-video-remix-jobs';
export const HOT_VIDEO_REMIX_LEASE_BUCKET='hot-video-remix-leases';
const HOT_VIDEO_REMIX_PROBE_BUCKET='hot-video-remix-probes';

const QUOTE_TTL_MS=15*60_000;
const EXECUTION_LEASE_MS=120_000;
const DEFAULT_STALE_AFTER_MS=10*60_000;
const DEFAULT_WORKDIR_TTL_MS=6*60*60_000;
const MAX_SOURCES=3;
const MAX_ACTIVE_PER_OWNER=2;
const MAX_CLIPS=12;
const MIN_DURATION=2;
const MAX_DURATION=60;

export type HotVideoRemixAspectRatio='9:16'|'16:9'|'1:1';
export type HotVideoRemixStatus='queued'|'running'|'succeeded'|'failed';

export type HotVideoRemixQuoteInput={
  requestId:string;
  sourceAssetIds:string[];
  bgmAssetId?:string;
  targetDuration:number;
  aspectRatio:HotVideoRemixAspectRatio;
  preserveSourceAudio?:boolean;
  bgmVolume?:number;
  clips?:Array<{assetId:string;start:number;duration:number}>;
};

export type HotVideoRemixSourceSnapshot={
  assetId:string;
  name:string;
  type:string;
  size:number;
  sha256:string;
  duration:number;
  hasAudio:boolean;
  width?:number;
  height?:number;
};

export type HotVideoRemixClip={
  assetId:string;
  start:number;
  duration:number;
  order:number;
};

export type HotVideoRemixSettings={
  targetDuration:number;
  aspectRatio:HotVideoRemixAspectRatio;
  preserveSourceAudio:boolean;
  bgmVolume:number;
  width:number;
  height:number;
  fps:24;
  audioSampleRate:48000;
};

export type HotVideoRemixQuote={
  schema:'commerce-hot-video-remix-quote/v1';
  id:string;
  owner:string;
  requestId:string;
  createdAt:number;
  expiresAt:number;
  inputFingerprint:string;
  requestFingerprint:string;
  sourceAssetIds:string[];
  bgmAssetId?:string;
  sourceSnapshots:HotVideoRemixSourceSnapshot[];
  bgmSnapshot?:HotVideoRemixSourceSnapshot;
  clipPlan:HotVideoRemixClip[];
  settings:HotVideoRemixSettings;
  jobId?:string;
};

export type HotVideoRemixEvent={
  at:number;
  stage:'queued'|'running'|'sources-verified'|'clips-normalized'|'concatenated'|'bgm-mixed'|'asset-saved'|'succeeded'|'failed'|'recovered';
};

export type HotVideoRemixOutputProbe={
  duration:number;
  hasAudio:boolean;
  width:number;
  height:number;
};

export type HotVideoRemixJob={
  schema:'commerce-hot-video-remix-job/v1';
  id:string;
  owner:string;
  quoteId:string;
  requestId:string;
  status:HotVideoRemixStatus;
  sourceAssetIds:string[];
  bgmAssetId?:string;
  sourceSnapshots:HotVideoRemixSourceSnapshot[];
  bgmSnapshot?:HotVideoRemixSourceSnapshot;
  clipPlan:HotVideoRemixClip[];
  settings:HotVideoRemixSettings;
  events:HotVideoRemixEvent[];
  createdAt:number;
  updatedAt:number;
  startedAt?:number;
  finishedAt?:number;
  resultAssetId?:string;
  resultProbe?:HotVideoRemixOutputProbe;
  error?:string;
  recoveryAttempts?:number;
  recoveredAt?:number;
};

export type PublicHotVideoRemixQuote={
  id:string;
  quoteId:string;
  requestId:string;
  status:'quoted'|'confirmed';
  createdAt:number;
  expiresAt:number;
  inputFingerprint:string;
  sourceSnapshots:HotVideoRemixSourceSnapshot[];
  bgmSnapshot?:HotVideoRemixSourceSnapshot;
  clipPlan:HotVideoRemixClip[];
  settings:HotVideoRemixSettings;
  pricing:{currency:'CNY';payableTotal:0;estimatedTotalCost:0;billingUnit:'local_free'};
  execution:{engine:'local-ffmpeg';networkRequired:false;walletRequired:false};
};

export type PublicHotVideoRemixJob={
  id:string;
  quoteId:string;
  requestId:string;
  status:HotVideoRemixStatus;
  sourceSnapshots:HotVideoRemixSourceSnapshot[];
  bgmSnapshot?:HotVideoRemixSourceSnapshot;
  clipPlan:HotVideoRemixClip[];
  settings:HotVideoRemixSettings;
  events:HotVideoRemixEvent[];
  progress:number;
  createdAt:number;
  updatedAt:number;
  startedAt?:number;
  finishedAt?:number;
  resultAsset?:PublicAsset;
  resultProbe?:HotVideoRemixOutputProbe;
  error?:string;
  recoveryAttempts?:number;
  recoveredAt?:number;
};

function stableJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}
function round(value:number){return Math.round(value*1_000_000)/1_000_000;}
function validId(value:unknown){return typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);}
function durationFromOutput(output:string){const match=output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);return match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):0;}
function outputHasAudio(output:string){return /Stream #[^\r\n]*\bAudio:/u.test(output);}
function outputDimensions(output:string){const match=output.match(/Stream #[^\r\n]*\bVideo:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/u);return match?{width:Number(match[1]),height:Number(match[2])}:undefined;}
function assetPath(assetId:string){return path.join(runtimeDir(),'assets',assetId);}

/** Remove only stale direct children of the dedicated remix scratch root. */
export async function sweepHotVideoRemixWorkdirs(now=Date.now(),ttlMs=DEFAULT_WORKDIR_TTL_MS,limit=64){
  const runtimeRoot=path.resolve(runtimeDir());
  const workRoot=path.resolve(runtimeRoot,'hot-video-remix-work');
  if(path.dirname(workRoot)!==runtimeRoot)throw Error('爆款视频二创临时目录越界');
  let entries:import('node:fs').Dirent[];
  try{entries=await fs.readdir(workRoot,{withFileTypes:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {examined:0,removed:0};throw error;}
  let examined=0,removed=0;
  for(const entry of entries){
    if(examined>=Math.max(1,Math.min(512,Math.trunc(limit)||64)))break;
    examined+=1;
    const match=entry.name.match(/^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    if(!match)continue;
    const child=path.resolve(workRoot,entry.name);
    if(path.dirname(child)!==workRoot)continue;
    const stat=await fs.lstat(child).catch(()=>undefined);
    if(!stat||stat.mtimeMs>now-Math.max(60_000,ttlMs))continue;
    const jobRow=db().prepare("SELECT owner,value FROM records WHERE bucket=? AND id=? LIMIT 1").get(HOT_VIDEO_REMIX_JOB_BUCKET,match[1]) as {owner?:string;value?:string}|undefined;
    if(jobRow?.owner&&jobRow.value){
      const job=JSON.parse(jobRow.value) as HotVideoRemixJob;
      const lease=get<DurableRecordLease>(HOT_VIDEO_REMIX_LEASE_BUCKET,match[1],jobRow.owner);
      if(job.status==='running'&&lease&&lease.expiresAt>now)continue;
    }
    if(stat.isSymbolicLink()||stat.isFile())await fs.unlink(child).catch(()=>undefined);
    else if(stat.isDirectory())await fs.rm(child,{recursive:true,force:true}).catch(()=>undefined);
    else continue;
    removed+=1;
  }
  return {examined,removed};
}

async function probeVideo(asset:Asset):Promise<HotVideoRemixSourceSnapshot>{
  await assertAssetIntegrity(asset);
  const cached=get<HotVideoRemixSourceSnapshot>(HOT_VIDEO_REMIX_PROBE_BUCKET,asset.id,asset.owner);
  if(cached?.sha256===asset.sha256&&cached.size===asset.size&&cached.type===asset.type&&cached.duration>0&&cached.width&&cached.height)return {...cached,name:asset.name};
  const output=await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',assetPath(asset.id),'-map','0:v:0','-frames:v','1','-f','null','-'],30_000);
  const duration=durationFromOutput(output),dimensions=outputDimensions(output);
  if(!duration||!dimensions)throw Error(`无法读取视频“${asset.name}”的时长或尺寸`);
  const snapshot={assetId:asset.id,name:asset.name,type:asset.type,size:asset.size,sha256:asset.sha256,duration:round(duration),hasAudio:outputHasAudio(output),...dimensions};
  put(HOT_VIDEO_REMIX_PROBE_BUCKET,asset.id,asset.owner,snapshot);return snapshot;
}

async function probeBgm(asset:Asset):Promise<HotVideoRemixSourceSnapshot>{
  await assetBytes(asset);
  const cached=get<HotVideoRemixSourceSnapshot>(HOT_VIDEO_REMIX_PROBE_BUCKET,asset.id,asset.owner);
  if(cached?.sha256===asset.sha256&&cached.size===asset.size&&cached.type===asset.type&&cached.duration>0&&cached.hasAudio)return {...cached,name:asset.name};
  const output=await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',assetPath(asset.id),'-map','0:a:0','-t','0.02','-f','null','-'],30_000);
  const duration=durationFromOutput(output);
  if(!duration||!outputHasAudio(output))throw Error(`无法读取配乐“${asset.name}”的有效音轨`);
  const snapshot={assetId:asset.id,name:asset.name,type:asset.type,size:asset.size,sha256:asset.sha256,duration:round(duration),hasAudio:true};
  put(HOT_VIDEO_REMIX_PROBE_BUCKET,asset.id,asset.owner,snapshot);return snapshot;
}

function normalizedSettings(input:HotVideoRemixQuoteInput):HotVideoRemixSettings{
  const duration=Number(input.targetDuration);
  if(!Number.isFinite(duration)||duration<MIN_DURATION||duration>MAX_DURATION)throw Error(`成片时长须为 ${MIN_DURATION}–${MAX_DURATION} 秒`);
  if(!['9:16','16:9','1:1'].includes(input.aspectRatio))throw Error('成片画幅无效');
  const dimensions=input.aspectRatio==='9:16'?{width:720,height:1280}:input.aspectRatio==='16:9'?{width:1280,height:720}:{width:720,height:720};
  const bgmVolume=input.bgmAssetId?Number(input.bgmVolume??0.18):0;
  if(!Number.isFinite(bgmVolume)||bgmVolume<0||bgmVolume>1)throw Error('配乐音量须为 0–1');
  return {targetDuration:round(duration),aspectRatio:input.aspectRatio,preserveSourceAudio:input.preserveSourceAudio!==false,bgmVolume:round(bgmVolume),...dimensions,fps:24,audioSampleRate:48000};
}

function exactPlan(input:HotVideoRemixQuoteInput,snapshots:HotVideoRemixSourceSnapshot[],settings:HotVideoRemixSettings){
  const clips=input.clips;
  if(!clips?.length)return undefined;
  if(clips.length>MAX_CLIPS)throw Error(`片段数量不能超过 ${MAX_CLIPS} 个`);
  const allowed=new Map(snapshots.map(value=>[value.assetId,value]));
  const plan=clips.map((clip,order)=>{
    const snapshot=allowed.get(clip.assetId),start=Number(clip.start),duration=Number(clip.duration);
    if(!snapshot)throw Error('片段引用了未选择的视频素材');
    if(!Number.isFinite(start)||!Number.isFinite(duration)||start<0||duration<0.1||start+duration>snapshot.duration+0.02)throw Error(`视频“${snapshot.name}”的截取区间无效`);
    return {assetId:clip.assetId,start:round(start),duration:round(duration),order};
  });
  const total=round(plan.reduce((sum,value)=>sum+value.duration,0));
  if(Math.abs(total-settings.targetDuration)>0.02)throw Error('自定义片段总时长必须等于成片时长');
  const drift=settings.targetDuration-total;
  if(Math.abs(drift)>0)plan[plan.length-1].duration=round(plan[plan.length-1].duration+drift);
  return plan;
}

function automaticPlan(snapshots:HotVideoRemixSourceSnapshot[],targetDuration:number){
  const total=snapshots.reduce((sum,value)=>sum+value.duration,0);
  if(total+0.02<targetDuration)throw Error('所选视频的可用总时长不足，请减少成片时长或增加素材');
  const remainingCapacity=[...snapshots.map(value=>value.duration)];
  const allocations=new Array(snapshots.length).fill(0) as number[];
  let remaining=targetDuration;
  for(let pass=0;pass<snapshots.length&&remaining>0.000001;pass++){
    const candidates=remainingCapacity.map((capacity,index)=>({capacity,index})).filter(value=>value.capacity>0.000001);
    if(!candidates.length)break;
    const share=remaining/candidates.length;
    for(const candidate of candidates){const take=Math.min(candidate.capacity,share);allocations[candidate.index]+=take;remaining-=take;remainingCapacity[candidate.index]-=take;}
  }
  if(remaining>0.02)throw Error('无法为当前素材生成确定性片段计划');
  const plan:HotVideoRemixClip[]=[];
  allocations.forEach((allocated,index)=>{
    if(allocated<0.001)return;
    const snapshot=snapshots[index];
    const start=Math.max(0,(snapshot.duration-allocated)/2);
    plan.push({assetId:snapshot.assetId,start:round(start),duration:round(allocated),order:plan.length});
  });
  const drift=round(targetDuration-plan.reduce((sum,value)=>sum+value.duration,0));
  if(plan.length&&Math.abs(drift)>0)plan[plan.length-1].duration=round(plan[plan.length-1].duration+drift);
  return plan;
}

export function publicHotVideoRemixQuote(value:HotVideoRemixQuote):PublicHotVideoRemixQuote{
  return {
    id:value.id,
    quoteId:value.id,
    requestId:value.requestId,
    status:value.jobId?'confirmed':'quoted',
    createdAt:value.createdAt,
    expiresAt:value.expiresAt,
    inputFingerprint:value.inputFingerprint,
    sourceSnapshots:value.sourceSnapshots.map(item=>({...item})),
    ...(value.bgmSnapshot?{bgmSnapshot:{...value.bgmSnapshot}}:{}),
    clipPlan:value.clipPlan.map(item=>({...item})),
    settings:{...value.settings},
    pricing:{currency:'CNY',payableTotal:0,estimatedTotalCost:0,billingUnit:'local_free'},
    execution:{engine:'local-ffmpeg',networkRequired:false,walletRequired:false},
  };
}

function progress(value:HotVideoRemixJob){
  if(value.status==='succeeded')return 100;
  if(value.status==='failed')return 100;
  const stages=value.events.map(event=>event.stage);
  if(stages.includes('asset-saved'))return 95;
  if(stages.includes('bgm-mixed')||stages.includes('concatenated'))return 80;
  if(stages.includes('clips-normalized'))return 60;
  if(stages.includes('sources-verified'))return 25;
  return value.status==='running'?10:0;
}

export function publicHotVideoRemixJob(value:HotVideoRemixJob):PublicHotVideoRemixJob{
  const result=value.resultAssetId?readAsset(value.resultAssetId,value.owner):undefined;
  return {
    id:value.id,
    quoteId:value.quoteId,
    requestId:value.requestId,
    status:value.status,
    sourceSnapshots:value.sourceSnapshots.map(item=>({...item})),
    ...(value.bgmSnapshot?{bgmSnapshot:{...value.bgmSnapshot}}:{}),
    clipPlan:value.clipPlan.map(item=>({...item})),
    settings:{...value.settings},
    events:value.events.map(event=>({...event})),
    progress:progress(value),
    createdAt:value.createdAt,
    updatedAt:value.updatedAt,
    ...(value.startedAt?{startedAt:value.startedAt}:{}),
    ...(value.finishedAt?{finishedAt:value.finishedAt}:{}),
    ...(result?{resultAsset:publicAsset(result)}:{}),
    ...(value.resultProbe?{resultProbe:{...value.resultProbe}}:{}),
    ...(value.error?{error:value.error}:{}),
    ...(value.recoveryAttempts?{recoveryAttempts:value.recoveryAttempts}:{}),
    ...(value.recoveredAt?{recoveredAt:value.recoveredAt}:{}),
  };
}

export async function quoteHotVideoRemix(owner:string,input:HotVideoRemixQuoteInput){
  if(!owner)throw Error('带货工作区身份无效');
  if(!validId(input.requestId))throw Error('请求号无效');
  if(!Array.isArray(input.sourceAssetIds)||input.sourceAssetIds.length<1||input.sourceAssetIds.length>MAX_SOURCES||new Set(input.sourceAssetIds).size!==input.sourceAssetIds.length)throw Error(`请选择 1–${MAX_SOURCES} 个不重复的视频素材`);
  const settings=normalizedSettings(input);
  const requestKey=`${owner}:hot-video-remix-quote:${input.requestId}`;
  const requestFingerprint=sha({sourceAssetIds:input.sourceAssetIds,bgmAssetId:input.bgmAssetId||null,settings,clips:Array.isArray(input.clips)?input.clips.map(value=>({assetId:String(value.assetId||''),start:round(Number(value.start)),duration:round(Number(value.duration))})):null});
  const requestRow=db().prepare('SELECT job_id FROM requests WHERE request_key=?').get(requestKey) as {job_id?:string}|undefined;
  if(requestRow?.job_id){
    const existing=get<HotVideoRemixQuote>(HOT_VIDEO_REMIX_QUOTE_BUCKET,String(requestRow.job_id),owner);
    if(!existing)throw Error('爆款视频二创报价请求已占用但记录缺失');
    if(existing.requestFingerprint&&existing.requestFingerprint!==requestFingerprint)throw Error('同一个请求号对应了不同内容，请重新确认任务。');
    if(existing.requestFingerprint===requestFingerprint)return publicHotVideoRemixQuote(existing);
  }
  const sourceAssets=input.sourceAssetIds.map(id=>{
    const asset=readAsset(id,owner);
    if(!asset||!asset.type.startsWith('video/'))throw Error('请选择当前带货工作区中的视频素材');
    return asset;
  });
  const sourceSnapshots=[] as HotVideoRemixSourceSnapshot[];
  for(const asset of sourceAssets)sourceSnapshots.push(await probeVideo(asset));
  let bgmSnapshot:HotVideoRemixSourceSnapshot|undefined;
  if(input.bgmAssetId){
    const asset=readAsset(input.bgmAssetId,owner);
    if(!asset||!asset.type.startsWith('audio/'))throw Error('请选择当前带货工作区中的音频素材');
    bgmSnapshot=await probeBgm(asset);
  }
  const clipPlan=exactPlan(input,sourceSnapshots,settings)||automaticPlan(sourceSnapshots,settings.targetDuration);
  const normalized={
    requestId:input.requestId,
    sourceAssetIds:[...input.sourceAssetIds],
    ...(input.bgmAssetId?{bgmAssetId:input.bgmAssetId}:{}),
    sourceSnapshots,
    ...(bgmSnapshot?{bgmSnapshot}:{}),
    clipPlan,
    settings,
  };
  const inputFingerprint=sha({schema:'commerce-hot-video-remix-input/v1',...normalized});
  const now=Date.now(),id=randomUUID();
  const value:HotVideoRemixQuote={schema:'commerce-hot-video-remix-quote/v1',id,owner,createdAt:now,expiresAt:now+QUOTE_TTL_MS,inputFingerprint,requestFingerprint,...normalized};
  const result=transaction(()=>{const request=claim(requestKey,inputFingerprint,id);if(request.created)put(HOT_VIDEO_REMIX_QUOTE_BUCKET,id,owner,value);return request;});
  const stored=get<HotVideoRemixQuote>(HOT_VIDEO_REMIX_QUOTE_BUCKET,result.id,owner);
  if(!stored)throw Error('爆款视频二创报价保存失败');
  return publicHotVideoRemixQuote(stored);
}

export function confirmHotVideoRemix(owner:string,quoteId:string){
  if(!validId(quoteId))throw Error('报价身份无效');
  return transaction(()=>{
    const quote=get<HotVideoRemixQuote>(HOT_VIDEO_REMIX_QUOTE_BUCKET,quoteId,owner);
    if(!quote)throw Error('报价不存在或不属于当前账号');
    if(quote.jobId){
      const existing=get<HotVideoRemixJob>(HOT_VIDEO_REMIX_JOB_BUCKET,quote.jobId,owner);
      if(!existing||existing.quoteId!==quote.id)throw Error('报价确认记录不完整');
      return {job:publicHotVideoRemixJob(existing),created:false};
    }
    if(quote.expiresAt<=Date.now())throw Error('报价已过期，请重新获取');
    if(list<HotVideoRemixJob>(HOT_VIDEO_REMIX_JOB_BUCKET,owner).filter(value=>['queued','running'].includes(value.status)).length>=MAX_ACTIVE_PER_OWNER)throw Error(`当前已有 ${MAX_ACTIVE_PER_OWNER} 个爆款视频二创任务，完成后再确认新任务`);
    const now=Date.now(),id=randomUUID();
    const job:HotVideoRemixJob={
      schema:'commerce-hot-video-remix-job/v1',id,owner,quoteId:quote.id,requestId:quote.requestId,status:'queued',
      sourceAssetIds:[...quote.sourceAssetIds],...(quote.bgmAssetId?{bgmAssetId:quote.bgmAssetId}:{}),
      sourceSnapshots:quote.sourceSnapshots.map(item=>({...item})),...(quote.bgmSnapshot?{bgmSnapshot:{...quote.bgmSnapshot}}:{}),
      clipPlan:quote.clipPlan.map(item=>({...item})),settings:{...quote.settings},events:[{at:now,stage:'queued'}],createdAt:now,updatedAt:now,
    };
    quote.jobId=id;
    put(HOT_VIDEO_REMIX_JOB_BUCKET,id,owner,job);
    put(HOT_VIDEO_REMIX_QUOTE_BUCKET,quote.id,owner,quote);
    return {job:publicHotVideoRemixJob(job),created:true};
  });
}

export const readHotVideoRemix=(id:string,owner:string)=>get<HotVideoRemixJob>(HOT_VIDEO_REMIX_JOB_BUCKET,id,owner);
export const listHotVideoRemixes=(owner:string)=>list<HotVideoRemixJob>(HOT_VIDEO_REMIX_JOB_BUCKET,owner).map(publicHotVideoRemixJob);

function pushEvent(value:HotVideoRemixJob,stage:HotVideoRemixEvent['stage']){value.events.push({at:Date.now(),stage});value.updatedAt=Date.now();}
function persistWithLease(value:HotVideoRemixJob,lease:DurableRecordLease){
  transaction(()=>{
    if(!recordLeaseIsCurrent(lease))throw Error('爆款视频二创执行租约已经失效');
    const current=get<HotVideoRemixJob>(HOT_VIDEO_REMIX_JOB_BUCKET,value.id,value.owner);
    if(!current||current.quoteId!==value.quoteId)throw Error('爆款视频二创任务身份已改变');
    put(HOT_VIDEO_REMIX_JOB_BUCKET,value.id,value.owner,value);
  });
}

async function verifyFrozenInputs(value:HotVideoRemixJob,guard:()=>boolean){
  for(const snapshot of value.sourceSnapshots){
    if(!guard())throw Error('爆款视频二创执行租约已经失效');
    const asset=readAsset(snapshot.assetId,value.owner);
    if(!asset||asset.sha256!==snapshot.sha256||asset.size!==snapshot.size||asset.type!==snapshot.type)throw Error(`视频素材“${snapshot.name}”已改变，请重新报价`);
    const bytes=await assertAssetIntegrity(asset);
    if(createHash('sha256').update(bytes).digest('hex')!==snapshot.sha256)throw Error(`视频素材“${snapshot.name}”内容校验失败`);
  }
  if(value.bgmSnapshot){
    if(!guard())throw Error('爆款视频二创执行租约已经失效');
    const asset=readAsset(value.bgmSnapshot.assetId,value.owner);
    if(!asset||asset.sha256!==value.bgmSnapshot.sha256||asset.size!==value.bgmSnapshot.size||asset.type!==value.bgmSnapshot.type)throw Error(`配乐“${value.bgmSnapshot.name}”已改变，请重新报价`);
    const bytes=await assetBytes(asset);
    if(createHash('sha256').update(bytes).digest('hex')!==value.bgmSnapshot.sha256)throw Error(`配乐“${value.bgmSnapshot.name}”内容校验失败`);
  }
}

function videoFilter(settings:HotVideoRemixSettings){return `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=increase,crop=${settings.width}:${settings.height},setsar=1,fps=${settings.fps},format=yuv420p,setpts=PTS-STARTPTS`;}

async function normalizeClip(value:HotVideoRemixJob,clip:HotVideoRemixClip,snapshot:HotVideoRemixSourceSnapshot,output:string,guard:()=>boolean){
  if(!guard())throw Error('爆款视频二创执行租约已经失效');
  const duration=String(clip.duration),source=assetPath(clip.assetId);
  if(value.settings.preserveSourceAudio&&snapshot.hasAudio){
    await runFFmpeg(['-hide_banner','-nostdin','-y','-ss',String(clip.start),'-protocol_whitelist','file,pipe','-i',source,'-t',duration,'-filter_complex',`[0:v:0]${videoFilter(value.settings)}[v];[0:a:0]aresample=${value.settings.audioSampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${duration},asetpts=PTS-STARTPTS[a]`,'-map','[v]','-map','[a]','-map_metadata','-1','-c:v','libx264','-threads','2','-preset','veryfast','-crf','21','-r',String(value.settings.fps),'-fps_mode','cfr','-c:a','aac','-ar',String(value.settings.audioSampleRate),'-ac','2','-t',duration,'-movflags','+faststart',output],240_000);
  }else{
    await runFFmpeg(['-hide_banner','-nostdin','-y','-ss',String(clip.start),'-protocol_whitelist','file,pipe','-i',source,'-f','lavfi','-t',duration,'-i',`anullsrc=r=${value.settings.audioSampleRate}:cl=stereo`,'-filter_complex',`[0:v:0]${videoFilter(value.settings)}[v];[1:a:0]atrim=0:${duration},asetpts=PTS-STARTPTS[a]`,'-map','[v]','-map','[a]','-map_metadata','-1','-c:v','libx264','-threads','2','-preset','veryfast','-crf','21','-r',String(value.settings.fps),'-fps_mode','cfr','-c:a','aac','-ar',String(value.settings.audioSampleRate),'-ac','2','-t',duration,'-movflags','+faststart',output],240_000);
  }
  if(!guard())throw Error('爆款视频二创执行租约已经失效');
}

function concatLine(file:string){return `file '${file.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`;}

async function renderFinal(value:HotVideoRemixJob,work:string,guard:()=>boolean,lease:DurableRecordLease){
  const snapshotById=new Map(value.sourceSnapshots.map(snapshot=>[snapshot.assetId,snapshot]));
  const normalized:string[]=[];
  for(const clip of value.clipPlan){
    const snapshot=snapshotById.get(clip.assetId);
    if(!snapshot)throw Error('冻结片段计划缺少素材快照');
    const output=path.join(work,`clip-${String(clip.order).padStart(2,'0')}.mp4`);
    await normalizeClip(value,clip,snapshot,output,guard);
    normalized.push(output);
  }
  pushEvent(value,'clips-normalized');persistWithLease(value,lease);
  const listFile=path.join(work,'concat.txt'),combined=path.join(work,'combined.mp4');
  await fs.writeFile(listFile,normalized.map(concatLine).join('\n'),'utf8');
  await runFFmpeg(['-hide_banner','-nostdin','-y','-f','concat','-safe','0','-protocol_whitelist','file,pipe','-i',listFile,'-map','0:v:0','-map','0:a:0','-c','copy','-movflags','+faststart',combined],180_000);
  if(!guard())throw Error('爆款视频二创执行租约已经失效');
  pushEvent(value,'concatenated');persistWithLease(value,lease);
  const output=path.join(work,'result.mp4'),target=String(value.settings.targetDuration);
  if(value.bgmSnapshot){
    const bgm=assetPath(value.bgmSnapshot.assetId);
    const sourceAudio=value.settings.preserveSourceAudio
      ?`[0:a:0]aresample=${value.settings.audioSampleRate},atrim=0:${target},asetpts=PTS-STARTPTS[source];[1:a:0]aresample=${value.settings.audioSampleRate},volume=${value.settings.bgmVolume},atrim=0:${target},asetpts=PTS-STARTPTS[music];[source][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`
      :`[1:a:0]aresample=${value.settings.audioSampleRate},volume=${value.settings.bgmVolume},atrim=0:${target},asetpts=PTS-STARTPTS[aout]`;
    await runFFmpeg(['-hide_banner','-nostdin','-y','-i',combined,'-stream_loop','-1','-protocol_whitelist','file,pipe','-i',bgm,'-filter_complex',sourceAudio,'-map','0:v:0','-map','[aout]','-map_metadata','-1','-c:v','copy','-c:a','aac','-ar',String(value.settings.audioSampleRate),'-ac','2','-t',target,'-movflags','+faststart',output],180_000);
    if(!guard())throw Error('爆款视频二创执行租约已经失效');
    pushEvent(value,'bgm-mixed');persistWithLease(value,lease);
  }else{
    await runFFmpeg(['-hide_banner','-nostdin','-y','-i',combined,'-map','0:v:0',...(value.settings.preserveSourceAudio?['-map','0:a:0','-c:a','copy']:['-an']),'-map_metadata','-1','-c:v','copy','-t',target,'-movflags','+faststart',output],120_000);
  }
  return output;
}

async function probeOutput(file:string):Promise<HotVideoRemixOutputProbe>{
  const output=await runFFmpeg(['-hide_banner','-nostdin','-i',file,'-map','0:v:0','-frames:v','1','-f','null','-'],30_000);
  const duration=durationFromOutput(output),dimensions=outputDimensions(output);
  if(!duration||!dimensions)throw Error('二创成片无法通过本地完整性检查');
  return {duration:round(duration),hasAudio:outputHasAudio(output),...dimensions};
}

function assertOutputMatches(value:HotVideoRemixJob,probe:HotVideoRemixOutputProbe){
  if(Math.abs(probe.duration-value.settings.targetDuration)>0.35)throw Error('二创成片时长与冻结计划不一致');
  if(probe.width!==value.settings.width||probe.height!==value.settings.height)throw Error('二创成片画幅与冻结计划不一致');
  if((value.settings.preserveSourceAudio||value.bgmSnapshot)&&!probe.hasAudio)throw Error('二创成片缺少已确认的声音轨道');
}

export function recoverStaleHotVideoRemix(id:string,owner:string,now=Date.now(),staleAfterMs=DEFAULT_STALE_AFTER_MS){
  return transaction(()=>{
    const value=get<HotVideoRemixJob>(HOT_VIDEO_REMIX_JOB_BUCKET,id,owner);
    if(!value||value.status!=='running'||value.updatedAt>now-staleAfterMs)return false;
    const lease=get<DurableRecordLease>(HOT_VIDEO_REMIX_LEASE_BUCKET,id,owner);
    if(lease&&lease.expiresAt>now)return false;
    value.status='queued';value.error=undefined;value.recoveryAttempts=Number(value.recoveryAttempts||0)+1;value.recoveredAt=now;value.updatedAt=now;value.events.push({at:now,stage:'recovered'});
    put(HOT_VIDEO_REMIX_JOB_BUCKET,id,owner,value);
    return true;
  });
}

export async function runHotVideoRemix(id:string,owner:string){
  let initial=readHotVideoRemix(id,owner);
  if(!initial)throw Error('爆款视频二创任务不存在');
  if(initial.status==='succeeded'||initial.status==='failed')return publicHotVideoRemixJob(initial);
  if(initial.status==='running')recoverStaleHotVideoRemix(id,owner);
  initial=readHotVideoRemix(id,owner)!;
  if(initial.status!=='queued')return publicHotVideoRemixJob(initial);
  const lease=claimRecordLease(HOT_VIDEO_REMIX_LEASE_BUCKET,id,owner,`${process.pid}:${randomUUID()}`,Date.now(),EXECUTION_LEASE_MS);
  if(!lease)return publicHotVideoRemixJob(readHotVideoRemix(id,owner)!);
  let owned=true;
  const guard=()=>owned&&recordLeaseIsCurrent(lease);
  const heartbeat=setInterval(()=>{if(owned)try{owned=renewRecordLease(lease,Date.now(),EXECUTION_LEASE_MS);}catch{owned=false;}},Math.floor(EXECUTION_LEASE_MS/3));
  heartbeat.unref?.();
  const work=path.join(runtimeDir(),'hot-video-remix-work',`${id}-${randomUUID()}`);
  let value=initial;
  try{
    value=transaction(()=>{
      if(!recordLeaseIsCurrent(lease))throw Error('爆款视频二创执行租约已经失效');
      const current=readHotVideoRemix(id,owner);
      if(!current||current.status!=='queued')throw Error('爆款视频二创任务已由其他执行器处理');
      current.status='running';current.startedAt=current.startedAt||Date.now();current.error=undefined;pushEvent(current,'running');put(HOT_VIDEO_REMIX_JOB_BUCKET,id,owner,current);return current;
    });
    const resultKey=`hot-remix-result:${value.id}`;
    const existing=readIdempotentAsset(owner,resultKey);
    if(existing){
      if(existing.jobId!==value.id||existing.type!=='video/mp4')throw Error('二创成片幂等资产身份冲突');
      await assertAssetIntegrity(existing);
      if(!guard())throw Error('爆款视频二创执行租约已经失效');
      const existingProbe=await probeOutput(assetPath(existing.id));
      assertOutputMatches(value,existingProbe);
      value.resultAssetId=existing.id;value.resultProbe=existingProbe;value.status='succeeded';value.finishedAt=Date.now();pushEvent(value,'asset-saved');pushEvent(value,'succeeded');persistWithLease(value,lease);
      return publicHotVideoRemixJob(value);
    }
    await verifyFrozenInputs(value,guard);
    pushEvent(value,'sources-verified');persistWithLease(value,lease);
    await fs.mkdir(work,{recursive:true,mode:0o700});
    const output=await renderFinal(value,work,guard,lease);
    const probe=await probeOutput(output);
    assertOutputMatches(value,probe);
    if(!guard())throw Error('爆款视频二创执行租约已经失效');
    const bytes=await fs.readFile(output);
    const result=await storeAsset(owner,bytes,'video/mp4',`爆款视频二创-${value.id.slice(0,8)}.mp4`,'generated',value.id,undefined,resultKey,guard);
    await assertAssetIntegrity(result);
    if(!guard())throw Error('爆款视频二创执行租约已经失效');
    value.resultAssetId=result.id;value.resultProbe=probe;value.status='succeeded';value.finishedAt=Date.now();value.error=undefined;pushEvent(value,'asset-saved');pushEvent(value,'succeeded');persistWithLease(value,lease);
    return publicHotVideoRemixJob(value);
  }catch(error){
    if(guard()){
      const current=readHotVideoRemix(id,owner);
      if(current&&current.status==='running'){
        current.status='failed';current.error=error instanceof Error?error.message:'本地视频二创失败';current.finishedAt=Date.now();pushEvent(current,'failed');
        try{persistWithLease(current,lease);}catch{/* A newer fenced worker owns the record. */}
      }
    }
    return publicHotVideoRemixJob(readHotVideoRemix(id,owner)||value);
  }finally{
    clearInterval(heartbeat);
    await fs.rm(work,{recursive:true,force:true}).catch(()=>undefined);
    if(owned)try{releaseRecordLease(lease);}catch{/* A newer fenced worker owns recovery. */}
  }
}
