import crypto from 'node:crypto';
import os from 'node:os';

import {DurableQueueLoop} from '../../lib/durable-queue-loop';
import {runDepthPreparation} from './depth-video-clones';
import {runFrameExtraction} from './frame-extraction';
import {recoverStaleHotVideoRemix,runHotVideoRemix,sweepHotVideoRemixWorkdirs} from './hot-video-remix';
import {job,reconcileJobBilling,reconcileStaleUndispatchedCommerceJobs,recoverSavingJob,refreshJob,runJob} from './jobs';
import {recoverStaleEdit,runEdit,type EditJob} from './media-tools';
import {sweepAssetOrphans} from './assets';
import {sweepProviderReferenceIntents} from './media-reference';
import {db,get,put,transaction} from './store';
import {runVoiceJob} from './voice-jobs';
import {recoverStaleVoiceReplacement,runVoiceReplacementJob,sweepVoiceReplacementWorkdirs,voiceReplacementCandidates} from './voice-replace';

const LEASE_BUCKET='commerce-ordinary-worker-leases';
const DEFAULT_LEASE_MS=60_000;
const DEFAULT_BATCH_LIMIT=8;
const POLLABLE_JOB_AGE_MS=5_000;
const STALE_MEDIA_EDIT_MS=10*60_000;
const MAINTENANCE_INTERVAL_MS=15*60_000;
const HOT_VIDEO_CONCURRENCY=2;

export type CommerceOrdinaryCandidate={
 kind:'job'|'media-edit'|'frame-extraction'|'depth-preparation'|'hot-video-remix'|'voice-synthesis'|'voice-replacement';
 id:string;
 owner:string;
 updatedAt:number;
 subId?:string;
};

export type CommerceOrdinaryLease={
 key:string;
 owner:string;
 workerId:string;
 token:number;
 claimedAt:number;
 expiresAt:number;
};

type ReconcileOptions={
 now?:number;
 limit?:number;
 leaseMs?:number;
 candidates?:CommerceOrdinaryCandidate[];
 processCandidate?:(candidate:CommerceOrdinaryCandidate)=>Promise<void>;
};

const workerId=`${os.hostname()}:${process.pid}:${process.env.NODE_APP_INSTANCE||process.env.pm_id||'0'}:${crypto.randomUUID()}`;
const leaseKey=(candidate:CommerceOrdinaryCandidate)=>`${candidate.kind}:${candidate.id}${candidate.subId?`:${candidate.subId}`:''}`;
const safeLimit=(value=DEFAULT_BATCH_LIMIT)=>Math.max(1,Math.min(32,Math.trunc(value)||DEFAULT_BATCH_LIMIT));
const leaseDuration=(value=Number(process.env.COMMERCE_ORDINARY_LEASE_MS||DEFAULT_LEASE_MS))=>Number.isFinite(value)?Math.max(10_000,Math.min(300_000,Math.trunc(value))):DEFAULT_LEASE_MS;

export function claimCommerceOrdinaryLease(candidate:CommerceOrdinaryCandidate,currentWorkerId=workerId,now=Date.now(),durationMs=leaseDuration()){
 const key=leaseKey(candidate);
 return transaction(()=>{
  const previous=get<CommerceOrdinaryLease>(LEASE_BUCKET,key,candidate.owner);
  if(previous&&previous.expiresAt>now)return null;
  const lease:CommerceOrdinaryLease={key,owner:candidate.owner,workerId:currentWorkerId,token:Number(previous?.token||0)+1,claimedAt:now,expiresAt:now+durationMs};
  put(LEASE_BUCKET,key,candidate.owner,lease);return lease;
 });
}

export function renewCommerceOrdinaryLease(lease:CommerceOrdinaryLease,now=Date.now(),durationMs=leaseDuration()){
 return transaction(()=>{
  const current=get<CommerceOrdinaryLease>(LEASE_BUCKET,lease.key,lease.owner);
  if(!current||current.workerId!==lease.workerId||current.token!==lease.token||current.expiresAt<=now)return false;
  current.expiresAt=now+durationMs;put(LEASE_BUCKET,current.key,current.owner,current);lease.expiresAt=current.expiresAt;return true;
 });
}

export function releaseCommerceOrdinaryLease(lease:CommerceOrdinaryLease){
 return transaction(()=>{
  const current=get<CommerceOrdinaryLease>(LEASE_BUCKET,lease.key,lease.owner);
  if(!current||current.workerId!==lease.workerId||current.token!==lease.token)return false;
   current.expiresAt=0;put(LEASE_BUCKET,current.key,current.owner,current);return true;
 });
}

