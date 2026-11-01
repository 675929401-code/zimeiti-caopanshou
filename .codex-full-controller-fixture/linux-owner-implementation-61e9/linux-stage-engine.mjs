// Linux transaction coordinator. This module is a stage engine, not a
// production launcher: callers cannot derive authenticated providers from JSON.
// Production entry remains closed until installed control-plane, ingress,
// worker and receipt providers are wired and independently reviewed.
import crypto from 'node:crypto';
import path from 'node:path';
import {hashValue} from '../worker-quiescence-plan-61e9/activation-integration/hook-adoption-prototype.mjs';
import {createJournalForLinux} from './linux-journal-owned.mjs';

const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=x=>{throw Error(x)};
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const metaKeys=['batchId','scriptSha256','wireSha256'];
function batch(x){
 if(!x||Array.isArray(x)||Object.keys(x).sort().join(',')!==metaKeys.join(',')||!UUID.test(x.batchId)||!HASH.test(x.scriptSha256)||!HASH.test(x.wireSha256))fail('WINDOW_BATCH_INVALID');
 return Object.freeze({...x});
}
function sameBatch(a,b){return !!a&&!!b&&metaKeys.every(k=>a[k]===b[k]);}
function stoppedSnapshot(input,binding){
 if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='bootId,previous,workers'||input.bootId!==binding.bootId||!Array.isArray(input.workers)||input.workers.length!==2)fail('WINDOW_WORKER_SNAPSHOT_INVALID');
 const prev=input.previous,keys=['name','cwd','executable','port','releaseId','commitSha','buildId','sourceVersion','buildOutputDigest','assetDigest','assetManifestSha256','execMode','processFlags','ports'];
 if(!prev||Array.isArray(prev)||Object.keys(prev).sort().join(',')!==keys.sort().join(',')||prev.name!=='agent-hub-media-worker'||prev.execMode!=='fork_mode'||prev.port!==5102||JSON.stringify(prev.ports)!=='[5102,5103]'||typeof prev.cwd!=='string'||!path.posix.isAbsolute(prev.cwd)||path.posix.normalize(prev.cwd)!==prev.cwd||prev.executable!==path.posix.join(prev.cwd,'server.js')||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(prev.releaseId||'')||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(prev.commitSha||'')||!/^[A-Za-z0-9._-]{1,256}$/.test(prev.buildId||'')||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(prev.sourceVersion||'')||!['buildOutputDigest','assetDigest','assetManifestSha256'].every(k=>HASH.test(prev[k]||''))||
    !prev.processFlags||Object.keys(prev.processFlags).sort().join(',')!=='human,media,video'||Object.values(prev.processFlags).some(x=>x!=='1'))fail('WINDOW_WORKER_SNAPSHOT_INVALID');
 const ids=new Set(),pids=new Set(),ports=new Set(),unique=new Set();
 for(const w of input.workers){
  if(!w||Array.isArray(w)||Object.keys(w).sort().join(',')!=='id,pid,pm2UniqueId,port,startTicks'||!Number.isSafeInteger(w.id)||w.id<0||!Number.isSafeInteger(w.pid)||w.pid<=0||!Number.isSafeInteger(w.startTicks)||w.startTicks<=0||!Number.isInteger(w.port)||![5102,5103].includes(w.port)||typeof w.pm2UniqueId!=='string'||!w.pm2UniqueId||w.pm2UniqueId.length>128)fail('WINDOW_WORKER_SNAPSHOT_INVALID');
  ids.add(w.id);pids.add(w.pid);ports.add(w.port);unique.add(w.pm2UniqueId);
 }
 if(ids.size!==2||pids.size!==2||ports.size!==2||unique.size!==2)fail('WINDOW_WORKER_SNAPSHOT_INVALID');
 return clone(input);
}
function expectReceipt(r,tx,outcome){
 if(!r||r.transactionId!==tx||r.outcome!==outcome||!HASH.test(r.evidenceSha256||''))fail('WINDOW_PROVIDER_RECEIPT_INVALID');
 return r.evidenceSha256;
}

