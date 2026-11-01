// Linux transaction coordinator. This module is a stage engine, not a
// production launcher: callers cannot derive authenticated providers from JSON.
// Production entry remains closed until installed control-plane, ingress,
// worker and receipt providers are wired and independently reviewed.
import crypto from 'node:crypto';
import {hashValue} from '../worker-quiescence-plan-61e9/activation-integration/hook-adoption-prototype.mjs';
import {createJournalForLinux} from '../worker-quiescence-plan-61e9/activation-integration/journal-storage-prototype.mjs';

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
function expectReceipt(r,tx,outcome){
 if(!r||r.transactionId!==tx||r.outcome!==outcome||!HASH.test(r.evidenceSha256||''))fail('WINDOW_PROVIDER_RECEIPT_INVALID');
 return r.evidenceSha256;
}

// `providers` must come from the installed, authenticated control-plane, not a
// stdio request. The only production factory in this file is hard-closed below.
export function openLinuxStageEngine({root,binding,providers}){
 if(process.platform!=='linux'||process.geteuid?.()!==0)fail('WINDOW_LINUX_ROOT_REQUIRED');
 const names=['assertContinuity','installIngress','drainWorkers','verifyCommittedTransport','runProductionPreflight','activateFormalCandidate','restoreIngress','holdUnknown'];
 if(!providers||!names.every(k=>typeof providers[k]==='function'))fail('WINDOW_PROVIDER_MISSING');
 const fixed=Object.freeze(clone(binding)),tx=fixed.transactionId;
 const initial={status:'preparing',slotJournal:{phase:'initial'},owner:{phase:'created',transactionId:tx,stateUncertain:false}};
 const journal=createJournalForLinux({root,binding:fixed,initialState:initial});
 const ownerPid=process.pid,bindingHash=hashValue(fixed);let state='created',busy=false,poisoned=false,prepared=null;
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
 async function run(expected,fn){
  if(poisoned||busy||state!==expected||process.pid!==ownerPid)fail('WINDOW_PHASE_INVALID');busy=true;
  try{await providers.assertContinuity(fixed);const value=await fn();await providers.assertContinuity(fixed);return value;}
  catch(e){poison();throw e;}finally{busy=false;}
 }
 async function prepare(){return run('created',async()=>{
  save('ingress-install-intent');const held=expectReceipt(await providers.installIngress(fixed),tx,'INGRESS_VERIFIED');save('ingress-verified',{ingressEvidenceSha256:held});
  save('worker-drain-intent');const drained=expectReceipt(await providers.drainWorkers(fixed),tx,'WORKERS_DRAINED');save('held',{workerEvidenceSha256:drained});
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
 async function activate(){return run('preflight-ok',async()=>{
  save('activation-intent');const proof=expectReceipt(await providers.activateFormalCandidate(fixed),tx,'CANDIDATE_ACTIVE_AND_PERSISTED');save('active',{activationEvidenceSha256:proof});return 'ACTIVE_PERSISTED';
 });}
 async function release(){return run('active',async()=>{
  save('ingress-release-intent');const proof=expectReceipt(await providers.restoreIngress(fixed),tx,'INGRESS_RESTORED_AND_VERIFIED');save('complete',{restoreEvidenceSha256:proof});return 'RELEASED';
 });}
 function inspect(){return journal.inspect();}
 function policy(){const rec=journal.inspect();return Object.freeze({phase:rec.value.owner.phase,stateUncertain:poisoned||rec.value.owner.stateUncertain===true,maintenanceMustRemain:rec.value.owner.phase!=='complete'||poisoned||rec.value.owner.stateUncertain===true,automaticMigrationRetry:false,automaticOldRollback:false});}
 return Object.freeze({prepare,recordPrepared,recordIntent,recordOutcome,preflight,activate,release,poison,inspect,policy});
}

export function openProductionLinuxOwner(){
 // No network request, argument, environmental flag or external JSON may
 // substitute for the missing installed descriptor/provider binding.
 fail('WINDOW_AUTHENTICATED_PROVIDERS_NOT_CONNECTED');
}
