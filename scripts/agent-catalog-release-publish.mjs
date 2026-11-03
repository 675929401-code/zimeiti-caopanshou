import crypto from 'node:crypto';
import {Archive,hash,bytesHash,safeFailure,validatePortable} from './agent-catalog-release-core.mjs';
import {api,readProductionCard,verifyVersion,inventoryFingerprint,checkedAuthority} from './agent-catalog-release-readers.mjs';
import {assertManifestPlan,verifyManifestLiveIndex} from './agent-catalog-release-gate.mjs';
function demand(ok,code){if(!ok)throw new Error(code);}
function same(a,b){return hash(a)===hash(b);}
function safeReceipt(r){return Object.fromEntries(['id','requestKey','planHash','sourceRevision','sourceHash','targetHash','revision','operation','audience','lifecycle','stripPortability','billingEvidence','providerCalls'].filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]]));}
function checkReceipt(receipt,pending){
 demand(receipt&&receipt.id===pending.id&&receipt.requestKey===pending.requestKey&&receipt.planHash===pending.serverPlanHash&&receipt.sourceHash===pending.localHash&&receipt.targetHash===pending.targetHash&&Number.isSafeInteger(receipt.revision)&&receipt.revision===pending.expectedRevision&&(receipt.audience??'source')===pending.audience&&(receipt.lifecycle??'executable')===(pending.lifecycle??'executable')&&hash(receipt.stripPortability??[])===hash(pending.stripPortability??[])&&receipt.providerCalls===0&&receipt.billingEvidence==='configuration-only','PUBLICATION_RECEIPT_MISMATCH');
}
async function confirm({archive,state,pending,request,receipt,author,reason}){
 checkReceipt(receipt,pending);
 if(!state.pending[pending.id]?.acknowledgedReceipt)archive.append(state,'receipt-observed',{id:pending.id,requestKey:pending.requestKey,receipt:safeReceipt(receipt)},author,reason);
 const card=await readProductionCard(request,pending.id);
 demand(card&&!card.deleted&&card.revision===receipt.revision&&card.sourceHash===receipt.targetHash,'POST_WRITE_READBACK_CONFLICT');
 const version=archive.saveVersion(card,'formal-production',state);
 const indexEntry={id:card.id,revision:card.revision,sourceHash:card.sourceHash,promptHash:bytesHash(card.fields.system_prompt??''),deleted:false,isActive:card.fields.is_active,userAccess:card.fields.user_access,category:card.fields.category,portability:card.portability??[]};
 archive.append(state,'confirmed',{id:pending.id,requestKey:pending.requestKey,version,receipt:safeReceipt(receipt),indexEntry},author,reason);
 return {id:pending.id,status:'verified',revision:receipt.revision,requestKey:pending.requestKey};
}
export async function reconcilePublication({archive,request,authority,ids,author,reason}){
 demand(archive instanceof Archive,'ARCHIVE_INSTANCE_REQUIRED');checkedAuthority(authority);
 return archive.locked(async state=>{
  await verifyVersion(request,authority);const results=[];
  for(const id of ids){const pending=state.pending[id];if(!pending){results.push({id,status:'no-pending'});continue;}
   try{
    const response=await api(request,{method:'GET',path:`/api/admin/agent-catalog-publications?requestKey=${pending.requestKey}`});
    demand(response?.ok===true&&Object.hasOwn(response,'receipt'),'RECEIPT_RESPONSE_INVALID');
    if(!response.receipt){results.push({id,status:'pending',reason:'NO_RECEIPT_NO_AUTOMATIC_RETRY',requestKey:pending.requestKey});continue;}
    results.push(await confirm({archive,state,pending,request,receipt:response.receipt,author,reason}));
   }catch(error){results.push({id,status:'pending',writeAcknowledged:Boolean(state.pending[id]?.acknowledgedReceipt),...safeFailure(error),requestKey:pending.requestKey});}
  }
  let finalIdentityVerified=true,identityFailure=null;
  try{await verifyVersion(request,authority);}catch(error){finalIdentityVerified=false;identityFailure=safeFailure(error);}
  const remainingPendingIds=Object.keys(state.pending).sort(),scopeComplete=ids.every(id=>!state.pending[id])&&results.length===ids.length&&results.every(r=>['verified','no-pending'].includes(r.status)),complete=finalIdentityVerified&&scopeComplete&&remainingPendingIds.length===0;
  return {operation:'reconcile-read-only',status:complete?'complete':!finalIdentityVerified?'identity-unverified':'pending',complete,scopeComplete,remainingPendingIds,results,finalIdentityVerified,...(identityFailure?{identityFailure}:{}),configurationWrites:0};
 });
}
export async function publishIncremental({archive,request,authority,planId,expectedPlanHash,scopeIds,audiences={},manifest,expectedManifestHash,approval,readLocal,author,reason}){
 demand(archive instanceof Archive&&typeof request==='function'&&typeof readLocal==='function','CONTROLLED_PUBLISH_DEPENDENCIES_REQUIRED');
 const checked=checkedAuthority(authority);
 demand(Array.isArray(scopeIds)&&scopeIds.length>0&&new Set(scopeIds).size===scopeIds.length,'EXACT_WRITE_SCOPE_REQUIRED');
 return archive.locked(async state=>{
  const plan=state.plans[planId];demand(plan&&plan.planHash===expectedPlanHash&&plan.id===planId,'APPROVED_PLAN_HASH_REQUIRED');
  assertManifestPlan({manifest,expectedManifestHash,approval,plan,scopeIds,audiences});
  demand(same(plan.remoteIdentity,checked),'PLAN_PRODUCTION_AUTHORITY_MISMATCH');
  demand(Object.keys(state.pending).length===0,'RELEASE_PENDING_RECONCILIATION_REQUIRED');
  const selected=scopeIds.map(id=>{const card=plan.cards.find(c=>c.id===id);demand(card&&['new','update'].includes(card.kind)&&!state.pending[id],'SCOPE_REQUIRES_NEW_PLAN_OR_RECONCILIATION');return card;});
  demand(Object.keys(audiences).every(id=>scopeIds.includes(id))&&Object.values(audiences).every(x=>x==='source'||x==='owner-only'),'UNSCOPED_AUDIENCE_OVERRIDE');
  const local=await readLocal();demand(local.environment==='formal-local'&&local.complete===true&&local.readOnly===true&&local.identity?.profileId==='formal-local-postgres-readonly-v1'&&inventoryFingerprint(local.cards)===plan.localInventoryHash,'LOCAL_COMPLETE_INVENTORY_DRIFT_NEW_PLAN_REQUIRED');
  const initial=await verifyManifestLiveIndex({state,manifest,manifestHash:expectedManifestHash,request,authority});
  if(!state.releaseStarts[expectedManifestHash])archive.append(state,'release-started',{manifestHash:expectedManifestHash,baseCaptureId:initial.baseCaptureId,baseIndexHash:initial.baseIndexHash},author,reason);
  const already=new Set(initial.confirmedIds),results=[];let applyAttempts=0;
  for(const planned of selected){
   if(already.has(planned.id)){results.push({id:planned.id,status:'previously-verified',applyAttempts:0});continue;}
   let pending=null,applyOutcome='not-started';
   try{
    await verifyVersion(request,authority);
    await verifyManifestLiveIndex({state,manifest,manifestHash:expectedManifestHash,request,authority});
    const action=manifest.actions.find(a=>a.id===planned.id),lifecycle=action.lifecycle??'executable',stripPortability=action.stripPortability??[];
    const card=local.cards.find(c=>c.id===planned.id);demand(card&&!card.deleted&&card.revision===planned.local.revision&&card.sourceHash===planned.local.hash,'LOCAL_CARD_CHANGED');demand(stripPortability.every(code=>(card.portability??[]).includes(code)),'SOURCE_STRIPPING_DECLARATION_MISMATCH');demand(!(card.portability??[]).some(code=>!(code==='PRIVATE_AGENT_PROXY'&&lifecycle==='catalog-only'&&hash(stripPortability)===hash(['PRIVATE_AGENT_PROXY']))),'LOCAL_CONFIGURATION_NOT_PORTABLE');
    const current=await readProductionCard(request,card.id);
    demand(planned.remote?Boolean(current&&!current.deleted&&current.revision===planned.remote.revision&&current.sourceHash===planned.remote.hash):current===null,'PRODUCTION_CARD_DRIFT_NEW_PLAN_REQUIRED');
    const requestKey=crypto.randomUUID(),audience=audiences[card.id]??'source';
    let beforeImage=null;if(current){beforeImage=archive.saveBeforeImage(current,{requestKey,manifestHash:expectedManifestHash});archive.append(state,'before-image',beforeImage,author,reason);}
    const source={id:card.id,revision:card.revision,fields:card.fields,sourceHash:card.sourceHash};
    const body=validatePortable(source,planned.baseline,requestKey,audience,lifecycle,stripPortability);
    const preview=await api(request,{method:'POST',path:'/api/admin/agent-catalog-publications',body});
    const server=preview?.plan;
    demand(preview?.ok===true&&server?.eligible===true&&server.id===card.id&&server.sourceHash===card.sourceHash&&server.requestKey===requestKey&&['create','update','noop'].includes(server.operation)&&/^[a-f0-9]{64}$/u.test(server.planHash)&&/^[a-f0-9]{64}$/u.test(server.targetHash),'NATIVE_PUBLICATION_PLAN_REJECTED');
    demand((planned.remote?server.currentRevision===planned.remote.revision&&server.currentHash===planned.remote.hash:server.currentRevision===null&&server.currentHash===null),'NATIVE_PLAN_TARGET_MISMATCH');
    if(server.operation==='noop'){results.push({id:card.id,status:'noop',baselineAdoptionRequired:true});continue;}
    await verifyVersion(request,authority);
    await verifyManifestLiveIndex({state,manifest,manifestHash:expectedManifestHash,request,authority});
    pending={id:card.id,requestKey,planId,localVersion:planned.local.version,localHash:card.sourceHash,sourceRevision:card.revision,baseline:planned.baseline,serverPlanHash:server.planHash,targetHash:server.targetHash,expectedRevision:server.operation==='create'?1:server.currentRevision+1,audience,lifecycle,stripPortability,manifestHash:expectedManifestHash,beforeImage,phase:'issued_unknown'};
    archive.append(state,'dispatch',pending,author,reason);
    // The durable request key exists before this one-shot dispatch. No catch path retries apply.
    applyAttempts++;applyOutcome='in-flight';const result=await api(request,{method:'POST',path:'/api/admin/agent-catalog-publications',body:{...body,action:'apply',planHash:server.planHash}});applyOutcome='acknowledged';
    demand(result?.ok===true&&result.receipt,'NATIVE_APPLY_RECEIPT_REQUIRED');
    const confirmed=await confirm({archive,state,pending,request,receipt:result.receipt,author,reason});
    await verifyManifestLiveIndex({state,manifest,manifestHash:expectedManifestHash,request,authority});results.push(confirmed);
   }catch(error){
    // A 4xx response is an authoritative rejection; 5xx, disconnect, malformed replies and mismatches remain pending.
    if(pending&&applyOutcome==='in-flight'&&Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500&&error.officialCode){archive.append(state,'rejected',{id:pending.id,requestKey:pending.requestKey,httpStatus:error.httpStatus,officialCode:error.officialCode},author,reason);results.push({id:planned.id,status:'rejected',...safeFailure(error)});}
    else {const completed=state.confirmedPublications.some(r=>r.requestKey===pending?.requestKey);results.push({id:planned.id,status:completed?'verified-with-index-drift':pending?'pending':'not-dispatched',writeAcknowledged:completed||Boolean(state.pending[planned.id]?.acknowledgedReceipt),...safeFailure(error),...(pending?{requestKey:pending.requestKey}:{})});}
    if(error?.message==='PRODUCTION_VERSION_DRIFT'||/INDEX|RELEASE_PROGRESS/u.test(error?.message??'')||Object.keys(state.pending).length>0)break;
   }
  }
  let finalIdentityVerified=true,identityFailure=null;
  try{await verifyVersion(request,authority);}catch(error){finalIdentityVerified=false;identityFailure=safeFailure(error);}
  const confirmedIds=new Set(state.confirmedPublications.filter(r=>r.manifestHash===expectedManifestHash).map(r=>r.id)),remainingIds=manifest.actions.filter(a=>['create','update','retire'].includes(a.operation)&&!confirmedIds.has(a.id)).map(a=>a.id).sort(),remainingPendingIds=Object.keys(state.pending).sort();
  const scopeComplete=results.length===scopeIds.length&&results.every(r=>['verified','previously-verified'].includes(r.status)),complete=finalIdentityVerified&&scopeComplete&&remainingIds.length===0&&remainingPendingIds.length===0;
  const status=complete?'complete':!finalIdentityVerified?'identity-unverified':remainingPendingIds.length?'pending':results.some(r=>r.status==='verified-with-index-drift'||/INDEX|RELEASE_PROGRESS/u.test(r.code??''))?'index-drift':confirmedIds.size?'partial':results.every(r=>r.status==='not-dispatched')?'not-dispatched':'blocked';
  return {operation:'publish',status,complete,scopeComplete,remainingIds,remainingPendingIds,planId,applyAttempts,results,providerCalls:0,billingEvidence:'configuration-only',finalIdentityVerified,...(identityFailure?{identityFailure}:{})};
 });
}
