import crypto from 'node:crypto';
import {Archive,hash} from './agent-catalog-release-core.mjs';
import {api,verifyVersion,checkedAuthority} from './agent-catalog-release-readers.mjs';
const HEX=/^[a-f0-9]{64}$/u,ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,160}$/u;
function demand(ok,code){if(!ok)throw new Error(code);}
const ordered=rows=>[...rows].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
export function validateProductionIndex(index){
 demand(index?.schema==='agent-catalog-production-index.v1'&&index.complete===true&&index.database?.database==='zimeiti_prod'&&index.database?.oid==='57747','COMPLETE_REGISTERED_PRODUCTION_INDEX_REQUIRED');
 demand(hash(Object.keys(index).sort())===hash(['schema','complete','observedAt','database','totalCount','counts','entries','inventoryHash'].sort())&&hash(Object.keys(index.database).sort())===hash(['database','oid'])&&hash(Object.keys(index.counts??{}).sort())===hash(['active','hidden','tombstones']),'PRODUCTION_INDEX_UNAPPROVED_FIELDS');
 demand(Array.isArray(index.entries)&&Number.isSafeInteger(index.totalCount)&&index.totalCount===index.entries.length&&new Set(index.entries.map(e=>e.id)).size===index.entries.length,'PRODUCTION_INDEX_TRUNCATED_OR_DUPLICATE');
 demand(Number.isFinite(Date.parse(index.observedAt))&&Date.parse(index.observedAt)<=Date.now()+60000,'PRODUCTION_INDEX_TIME_INVALID');
 const keys=['id','revision','sourceHash','promptHash','deleted','isActive','userAccess','category','portability'].sort();
 for(const e of index.entries){
  demand(hash(Object.keys(e).sort())===hash(keys)&&ID.test(e.id)&&Number.isSafeInteger(e.revision)&&e.revision>0&&(e.sourceHash===null||HEX.test(e.sourceHash))&&HEX.test(e.promptHash)&&typeof e.deleted==='boolean'&&typeof e.isActive==='boolean'&&typeof e.userAccess==='string'&&e.userAccess.length<=64&&typeof e.category==='string'&&e.category.length<=255&&!/(?:https?:\/\/|(?:secret|env):\/\/|[\r\n])/iu.test(e.category+e.userAccess)&&Array.isArray(e.portability)&&e.portability.every(v=>/^[A-Z][A-Z0-9_]{2,100}$/u.test(v)),'PRODUCTION_INDEX_ENTRY_INVALID');
 }
 demand(index.inventoryHash===hash(ordered(index.entries)),'PRODUCTION_INDEX_HASH_MISMATCH');
 demand(index.counts?.active===index.entries.filter(e=>!e.deleted&&e.isActive).length&&index.counts?.hidden===index.entries.filter(e=>!e.deleted&&e.userAccess==='hidden').length&&index.counts?.tombstones===index.entries.filter(e=>e.deleted).length,'PRODUCTION_INDEX_COUNTS_MISMATCH');
 return index;
}
export async function readProductionIndex({request,authority}){
 const identity=await verifyVersion(request,authority),body=await api(request,{method:'GET',path:'/api/admin/agent-catalog-publications?view=index'});
 demand(body?.ok===true,'PRODUCTION_INDEX_RESPONSE_REQUIRED');const index=validateProductionIndex(body.index);demand(Date.now()-Date.parse(index.observedAt)<=600000,'PRODUCTION_INDEX_EXPIRED_REFRESH_REQUIRED');await verifyVersion(request,authority);return {identity,index};
}
export async function captureProductionIndex({archive,request,authority,author,reason}){
 demand(archive instanceof Archive,'ARCHIVE_INSTANCE_REQUIRED');const read=await readProductionIndex({request,authority});
 return archive.locked(state=>{const data={id:crypto.randomUUID(),schema:'agent-catalog-private-index-capture.v1',identity:read.identity,index:read.index};archive.append(state,'index-capture',data,author,reason);return data;});
}
export function validateReleaseManifest(manifest,{expectedHash,approval,scopeIds=[],requireWrite=false}={}){
 demand(manifest?.schema==='agent-catalog-release-manifest.v1'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,100}$/u.test(manifest.releaseId)&&['full','selected'].includes(manifest.mode)&&Array.isArray(manifest.actions)&&HEX.test(manifest.localInventoryHash)&&HEX.test(manifest.productionIndexHash),'RELEASE_MANIFEST_REQUIRED');
 if(expectedHash!==undefined)demand(HEX.test(expectedHash)&&hash(manifest)===expectedHash,'RELEASE_MANIFEST_HASH_MISMATCH');
 checkedAuthority(manifest.authority);
 const binding=manifest.productionIndexBinding;
 demand(binding&&typeof binding.captureId==='string'&&binding.scope==='all-agents-including-deleted'&&HEX.test(binding.inventoryHash)&&binding.inventoryHash===manifest.productionIndexHash&&Number.isFinite(Date.parse(binding.observedAt))&&Number.isSafeInteger(binding.totalCount)&&binding.totalCount>=0&&HEX.test(binding.identityHash)&&binding.database?.database==='zimeiti_prod'&&binding.database?.oid==='57747','FROZEN_COMPLETE_INDEX_BINDING_REQUIRED');
 demand(new Set(manifest.actions.map(a=>a.id)).size===manifest.actions.length,'MANIFEST_DUPLICATE_ID');
 for(const a of manifest.actions){
  demand(ID.test(a.id)&&['create','update','retire','preserve-remote','exclude'].includes(a.operation),'MANIFEST_ACTION_INVALID');
  if(['create','update'].includes(a.operation)){
   demand(a.local&&Number.isSafeInteger(a.local.revision)&&a.local.revision>0&&HEX.test(a.local.hash)&&HEX.test(a.local.promptHash)&&['source','owner-only'].includes(a.audience),'EXPLICIT_SOURCE_AND_AUDIENCE_REQUIRED');
   if(a.operation==='create')demand(a.production===null,'CREATE_MUST_DECLARE_TARGET_ABSENT');
   else demand(a.production&&Number.isSafeInteger(a.production.revision)&&a.production.revision>0&&HEX.test(a.production.hash),'UPDATE_PRODUCTION_CAS_REQUIRED');
   demand(['executable','catalog-only'].includes(a.lifecycle??'executable'),'MANIFEST_LIFECYCLE_INVALID');
   demand(hash(a.stripPortability??[])===hash([])||((a.lifecycle??'executable')==='catalog-only'&&hash(a.stripPortability)===hash(['PRIVATE_AGENT_PROXY'])),'MANIFEST_UNAPPROVED_STRIPPING');
  }
  if(a.operation==='retire')demand(a.production&&Number.isSafeInteger(a.production.revision)&&a.production.revision>0&&HEX.test(a.production.hash),'RETIRE_PRODUCTION_CAS_REQUIRED');
 }
 if(requireWrite){
  const auth=manifest.authorization,writeIds=manifest.actions.filter(a=>['create','update','retire'].includes(a.operation)).map(a=>a.id).sort();
  demand(auth?.kind==='user-explicit'&&HEX.test(auth.referenceHash)&&Number.isFinite(Date.parse(auth.approvedAt))&&Array.isArray(auth.scopeIds)&&hash([...auth.scopeIds].sort())===hash(writeIds),'USER_EXPLICIT_MANIFEST_AUTHORIZATION_REQUIRED');
  demand(expectedHash&&approval===`APPLY ${manifest.releaseId} ${expectedHash}`,'EXPLICIT_RELEASE_APPROVAL_REQUIRED');
  demand(scopeIds.length>0&&new Set(scopeIds).size===scopeIds.length&&scopeIds.every(id=>writeIds.includes(id)),'MANIFEST_EXACT_WRITE_SCOPE_REQUIRED');
 }
 return manifest;
}
export function bindIndexCapture(capture){
 validateProductionIndex(capture.index);return {captureId:capture.id,scope:'all-agents-including-deleted',inventoryHash:capture.index.inventoryHash,observedAt:capture.index.observedAt,totalCount:capture.index.totalCount,database:capture.index.database,identityHash:hash(capture.identity)};
}
export function expectedManifestIndex({state,manifest,manifestHash=hash(manifest),now=Date.now(),maxAgeMs=600000}){
 demand(Object.keys(state.pending).length===0,'RELEASE_PENDING_RECONCILIATION_REQUIRED');
 validateReleaseManifest(manifest);const b=manifest.productionIndexBinding,capture=state.indexes[b.captureId];
 demand(capture&&hash(bindIndexCapture(capture))===hash(b)&&manifest.productionIndexHash===capture.index.inventoryHash,'MANIFEST_PRODUCTION_INDEX_BINDING_MISMATCH');
 demand(hash(checkedAuthority(manifest.authority))===hash(capture.identity),'MANIFEST_INDEX_AUTHORITY_MISMATCH');
 const records=state.confirmedPublications.filter(r=>r.manifestHash===manifestHash),started=state.releaseStarts[manifestHash];
 if(now-Date.parse(b.observedAt)>Math.min(maxAgeMs,600000))demand(started&&records.length>0&&started.baseCaptureId===b.captureId&&started.baseIndexHash===b.inventoryHash&&Date.parse(started.startedAt)-Date.parse(b.observedAt)<=600000,'FROZEN_PRODUCTION_INDEX_EXPIRED');
 const rows=new Map(capture.index.entries.map(e=>[e.id,e])),seen=new Set();
 for(const r of records){
  const a=manifest.actions.find(a=>a.id===r.id),before=rows.get(r.id);
  demand(a&&['create','update'].includes(a.operation)&&!seen.has(r.id)&&r.indexEntry.id===r.id&&r.receipt.id===r.id&&r.receipt.requestKey===r.requestKey&&a.local.hash===r.receipt.sourceHash&&a.local.revision===r.sourceRevision&&r.receipt.targetHash===r.indexEntry.sourceHash&&r.receipt.revision===r.indexEntry.revision&&r.receipt.billingEvidence==='configuration-only'&&r.receipt.providerCalls===0&&hash(a.production)===hash(r.baseline),'UNTRUSTED_RELEASE_PROGRESS_RECEIPT');
  demand(a.operation==='create'?!before:Boolean(before&&before.revision===a.production.revision&&before.sourceHash===a.production.hash),'RELEASE_PROGRESS_BASELINE_MISMATCH');
  demand((r.receipt.audience??'source')===a.audience&&(r.receipt.lifecycle??'executable')===(a.lifecycle??'executable')&&hash(r.receipt.stripPortability??[])===hash(a.stripPortability??[]),'RELEASE_PROGRESS_POLICY_MISMATCH');
  seen.add(r.id);rows.set(r.id,r.indexEntry);
 }
 const entries=ordered([...rows.values()]);return {entries,inventoryHash:hash(entries),identity:capture.identity,confirmedIds:[...seen],baseCaptureId:capture.id,baseIndexHash:capture.index.inventoryHash};
}
export async function verifyManifestLiveIndex({state,manifest,manifestHash,request,authority}){
 const expected=expectedManifestIndex({state,manifest,manifestHash}),live=await readProductionIndex({request,authority});
 demand(hash(live.identity)===hash(expected.identity)&&hash(checkedAuthority(authority))===hash(expected.identity),'MANIFEST_LIVE_INDEX_AUTHORITY_MISMATCH');
 demand(live.index.inventoryHash===expected.inventoryHash,'MANIFEST_LIVE_COMPLETE_INDEX_DRIFT');return {...expected,liveIndex:live.index};
}
export function assertManifestPlan({manifest,expectedManifestHash,approval,plan,scopeIds,audiences={}}){
 validateReleaseManifest(manifest,{expectedHash:expectedManifestHash,approval,scopeIds,requireWrite:true});
 demand(hash(checkedAuthority(manifest.authority))===hash(plan.remoteIdentity),'MANIFEST_PRODUCTION_AUTHORITY_MISMATCH');
 demand(manifest.localInventoryHash===plan.localInventoryHash,'MANIFEST_COMPLETE_LOCAL_INVENTORY_MISMATCH');
 for(const id of scopeIds){const action=manifest.actions.find(a=>a.id===id),card=plan.cards.find(c=>c.id===id);
  demand(action&&card&&action.operation===(card.kind==='new'?'create':card.kind==='update'?'update':'not-publishable')&&action.local.revision===card.local?.revision&&action.local.hash===card.local?.hash,'MANIFEST_SOURCE_PLAN_MISMATCH');
  demand(hash(action.production)===hash(card.baseline)&&action.audience===(audiences[id]??'source'),'MANIFEST_BASELINE_OR_AUDIENCE_MISMATCH');
  if(plan.requestedPolicies?.[id])demand(hash(plan.requestedPolicies[id])===hash({audience:action.audience,lifecycle:action.lifecycle??'executable',stripPortability:action.stripPortability??[]}),'MANIFEST_REQUESTED_POLICY_MISMATCH');
 }
 return true;
}
function localSummary(archive,entry){const m=archive.version(entry.version);return {id:entry.id,revision:entry.revision,sourceHash:entry.hash,promptHash:m.promptHash,deleted:entry.deleted,isActive:m.safe.is_active===true,userAccess:String(m.safe.user_access??''),portability:entry.portability??[],promptStored:m.promptStored!==false};}
export function coverageGate({archive,localCaptureId,indexCaptureId,manifest,expectedManifestHash,maxAgeMs=10*60*1000,now=Date.now()}){
 const unknown=reason=>({schema:'agent-catalog-web-coverage-gate.v1',status:'UNKNOWN',reason,readyToPush:false,complete:false,webReleaseAllowed:false,claimsFullParity:false,catalogWriteAllowed:false,defaultAction:'dryrun',configurationWrites:0,providerCalls:0});
 const state=archive.load(),capture=state.captures[localCaptureId],remote=state.indexes[indexCaptureId];
 if(capture?.environment!=='formal-local'||capture.coverage.kind!=='full')return unknown('COMPLETE_LOCAL_PRESENT_INVENTORY_REQUIRED');
 if(!remote)return unknown('LEGAL_COMPLETE_PRODUCTION_INDEX_NOT_OBTAINED');
 try{validateProductionIndex(remote.index);}catch{return unknown('LEGAL_COMPLETE_PRODUCTION_INDEX_INVALID');}
 if(now-Date.parse(remote.index.observedAt)>maxAgeMs)return unknown('PRODUCTION_INDEX_EXPIRED_REFRESH_REQUIRED');
 if(!manifest)return unknown('EXPLICIT_RELEASE_MANIFEST_REQUIRED');
 try{validateReleaseManifest(manifest,{expectedHash:expectedManifestHash});}catch{return unknown('RELEASE_MANIFEST_INVALID');}
 if(hash(checkedAuthority(manifest.authority))!==hash(remote.identity))return unknown('RELEASE_MANIFEST_AUTHORITY_DRIFT');
 if(manifest.localInventoryHash!==capture.inventoryHash)return unknown('MANIFEST_COMPLETE_LOCAL_INVENTORY_DRIFT');
 let expected;try{expected=expectedManifestIndex({state,manifest,now,maxAgeMs});}catch(error){return unknown(error.message);}
 if(remote.index.inventoryHash!==expected.inventoryHash)return unknown('MANIFEST_LIVE_COMPLETE_INDEX_DRIFT');
 const local=new Map(capture.entries.map(e=>[e.id,localSummary(archive,e)])),production=new Map(remote.index.entries.map(e=>[e.id,e]));
 const ids=[...new Set([...local.keys(),...production.keys(),...Object.keys(state.baselines)])].sort();
 const rows=ids.map(id=>{
  const l=local.get(id),r=production.get(id),b=state.baselines[id]?archive.version(state.baselines[id]):null,action=manifest.actions.find(a=>a.id===id);
  let kind='unchanged';
  if(!l)kind=b?'local-row-missing':'production-only';
  else if(!r)kind=l.deleted?'local-retired-only':b?'production-row-missing':'local-new-unpublished';
  else if(r.sourceHash===null)kind='production-summary-unverifiable';
  else if(l.deleted!==r.deleted)kind=l.deleted?'retire-unpublished':'production-retired-local-active';
  else if(l.promptHash!==r.promptHash||l.sourceHash!==r.sourceHash||l.isActive!==r.isActive||l.userAccess!==r.userAccess){
   const localMatchesBase=b&&l.sourceHash===(state.publishedLocalHashes[id]??b.sourceHash),remoteMatchesBase=b&&r.sourceHash===b.sourceHash&&r.revision===b.revision;
   const p=state.publishedPolicies[id],approvedTarget=action&&p&&['create','update'].includes(action.operation)&&action.local.hash===l.sourceHash&&localMatchesBase&&remoteMatchesBase&&l.promptHash===r.promptHash&&p.audience===action.audience&&p.lifecycle===(action.lifecycle??'executable')&&hash(p.stripPortability)===hash(action.stripPortability??[]);
   if(approvedTarget)kind='approved-policy-match';
   else if(localMatchesBase&&!remoteMatchesBase)kind='production-changed';
   else if(b&&!localMatchesBase&&!remoteMatchesBase)kind='conflict';
   else kind=l.promptHash!==r.promptHash?'prompt-unpublished':'metadata-unpublished';
  }
  let accounted=['unchanged','approved-policy-match'].includes(kind),writeCandidate=false,reason=null;
  if(!accounted&&action){
   if(action.operation==='preserve-remote')accounted=Boolean(r&&action.production?.revision===r.revision&&action.production?.hash===r.sourceHash);
   else if(action.operation==='exclude')accounted=Boolean(!r&&action.local?.hash===l?.sourceHash&&typeof action.reasonCode==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/u.test(action.reasonCode));
   else if(['create','update','retire'].includes(action.operation)){
    const sourceBound=action.operation==='retire'||Boolean(l&&action.local?.revision===l.revision&&action.local?.hash===l.sourceHash&&action.local?.promptHash===l.promptHash);
    const targetBound=r?Boolean(action.production?.revision===r.revision&&action.production?.hash===r.sourceHash):action.production===null;
    const safeOperation=action.operation==='create'?kind==='local-new-unpublished':action.operation==='update'?['prompt-unpublished','metadata-unpublished'].includes(kind):kind==='retire-unpublished';
    const blocks=(l?.portability??[]).filter(code=>!(code==='PRIVATE_AGENT_PROXY'&&action.lifecycle==='catalog-only'&&hash(action.stripPortability??[])===hash(['PRIVATE_AGENT_PROXY'])));
    accounted=sourceBound&&targetBound&&safeOperation;writeCandidate=accounted&&action.operation!=='retire'&&!blocks.length;reason=action.operation==='retire'?'NATIVE_SOFT_DELETE_CAS_REQUIRED':blocks.length?'NON_PORTABLE_LOCAL_CONFIGURATION':null;
   }
  }
  return {id,kind,accounted,writeCandidate,reason,local:l?{revision:l.revision,hash:l.sourceHash,promptHash:l.promptHash,deleted:l.deleted,isActive:l.isActive,portability:l.portability}:null,production:r?{revision:r.revision,hash:r.sourceHash,promptHash:r.promptHash,deleted:r.deleted,isActive:r.isActive}:null};
 });
 const unrecognizedManifestIds=manifest.actions.filter(a=>!ids.includes(a.id)).map(a=>a.id),allAccounted=rows.every(r=>r.accounted)&&unrecognizedManifestIds.length===0;
 const claimsFullParity=rows.every(r=>['unchanged','approved-policy-match'].includes(r.kind))&&unrecognizedManifestIds.length===0;
 const pendingActionIds=rows.filter(r=>!['unchanged','approved-policy-match'].includes(r.kind)&&['create','update','retire'].includes(manifest.actions.find(a=>a.id===r.id)?.operation)).map(r=>r.id);
 const webReleaseAllowed=allAccounted&&pendingActionIds.length===0&&(claimsFullParity||(manifest.mode==='selected'&&manifest.allowSelectiveWebRelease===true));
 return {schema:'agent-catalog-web-coverage-gate.v1',status:claimsFullParity?'VERIFIED':allAccounted?'ACCOUNTED_DIFFERENCES':'BLOCKED',comparison:'complete-stable-ids-lifecycle-prompt-and-portable-fields',readyToPush:webReleaseAllowed,complete:claimsFullParity,webReleaseAllowed,claimsFullParity,catalogWriteAllowed:allAccounted&&rows.filter(r=>r.writeCandidate).length>0,localCaptureId,indexCaptureId,manifestHash:hash(manifest),localInventoryHash:capture.inventoryHash,productionInventoryHash:remote.index.inventoryHash,productionComplete:true,pendingActionIds,unrecognizedManifestIds,rows,configurationWrites:0,providerCalls:0,billingEvidence:'configuration-only'};
}
export function manifestTemplate({archive,localCaptureId,indexCaptureId,authority,releaseId}){
 demand(archive.load().captures[localCaptureId],'LOCAL_CAPTURE_REQUIRED');
 const state=archive.load();demand(state.indexes[indexCaptureId],'COMPLETE_PRODUCTION_INDEX_REQUIRED');validateProductionIndex(state.indexes[indexCaptureId].index);
 return validateReleaseManifest({schema:'agent-catalog-release-manifest.v1',releaseId,mode:'full',authority,localCaptureId,indexCaptureId,localInventoryHash:state.captures[localCaptureId].inventoryHash,productionIndexHash:state.indexes[indexCaptureId].index.inventoryHash,productionIndexBinding:bindIndexCapture(state.indexes[indexCaptureId]),allowSelectiveWebRelease:false,actions:[],authorization:null,templateOnly:true});
}