// `providers` must come from the installed, authenticated control-plane, not a
// stdio request. The only production factory in this file is hard-closed below.
export function openLinuxStageEngine({root,binding,providers}){
 if(process.platform!=='linux'||process.geteuid?.()!==0)fail('WINDOW_LINUX_ROOT_REQUIRED');
 const names=['assertContinuity','installIngress','drainWorkers','verifyCommittedTransport','runProductionPreflight','adoptStoppedWorkers','activateFormalCandidate','restoreIngress','holdUnknown'];
 if(!providers||!names.every(k=>typeof providers[k]==='function'))fail('WINDOW_PROVIDER_MISSING');
 const fixed=Object.freeze(clone(binding)),tx=fixed.transactionId;
 const initial={status:'preparing',slotJournal:{phase:'initial'},owner:{phase:'created',transactionId:tx,stateUncertain:false}};
 const journal=createJournalForLinux({root,binding:fixed,initialState:initial});
 const ownerPid=process.pid,bindingHash=hashValue(fixed);let state='created',busy=false,poisoned=false,prepared=null,workerTerminalAuthorized=false,controllerClaim=null;
 function save(next,extra={}){
  if(poisoned||process.pid!==ownerPid)fail('WINDOW_OWNER_INVALID');
  const old=journal.inspect();
  if(hashValue(old.binding)!==bindingHash||old.value.owner.phase!==state)fail('WINDOW_JOURNAL_DRIFT');
  const value=clone(old.value);value.owner={...value.owner,...clone(extra),phase:next};
  journal.checkpoint(old.valueSha256,value);
  if(journal.inspect().valueSha256!==hashValue(value))fail('WINDOW_JOURNAL_READBACK_FAILED');
  state=next;
 }
 function poison(){
  if(poisoned)return;poisoned=true;
  try{
   if(process.pid===ownerPid){const old=journal.inspect();if(old.value.owner.phase===state){const v=clone(old.value);v.owner.stateUncertain=true;journal.checkpoint(old.valueSha256,v);}}
  }catch{}
  try{const p=providers.holdUnknown();if(p&&typeof p.then==='function')Promise.resolve(p).catch(()=>{});}catch{}
 }
 function assertOwnerCurrent(){
  if(poisoned||process.pid!==ownerPid)fail('WINDOW_OWNER_INVALID');
  const rec=journal.inspect();if(hashValue(rec.binding)!==bindingHash||rec.value.owner.phase!==state||rec.value.owner.stateUncertain===true)fail('WINDOW_JOURNAL_DRIFT');
 }
 async function run(expected,fn){
  if(poisoned||busy||state!==expected||process.pid!==ownerPid)fail('WINDOW_PHASE_INVALID');busy=true;
  try{assertOwnerCurrent();await providers.assertContinuity(fixed);assertOwnerCurrent();const value=await fn();assertOwnerCurrent();await providers.assertContinuity(fixed);assertOwnerCurrent();return value;}
  catch(e){poison();throw e;}finally{busy=false;}
 }
 // This capability is minted inside the journal-owning engine. It can
 // persist only bounded worker observations while the same drain stage runs.
 // Production entry stays closed until the installed verifier is authenticated.
 const workerPhases=new Set(['worker-drain-intent','held','migration-prepared','migration-dispatch-intent','migration-committed','preflight-intent','preflight-ok','hook-adoption-intent','hook-prepared','controller-activated','controller-precommit','controller-persisted','activation-intent','active','ingress-release-intent','complete']);
 const workerEvents=new Set(['worker-watch-created','worker-watch-unknown','worker-stop-intent','worker-generation-absence-observed','worker-exact-rpc-intent','worker-exact-stop-observed']);
 function assertWorkerBound(){
  if(poisoned||!workerPhases.has(state)||(state==='complete'&&!busy&&!workerTerminalAuthorized)||process.pid!==ownerPid)fail('WINDOW_WORKER_OWNER_INVALID');
  const rec=journal.inspect();
  if(hashValue(rec.binding)!==bindingHash||rec.value.owner.phase!==state)fail('WINDOW_WORKER_JOURNAL_CHANGED');
 }
 const workerOwner=Object.freeze({
  assert_live:assertWorkerBound,
  assert_bound:assertWorkerBound,
  assert_terminal(){assertWorkerBound();if(state!=='complete'||!workerTerminalAuthorized||journal.inspect().value.owner.stateUncertain===true)fail('WINDOW_WORKER_TERMINAL_NOT_AUTHORIZED');},
  async verify_file(path,sha){
   assertWorkerBound();if(typeof providers.verifyWorkerControlFile!=='function')fail('WINDOW_WORKER_VERIFIER_NOT_CONNECTED');
   if(typeof path!=='string'||!HASH.test(sha||''))fail('WINDOW_WORKER_FILE_INVALID');
   const ok=await providers.verifyWorkerControlFile(fixed,path,sha);assertWorkerBound();if(ok!==true)fail('WINDOW_WORKER_FILE_UNVERIFIED');
  },
  checkpoint(phase,details){
   assertWorkerBound();if(!workerEvents.has(phase)||!details||typeof details!=='object'||Array.isArray(details)||Buffer.byteLength(JSON.stringify(details))>8192)fail('WINDOW_WORKER_EVENT_INVALID');
   if(phase==='worker-watch-unknown'){poison();fail('WINDOW_WORKER_UNKNOWN');}
   const rec=journal.inspect(),prior=rec.value.owner.workerEvents||[];
   if(!Array.isArray(prior)||prior.length>=16)fail('WINDOW_WORKER_EVENT_LIMIT');
   save(state,{workerEvents:[...prior,{phase,details:clone(details)}]});assertWorkerBound();
  },
  mark_unknown(){poison();},
 });
 async function prepare(){return run('created',async()=>{
  save('ingress-install-intent');const held=expectReceipt(await providers.installIngress(fixed),tx,'INGRESS_VERIFIED');save('ingress-verified',{ingressEvidenceSha256:held});
  save('worker-drain-intent');const workerReceipt=await providers.drainWorkers(fixed,workerOwner);const drained=expectReceipt(workerReceipt,tx,'WORKERS_DRAINED');const workerSnapshot=stoppedSnapshot(workerReceipt.snapshot,fixed);const workerSnapshotSha256=hashValue(workerSnapshot);save('held',{workerEvidenceSha256:drained,workerSnapshot,workerSnapshotSha256});
  return 'HELD';
 });}
 async function recordPrepared(input){return run('held',async()=>{prepared=batch(input);save('migration-prepared',{migration:prepared});return 'PREPARED';});}
 async function recordIntent(input){return run('migration-prepared',async()=>{const b=batch(input);if(!sameBatch(prepared,b))fail('WINDOW_BATCH_DRIFT');save('migration-dispatch-intent');return 'INTENT_RECORDED';});}
 async function recordOutcome(input,rawReceipt){return run('migration-dispatch-intent',async()=>{
  const b=batch(input);if(!sameBatch(prepared,b))fail('WINDOW_BATCH_DRIFT');
  if(rawReceipt==='UNKNOWN'){save('migration-unknown',{migrationOutcome:'UNKNOWN'});poison();return 'UNKNOWN_RECORDED';}
  // Text alone is never proof. The provider must bind it to the same fixed
  // authenticated sender/session and exact raw successful process receipt.
  if(![`COMMIT_CONFIRMED_${b.batchId}\n`,`COMMIT_CONFIRMED_${b.batchId}\r\n`].includes(rawReceipt))fail('WINDOW_COMMIT_RECEIPT_INVALID');
  const proof=expectReceipt(await providers.verifyCommittedTransport(fixed,b,rawReceipt),tx,'EXACT_RECEIPT_VERIFIED');
  save('migration-committed',{migrationOutcome:'COMMITTED',commitEvidenceSha256:proof,rawReceiptSha256:digest(Buffer.from(rawReceipt))});
  return 'COMMITTED_RECORDED';
 });}
 async function preflight(){return run('migration-committed',async()=>{
  save('preflight-intent');const proof=expectReceipt(await providers.runProductionPreflight(fixed),tx,'PREFLIGHT_VERIFIED');save('preflight-ok',{preflightEvidenceSha256:proof});return 'PREFLIGHT_OK';
 });}
 // Controller session: the controller has performed its own original web
 // preflight and is blocked on its private FD until the durable claim exists.
 async function claimControllerHook(){return run('preflight-ok',async()=>{
  const before=journal.inspect();controllerClaim=journal.claimPreStoppedHook(before.valueSha256,before.value.owner.workerSnapshotSha256);
  state='hook-adoption-intent';return 'CLAIMED';
 });}
 async function controllerPhase(phase){
  const table={prepare:['hook-adoption-intent','hook-prepared','HOOK_PREPARED'],activated:['hook-prepared','controller-activated','HOOK_ACTIVATED'],precommit:['controller-activated','controller-precommit','HOOK_PRECOMMIT'],persisted:['controller-precommit','controller-persisted','HOOK_PERSISTED']};
  const row=table[phase];if(!row)fail('WINDOW_CONTROLLER_PHASE_INVALID');
  return run(row[0],async()=>{
   if(typeof providers.invokeControllerHookPhase!=='function'||!controllerClaim)fail('WINDOW_CONTROLLER_PROVIDER_NOT_CONNECTED');
   const receipt=await providers.invokeControllerHookPhase(fixed,phase,controllerClaim);
   const proof=expectReceipt(receipt,tx,row[2]);
   if(phase==='prepare'&&(receipt.workerSnapshotSha256!==controllerClaim.workerSnapshotSha256||receipt.journalValueSha256!==controllerClaim.journalValueSha256))fail('WINDOW_HOOK_ADOPTION_BINDING_INVALID');
   save(row[1],{['controller_'+phase+'Sha256']:proof});return row[2];
  });
 }
 async function controllerExited(){return run('controller-persisted',async()=>{
  if(typeof providers.verifyControllerExitAndDurableSuccess!=='function')fail('WINDOW_CONTROLLER_SUCCESS_PROVIDER_NOT_CONNECTED');
  const receipt=await providers.verifyControllerExitAndDurableSuccess(fixed);const proof=expectReceipt(receipt,tx,'CONTROLLER_SUCCESS_DURABLE');
  save('active',{activationEvidenceSha256:proof});return 'ACTIVE_PERSISTED';
 });}
 async function activate(){return run('preflight-ok',async()=>{
  // Original hook's transaction directory already exists. Claim it through the
  // same in-process Linux journal and its captured worker snapshot, never from
  // caller-supplied paths/JSON. The claim is durable before the first effect.
  const before=journal.inspect(),owner=before.value.owner;
  const claim=journal.claimPreStoppedHook(before.valueSha256,owner.workerSnapshotSha256);
  state='hook-adoption-intent';
  const hookReceipt=await providers.adoptStoppedWorkers(fixed,claim);
  const adopted=expectReceipt(hookReceipt,tx,'HOOK_PREPARED');
  if(hookReceipt.workerSnapshotSha256!==claim.workerSnapshotSha256||hookReceipt.journalValueSha256!==claim.journalValueSha256)fail('WINDOW_HOOK_ADOPTION_BINDING_INVALID');
  save('hook-prepared',{hookAdoptionEvidenceSha256:adopted});
  save('activation-intent');const proof=expectReceipt(await providers.activateFormalCandidate(fixed),tx,'CANDIDATE_ACTIVE_AND_PERSISTED');save('active',{activationEvidenceSha256:proof});return 'ACTIVE_PERSISTED';
 });}
 async function release(){
  const result=await run('active',async()=>{
   save('ingress-release-intent');const proof=expectReceipt(await providers.restoreIngress(fixed),tx,'INGRESS_RESTORED_AND_VERIFIED');save('complete',{restoreEvidenceSha256:proof});return 'RELEASED';
  });
  // Only the same supervisor can open retirement after the final continuity
  // check and durable completion. A child cannot self-authorize termination.
  assertOwnerCurrent();workerTerminalAuthorized=true;return result;
 }
 function inspect(){return journal.inspect();}
 function policy(){const rec=journal.inspect();return Object.freeze({phase:rec.value.owner.phase,stateUncertain:poisoned||rec.value.owner.stateUncertain===true,maintenanceMustRemain:rec.value.owner.phase!=='complete'||poisoned||rec.value.owner.stateUncertain===true,automaticMigrationRetry:false,automaticOldRollback:false});}
 return Object.freeze({prepare,recordPrepared,recordIntent,recordOutcome,preflight,claimControllerHook,controllerPhase,controllerExited,activate,release,poison,inspect,policy});
}

export function openProductionLinuxOwner(){
 // No network request, argument, environmental flag or external JSON may
 // substitute for the missing installed descriptor/provider binding.
 fail('WINDOW_AUTHENTICATED_PROVIDERS_NOT_CONNECTED');
}
