// Isolated root-owned Linux fixture. No server, PM2, Nginx, or network is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {openLinuxStageEngine,openProductionLinuxOwner} from './linux-stage-engine.mjs';
import {createJournalForLinux} from './linux-journal-owned.mjs';
import {attachLinuxSupervisor} from './supervisor-channel.mjs';
import {createControllerStageFacade} from './controller-stage-facade.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hashValue} from '../worker-quiescence-plan-61e9/activation-integration/hook-adoption-prototype.mjs';
if(process.platform!=='linux'||process.geteuid()!==0)throw Error('LINUX_ROOT_REQUIRED');
const parent=fs.mkdtempSync('/root/zimeiti-supervisor-fixture-');fs.chmodSync(parent,0o700);
if(fs.realpathSync(parent)!==parent||!/^\/root\/zimeiti-supervisor-fixture-[A-Za-z0-9]+$/.test(parent))throw Error('FIXTURE_PATH_UNSAFE');
const b={batchId:'c5d939ed-099b-42d0-b6e3-26a15b59eb70',scriptSha256:'d'.repeat(64),wireSha256:'e'.repeat(64)};
const identity=id=>({transactionId:id,bootId:'fixture-boot',releaseId:'fixture-release',artifactSha256:'a'.repeat(64),hookSha256:'b'.repeat(64),configSha256:'c'.repeat(64),migrationSqlSha256:'d'.repeat(64),dbIdentity:'fixture-database'});
const snapshot={bootId:'fixture-boot',previous:{name:'agent-hub-media-worker',cwd:'/fixture/old-web',executable:'/fixture/old-web/server.js',port:5102,releaseId:'old-release',commitSha:'a'.repeat(40),buildId:'old-build',sourceVersion:'old-source',buildOutputDigest:'b'.repeat(64),assetDigest:'c'.repeat(64),assetManifestSha256:'d'.repeat(64),execMode:'fork_mode',processFlags:{media:'1',video:'1',human:'1'},ports:[5102,5103]},workers:[{id:18,pid:42,startTicks:100,pm2UniqueId:'slot-18',port:5102},{id:19,pid:43,startTicks:101,pm2UniqueId:'slot-19',port:5103}]};
function newSession(id,opts={}){
 const binding=identity(id),tx=binding.transactionId,trace=[];
 const r=(outcome)=>({transactionId:tx,outcome,evidenceSha256:crypto.createHash('sha256').update(outcome).digest('hex')});
 const providers={assertContinuity:async()=>{trace.push('continuity');if(opts.failAfterRestore&&trace.includes('restore'))throw Error('POST_RELEASE_CONTINUITY_FAILED');},installIngress:async()=>{trace.push('ingress');return r('INGRESS_VERIFIED')},drainWorkers:async()=>{trace.push('drain');return {...r('WORKERS_DRAINED'),snapshot:structuredClone(snapshot)}},invokeControllerHookPhase:async(_binding,phase,claim)=>({...r({prepare:'HOOK_PREPARED',activated:'HOOK_ACTIVATED',precommit:'HOOK_PRECOMMIT',persisted:'HOOK_PERSISTED'}[phase]),workerSnapshotSha256:claim.workerSnapshotSha256,journalValueSha256:claim.journalValueSha256}),verifyControllerExitAndDurableSuccess:async()=>r('CONTROLLER_SUCCESS_DURABLE'),verifyCommittedTransport:async(_i,_b,raw)=>{trace.push('verify-receipt');if(opts.rejectReceipt)throw Error('REJECTED');assert.equal(raw,`COMMIT_CONFIRMED_${b.batchId}\n`);return r('EXACT_RECEIPT_VERIFIED')},runProductionPreflight:async()=>{trace.push('preflight');return r('PREFLIGHT_VERIFIED')},adoptStoppedWorkers:async(_binding,claim)=>{trace.push('adopt');assert.equal(claim.workerSnapshotSha256,hashValue(snapshot));assert.deepEqual(claim.workerSnapshot,snapshot);return {...r('HOOK_PREPARED'),workerSnapshotSha256:opts.badAdoption?'0'.repeat(64):claim.workerSnapshotSha256,journalValueSha256:claim.journalValueSha256}},activateFormalCandidate:async()=>{trace.push('activate');return r('CANDIDATE_ACTIVE_AND_PERSISTED')},restoreIngress:async()=>{trace.push('restore');return r('INGRESS_RESTORED_AND_VERIFIED')},holdUnknown:()=>trace.push('hold-unknown')};
 return {engine:openLinuxStageEngine({root:path.join(parent,id),binding,providers}),trace};
}
const id='fixture-transaction-0123456789ab',context={transactionId:id,artifactSha256:'a'.repeat(64),descriptorSha256:'f'.repeat(64),manifestSha256:'b'.repeat(64),ownerSha256:'c'.repeat(64)};
const {engine}=newSession(id),shell=path.join(path.dirname(fileURLToPath(import.meta.url)),'controller-fixture.sh');
const facade=createControllerStageFacade({engine,launchOwnedController:async()=>spawn('/bin/bash',[shell],{stdio:['ignore','ignore','ignore','pipe','pipe'],shell:false,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}})});
attachLinuxSupervisor({input:process.stdin,output:process.stdout,verifyAndOpen:async()=>({identity:context,engine:facade})});
process.once('exit',()=>{try{fs.rmSync(parent,{recursive:true,force:true})}catch{}});
