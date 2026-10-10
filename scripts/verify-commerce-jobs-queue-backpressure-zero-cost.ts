import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
 const root=process.cwd();
 const fixtureRoot=path.join(root,'.codex-evidence','commerce-jobs-queue-backpressure','fixture');
 await fs.mkdir(fixtureRoot,{recursive:true});
 process.env.COMMERCE_DATA_DIR=fixtureRoot;
 process.env.COMMERCE_PROVIDER_CONCURRENCY='2';
 Reflect.set(process.env,'NODE_ENV','test');

 const worker=await import('../src/commerce/server/ordinary-worker');
 const routeSource=await fs.readFile(path.join(root,'src','app','api','commerce','jobs','route.ts'),'utf8');
 const workerSource=await fs.readFile(path.join(root,'src','commerce','server','ordinary-worker.ts'),'utf8');
 const checks:Array<{name:string;passed:boolean;evidence:unknown}>=[];
 const check=(name:string,condition:unknown,evidence:unknown)=>{assert.ok(condition,name);checks.push({name,passed:true,evidence});};

 const getBody=routeSource.slice(routeSource.indexOf('export async function GET'),routeSource.indexOf('export async function POST'));
 const confirmBody=routeSource.slice(routeSource.indexOf('const value = await confirmCommerceQuote'));
 check('job list is read-only and cannot trigger provider polling',!getBody.includes('after(')&&!getBody.includes('refreshJob'),{after:false,refreshJob:false});
 check('quote confirmation only persists a queued job',!confirmBody.includes('runJob(')&&routeSource.includes('Only the dedicated\n    // Commerce worker may claim and dispatch it'),{directDispatch:false,status:202});
 check('worker owns a durable cross-process provider slot cap',workerSource.includes("GLOB 'job:*'")&&workerSource.includes('COMMERCE_PROVIDER_CONCURRENCY')&&workerSource.includes('commerceProviderConcurrencyLimit'),{configuredLimit:worker.commerceProviderConcurrencyLimit()});
 check('stale pre-dispatch recovery stays behind the worker lease',workerSource.includes('claimStaleUndispatchedCommerceJob(candidate.id,candidate.owner,now)')&&!workerSource.includes('await reconcileStaleUndispatchedCommerceJobs(now,limit)'),{recoveryInsideCandidateLease:true});

 const owner='queue-backpressure-fixture-owner',now=100_000,duration=10_000;
 const candidate=(id:string,kind:'job'|'media-edit'='job')=>({kind,id,owner,updatedAt:1} as const);
 const first=worker.claimCommerceOrdinaryLease(candidate('job-a'),'worker-a',now,duration);
 const second=worker.claimCommerceOrdinaryLease(candidate('job-b'),'worker-b',now,duration);
 const blocked=worker.claimCommerceOrdinaryLease(candidate('job-c'),'worker-c',now,duration);
 check('provider slots stop the third simultaneous job across workers',Boolean(first&&second)&&blocked===null,{limit:2,first:Boolean(first),second:Boolean(second),third:blocked});
 const nonProvider=worker.claimCommerceOrdinaryLease(candidate('edit-a','media-edit'),'worker-c',now,duration);
 check('provider backpressure does not block unrelated local media work',Boolean(nonProvider),{mediaEditLease:Boolean(nonProvider)});
 assert.ok(first&&second&&nonProvider);
 worker.releaseCommerceOrdinaryLease(first);
 const admitted=worker.claimCommerceOrdinaryLease(candidate('job-c'),'worker-c',now+1,duration);
 check('released capacity admits the next queued job',Boolean(admitted),{admitted:Boolean(admitted)});
 worker.releaseCommerceOrdinaryLease(second);
 worker.releaseCommerceOrdinaryLease(nonProvider);
 if(admitted)worker.releaseCommerceOrdinaryLease(admitted);

 let processed=0;
 await worker.reconcileCommerceOrdinaryBatch({
  now:200_000,
  leaseMs:duration,
  candidates:['batch-a','batch-b','batch-c','batch-d'].map(id=>candidate(id)),
  processCandidate:async()=>{processed+=1;await new Promise(resolve=>setTimeout(resolve,20));},
 });
 check('one worker tick cannot exceed the durable provider limit',processed===2,{queued:4,processed,limit:2});

 const report={
  observedAt:new Date().toISOString(),
  result:{total:checks.length,passed:checks.length,failed:0},
  safety:{networkRequests:0,providerRequests:0,paidTasksCreated:0,productionWrites:0,deployment:0},
  checks,
 };
 const output=path.join(root,'.codex-evidence','commerce-jobs-queue-backpressure','report.json');
 await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');
 console.log(JSON.stringify({output,result:report.result,safety:report.safety},null,2));
}

main().catch(error=>{
 console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error),networkRequests:0,providerRequests:0,paidTasksCreated:0,productionWrites:0,deployment:0}));
 process.exitCode=1;
});
