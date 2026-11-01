// Synthetic test only. Uses actual v5 engine, journal, Node owner and child
// session; ingress, application state and PM2 slots below are test doubles.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {openLinuxStageEngine} from './scripts/linux-stage-engine-vnext.mjs';
import {inspectJournalReadOnly} from './scripts/linux-journal-owned-vnext.mjs';
import {startPrivateWorkerJournal} from './scripts/worker-closure/linux-owner-implementation-61e9/private-worker-owner-node.mjs';
if(process.platform!=='linux'||process.geteuid?.()!==0||process.env.WORKER_FIXTURE_ONLY!=='github-isolated-v1')throw Error('FIXTURE_SCOPE');
const here=path.dirname(fileURLToPath(import.meta.url)),python='/usr/bin/python3',entry=path.join(here,'scripts/worker-closure/linux-owner-implementation-61e9/worker-provider/fixture-launcher.py');
const tx='synthetic-worker-session-0123456789ab',sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const snapshot={bootId:'synthetic-boot',previous:{name:'agent-hub-media-worker',cwd:'/synthetic/old',executable:'/synthetic/old/server.js',port:5102,releaseId:'old-release',commitSha:'a'.repeat(40),buildId:'old-build',sourceVersion:'old-source',buildOutputDigest:'b'.repeat(64),assetDigest:'c'.repeat(64),assetManifestSha256:'d'.repeat(64),execMode:'fork_mode',processFlags:{media:'1',video:'1',human:'1'},ports:[5102,5103]},workers:[{id:18,pid:42,startTicks:100,pm2UniqueId:'synthetic-18',port:5102},{id:19,pid:43,startTicks:101,pm2UniqueId:'synthetic-19',port:5103}]};
const batch={batchId:'c5d939ed-099b-42d0-b6e3-26a15b59eb70',scriptSha256:'d'.repeat(64),wireSha256:'e'.repeat(64)};
async function runCase(mode){
 const parent=fs.mkdtempSync('/root/codex-worker-session-v5-');fs.chmodSync(parent,0o700);const root=path.join(parent,tx);
 const binding={transactionId:tx,bootId:'synthetic-boot',releaseId:'synthetic-release',artifactSha256:'a'.repeat(64),hookSha256:'b'.repeat(64),configSha256:'c'.repeat(64),migrationSqlSha256:'d'.repeat(64),dbIdentity:'synthetic-database'};
 const allow=[{path:python,sha256:sha(python)},{path:entry,sha256:sha(entry)}];let session,engine;
 const receipt=outcome=>({transactionId:tx,outcome,evidenceSha256:'9'.repeat(64)});
 const providers={assertContinuity:async()=>{},installIngress:async()=>receipt('INGRESS_VERIFIED'),
 verifyWorkerControlFile:async(_b,p,h)=>allow.some(x=>x.path===p&&x.sha256===h)&&sha(p)===h,
 drainWorkers:async(_b,owner)=>{
  session=await startPrivateWorkerJournal({owner,python,entry,transactionId:tx,allowedFiles:allow});
  if(mode==='wrong-order'){
   await assert.rejects(session.request('check'));throw Error('EXPECTED_FIXTURE_UNKNOWN');
  }
  assert.equal(await session.request('open'),'WATCH_OPEN');assert.equal(await session.request('check'),'WATCH_OK');
  const read=inspectJournalReadOnly({root,binding});assert.deepEqual(read.value.owner.workerEvents.map(x=>x.phase),['worker-current-baseline','worker-watch-created']);
  if(mode==='early-finish'){await assert.rejects(session.request('finish'));throw Error('EXPECTED_FIXTURE_UNKNOWN');}
  if(mode==='disconnect'){session.closeUnknown();throw Error('EXPECTED_FIXTURE_UNKNOWN');}
  if(mode==='owner-loss'){engine.poison();await assert.rejects(session.request('check'));throw Error('EXPECTED_FIXTURE_UNKNOWN');}
  return {...receipt('WORKERS_DRAINED'),snapshot};
 },
 verifyCommittedTransport:async()=>receipt('EXACT_RECEIPT_VERIFIED'),runProductionPreflight:async()=>receipt('PREFLIGHT_VERIFIED'),
 adoptStoppedWorkers:async(_b,c)=>({...receipt('HOOK_PREPARED'),workerSnapshotSha256:c.workerSnapshotSha256,journalValueSha256:c.journalValueSha256}),
 activateFormalCandidate:async()=>receipt('CANDIDATE_ACTIVE_AND_PERSISTED'),restoreIngress:async()=>receipt('INGRESS_RESTORED_AND_VERIFIED'),holdUnknown:()=>{}};
 try{
  engine=openLinuxStageEngine({root,binding,providers});
  if(mode!=='normal'){
   await assert.rejects(engine.prepare());assert.equal(engine.policy().stateUncertain,true);assert.equal(engine.policy().maintenanceMustRemain,true);assert.equal(session.status(),'unknown');
   assert.equal(inspectJournalReadOnly({root,binding}).value.owner.stateUncertain,true);return;
  }
  assert.equal(await engine.prepare(),'HELD');assert.equal(await session.request('check'),'WATCH_OK');
  await engine.recordPrepared(batch);await engine.recordIntent(batch);await engine.recordOutcome(batch,`COMMIT_CONFIRMED_${batch.batchId}\n`);await engine.preflight();await engine.activate();await engine.release();
  assert.equal(await session.request('finish'),'WATCH_FINISHED');assert.equal(session.status(),'retired');
  const final=inspectJournalReadOnly({root,binding});assert.equal(final.value.owner.phase,'complete');assert.equal(final.value.owner.stateUncertain,false);
  assert.deepEqual(final.value.owner.workerEvents.map(x=>x.phase),['worker-current-baseline','worker-watch-created']);
 }finally{
  session?.closeUnknown();
  if(!parent.startsWith('/root/codex-worker-session-v5-')||path.dirname(parent)!=='/root')throw Error('FIXTURE_CLEANUP_PATH');
  fs.rmSync(parent,{recursive:true,force:true});
 }
}
for(const mode of ['normal','wrong-order','early-finish','disconnect','owner-loss']){await runCase(mode);console.log('PASS synthetic '+mode);}