export function commerceOrdinaryCandidates(limit=DEFAULT_BATCH_LIMIT,now=Date.now()):CommerceOrdinaryCandidate[]{
 const cap=safeLimit(limit),rows:CommerceOrdinaryCandidate[]=[];
 const jobs=db().prepare(`SELECT id,owner,updated FROM records WHERE bucket='jobs'
   AND json_extract(value,'$.input.rollingPlan') IS NULL
   AND (
     (COALESCE(json_extract(value,'$.input.rollingChild'),0)=0 AND (
       json_extract(value,'$.status')='queued'
       OR (json_extract(value,'$.status') IN ('running','processing','unknown','saving') AND updated<=?)
       OR (json_extract(value,'$.status') IN ('succeeded','failed') AND EXISTS (
         SELECT 1 FROM records AS billing
         WHERE billing.bucket='billing' AND billing.id=records.id AND billing.owner=records.owner
           AND json_extract(billing.value,'$.status') IN ('charge_pending','refund_pending','revenue_pending','reconciliation_required')
       ))
     ))
     OR (COALESCE(json_extract(value,'$.input.rollingChild'),0)=1
       AND json_extract(value,'$.status')='saving' AND updated<=?)
   )
   ORDER BY updated ASC LIMIT ?`).all(now-POLLABLE_JOB_AGE_MS,now-POLLABLE_JOB_AGE_MS,cap);
 for(const row of jobs)rows.push({kind:'job',id:String(row.id),owner:String(row.owner),updatedAt:Number(row.updated||0)});
 const edits=db().prepare(`SELECT id,owner,updated FROM records WHERE bucket='media-edits'
   AND (json_extract(value,'$.status')='queued'
     OR (json_extract(value,'$.status')='running' AND updated<=?))
   ORDER BY updated ASC LIMIT ?`).all(now-STALE_MEDIA_EDIT_MS,cap);
 for(const row of edits)rows.push({kind:'media-edit',id:String(row.id),owner:String(row.owner),updatedAt:Number(row.updated||0)});
 const frames=db().prepare(`SELECT id,owner,updated FROM records WHERE bucket='frame-extractions'
   AND json_extract(value,'$.status')='queued'
   ORDER BY updated ASC LIMIT ?`).all(cap);
 for(const row of frames)rows.push({kind:'frame-extraction',id:String(row.id),owner:String(row.owner),updatedAt:Number(row.updated||0)});
 const depth=db().prepare(`SELECT id,owner,updated,json_extract(value,'$.preparation.id') AS subId FROM records WHERE bucket='depth-video-clones'
   AND (json_extract(value,'$.preparation.status')='queued'
     OR (json_extract(value,'$.preparation.status')='running' AND COALESCE(json_extract(value,'$.preparation.leaseUntil'),0)<=?))
   ORDER BY updated ASC LIMIT ?`).all(now,cap);
 for(const row of depth)if(row.subId)rows.push({kind:'depth-preparation',id:String(row.id),owner:String(row.owner),updatedAt:Number(row.updated||0),subId:String(row.subId)});
 const hotRemixes=db().prepare(`SELECT id,owner,updated FROM records WHERE bucket='hot-video-remix-jobs'
   AND (json_extract(value,'$.status')='queued'
     OR (json_extract(value,'$.status')='running' AND updated<=?))
   ORDER BY updated ASC LIMIT ?`).all(now-STALE_MEDIA_EDIT_MS,cap);
 for(const row of hotRemixes)rows.push({kind:'hot-video-remix',id:String(row.id),owner:String(row.owner),updatedAt:Number(row.updated||0)});
  const voices=db().prepare(`SELECT id,owner,updated FROM records WHERE bucket='voice-jobs'
    AND (
      (json_extract(value,'$.status')='queued' AND json_extract(value,'$.billingState')='charged')
      OR (json_extract(value,'$.status') IN ('running','saving') AND json_extract(value,'$.billingState')='charged' AND updated<=?)
      OR (json_extract(value,'$.status')='succeeded' AND json_extract(value,'$.billingState') IN ('charged','revenue_pending'))
      OR (json_extract(value,'$.status')='failed' AND json_extract(value,'$.billingState') IN ('charged','refund_pending','reconciliation_required'))
   )
   ORDER BY updated ASC LIMIT ?`).all(now-STALE_MEDIA_EDIT_MS,cap);
 for(const row of voices)rows.push({kind:'voice-synthesis',id:String(row.id),owner:String(row.owner),updatedAt:Number(row.updated||0)});
 for(const row of voiceReplacementCandidates(cap,now))rows.push({kind:'voice-replacement',...row});
 return rows.sort((left,right)=>left.updatedAt-right.updatedAt||left.kind.localeCompare(right.kind)||left.id.localeCompare(right.id)).slice(0,cap);
}

