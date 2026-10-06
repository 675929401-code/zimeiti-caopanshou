import os from 'node:os';
import crypto from 'node:crypto';

import {DurableQueueLoop} from '../../lib/durable-queue-loop';
import {advanceRollingParentWithLease,job,reconcileStaleUndispatchedCommerceJobs,type Job} from './jobs';
import {db,get,put,transaction} from './store';
import {cleanupRollingTailAssets,type RollingExecutionPermit} from './rolling-video';

const LEASE_BUCKET='rolling-job-leases';
const DEFAULT_LEASE_MS=45_000;
const MAX_AUTOMATIC_RESTITCH_ATTEMPTS=3;

export type CommerceRollingCandidate={id:string;owner:string;status:Job['status'];updatedAt:number};
export type CommerceRollingLease={jobId:string;owner:string;workerId:string;token:number;claimedAt:number;expiresAt:number};
type ProcessOptions={forceRestitch?:boolean;leaseMs?:number;now?:number;skipWorkflowSync?:boolean;processor?:(candidate:CommerceRollingCandidate,permit:RollingExecutionPermit)=>Promise<Job|undefined>};

function leaseDuration(value=Number(process.env.COMMERCE_ROLLING_LEASE_MS||DEFAULT_LEASE_MS)){
  return Number.isFinite(value)?Math.max(10_000,Math.min(300_000,Math.trunc(value))):DEFAULT_LEASE_MS;
}

export function claimCommerceRollingLease(jobId:string,owner:string,workerId:string,now=Date.now(),durationMs=leaseDuration()){
  return transaction(()=>{
    const previous=get<CommerceRollingLease>(LEASE_BUCKET,jobId,owner);
    // Any live lease is exclusive, including a re-entrant call from the same
    // process. Re-fencing an active execution would make its permit stale and
    // could let two local callers advance the same parent concurrently.
    if(previous&&previous.expiresAt>now)return null;
    const lease:CommerceRollingLease={jobId,owner,workerId,token:Number(previous?.token||0)+1,claimedAt:now,expiresAt:now+durationMs};
    put(LEASE_BUCKET,jobId,owner,lease);
    return lease;
  });
}

export function renewCommerceRollingLease(lease:CommerceRollingLease,now=Date.now(),durationMs=leaseDuration()){
  return transaction(()=>{
    const current=get<CommerceRollingLease>(LEASE_BUCKET,lease.jobId,lease.owner);
    if(!current||current.workerId!==lease.workerId||current.token!==lease.token||current.expiresAt<=now)return false;
    current.expiresAt=now+durationMs;
    put(LEASE_BUCKET,current.jobId,current.owner,current);
    lease.expiresAt=current.expiresAt;
    return true;
  });
}

export function commerceRollingLeaseIsCurrent(lease:CommerceRollingLease,now=Date.now()){
  const current=get<CommerceRollingLease>(LEASE_BUCKET,lease.jobId,lease.owner);
  return Boolean(current&&current.workerId===lease.workerId&&current.token===lease.token&&current.expiresAt>now);
}

export function releaseCommerceRollingLease(lease:CommerceRollingLease){
  return transaction(()=>{
    const current=get<CommerceRollingLease>(LEASE_BUCKET,lease.jobId,lease.owner);
    if(!current||current.workerId!==lease.workerId||current.token!==lease.token)return false;
    current.expiresAt=0;
    put(LEASE_BUCKET,current.jobId,current.owner,current);
    return true;
  });
}

export function commerceRollingCandidates(limit=4,now=Date.now()):CommerceRollingCandidate[]{
  const safeLimit=Math.max(1,Math.min(20,Math.trunc(limit)||4));
  const rows=db().prepare(`SELECT id,owner,value,updated FROM records
    WHERE bucket='jobs'
      AND json_extract(value,'$.input.rollingPlan') IS NOT NULL
      AND COALESCE(json_extract(value,'$.input.rollingChild'),0)=0
      AND (json_extract(value,'$.status') IN ('queued','running','processing','unknown','saving','save_failed')
        OR (json_extract(value,'$.status')='succeeded' AND json_extract(value,'$.rollingState.temporaryAssetsCleanupStatus') IN ('pending','failed')))
    ORDER BY updated ASC LIMIT ?`).all(safeLimit);
  return rows.flatMap((row)=>{
    const value=JSON.parse(String(row.value)) as Job;
    if(value.status==='save_failed'){
      const attempts=Number(value.rollingState?.restitchAttempts||0);
      if(attempts>=MAX_AUTOMATIC_RESTITCH_ATTEMPTS||Number(value.rollingState?.restitchRetryAt||0)>now)return [];
    }
    if(value.status==='succeeded'&&Number(value.rollingState?.temporaryAssetsCleanupRetryAt||0)>now)return [];
    return [{id:String(row.id),owner:String(row.owner),status:value.status,updatedAt:Number(row.updated||0)}];
  });
}

