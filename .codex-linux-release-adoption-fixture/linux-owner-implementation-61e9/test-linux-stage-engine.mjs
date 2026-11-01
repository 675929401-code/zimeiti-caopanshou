// Isolated root-owned Linux fixture. No server, PM2, Nginx, or network is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {openLinuxStageEngine,openProductionLinuxOwner} from './linux-stage-engine.mjs';
import {createJournalForLinux} from './linux-journal-owned.mjs';
import {hashValue} from '../worker-quiescence-plan-61e9/activation-integration/hook-adoption-prototype.mjs';
if(process.platform!=='linux'||process.geteuid()!==0)throw Error('LINUX_ROOT_REQUIRED');
if(fs.readlinkSync('/proc/self/ns/net')===fs.readlinkSync('/proc/1/ns/net'))throw Error('ISOLATED_NETWORK_REQUIRED');
const parent=fs.mkdtempSync('/root/zimeiti-supervisor-fixture-');fs.chmodSync(parent,0o700);
if(fs.realpathSync(parent)!==parent||!/^\/root\/zimeiti-supervisor-fixture-[A-Za-z0-9]+$/.test(parent))throw Error('FIXTURE_PATH_UNSAFE');
const b={batchId:'c5d939ed-099b-42d0-b6e3-26a15b59eb70',scriptSha256:'d'.repeat(64),wireSha256:'e'.repeat(64)};
const identity=id=>({transactionId:id,bootId:'fixture-boot',releaseId:'fixture-release',artifactSha256:'a'.repeat(64),hookSha256:'b'.repeat(64),configSha256:'c'.repeat(64),migrationSqlSha256:'d'.repeat(64),dbIdentity:'fixture-database'});
const snapshot={bootId:'fixture-boot',previous:{name:'agent-hub-media-worker',cwd:'/fixture/old-web',executable:'/fixture/old-web/server.js',port:5102,releaseId:'old-release',commitSha:'a'.repeat(40),buildId:'old-build',sourceVersion:'old-source',buildOutputDigest:'b'.repeat(64),assetDigest:'c'.repeat(64),assetManifestSha256:'d'.repeat(64),execMode:'fork_mode',processFlags:{media:'1',video:'1',human:'1'},ports:[5102,5103]},workers:[{id:18,pid:42,startTicks:100,pm2UniqueId:'slot-18',port:5102},{id:19,pid:43,startTicks:101,pm2UniqueId:'slot-19',port:5103}]};
function newSession(id,opts={}){
 const binding=identity(id),tx=binding.transactionId,trace=[];
 const r=(outcome)=>({transactionId:tx,outcome,evidenceSha256:crypto.createHash('sha256').update(outcome).digest('hex')});
 const providers={assertContinuity:async()=>{trace.push('continuity');if(opts.failAfterRestore&&trace.includes('restore'))throw Error('POST_RELEASE_CONTINUITY_FAILED');},installIngress:async()=>{trace.push('ingress');return r('INGRESS_VERIFIED')},drainWorkers:async()=>{trace.push('drain');return {...r('WORKERS_DRAINED'),snapshot:structuredClone(snapshot)}},verifyCommittedTransport:async(_i,_b,raw)=>{trace.push('verify-receipt');if(opts.rejectReceipt)throw Error('REJECTED');assert.equal(raw,`COMMIT_CONFIRMED_${b.batchId}\n`);return r('EXACT_RECEIPT_VERIFIED')},runProductionPreflight:async()=>{trace.push('preflight');return r('PREFLIGHT_VERIFIED')},adoptStoppedWorkers:async(_binding,claim)=>{trace.push('adopt');assert.equal(claim.workerSnapshotSha256,hashValue(snapshot));assert.deepEqual(claim.workerSnapshot,snapshot);return {...r('HOOK_PREPARED'),workerSnapshotSha256:opts.badAdoption?'0'.repeat(64):claim.workerSnapshotSha256,journalValueSha256:claim.journalValueSha256}},activateFormalCandidate:async()=>{trace.push('activate');return r('CANDIDATE_ACTIVE_AND_PERSISTED')},restoreIngress:async()=>{trace.push('restore');return r('INGRESS_RESTORED_AND_VERIFIED')},holdUnknown:()=>trace.push('hold-unknown')};
 return {engine:openLinuxStageEngine({root:path.join(parent,id),binding,providers}),trace};
}
try{
 assert.throws(openProductionLinuxOwner,/WINDOW_AUTHENTICATED_PROVIDERS_NOT_CONNECTED/);
 const x=newSession('fixture-transaction-0001');assert.equal(await x.engine.prepare(),'HELD');assert.equal(await x.engine.recordPrepared(b),'PREPARED');assert.equal(await x.engine.recordIntent(b),'INTENT_RECORDED');assert.equal(await x.engine.recordOutcome(b,`COMMIT_CONFIRMED_${b.batchId}\n`),'COMMITTED_RECORDED');assert.equal(await x.engine.preflight(),'PREFLIGHT_OK');assert.equal(await x.engine.activate(),'ACTIVE_PERSISTED');assert.equal(await x.engine.release(),'RELEASED');assert.equal(x.engine.policy().phase,'complete');assert.equal(x.engine.policy().maintenanceMustRemain,false);assert.ok(x.trace.indexOf('verify-receipt')<x.trace.indexOf('preflight'));assert.ok(x.trace.indexOf('adopt')<x.trace.indexOf('activate'));assert.ok(x.trace.indexOf('activate')<x.trace.indexOf('restore'));
 const y=newSession('fixture-transaction-0002');await y.engine.prepare();await y.engine.recordPrepared(b);await y.engine.recordIntent(b);assert.equal(await y.engine.recordOutcome(b,'UNKNOWN'),'UNKNOWN_RECORDED');assert.equal(y.engine.policy().stateUncertain,true);assert.equal(y.engine.policy().maintenanceMustRemain,true);await assert.rejects(y.engine.preflight(),/WINDOW_PHASE_INVALID/);assert.ok(!y.trace.includes('activate'));
 const z=newSession('fixture-transaction-0003',{rejectReceipt:true});await z.engine.prepare();await z.engine.recordPrepared(b);await z.engine.recordIntent(b);await assert.rejects(z.engine.recordOutcome(b,`COMMIT_CONFIRMED_${b.batchId}\n`),/REJECTED/);assert.equal(z.engine.policy().phase,'migration-dispatch-intent');assert.equal(z.engine.policy().stateUncertain,true);assert.ok(!z.trace.includes('preflight'));
 const q=newSession('fixture-transaction-0004');await q.engine.prepare();await q.engine.recordPrepared(b);await q.engine.recordIntent(b);await assert.rejects(q.engine.recordOutcome({...b,wireSha256:'f'.repeat(64)},`COMMIT_CONFIRMED_${b.batchId}\n`),/WINDOW_BATCH_DRIFT/);assert.equal(q.engine.policy().stateUncertain,true);
 // Formal parent permits 0755 when root-owned and not writable by group/other.
 fs.chmodSync(parent,0o755);
 const directId='fixture-transaction-0006',directBinding=identity(directId),h=hashValue(snapshot);
 const initial={status:'preparing',slotJournal:{phase:'initial'},owner:{phase:'preflight-ok',stateUncertain:false,migrationOutcome:'COMMITTED',workerEvidenceSha256:'1'.repeat(64),commitEvidenceSha256:'2'.repeat(64),rawReceiptSha256:'3'.repeat(64),preflightEvidenceSha256:'4'.repeat(64),workerSnapshot:snapshot,workerSnapshotSha256:h}};
 const direct=createJournalForLinux({root:path.join(parent,directId),binding:directBinding,initialState:initial});
 const pre=direct.inspect();assert.throws(()=>direct.claimPreStoppedHook(pre.valueSha256,'f'.repeat(64)),/HOOK_ADOPTION_EVIDENCE_INVALID/);
 const adopted=direct.claimPreStoppedHook(pre.valueSha256,h);assert.deepEqual(adopted.workerSnapshot,snapshot);assert.equal(direct.inspect().value.owner.phase,'hook-adoption-intent');
 assert.throws(()=>direct.claimPreStoppedHook(pre.valueSha256,h),/HOOK_ADOPTION_REPLAY_FORBIDDEN/);
 fs.chmodSync(parent,0o777);assert.throws(()=>direct.inspect());fs.chmodSync(parent,0o700);
 const t=newSession('fixture-transaction-0007',{badAdoption:true});await t.engine.prepare();await t.engine.recordPrepared(b);await t.engine.recordIntent(b);await t.engine.recordOutcome(b,`COMMIT_CONFIRMED_${b.batchId}\n`);await t.engine.preflight();await assert.rejects(t.engine.activate(),/WINDOW_HOOK_ADOPTION_BINDING_INVALID/);assert.equal(t.engine.policy().phase,'hook-adoption-intent');assert.equal(t.engine.policy().stateUncertain,true);assert.ok(!t.trace.includes('activate'));
 const f=newSession('fixture-transaction-0005',{failAfterRestore:true});await f.engine.prepare();await f.engine.recordPrepared(b);await f.engine.recordIntent(b);await f.engine.recordOutcome(b,`COMMIT_CONFIRMED_${b.batchId}\n`);await f.engine.preflight();await f.engine.activate();await assert.rejects(f.engine.release(),/POST_RELEASE_CONTINUITY_FAILED/);assert.equal(f.engine.policy().phase,'complete');assert.equal(f.engine.policy().stateUncertain,true);assert.equal(f.engine.policy().maintenanceMustRemain,true);
 console.log(JSON.stringify({passed:true,nativeJournal:true,syntheticProviders:true,productionCalls:0,realDatabaseCalls:0,successAndFiveFailureCases:true,existingParent755AndNoReplay:true}));
}finally{fs.rmSync(parent,{recursive:true,force:true});}
