import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {readAsset,assertAssetIntegrity,materializeAsset,type Asset} from './assets';import {runtimeDir,get,put,db,transaction,claimRecordLease,renewRecordLease,recordLeaseIsCurrent,releaseRecordLease,type DurableRecordLease} from './store';
import {frameInput,type FrameMode,type FrameExtractionJob,type ExtractedFrame} from '../frame-extraction-types';
import {probeFrameTimeline,planFrameTimeline,extractPlannedFiles,FrameCapacityError} from './frame-extraction-media';
export type {FrameMode} from '../frame-extraction-types';
type StoredJob=FrameExtractionJob&{owner:string;workerId:string;workerPid:number;leaseUntil:number;executionToken?:number;plan?:ExtractedFrame[]};
type RequestRecord={jobId:string;fingerprint:string};
const JOBS='frame-extractions',REQUESTS='frame-extraction-requests',LEASES='commerce-frame-extraction-leases',LEASE_MS=30_000;
const rawJob=(id:string,owner:string)=>get<StoredJob>(JOBS,id,owner);
const save=(job:StoredJob)=>{job.updatedAt=Date.now();put(JOBS,job.id,job.owner,job);};
const publicJob=({owner:_,workerId:__,workerPid:___,leaseUntil:____,executionToken:_____,plan:______,...job}:StoredJob):FrameExtractionJob=>job;
const requestKey=(owner:string,requestId:string)=>owner+':'+requestId;
export class FrameRequestConflict extends Error{constructor(){super('这个抽帧请求号已用于不同参数，请重新发起新的抽帧');}}
function workerAlive(pid:number){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}}
function executionLeaseCurrent(job:StoredJob){const lease=get<DurableRecordLease>(LEASES,job.id,job.owner);return Boolean(lease&&job.executionToken&&lease.holder===job.workerId&&lease.token===job.executionToken&&lease.expiresAt>Date.now());}
function reconcile(job:StoredJob){if(job.plan)job.frames=job.plan.filter(frame=>!!readAsset(frame.assetId,job.owner));}
export function readFrameExtraction(owner:string,id:string):FrameExtractionJob|undefined{
 const value=rawJob(id,owner);if(!value)return;
 if(value.status==='running'&&(!workerAlive(value.workerPid)||value.leaseUntil<Date.now()||!executionLeaseCurrent(value))){
  transaction(()=>{const current=rawJob(id,owner);if(!current||current.status!=='running')return;if(workerAlive(current.workerPid)&&current.leaseUntil>=Date.now()&&executionLeaseCurrent(current))return;reconcile(current);current.status='interrupted';current.errorCode='WORKER_INTERRUPTED';current.error='上次抽帧进程已中断。已保存图片仍保留；查询不会重新运行或重复生成。';save(current);});
  return publicJob(rawJob(id,owner)!);
 }
 return publicJob(value);
}
export function findFrameExtraction(owner:string,query:{requestId?:string;assetId?:string;contextKey?:string}){
 if(query.requestId){const request=get<RequestRecord>(REQUESTS,requestKey(owner,query.requestId),owner);return request?readFrameExtraction(owner,request.jobId):undefined;}
 if(!query.assetId||!query.contextKey)return undefined;
 const row=db().prepare("SELECT id FROM records WHERE bucket=? AND owner=? AND json_extract(value,'$.input.assetId')=? AND json_extract(value,'$.input.contextKey')=? ORDER BY updated DESC LIMIT 1").get(JOBS,owner,query.assetId,query.contextKey);
 return row?readFrameExtraction(owner,String(row.id)):undefined;
}
export function createFrameExtraction(owner:string,value:unknown):{job:FrameExtractionJob;created:boolean}{
 const input=frameInput(value),fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 return transaction(()=>{
  const previous=get<RequestRecord>(REQUESTS,requestKey(owner,input.requestId),owner);
  if(previous){if(previous.fingerprint!==fingerprint)throw new FrameRequestConflict();const job=rawJob(previous.jobId,owner);if(!job)throw Error('原抽帧记录缺失，请核对请求号');return {job:publicJob(job),created:false};}
  if(input.remainingSlots===0)throw new FrameCapacityError(1,0);
  const asset=readAsset(input.assetId,owner);if(!asset||!asset.type.startsWith('video/'))throw Error('请选择当前账号的视频');
  const active=db().prepare("SELECT count(*) AS count FROM records WHERE bucket=? AND owner=? AND json_extract(value,'$.status') IN ('queued','running') AND json_extract(value,'$.leaseUntil')>?").get(JOBS,owner,Date.now());
  if(Number(active?.count||0)>=2)throw Error('已有两个抽帧任务正在处理，请等待完成');
  const job:StoredJob={id:crypto.randomUUID(),owner,input,sourceAssetId:asset.id,sourceSha256:asset.sha256,status:'queued',phase:'queued',createdAt:Date.now(),updatedAt:Date.now(),frames:[],detector:input.mode.startsWith('shot')?'ffmpeg-scene-threshold-0.3':'actual-frame-pts',workerId:'',workerPid:0,leaseUntil:0};
  put(REQUESTS,requestKey(owner,input.requestId),owner,{jobId:job.id,fingerprint});save(job);return {job:publicJob(job),created:true};
 });
}
export function frameAssetId(jobId:string,decodeIndex:number){const h=createHash('sha256').update('frame-asset-v1:'+jobId+':'+decodeIndex).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
async function storeFrameOnce(job:StoredJob,frame:ExtractedFrame,bytes:Buffer,source:Asset,isCurrent:()=>boolean){
 const hash=createHash('sha256').update(bytes).digest('hex'),old=readAsset(frame.assetId,job.owner);if(old&&(old.jobId!==job.id||old.sha256!==hash))throw Error('原抽帧图片与任务不匹配');
 const value:Asset={id:frame.assetId,owner:job.owner,name:`${source.name.replace(/\.[^.]+$/,'')}-${job.input.mode}-${frame.decodeIndex+1}-${frame.time.toFixed(3)}s.jpg`.slice(0,160),type:'image/jpeg',size:bytes.length,sha256:hash,createdAt:old?.createdAt||Date.now(),source:'generated',jobId:job.id};
 await materializeAsset(value,bytes,isCurrent);
}
export async function runFrameExtraction(id:string,owner:string){
 const holder=`${process.pid}:${crypto.randomUUID()}`,lease=claimRecordLease(LEASES,id,owner,holder,Date.now(),LEASE_MS);if(!lease)return;
 const claimed=transaction(()=>{const job=rawJob(id,owner);if(!job||job.status!=='queued')return false;job.status='running';job.phase='analyzing';job.workerId=holder;job.workerPid=process.pid;job.executionToken=lease.token;job.leaseUntil=lease.expiresAt;save(job);return true;});if(!claimed){releaseRecordLease(lease);return;}
 let leaseCurrent=true;
 const folder=path.join(runtimeDir(),'media-work','frames-'+id),heartbeat=setInterval(()=>{try{leaseCurrent=renewRecordLease(lease,Date.now(),LEASE_MS);const job=rawJob(id,owner);if(leaseCurrent&&job?.status==='running'&&job.workerId===holder&&job.executionToken===lease.token){job.leaseUntil=lease.expiresAt;save(job);}}catch{leaseCurrent=false;}},5000);
 const isCurrent=()=>leaseCurrent&&recordLeaseIsCurrent(lease)&&(()=>{const job=rawJob(id,owner);return Boolean(job&&job.status==='running'&&job.workerId===holder&&job.executionToken===lease.token);})();
 const current=()=>{const job=rawJob(id,owner);if(!job||!isCurrent())throw Error('原抽帧任务已中断，未重新执行');return job;};
 try{
  let job=current();const asset=readAsset(job.sourceAssetId,owner);if(!asset)throw Error('原视频已删除');if(asset.sha256!==job.sourceSha256)throw Error('原视频内容已变化，请重新发起抽帧');await assertAssetIntegrity(asset);const source=path.join(runtimeDir(),'assets',asset.id),probe=await probeFrameTimeline(source),planned=planFrameTimeline(probe,job.input.mode,job.input.remainingSlots);
  job=current();job.duration=probe.duration;job.sourceStartTime=probe.startPts*probe.timeBase.numerator/probe.timeBase.denominator;job.plan=planned.map(frame=>({...frame,assetId:frameAssetId(job.id,frame.decodeIndex),sourceAssetId:asset.id}));job.plannedCount=planned.length;job.phase='extracting';save(job);
  const files=await extractPlannedFiles(source,folder,planned);job=current();job.phase='saving';save(job);
  for(const [decodeIndex,file] of files){job=current();const frame=job.plan!.find(frame=>frame.decodeIndex===decodeIndex)!;await storeFrameOnce(job,frame,await fs.readFile(file),asset,isCurrent);job=current();reconcile(job);save(job);}
  job=current();reconcile(job);if(job.frames.length!==job.plannedCount)throw Error('抽帧结果未保存完整');job.status='succeeded';job.phase='complete';save(job);
 }catch(error){const job=rawJob(id,owner);if(job?.status==='running'&&job.workerId===holder&&job.executionToken===lease.token&&recordLeaseIsCurrent(lease)){reconcile(job);job.status='failed';job.error=error instanceof Error?error.message:'抽帧失败';job.errorCode=error instanceof FrameCapacityError?error.code:'FRAME_EXTRACTION_FAILED';if(error instanceof FrameCapacityError){job.requiredSlots=error.requiredSlots;job.availableSlots=error.availableSlots;}save(job);}}
 finally{clearInterval(heartbeat);if(recordLeaseIsCurrent(lease))releaseRecordLease(lease);try{for(const file of await fs.readdir(folder))await fs.unlink(path.join(folder,file));await fs.rmdir(folder);}catch{}}
}
// Compatibility for the existing isolated verification script; production uses request IDs and GET recovery.
export async function extractFrames(owner:string,assetId:string,mode:FrameMode){const {job}=createFrameExtraction(owner,{requestId:crypto.randomUUID(),assetId,mode,contextKey:'isolated-direct-call',remainingSlots:100});await runFrameExtraction(job.id,owner);const result=readFrameExtraction(owner,job.id)!;if(result.status!=='succeeded')throw Error(result.error||'抽帧失败');return {...result,mode,duration:result.duration!,frames:result.frames};}