async function syncOwningWorkflows(parent:Job){
  if(!['succeeded','failed','unknown','save_failed'].includes(parent.status))return;
  const rows=db().prepare(`SELECT value FROM records WHERE bucket='workflows' AND owner=? AND instr(value,?)>0 ORDER BY updated ASC LIMIT 50`).all(parent.owner,parent.id);
  if(rows.length===0)return;
  const {advanceWorkflow,resumeWorkflow}=await import('./workflows');
  for(const row of rows){
    const workflow=JSON.parse(String(row.value)) as {id:string;status:string;steps:Record<string,{jobId?:string}>};
    if(!Object.values(workflow.steps||{}).some((step)=>step.jobId===parent.id))continue;
    if(workflow.status==='blocked'&&parent.status==='succeeded')await resumeWorkflow(workflow.id,parent.owner);
    await advanceWorkflow(workflow.id,parent.owner);
  }
}

export async function processCommerceRollingJob(id:string,owner:string,workerId:string,options:ProcessOptions={}){
  const value=job(id,owner);
  if(!value?.input.rollingPlan||value.input.rollingChild)return undefined;
  if(value.status==='save_failed'&&!options.forceRestitch){
    if(Number(value.rollingState?.restitchAttempts||0)>=MAX_AUTOMATIC_RESTITCH_ATTEMPTS)return value;
    if(Number(value.rollingState?.restitchRetryAt||0)>Date.now())return value;
  }
  const lease=claimCommerceRollingLease(id,owner,workerId,options.now??Date.now(),options.leaseMs??leaseDuration());
  if(!lease)return undefined;
  let current=true;
  const renew=()=>{
    if(!current)return false;
    try{current=renewCommerceRollingLease(lease);return current;}catch{current=false;return false;}
  };
  const heartbeat=setInterval(renew,Math.max(1_000,Math.floor((options.leaseMs??leaseDuration())/3)));
  heartbeat.unref?.();
  const permit:RollingExecutionPermit={isCurrent:()=>current&&commerceRollingLeaseIsCurrent(lease)};
  try{
    const candidate:CommerceRollingCandidate={id,owner,status:value.status,updatedAt:value.updatedAt};
    const result=options.processor?await options.processor(candidate,permit):value.status==='succeeded'&&value.rollingState?.temporaryAssetsCleanupStatus!=='complete'?(await cleanupRollingTailAssets(value,owner,permit),job(id,owner)):await advanceRollingParentWithLease(id,owner,permit);
    if(permit.isCurrent()&&result&&!options.skipWorkflowSync)await syncOwningWorkflows(result);
    return result;
  }finally{
    clearInterval(heartbeat);
    if(current)releaseCommerceRollingLease(lease);
  }
}

const processWorkerId=`${os.hostname()}:${process.pid}:${process.env.NODE_APP_INSTANCE||process.env.pm_id||'0'}:${crypto.randomUUID()}`;

export async function reconcileCommerceRollingBatch(options:ProcessOptions={}){
  await reconcileStaleUndispatchedCommerceJobs(options.now??Date.now());
  const candidates=commerceRollingCandidates(4,options.now??Date.now());
  for(const candidate of candidates)await processCommerceRollingJob(candidate.id,candidate.owner,processWorkerId,options);
}

const workerGlobal=globalThis as typeof globalThis&{__commerceRollingWorker?:DurableQueueLoop};
function loop(){return workerGlobal.__commerceRollingWorker??=new DurableQueueLoop({name:'commerce-rolling-video',intervalMs:5_000,runOnce:reconcileCommerceRollingBatch,onError:()=>console.warn('[CommerceRollingWorker] durable tick deferred')});}

export function startCommerceRollingWorker(){if(process.env.COMMERCE_ROLLING_WORKER==='0')return false;return loop().start();}
export function stopCommerceRollingWorker(timeout:number){return loop().stop(timeout);}
export function commerceRollingWorkerStatus(){return loop().snapshot();}
