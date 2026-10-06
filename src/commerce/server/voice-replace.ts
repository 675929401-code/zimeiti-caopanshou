import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertAssetIntegrity,
  publicAsset,
  readAsset,
  readIdempotentAsset,
  storeAsset,
  type Asset,
  type PublicAsset,
} from './assets';
import {runFFmpeg} from './media-tools';
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

export const VOICE_REPLACE_JOB_BUCKET='voice-replace-jobs';
export const VOICE_REPLACE_LEASE_BUCKET='voice-replace-leases';

const EXECUTION_LEASE_MS=120_000;
const DEFAULT_STALE_AFTER_MS=10*60_000;
const DEFAULT_WORKDIR_TTL_MS=6*60*60_000;
const MAX_ACTIVE_PER_OWNER=2;

export type VoiceReplaceMode='replace'|'mix';
export type VoiceReplaceStatus='queued'|'running'|'succeeded'|'failed';
export type VoiceReplaceInput={videoAssetId:string;audioAssetId:string;mode?:VoiceReplaceMode;requestId:string};

export type VoiceReplaceSnapshot={
  assetId:string;
  name:string;
  type:string;
  size:number;
  sha256:string;
  duration:number;
  hasAudio:boolean;
};

export type VoiceReplaceProbe={duration:number;hasAudio:boolean};
export type VoiceReplaceEvent={
  at:number;
  stage:'queued'|'running'|'inputs-verified'|'duration-frozen'|'audio-aligned'|'asset-saved'|'succeeded'|'failed'|'recovered';
};

export type VoiceReplaceJob={
  schema:'commerce-voice-replace-job/v1';
  id:string;
  owner:string;
  requestId:string;
  requestFingerprint:string;
  requestedMode:VoiceReplaceMode;
  effectiveMode:VoiceReplaceMode;
  status:VoiceReplaceStatus;
  videoSnapshot:VoiceReplaceSnapshot;
  audioSnapshot:VoiceReplaceSnapshot;
  voiceJobId:string;
  events:VoiceReplaceEvent[];
  createdAt:number;
  updatedAt:number;
  startedAt?:number;
  finishedAt?:number;
  resultAssetId?:string;
  resultProbe?:VoiceReplaceProbe;
  error?:string;
  recoveryAttempts?:number;
  recoveredAt?:number;
};

export type PublicVoiceReplaceJob={
  id:string;
  requestId:string;
  requestedMode:VoiceReplaceMode;
  effectiveMode:VoiceReplaceMode;
  status:VoiceReplaceStatus;
  videoSnapshot:VoiceReplaceSnapshot;
  audioSnapshot:VoiceReplaceSnapshot;
  events:VoiceReplaceEvent[];
  progress:number;
  createdAt:number;
  updatedAt:number;
  startedAt?:number;
  finishedAt?:number;
  resultAsset?:PublicAsset;
  resultProbe?:VoiceReplaceProbe;
  error?:string;
  recoveryAttempts?:number;
  recoveredAt?:number;
  execution:{engine:'local-ffmpeg';networkRequired:false;walletRequired:false;payableTotal:0};
};

type CompletedVoiceJob={status?:string;assetId?:string};

function stableJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>`${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}
function validId(value:unknown){return typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);}
function round(value:number){return Math.round(value*1_000_000)/1_000_000;}
function assetPath(id:string){return path.join(runtimeDir(),'assets',id);}
function resultAssetKey(id:string){return `commerce:voice-replace:${id}:result:v1`;}
function durationFromOutput(output:string){const match=output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u);return match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):0;}
function outputHasAudio(output:string){return /Stream #[^\r\n]*\bAudio:/u.test(output);}

async function probeMedia(asset:Asset,expected:'video'|'audio'):Promise<VoiceReplaceSnapshot>{
  await assertAssetIntegrity(asset);
  const output=await runFFmpeg([
    '-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',assetPath(asset.id),
    '-map',expected==='video'?'0:v:0':'0:a:0',
    ...(expected==='video'?['-frames:v','1']:['-t','0.02']),
    '-f','null','-',
  ],30_000);
  const duration=durationFromOutput(output),hasAudio=outputHasAudio(output);
  if(!duration||(expected==='audio'&&!hasAudio))throw Error(expected==='video'?'无法读取目标视频时长':'无法读取配音时长或有效音轨');
  return {assetId:asset.id,name:asset.name,type:asset.type,size:asset.size,sha256:asset.sha256,duration:round(duration),hasAudio};
}

function requireOwnedInputs(owner:string,input:VoiceReplaceInput){
  const video=readAsset(input.videoAssetId,owner);
  if(!video||!video.type.startsWith('video/'))throw Error('请选择当前账号拥有的视频');
  const audio=readAsset(input.audioAssetId,owner);
  if(!audio||!audio.type.startsWith('audio/'))throw Error('请选择当前账号拥有的已完成配音');
  if(!audio.jobId)throw Error('配音资产缺少完成任务身份');
  const voiceJob=get<CompletedVoiceJob>('voice-jobs',audio.jobId,owner);
  if(!voiceJob||voiceJob.status!=='succeeded'||voiceJob.assetId!==audio.id)throw Error('配音任务尚未完成或资产不匹配');
  return {video,audio,voiceJobId:audio.jobId};
}

export function publicVoiceReplaceJob(value:VoiceReplaceJob):PublicVoiceReplaceJob{
  const result=value.resultAssetId?readAsset(value.resultAssetId,value.owner):undefined;
  return {
    id:value.id,
    requestId:value.requestId,
    requestedMode:value.requestedMode,
    effectiveMode:value.effectiveMode,
    status:value.status,
    videoSnapshot:{...value.videoSnapshot},
    audioSnapshot:{...value.audioSnapshot},
    events:value.events.map(event=>({...event})),
    progress:value.status==='succeeded'||value.status==='failed'?100:value.status==='running'?40:0,
    createdAt:value.createdAt,
    updatedAt:value.updatedAt,
    ...(value.startedAt?{startedAt:value.startedAt}:{}),
    ...(value.finishedAt?{finishedAt:value.finishedAt}:{}),
    ...(result?{resultAsset:publicAsset(result)}:{}),
    ...(value.resultProbe?{resultProbe:{...value.resultProbe}}:{}),
    ...(value.error?{error:value.error}:{}),
    ...(value.recoveryAttempts?{recoveryAttempts:value.recoveryAttempts}:{}),
    ...(value.recoveredAt?{recoveredAt:value.recoveredAt}:{}),
    execution:{engine:'local-ffmpeg',networkRequired:false,walletRequired:false,payableTotal:0},
  };
}

export async function createVoiceReplacement(owner:string,input:VoiceReplaceInput){
  if(!owner)throw Error('带货工作区身份无效');
  if(!validId(input.requestId))throw Error('请求号无效');
  if(!validId(input.videoAssetId)||!validId(input.audioAssetId))throw Error('素材ID无效');
  const requestedMode:VoiceReplaceMode=input.mode==='mix'?'mix':'replace';
  const requestFingerprint=hash({schema:'commerce-voice-replace-request/v1',videoAssetId:input.videoAssetId,audioAssetId:input.audioAssetId,mode:requestedMode});
  const requestKey=`${owner}:voice-replace:${input.requestId}`;
  const requestRow=db().prepare('SELECT job_id,fingerprint FROM requests WHERE request_key=?').get(requestKey) as {job_id?:string;fingerprint?:string}|undefined;
  if(requestRow?.job_id){
    if(requestRow.fingerprint!==requestFingerprint)throw Error('同一个请求号对应了不同内容，请重新确认任务。');
    const existing=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,String(requestRow.job_id),owner);
    if(!existing)throw Error('应用配音请求已占用但任务记录缺失');
    return {job:publicVoiceReplaceJob(existing),created:false};
  }
  if(list<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,owner).filter(value=>['queued','running'].includes(value.status)).length>=MAX_ACTIVE_PER_OWNER)throw Error(`当前已有 ${MAX_ACTIVE_PER_OWNER} 个应用配音任务，完成后再创建新任务`);
  const {video,audio,voiceJobId}=requireOwnedInputs(owner,input);
  const videoSnapshot=await probeMedia(video,'video');
  const audioSnapshot=await probeMedia(audio,'audio');
  const effectiveMode:VoiceReplaceMode=requestedMode==='mix'&&videoSnapshot.hasAudio?'mix':'replace';
  const now=Date.now(),id=randomUUID();
  const value:VoiceReplaceJob={
    schema:'commerce-voice-replace-job/v1',id,owner,requestId:input.requestId,requestFingerprint,requestedMode,effectiveMode,status:'queued',
    videoSnapshot,audioSnapshot,voiceJobId,events:[{at:now,stage:'queued'},{at:now,stage:'duration-frozen'}],createdAt:now,updatedAt:now,
  };
  const result=transaction(()=>{
    const request=claim(requestKey,requestFingerprint,id);
    if(request.created){
      if(list<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,owner).filter(item=>['queued','running'].includes(item.status)).length>=MAX_ACTIVE_PER_OWNER)throw Error(`当前已有 ${MAX_ACTIVE_PER_OWNER} 个应用配音任务，完成后再创建新任务`);
      put(VOICE_REPLACE_JOB_BUCKET,id,owner,value);
    }
    return request;
  });
  const stored=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,result.id,owner);
  if(!stored)throw Error('应用配音任务保存失败');
  return {job:publicVoiceReplaceJob(stored),created:result.created};
}

export const readVoiceReplacement=(id:string,owner:string)=>get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner);
export const listVoiceReplacements=(owner:string)=>list<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,owner).map(publicVoiceReplaceJob);

function event(value:VoiceReplaceJob,stage:VoiceReplaceEvent['stage']){value.events.push({at:Date.now(),stage});value.updatedAt=Date.now();}
function persistWithLease(value:VoiceReplaceJob,lease:DurableRecordLease){
  transaction(()=>{
    if(!recordLeaseIsCurrent(lease))throw Error('应用配音执行租约已经失效');
    const current=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,value.id,value.owner);
    if(!current||current.requestFingerprint!==value.requestFingerprint)throw Error('应用配音任务身份已经变化');
    put(VOICE_REPLACE_JOB_BUCKET,value.id,value.owner,value);
  });
}

async function verifyFrozenInput(snapshot:VoiceReplaceSnapshot,owner:string,kind:'video'|'audio',guard:()=>boolean){
  if(!guard())throw Error('应用配音执行租约已经失效');
  const asset=readAsset(snapshot.assetId,owner);
  if(!asset||asset.type!==snapshot.type||asset.size!==snapshot.size||asset.sha256!==snapshot.sha256)throw Error(kind==='video'?'目标视频已经变化，请重新创建任务':'配音资产已经变化，请重新创建任务');
  await assertAssetIntegrity(asset);
  if(kind==='audio'){
    if(!asset.jobId)throw Error('配音资产缺少完成任务身份');
    const voiceJob=get<CompletedVoiceJob>('voice-jobs',asset.jobId,owner);
    if(!voiceJob||voiceJob.status!=='succeeded'||voiceJob.assetId!==asset.id)throw Error('配音任务已不再处于完成状态');
  }
}

async function probeOutput(target:string):Promise<VoiceReplaceProbe>{
  const output=await runFFmpeg(['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',target,'-map','0:v:0','-frames:v','1','-f','null','-'],30_000);
  const duration=durationFromOutput(output),hasAudio=outputHasAudio(output);
  if(!duration||!hasAudio)throw Error('应用配音后的成片缺少有效视频或音轨');
  return {duration:round(duration),hasAudio};
}

function alignedFilter(job:VoiceReplaceJob){
  const duration=job.videoSnapshot.duration.toFixed(6);
  const voice=`[1:a:0]apad,atrim=duration=${duration},asetpts=N/SR/TB[voice]`;
  if(job.effectiveMode==='replace')return voice;
  return `[0:a:0]apad,atrim=duration=${duration},asetpts=N/SR/TB,volume=0.35[original];${voice};[original][voice]amix=inputs=2:duration=longest:dropout_transition=0,atrim=duration=${duration}[mixed]`;
}

function outputAudioMap(job:VoiceReplaceJob){return job.effectiveMode==='mix'?'[mixed]':'[voice]';}

async function finishFromExistingAsset(job:VoiceReplaceJob,lease:DurableRecordLease){
  const existing=readIdempotentAsset(job.owner,resultAssetKey(job.id));
  if(!existing)return undefined;
  if(existing.jobId!==job.id||existing.type!=='video/mp4')throw Error('应用配音幂等资产身份不匹配');
  await assertAssetIntegrity(existing);
  const probe=await probeOutput(assetPath(existing.id));
  if(Math.abs(probe.duration-job.videoSnapshot.duration)>0.25)throw Error('应用配音成片时长与原视频不一致');
  const value=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,job.id,job.owner);
  if(!value)throw Error('应用配音任务不存在');
  value.status='succeeded';value.resultAssetId=existing.id;value.resultProbe=probe;value.finishedAt=Date.now();value.error=undefined;event(value,'asset-saved');event(value,'succeeded');persistWithLease(value,lease);
  return publicVoiceReplaceJob(value);
}

export function recoverStaleVoiceReplacement(id:string,owner:string,now=Date.now(),staleAfterMs=DEFAULT_STALE_AFTER_MS){
  return transaction(()=>{
    const value=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner);
    if(!value||value.status!=='running'||value.updatedAt>now-staleAfterMs)return false;
    const lease=get<DurableRecordLease>(VOICE_REPLACE_LEASE_BUCKET,id,owner);
    if(lease&&lease.expiresAt>now)return false;
    value.status='queued';value.error=undefined;value.recoveryAttempts=Number(value.recoveryAttempts||0)+1;value.recoveredAt=now;value.updatedAt=now;value.events.push({at:now,stage:'recovered'});put(VOICE_REPLACE_JOB_BUCKET,id,owner,value);return true;
  });
}

export function voiceReplacementCandidates(limit=8,now=Date.now()){
  const cap=Math.max(1,Math.min(32,Math.trunc(limit)||8));
  return (db().prepare(`SELECT id,owner,updated FROM records WHERE bucket=? AND (json_extract(value,'$.status')='queued' OR (json_extract(value,'$.status')='running' AND updated<=?)) ORDER BY updated ASC LIMIT ?`).all(VOICE_REPLACE_JOB_BUCKET,now-DEFAULT_STALE_AFTER_MS,cap) as Array<{id:string;owner:string;updated:number}>).map(value=>({id:String(value.id),owner:String(value.owner),updatedAt:Number(value.updated||0)}));
}

export function activeVoiceReplacementReferencesAsset(owner:string,assetId:string){
  return Boolean(db().prepare(`SELECT 1 FROM records WHERE bucket=? AND owner=? AND json_extract(value,'$.status') IN ('queued','running') AND (json_extract(value,'$.videoSnapshot.assetId')=? OR json_extract(value,'$.audioSnapshot.assetId')=?) LIMIT 1`).get(VOICE_REPLACE_JOB_BUCKET,owner,assetId,assetId));
}

/** Remove only stale direct children of the dedicated replacement scratch root. */
export async function sweepVoiceReplacementWorkdirs(now=Date.now(),ttlMs=DEFAULT_WORKDIR_TTL_MS,limit=64){
  const runtimeRoot=path.resolve(runtimeDir());
  const workRoot=path.resolve(runtimeRoot,'voice-replace-work');
  if(path.dirname(workRoot)!==runtimeRoot)throw Error('应用配音临时目录越界');
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
    const row=db().prepare('SELECT owner,value FROM records WHERE bucket=? AND id=? LIMIT 1').get(VOICE_REPLACE_JOB_BUCKET,match[1]) as {owner?:string;value?:string}|undefined;
    if(row?.owner&&row.value){
      const job=JSON.parse(row.value) as VoiceReplaceJob;
      const lease=get<DurableRecordLease>(VOICE_REPLACE_LEASE_BUCKET,match[1],row.owner);
      if(job.status==='running'&&lease&&lease.expiresAt>now)continue;
    }
    if(stat.isSymbolicLink()||stat.isFile())await fs.unlink(child).catch(()=>undefined);
    else if(stat.isDirectory())await fs.rm(child,{recursive:true,force:true}).catch(()=>undefined);
    else continue;
    removed+=1;
  }
  return {examined,removed};
}

export async function runVoiceReplacementJob(id:string,owner:string){
  let initial=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner);
  if(!initial)throw Error('应用配音任务不存在');
  if(initial.status==='succeeded'||initial.status==='failed')return publicVoiceReplaceJob(initial);
  if(initial.status==='running')recoverStaleVoiceReplacement(id,owner);
  initial=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner)!;
  if(initial.status!=='queued')return publicVoiceReplaceJob(initial);
  const lease=claimRecordLease(VOICE_REPLACE_LEASE_BUCKET,id,owner,`${process.pid}:${randomUUID()}`,Date.now(),EXECUTION_LEASE_MS);
  if(!lease)return publicVoiceReplaceJob(get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner)!);
  let currentLease=true;
  const heartbeat=setInterval(()=>{try{currentLease=renewRecordLease(lease,Date.now(),EXECUTION_LEASE_MS);}catch{currentLease=false;}},Math.floor(EXECUTION_LEASE_MS/3));heartbeat.unref?.();
  const guard=()=>currentLease&&recordLeaseIsCurrent(lease);
  let work='';
  try{
    const recovered=await finishFromExistingAsset(initial,lease);
    if(recovered)return recovered;
    let value=transaction(()=>{
      if(!guard())throw Error('应用配音执行租约已经失效');
      const current=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner);
      if(!current||current.status!=='queued')throw Error('应用配音任务已由其他执行器处理');
      current.status='running';current.startedAt=current.startedAt||Date.now();current.error=undefined;event(current,'running');put(VOICE_REPLACE_JOB_BUCKET,id,owner,current);return current;
    });
    await verifyFrozenInput(value.videoSnapshot,owner,'video',guard);
    await verifyFrozenInput(value.audioSnapshot,owner,'audio',guard);
    event(value,'inputs-verified');persistWithLease(value,lease);
    const workRoot=path.join(runtimeDir(),'voice-replace-work');
    work=path.join(workRoot,`${value.id}-${randomUUID()}`);
    await fs.mkdir(work,{recursive:true,mode:0o700});
    const output=path.join(work,'result.mp4');
    const duration=value.videoSnapshot.duration.toFixed(6);
    await runFFmpeg([
      '-hide_banner','-nostdin','-y','-protocol_whitelist','file,pipe',
      '-i',assetPath(value.videoSnapshot.assetId),'-i',assetPath(value.audioSnapshot.assetId),
      '-filter_complex',alignedFilter(value),'-map','0:v:0','-map',outputAudioMap(value),
      '-c:v','copy','-c:a','aac','-b:a','192k','-t',duration,'-movflags','+faststart',output,
    ],180_000);
    if(!guard())throw Error('应用配音执行租约已经失效');
    const probe=await probeOutput(output);
    if(Math.abs(probe.duration-value.videoSnapshot.duration)>0.25)throw Error('应用配音成片时长与原视频不一致');
    event(value,'audio-aligned');persistWithLease(value,lease);
    const bytes=await fs.readFile(output);
    if(bytes.length<1024)throw Error('应用配音后的成片为空');
    const baseName=value.videoSnapshot.name.replace(/\.[a-z0-9]+$/i,'').slice(0,40);
    const asset=await storeAsset(owner,bytes,'video/mp4',`应用配音-${baseName}.mp4`,'generated',value.id,undefined,resultAssetKey(value.id),guard);
    value=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner)!;
    value.status='succeeded';value.resultAssetId=asset.id;value.resultProbe=probe;value.finishedAt=Date.now();value.error=undefined;event(value,'asset-saved');event(value,'succeeded');persistWithLease(value,lease);
    return publicVoiceReplaceJob(value);
  }catch(error){
    const current=get<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,id,owner);
    if(current&&['queued','running'].includes(current.status)&&guard()){
      current.status='failed';current.error=error instanceof Error?error.message:'应用配音失败';current.finishedAt=Date.now();event(current,'failed');persistWithLease(current,lease);
    }
    throw error;
  }finally{
    clearInterval(heartbeat);
    if(work)await fs.rm(work,{recursive:true,force:true}).catch(()=>undefined);
    if(currentLease)try{releaseRecordLease(lease);}catch{/* A newer recovery lease owns the job. */}
  }
}

export async function recoverVoiceReplacementJobs(owner:string,limit=4,now=Date.now()){
  const jobs=list<VoiceReplaceJob>(VOICE_REPLACE_JOB_BUCKET,owner).filter(value=>value.status==='queued'||(value.status==='running'&&value.updatedAt<=now-DEFAULT_STALE_AFTER_MS)).slice(0,Math.max(1,Math.min(16,Math.trunc(limit)||4)));
  const results:PublicVoiceReplaceJob[]=[];
  for(const job of jobs){recoverStaleVoiceReplacement(job.id,owner,now);results.push(await runVoiceReplacementJob(job.id,owner));}
  return results;
}
