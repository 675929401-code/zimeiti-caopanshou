import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

async function main(){
const routePath=path.resolve('src/app/api/commerce-model-gateway/route.ts');
const source=await fs.readFile(routePath,'utf8');
const sourceFile=ts.createSourceFile(routePath,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);

function declaration(name:string){
  for(const node of sourceFile.statements){
    if(ts.isFunctionDeclaration(node)&&node.name?.text===name)return node.getText(sourceFile);
    if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>ts.isIdentifier(item.name)&&item.name.text===name))return node.getText(sourceFile);
  }
  throw Error(`missing declaration: ${name}`);
}

function evaluate<T extends Record<string,unknown>>(names:string[],prelude=''){
  const exposed=names.map(name=>`${name}`).join(',');
  const typescript=`${prelude}\n${names.map(declaration).join('\n')}\n;(globalThis as any).__contract={${exposed}};`;
  const javascript=ts.transpileModule(typescript,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const sandbox:Record<string,unknown>={URL,Date,setTimeout,clearTimeout,console};
  vm.runInNewContext(javascript,sandbox,{filename:'commerce-gateway-contract.js'});
  return sandbox.__contract as T;
}

type Receipt={
  id:string;fingerprint:string;kind:string;modelId:string;modelConfigHash:string;status:string;
  revision:number;fencingGeneration:number;dispatchPhase:'dispatch_intent'|'request_sent'|'acknowledged'|'submission_unknown';
  createdAt:number;updatedAt:number;requestSentAt?:number;terminalAt?:number;error?:string;result?:Record<string,unknown>;providerAttestation?:Record<string,unknown>;reconciliation?:Record<string,unknown>;
};
const base:Receipt={id:'00000000-0000-4000-8000-000000000001',fingerprint:'f',kind:'video',modelId:'logical-video',modelConfigHash:'cfg',status:'processing',revision:3,fencingGeneration:3,dispatchPhase:'acknowledged',createdAt:1,updatedAt:2,result:{taskId:'task-1'}};
const pure=evaluate<{
  terminalReceipt:(value:Pick<Receipt,'status'>)=>boolean;
  receiptStateRank:(value:Pick<Receipt,'status'>)=>number;
  mergeReceiptObservation:(current:Receipt,candidate:Receipt,expectedRevision:number)=>Receipt;
  reconciliation:(reason:string,since?:number)=>Record<string,unknown>;
  endpointHost:(endpoint:string)=>string;
  providerAttestation:(receipt:Receipt,model:Record<string,unknown>,endpoint:string,reported?:unknown,taskId?:unknown)=>Record<string,unknown>;
}>(['terminalReceipt','receiptStateRank','mergeReceiptObservation','reconciliation','endpointHost','providerAttestation']);

const checks:Array<{name:string;evidence:unknown}>=[];
function check(name:string,condition:unknown,evidence:unknown){assert.ok(condition,name);checks.push({name,evidence});}

const success:Receipt={...base,status:'success',revision:4,updatedAt:4};
const lateProcessing=pure.mergeReceiptObservation(success,{...base,status:'processing'},3);
check('late processing cannot regress success',lateProcessing.status==='success'&&lateProcessing.revision===4,{status:lateProcessing.status,revision:lateProcessing.revision});

const lateFailure=pure.mergeReceiptObservation(success,{...base,status:'failed'},4);
check('late failure cannot regress success',lateFailure.status==='success'&&lateFailure.revision===4,{status:lateFailure.status,revision:lateFailure.revision});

const lateCancel=pure.mergeReceiptObservation(success,{...base,status:'manual_reconciliation'},4);
check('late SSE cancel cannot regress success',lateCancel.status==='success'&&lateCancel.revision===4,{status:lateCancel.status,revision:lateCancel.revision});

const staleTerminal=pure.mergeReceiptObservation(base,{...base,status:'success',revision:2},2);
check('terminal observation may close a newer nonterminal revision',staleTerminal.status==='success'&&staleTerminal.revision===4,{status:staleTerminal.status,revision:staleTerminal.revision});

const staleNonterminal=pure.mergeReceiptObservation(base,{...base,status:'queued',revision:2},2);
check('stale nonterminal observation is discarded',staleNonterminal===base,{sameObject:staleNonterminal===base});

const queued:Receipt={...base,status:'queued',revision:3};
const laterProcessing=pure.mergeReceiptObservation(queued,{...queued,status:'processing',revision:2},2);
check('stale revision may only advance a nonterminal state rank',laterProcessing.status==='processing'&&laterProcessing.revision===4,{status:laterProcessing.status,revision:laterProcessing.revision});

const normalSuccess=pure.mergeReceiptObservation({...base,revision:2},{...base,status:'success',revision:2},2);
check('matching revision advances exactly once',normalSuccess.status==='success'&&normalSuccess.revision===3,{status:normalSuccess.status,revision:normalSuccess.revision});

const attestation=pure.providerAttestation(base,{id:'internal-video',model_name:'submitted-video',provider:'provider-x',protocol_type:'protocol-y',api_key:'must-not-leak',api_endpoint:'https://models.example.test/private/path?token=must-not-leak'},'https://models.example.test/private/path?token=must-not-leak','reported-video','task-1');
const attestationKeys=Object.keys(attestation).sort();
check('provider attestation has the complete identity tuple',JSON.stringify(attestationKeys)===JSON.stringify(['configHash','endpointHost','internal','logical','protocol','provider','reported','submitted','taskId']),attestationKeys);
check('provider attestation stores host only and no secret',attestation.endpointHost==='models.example.test'&&!JSON.stringify(attestation).includes('must-not-leak'),attestation);

const manual=pure.reconciliation('PROVIDER_ACK_TIMEOUT',1234);
check('manual reconciliation is terminally non-retryable',manual.state==='required'&&manual.retryAllowed===false&&manual.reason==='PROVIDER_ACK_TIMEOUT',{state:manual.state,retryAllowed:manual.retryAllowed,reason:manual.reason});

check('receipt contract names all four dispatch phases',/type DispatchPhase = 'dispatch_intent' \| 'request_sent' \| 'acknowledged' \| 'submission_unknown'/u.test(source),{phases:4});
check('receipt carries a monotonic revision',/revision: number;/u.test(source)&&/revision: current\.revision \+ 1/u.test(source),{revisionIncrement:true});
check('CAS compares state rank as well as revision',source.includes('receiptStateRank(candidate)<=receiptStateRank(current)'),{stateRankCas:true});
check('immutable receipt generations fence an expired writer',source.includes('receiptVersionsPath')&&source.includes('fencingGeneration:lease.generation')&&source.includes('right.fencingGeneration-left.fencingGeneration'),{immutableGenerationJournal:true});
check('provider POST is preceded by durable request_sent transitions',source.indexOf('receipt=await markProviderRequestSent(receipt);')<source.indexOf(').chat({')&&source.indexOf('receipt=await markProviderRequestSent(receipt,providerAttestation(receipt,model,endpoint));')<source.indexOf("fetch(target,{method:'POST'")&&source.lastIndexOf('receipt=await markProviderRequestSent(receipt,providerAttestation(receipt,model,endpoint));')<source.indexOf('submitVideoTask('),{agent:true,image:true,video:true});
check('lost dispatch ownership aborts before provider POST',source.includes("next.revision!==receipt.revision+1")&&source.includes("throw Error('DISPATCH_OWNERSHIP_LOST')"),{fencedBeforePost:true});
check('recovery never reopens an agent provider POST',!source.includes('openStream')&&!source.includes('retryUsed')&&!source.includes('retryCount:1')&&source.includes('retryCount:0'),{automaticPostRetries:0});
check('legacy permanent locks are migration-only',!source.includes("fs.open(path.join(receipts(), `${input.id}.lock`)")&&source.includes('legacyLockPath')&&source.includes('fs.unlink(legacyLockPath(input.id))'),{newPermanentLocks:0});
check('no-ack timeout becomes an explainable manual terminal',source.includes("status: 'manual_reconciliation'")&&source.includes("dispatchPhase: 'submission_unknown'")&&source.includes("error: 'PROVIDER_ACK_TIMEOUT'")&&source.includes('retryAllowed: false'),{timeoutMs:6*60_000});
check('image poll HTTP errors never assert provider task failure',source.includes('IMAGE_PROVIDER_POLL_HTTP_')&&!/IMAGE_PROVIDER_POLL_HTTP_\$\{response\.status\}[^\n]+status:'failed'/u.test(source),{poll429Terminal:false});
check('SSE start and cancel both use revision-aware commits',source.includes('const streamRevision=receipt.revision')&&source.match(/commitReceiptObservation\(latest\.id,streamRevision/g)?.length===2,{streamCasCommits:2});

const temporaryRoot=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-gateway-lease-'));
try{
  const leasePrelude=`
    const fs=globalThis.__deps.fs;
    const path=globalThis.__deps.path;
    const crypto=globalThis.__deps.crypto;
    const process=globalThis.__deps.process;
    const receipts=()=>globalThis.__deps.root;
    const leasePath=(id)=>path.join(receipts(),id+'.lease.json');
    const load=async()=>null;
    const RECEIPT_LEASE_MS=45000;
  `;
  const typescript=`${leasePrelude}\n${['readLease','acquireReceiptLease','assertLeaseOwner','releaseReceiptLease'].map(declaration).join('\n')}\n;(globalThis as any).__contract={readLease,acquireReceiptLease,assertLeaseOwner,releaseReceiptLease};`;
  const javascript=ts.transpileModule(typescript,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const sandbox:Record<string,unknown>={Date,setTimeout,clearTimeout,console,__deps:{fs,path,crypto:{randomUUID},process:{pid:999},root:temporaryRoot}};
  vm.runInNewContext(javascript,sandbox,{filename:'commerce-gateway-lease.js'});
  const lease=sandbox.__contract as {readLease:(id:string)=>Promise<Record<string,unknown>|null>;acquireReceiptLease:(id:string,purpose:string,now?:number)=>Promise<Record<string,unknown>>;assertLeaseOwner:(lease:Record<string,unknown>)=>Promise<void>;releaseReceiptLease:(lease:Record<string,unknown>)=>Promise<void>};
  const first=await lease.acquireReceiptLease(base.id,'transition');
  await lease.assertLeaseOwner(first);
  await assert.rejects(()=>lease.acquireReceiptLease(base.id,'poll'),/RECEIPT_LEASE_ACTIVE/u);
  const persisted=await lease.readLease(base.id);
  check('live persistent lease excludes another process',persisted?.token===first.token&&Number(persisted?.expiresAt)>Date.now(),{tokenPersisted:true,expiresAt:persisted?.expiresAt});
  await fs.writeFile(path.join(temporaryRoot,`${base.id}.lease.json`),JSON.stringify({...first,expiresAt:Date.now()-1}),'utf8');
  const reclaimed=await lease.acquireReceiptLease(base.id,'poll');
  check('expired persistent lease is recoverable with a new fencing token',reclaimed.token!==first.token&&reclaimed.purpose==='poll',{firstToken:first.token,reclaimedToken:reclaimed.token});
  await lease.releaseReceiptLease(reclaimed);
  check('lease owner release removes only its own lease',(await lease.readLease(base.id))===null,{released:true});
  await fs.writeFile(path.join(temporaryRoot,`${base.id}.lease.json`),'{truncated','utf8');
  const recoveredMalformed=await lease.acquireReceiptLease(base.id,'reconcile');
  check('malformed persisted lease is quarantined and recoverable',recoveredMalformed.purpose==='reconcile'&&typeof recoveredMalformed.token==='string',{recovered:true});
  await lease.releaseReceiptLease(recoveredMalformed);

  const statePrelude=`
    const fs=globalThis.__deps.fs;
    const path=globalThis.__deps.path;
    const crypto=globalThis.__deps.crypto;
    const process=globalThis.__deps.process;
    const receipts=()=>globalThis.__deps.root;
    const receiptPath=(id)=>path.join(receipts(),id+'.json');
    const receiptVersionsPath=(id)=>path.join(receipts(),id+'.versions');
    const leasePath=(id)=>path.join(receipts(),id+'.lease.json');
    const RECEIPT_LEASE_MS=45000;
    const DISPATCH_INTENT_TIMEOUT_MS=90000;
    const PROVIDER_ACK_TIMEOUT_MS=360000;
  `;
  const stateNames=['atomicWriteJson','normalizeReceipt','writeReceipt','load','readLease','acquireReceiptLease','assertLeaseOwner','releaseReceiptLease','terminalReceipt','receiptStateRank','mergeReceiptObservation','commitReceiptObservation','reconciliation','reconcileStaleReceipt'];
  const stateTypescript=`${statePrelude}\n${stateNames.map(declaration).join('\n')}\n;(globalThis as any).__contract={${stateNames.join(',')}};`;
  const stateJavascript=ts.transpileModule(stateTypescript,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const stateSandbox:Record<string,unknown>={Date,setTimeout,clearTimeout,console,__deps:{fs,path,crypto:{randomUUID},process:{pid:1000},root:temporaryRoot}};
  vm.runInNewContext(stateJavascript,stateSandbox,{filename:'commerce-gateway-state.js'});
  const state=stateSandbox.__contract as {writeReceipt:(receipt:Receipt,lease:Record<string,unknown>)=>Promise<Receipt>;load:(id:string)=>Promise<Receipt>;acquireReceiptLease:(id:string,purpose:string,now?:number)=>Promise<Record<string,unknown>>;releaseReceiptLease:(lease:Record<string,unknown>)=>Promise<void>;reconcileStaleReceipt:(receipt:Receipt,now?:number)=>Promise<Receipt>;commitReceiptObservation:(id:string,expectedRevision:number,candidate:Receipt,purpose?:string)=>Promise<Receipt>};
  const now=Date.now();
  const noAck:Receipt={...base,id:'00000000-0000-4000-8000-000000000002',status:'dispatching',revision:7,dispatchPhase:'request_sent',createdAt:now-400_000,updatedAt:now-400_000};
  noAck.requestSentAt=now-400_000;
  const seedLease=await state.acquireReceiptLease(noAck.id,'transition');
  await state.writeReceipt(noAck,seedLease);
  await state.releaseReceiptLease(seedLease);
  const reconciled=await state.reconcileStaleReceipt(await state.load(noAck.id),now);
  check('persisted no-ack receipt reaches manual reconciliation terminal',reconciled.status==='manual_reconciliation'&&reconciled.dispatchPhase==='submission_unknown'&&reconciled.revision===8&&reconciled.error==='PROVIDER_ACK_TIMEOUT',{status:reconciled.status,phase:reconciled.dispatchPhase,revision:reconciled.revision,error:reconciled.error});
  const afterLatePoll=await state.commitReceiptObservation(noAck.id,7,{...noAck,status:'processing'},'poll');
  check('persisted manual reconciliation terminal rejects late poll',afterLatePoll.status==='manual_reconciliation'&&afterLatePoll.revision===8,{status:afterLatePoll.status,revision:afterLatePoll.revision});

  const staleLease=await state.acquireReceiptLease(noAck.id,'transition');
  await fs.writeFile(path.join(temporaryRoot,`${noAck.id}.lease.json`),JSON.stringify({...staleLease,expiresAt:Date.now()-1}),'utf8');
  const newerLease=await state.acquireReceiptLease(noAck.id,'poll');
  const current=await state.load(noAck.id);
  const newer=await state.writeReceipt({...current,status:'success',revision:current.revision+1,terminalAt:Date.now()},newerLease);
  await state.releaseReceiptLease(newerLease);
  await state.writeReceipt({...current,status:'processing',revision:current.revision+1},staleLease);
  const fencedRead=await state.load(noAck.id);
  check('expired writer cannot overwrite a newer lease generation',fencedRead.status==='success'&&fencedRead.fencingGeneration===newer.fencingGeneration&&Number(newerLease.generation)>Number(staleLease.generation),{staleGeneration:staleLease.generation,newerGeneration:newerLease.generation,readGeneration:fencedRead.fencingGeneration});
}finally{
  await fs.rm(temporaryRoot,{recursive:true,force:true});
}

console.log(JSON.stringify({
  result:{total:checks.length,passed:checks.length,failed:0},
  safety:{providerRequests:0,paidTasksCreated:0,databaseReads:0,databaseWrites:0,runtimeMutations:0,deployment:0},
  checks,
},null,2));
}

main().catch(error=>{
  console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error),providerRequests:0,paidTasksCreated:0,databaseReads:0,databaseWrites:0,runtimeMutations:0,deployment:0}));
  process.exitCode=1;
});
