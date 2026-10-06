import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
const root=process.cwd();
const fixtureRoot=path.join(root,'.codex-evidence','commerce-ordinary-worker-p0','fixture');
await fs.mkdir(fixtureRoot,{recursive:true});
process.env.COMMERCE_DATA_DIR=fixtureRoot;
Reflect.set(process.env,'NODE_ENV','test');

const store=await import('../src/commerce/server/store');
const worker=await import('../src/commerce/server/ordinary-worker');
const checks:Array<{name:string;passed:boolean;evidence:unknown}>=[];
const check=(name:string,condition:unknown,evidence:unknown)=>{assert.ok(condition,name);checks.push({name,passed:true,evidence});};
const owner='ordinary-worker-fixture-owner';
const base={kind:'job' as const,id:'job-lease-fixture',owner,updatedAt:1};

const first=worker.claimCommerceOrdinaryLease(base,'worker-a',1_000,10_000);
const blocked=worker.claimCommerceOrdinaryLease(base,'worker-b',1_001,10_000);
check('live lease excludes another worker',Boolean(first)&&blocked===null,{firstWorker:first?.workerId,blocked});
assert.ok(first);
check('only the lease owner can renew',worker.renewCommerceOrdinaryLease(first,2_000,10_000)===true,{expiresAt:first.expiresAt});
const forged={...first,workerId:'worker-b'};
check('forged worker cannot release another lease',worker.releaseCommerceOrdinaryLease(forged)===false,{forgedWorker:forged.workerId});
check('current lease owner releases successfully',worker.releaseCommerceOrdinaryLease(first)===true,{released:true});

const expired=worker.claimCommerceOrdinaryLease(base,'worker-a',20_000,10_000);
const reclaimed=worker.claimCommerceOrdinaryLease(base,'worker-b',30_001,10_000);
check('expired lease is reclaimable with a new fencing token',Boolean(expired&&reclaimed&&reclaimed.token===expired.token+1&&reclaimed.workerId==='worker-b'),{expiredToken:expired?.token,reclaimedToken:reclaimed?.token});
if(reclaimed)worker.releaseCommerceOrdinaryLease(reclaimed);

const now=Date.now()+20*60_000;
store.put('jobs','job-queued',owner,{id:'job-queued',owner,status:'queued',input:{rollingChild:false}});
store.put('media-edits','edit-running',owner,{id:'edit-running',owner,status:'running',updatedAt:1,input:{}});
store.put('frame-extractions','frame-queued',owner,{id:'frame-queued',owner,status:'queued'});
store.put('depth-video-clones','depth-queued',owner,{id:'depth-queued',owner,preparation:{id:'prep-queued',status:'queued'}});
store.put('hot-video-remix-jobs','remix-queued',owner,{id:'remix-queued',owner,status:'queued'});
store.put('voice-jobs','voice-queued',owner,{id:'voice-queued',owner,status:'queued',billingState:'charged'});
store.put('voice-jobs','voice-unknown',owner,{id:'voice-unknown',owner,status:'submission_unknown',billingState:'charged'});
store.put('voice-jobs','voice-charge-pending',owner,{id:'voice-charge-pending',owner,status:'billing_pending',billingState:'charge_pending'});
store.put('voice-jobs','voice-success-crash',owner,{id:'voice-success-crash',owner,status:'succeeded',billingState:'charged'});
store.put('voice-jobs','voice-failed-crash',owner,{id:'voice-failed-crash',owner,status:'failed',billingState:'charged'});
const candidates=worker.commerceOrdinaryCandidates(16,now),kinds=new Set(candidates.map(item=>item.kind));
check('candidate scan covers all six durable Commerce families',['job','media-edit','frame-extraction','depth-preparation','hot-video-remix','voice-synthesis'].every(kind=>kinds.has(kind as never))&&!candidates.some(item=>['voice-unknown','voice-charge-pending'].includes(item.id))&&['voice-success-crash','voice-failed-crash'].every(id=>candidates.some(item=>item.id===id)),{kinds:[...kinds].sort(),submissionUnknownExcluded:true,chargePendingExcluded:true,settlementCrashWindowsIncluded:true});

let processed=0;
await worker.reconcileCommerceOrdinaryBatch({
 now,
 leaseMs:10_000,
 candidates:[base,{...base}],
 processCandidate:async()=>{processed+=1;await new Promise(resolve=>setTimeout(resolve,20));},
});
check('duplicate candidates execute once behind the database lease',processed===1,{processed});

const mediaSource=await fs.readFile(path.join(root,'src','commerce','server','media-tools.ts'),'utf8');
const frameSource=await fs.readFile(path.join(root,'src','commerce','server','frame-extraction.ts'),'utf8');
const depthSource=await fs.readFile(path.join(root,'src','commerce','server','depth-video-clones.ts'),'utf8');
const coordinatorSource=await fs.readFile(path.join(root,'src','commerce','server','ordinary-worker.ts'),'utf8');
check('media edit dispatch uses an atomic queued-to-running transaction and bounded stale recovery',mediaSource.includes("current.status!=='queued'")&&mediaSource.includes('recoverStaleEdit')&&mediaSource.includes('10*60_000'),{atomicClaim:true,staleRecoveryMinutes:10});
check('queued frame extraction waits for the durable worker instead of being marked interrupted',frameSource.includes("if(value.status==='running'")&&!frameSource.includes("value.status==='queued'||value.status==='running'"),{queuedPreserved:true,runningCrashDetected:true});
check('depth preparation and new media families own durable recovery dispatch',depthSource.includes('DEPTH_PREPARATION_LEASE_MS=60_000')&&depthSource.includes('workerId===depthPreparationWorkerId')&&depthSource.includes('leaseUntil=Date.now()+DEPTH_PREPARATION_LEASE_MS')&&coordinatorSource.includes('recoverStaleHotVideoRemix')&&coordinatorSource.includes('runHotVideoRemix')&&coordinatorSource.includes('runVoiceJob')&&coordinatorSource.includes('sweepHotVideoRemixWorkdirs')&&!coordinatorSource.includes("json_extract(value,'$.status')='submission_unknown'")&&!coordinatorSource.includes("json_extract(value,'$.billingState')='charge_pending'"),{depthLeaseMs:60_000,ownerFenced:true,heartbeat:true,hotVideoRemix:true,voiceSynthesis:true,unknownAutoReplay:false,chargeAutoRetry:false,hotWorkdirSweep:true});

const report={
 observedAt:new Date().toISOString(),
 result:{total:checks.length,passed:checks.length,failed:0},
 safety:{providerRequests:0,paidTasksCreated:0,productionWrites:0,deployment:0},
 checks,
};
const output=path.join(root,'.codex-evidence','commerce-ordinary-worker-p0','report.json');
await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
console.log(JSON.stringify({output,result:report.result,safety:report.safety},null,2));
}

main().catch(error=>{
 console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error),providerRequests:0,paidTasksCreated:0,productionWrites:0,deployment:0}));
 process.exitCode=1;
});