async function processCommerceOrdinaryCandidate(candidate:CommerceOrdinaryCandidate,now=Date.now()){
 if(candidate.kind==='job'){
  const value=job(candidate.id,candidate.owner);
  if(value?.status==='queued')await runJob(candidate.id,candidate.owner);
  else if(value?.status==='saving')await recoverSavingJob(candidate.id,candidate.owner);
  else if(value&&['succeeded','failed'].includes(value.status))await reconcileJobBilling(candidate.id,candidate.owner);
  else if(value&&['running','processing','unknown'].includes(value.status))await refreshJob(candidate.id,candidate.owner);
  return;
 }
 if(candidate.kind==='media-edit'){
  const value=get<EditJob>('media-edits',candidate.id,candidate.owner);
  if(value?.status==='running'&&!recoverStaleEdit(candidate.id,candidate.owner,now,STALE_MEDIA_EDIT_MS))return;
  await runEdit(candidate.id,candidate.owner);return;
 }
 if(candidate.kind==='frame-extraction'){
  await runFrameExtraction(candidate.id,candidate.owner);return;
 }
 if(candidate.kind==='depth-preparation'){
  if(candidate.subId)await runDepthPreparation(candidate.owner,candidate.id,candidate.subId);
  return;
 }
 if(candidate.kind==='hot-video-remix'){
  recoverStaleHotVideoRemix(candidate.id,candidate.owner,now,STALE_MEDIA_EDIT_MS);
  await runHotVideoRemix(candidate.id,candidate.owner);return;
 }
 if(candidate.kind==='voice-replacement'){
  recoverStaleVoiceReplacement(candidate.id,candidate.owner,now,STALE_MEDIA_EDIT_MS);
  await runVoiceReplacementJob(candidate.id,candidate.owner);return;
 }
 await runVoiceJob(candidate.id,candidate.owner);
}

async function withLease(candidate:CommerceOrdinaryCandidate,processor:(candidate:CommerceOrdinaryCandidate)=>Promise<void>,now:number,durationMs:number){
 const lease=claimCommerceOrdinaryLease(candidate,workerId,now,durationMs);
 if(!lease)return false;
 let current=true;
 const heartbeat=setInterval(()=>{if(current)try{current=renewCommerceOrdinaryLease(lease);}catch{current=false;}},Math.max(1_000,Math.floor(durationMs/3)));
 heartbeat.unref?.();
 try{await processor(candidate);return true;}
 finally{clearInterval(heartbeat);if(current)releaseCommerceOrdinaryLease(lease);}
}

export async function reconcileCommerceOrdinaryBatch(options:ReconcileOptions={}){
  const now=options.now??Date.now(),limit=safeLimit(options.limit),durationMs=options.leaseMs??leaseDuration();
  await reconcileStaleUndispatchedCommerceJobs(now,limit);
  const maintenanceGlobal=globalThis as typeof globalThis&{__commerceAssetMaintenanceAt?:number};
  if(now-Number(maintenanceGlobal.__commerceAssetMaintenanceAt||0)>=MAINTENANCE_INTERVAL_MS){maintenanceGlobal.__commerceAssetMaintenanceAt=now;await Promise.allSettled([sweepAssetOrphans(now),sweepProviderReferenceIntents(now),sweepHotVideoRemixWorkdirs(now),sweepVoiceReplacementWorkdirs(now)]);}
  const candidates=options.candidates??commerceOrdinaryCandidates(limit,now),processor=options.processCandidate??(candidate=>processCommerceOrdinaryCandidate(candidate,now));
  let hotCount=0;
  const bounded=candidates.filter(candidate=>candidate.kind!=='hot-video-remix'||hotCount++<HOT_VIDEO_CONCURRENCY);
 await Promise.allSettled(bounded.map(candidate=>withLease(candidate,processor,now,durationMs)));
}

const globalWorker=globalThis as typeof globalThis&{__commerceOrdinaryWorker?:DurableQueueLoop};
function loop(){return globalWorker.__commerceOrdinaryWorker??=new DurableQueueLoop({name:'commerce-ordinary-coordinator',intervalMs:2_000,runOnce:reconcileCommerceOrdinaryBatch,onError:()=>console.warn('[CommerceOrdinaryWorker] durable tick deferred')});}
export function startCommerceOrdinaryWorker(){if(process.env.COMMERCE_ORDINARY_WORKER==='0')return false;return loop().start();}
export function stopCommerceOrdinaryWorker(timeout:number){return loop().stop(timeout);}
export function commerceOrdinaryWorkerStatus(){return loop().snapshot();}
