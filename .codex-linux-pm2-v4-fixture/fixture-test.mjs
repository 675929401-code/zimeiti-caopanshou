// Synthetic fixture only: engine journal and private Node/Python FD are real;
// ingress/slot inputs are simulated and no production PM2 endpoint is opened.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {openLinuxStageEngine} from './linux-stage-engine-vnext.mjs';
import {inspectJournalReadOnly} from './linux-journal-owned-vnext.mjs';
import {startPrivateWorkerJournal} from './private-worker-owner-node.mjs';
if(process.platform!=='linux'||process.geteuid?.()!==0||process.env.PM2_FIXTURE_ONLY!=='github-isolated-v1')throw Error('FIXTURE_SCOPE');
const dir=path.dirname(fileURLToPath(import.meta.url)),python='/usr/bin/python3',entry=path.join(dir,'fixture-child.py');
const parent=fs.mkdtempSync('/root/codex-pm2-v4-fixture-');fs.chmodSync(parent,0o700);
const tx='synthetic-pm2-window-0123456789ab',root=path.join(parent,tx);
const binding={transactionId:tx,bootId:'synthetic-boot',releaseId:'synthetic-release',artifactSha256:'a'.repeat(64),hookSha256:'b'.repeat(64),configSha256:'c'.repeat(64),migrationSqlSha256:'d'.repeat(64),dbIdentity:'synthetic-database'};
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const allow=[{path:python,sha256:sha(python)},{path:entry,sha256:sha(entry)}];let channel,observed=false,engine;
const receipt=outcome=>({transactionId:tx,outcome,evidenceSha256:'9'.repeat(64)});
const providers={assertContinuity:async()=>{},installIngress:async()=>receipt('INGRESS_VERIFIED'),
 verifyWorkerControlFile:async(_b,p,h)=>allow.some(x=>x.path===p&&x.sha256===h)&&sha(p)===h,
 drainWorkers:async(_b,owner)=>{
  channel=await startPrivateWorkerJournal({owner,python,entry,transactionId:tx,allowedFiles:allow});
  const deadline=Date.now()+12000;let events=[];
  while(Date.now()<deadline&&channel.status()==='active'){
   events=engine.inspect().value.owner.workerEvents||[];
   if(events.some(x=>x.phase==='worker-exact-stop-observed'))break;
   await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(channel.status(),'active');assert.equal(events.length,2);
  const [baseline,closed]=events;assert.equal(baseline.phase,'worker-current-baseline');
  assert.equal(baseline.details.releaseReady,false);assert.deepEqual(baseline.details.generations.map(x=>x[2]).sort(),[18,19]);
  assert.equal(closed.phase,'worker-exact-stop-observed');assert.deepEqual(closed.details,{syntheticPidfdExited:true,ownedSocketsClosed:true,releaseReady:false});
  // Reopen using the real read-only journal code before deliberately poisoning
  // the synthetic release. The journal's checkpoint path fsyncs before ACK.
  const reread=inspectJournalReadOnly({root,binding});assert.deepEqual(reread.value.owner.workerEvents,events);assert.ok(reread.revision>=5);observed=true;
  throw Error('FIXTURE_EXPECTED_STOP');
 },
 verifyCommittedTransport:async()=>{},runProductionPreflight:async()=>{},adoptStoppedWorkers:async()=>{},activateFormalCandidate:async()=>{},restoreIngress:async()=>{},holdUnknown:()=>{}};
try{
 engine=openLinuxStageEngine({root,binding,providers});
 await assert.rejects(engine.prepare(),/FIXTURE_EXPECTED_STOP/);assert.equal(observed,true);assert.equal(engine.policy().stateUncertain,true);
 assert.equal(engine.policy().maintenanceMustRemain,true);
 const after=inspectJournalReadOnly({root,binding});assert.equal(after.value.owner.stateUncertain,true);assert.equal(after.value.owner.workerEvents[0].phase,'worker-current-baseline');
 console.log('PASS synthetic: real private SO_PEERCRED, live pidfds, durable same-journal worker baseline, socket close failures, UNKNOWN retained');
}finally{
 channel?.closeUnknown();
 if(!parent.startsWith('/root/codex-pm2-v4-fixture-')||path.dirname(parent)!=='/root')throw Error('FIXTURE_CLEANUP_PATH');
 fs.rmSync(parent,{recursive:true,force:true});
}
