#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Archive,PRIVATE_ROOT,assertPrivatePath,safeFailure} from './agent-catalog-release-core.mjs';
import {readFormalLocal,refreshPublishedCache} from './agent-catalog-release-readers.mjs';
import {publishIncremental,reconcilePublication} from './agent-catalog-release-publish.mjs';
import {captureProductionIndex,coverageGate,manifestTemplate,validateReleaseManifest} from './agent-catalog-release-gate.mjs';
import {inventoryFingerprint} from './agent-catalog-release-readers.mjs';
import {hash,bytesHash} from './agent-catalog-release-core.mjs';
function demand(ok,code){if(!ok)throw new Error(code);}
function parse(argv){const [command,...rest]=argv,options={};for(let i=0;i<rest.length;i+=2){demand(/^--[a-z][a-z0-9-]*$/u.test(rest[i])&&typeof rest[i+1]==='string'&&!rest[i+1].startsWith('--')&&!Object.hasOwn(options,rest[i].slice(2)),'CLI_OPTION_INVALID');options[rest[i].slice(2)]=rest[i+1];}return {command,options};}
function privateJson(file){const p=path.resolve(file??'');assertPrivatePath(path.dirname(p));const s=fs.lstatSync(p);demand(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'PRIVATE_INPUT_FILE_REQUIRED');return JSON.parse(fs.readFileSync(p,'utf8'));}
function idsFile(value){const ids=privateJson(value);demand(Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,160}$/u.test(id)),'EXACT_IDS_FILE_REQUIRED');return ids;}
function attrs(o){return {author:o.author,reason:o.reason};}
const common=['archive','author','reason'];
const optionsByCommand={init:[], 'snapshot-local':[],status:[],verify:[],'before-image':['request-key'],export:['id','version'],plan:['local','remote','manifest'],baseline:['remote','ids','hashes'],'retire-intent':['id','revision','hash'],'refresh-production':['ids','authority'],'refresh-published':['ids','authority'],'index-production':['authority'],'coverage-gate':['local','index','manifest','manifest-sha256'],'coverage-live':['local','authority','manifest','manifest-sha256'],'manifest-template':['local','index','authority','release-id'],'manifest-hash':['manifest'],publish:['plan','hash','ids','authority','audiences','manifest','manifest-sha256','approve-release'],reconcile:['ids','authority']};
optionsByCommand['apply-release']=optionsByCommand.publish;
export function cliExitCode(result){
 if(!result||typeof result!=='object')return 2;
 if(Object.hasOwn(result,'webReleaseAllowed'))return result.webReleaseAllowed===true&&result.readyToPush===true?0:3;
 if(['publish','reconcile-read-only'].includes(result.operation)){
  const allowed=result.operation==='publish'?['verified','previously-verified']:['verified','no-pending'];
  const noRemaining=Array.isArray(result.remainingPendingIds)&&result.remainingPendingIds.length===0&&(result.operation!=='publish'||Array.isArray(result.remainingIds)&&result.remainingIds.length===0);
  return result.status==='complete'&&result.complete===true&&result.scopeComplete===true&&noRemaining&&result.finalIdentityVerified===true&&Array.isArray(result.results)&&result.results.length>0&&result.results.every(r=>allowed.includes(r.status))?0:2;
 }
 return result.finalIdentityVerified===false||result.complete===false||['pending','not-dispatched','index-drift','partial','identity-unverified'].includes(result.status)?2:0;
}
export async function runCliMain(argv,dependencies={},io={stdout:value=>console.log(value),stderr:value=>console.error(value)}){
 try{const result=await runCli(argv,dependencies);io.stdout(JSON.stringify(result,null,2));return cliExitCode(result);}
 catch(error){io.stderr(JSON.stringify({ok:false,...safeFailure(error)}));return 1;}
}
export async function runCli(argv,{withOwner,readLocal=readFormalLocal}={}){
 const {command,options:o}=parse(argv);
 if(command==='help'||!command)return {commands:Object.keys(optionsByCommand),privateRoot:PRIVATE_ROOT,network:'Only explicit online commands open the permanent normal owner transport; publish/apply-release require an approved frozen manifest.',publishFactory:'runCli(argv,{withOwner: async ({mode,scopeIds,authority,planId,expectedPlanHash},execute)=>execute(controlledRequest)})',processEntry:'runCliMain(argv, dependencies) returns an exit code; custom runners must preserve it.'};
 demand(Object.hasOwn(optionsByCommand,command)&&Object.keys(o).every(k=>[...common,...optionsByCommand[command]].includes(k)),'UNRECOGNIZED_COMMAND_OR_OPTION');
 const archive=new Archive(o.archive??PRIVATE_ROOT);
 if(command==='init')return {command,...archive.init(o.author,o.reason)};
 if(command==='snapshot-local'){const capture=await archive.capture(await readLocal(),attrs(o));return {command,captureId:capture.id,coverage:capture.coverage.kind,count:capture.entries.length,inventoryHash:capture.inventoryHash,storage:'private-local-only',databaseWrites:0};}
 const state=archive.load();
 if(command==='status')return {command,archiveId:archive.identity().id,sequence:state.sequence,head:state.head,captures:Object.values(state.captures).map(c=>({id:c.id,environment:c.environment,count:c.entries.length,coverage:c.coverage.kind,observedAt:c.observedAt})),indexes:Object.values(state.indexes).map(c=>({id:c.id,count:c.index.totalCount,complete:c.index.complete,observedAt:c.index.observedAt,inventoryHash:c.index.inventoryHash})),draftCount:Object.keys(state.drafts).length,baselineCount:Object.keys(state.baselines).length,pending:Object.values(state.pending).map(p=>({id:p.id,requestKey:p.requestKey,planId:p.planId,writeAcknowledged:Boolean(p.acknowledgedReceipt)})),plans:Object.keys(state.plans)};
 if(command==='verify'){let versions=0;for(const c of Object.values(state.captures))for(const e of c.entries){archive.version(e.version);versions++;}for(const r of Object.values(state.beforeImages))archive.beforeImage(r);return {command,passed:true,sequence:state.sequence,verifiedReferences:versions,verifiedBeforeImages:Object.keys(state.beforeImages).length,head:state.head};}
 if(command==='before-image'){const r=state.beforeImages[o['request-key']];demand(r,'BEFORE_IMAGE_NOT_FOUND');archive.beforeImage(r);return {command,id:r.id,revision:r.revision,sourceHash:r.sourceHash,fileSha256:r.fileSha256,fieldCount:r.fieldCount,file:archive.file('before-images',r.requestKey,r.id,'fields.private.json'),valuesPrinted:false,automaticRestore:false};}
 if(command==='export'){const ref={id:o.id,versionHash:o.version??state.drafts[o.id]?.version.versionHash??state.baselines[o.id]?.versionHash};const m=archive.version(ref);demand(m.promptStored!==false,'RESTRICTED_PROMPT_EXPORT_FORBIDDEN');return {command,id:m.id,revision:m.revision,promptHash:m.promptHash,promptFile:path.join(archive.root,'agents',m.id,'versions',ref.versionHash,'prompt.md'),metadataFile:path.join(archive.root,'agents',m.id,'versions',ref.versionHash,'metadata.json'),promptPrinted:false};}
 if(command==='plan'){const manifest=o.manifest?validateReleaseManifest(privateJson(o.manifest)):null,policies=Object.fromEntries((manifest?.actions??[]).filter(a=>['create','update'].includes(a.operation)).map(a=>[a.id,{audience:a.audience,lifecycle:a.lifecycle??'executable',stripPortability:a.stripPortability??[]}]));const p=await archive.plan(o.local,o.remote,{...attrs(o),policies});return {command,planId:p.id,planHash:p.planHash,coverage:p.coverage,cards:p.cards.map(({id,kind,reason,localDelta,baseline,local,remote})=>({id,kind,reason,localDelta,baseline,local:local?{hash:local.hash,revision:local.revision}:null,remote:remote?{hash:remote.hash,revision:remote.revision}:null})),writes:0};}
 if(command==='baseline')return {command,...await archive.acceptBaseline(o.remote,{ids:idsFile(o.ids),expectedHashes:privateJson(o.hashes),...attrs(o)})};
 if(command==='retire-intent')return {command,...await archive.retireIntent(o.id,{baselineRevision:Number(o.revision),baselineHash:o.hash,...attrs(o)})};
 if(command==='coverage-gate')return coverageGate({archive,localCaptureId:o.local,indexCaptureId:o.index,manifest:o.manifest?privateJson(o.manifest):null,expectedManifestHash:o['manifest-sha256']});
 if(command==='manifest-hash'){const m=validateReleaseManifest(privateJson(o.manifest));return {command,releaseId:m.releaseId,canonicalSha256:hash(m),fileSha256:bytesHash(fs.readFileSync(o.manifest)),hashForApproval:'canonicalSha256',writeAuthorized:false};}
 if(command==='manifest-template'){
  const m=manifestTemplate({archive,localCaptureId:o.local,indexCaptureId:o.index,authority:privateJson(o.authority),releaseId:o['release-id']});
  return archive.locked(s=>{const file=archive.file('release-manifests',m.releaseId+'.draft.json');fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(m,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}archive.append(s,'manifest-template',{releaseId:m.releaseId,manifestHash:hash(m)},o.author,o.reason);return {command,file,manifestHash:hash(m),writeAuthorized:false};});
 }
 const authority=privateJson(o.authority);let ownerFactory=withOwner;
 if(!ownerFactory){const permanent=await import('./agent-catalog-release-owner.mjs');ownerFactory=permanent.withCatalogOwner;}
 if(command==='index-production')return ownerFactory({mode:'read',scopeIds:[],authority},async request=>{const c=await captureProductionIndex({archive,request,authority,...attrs(o)});return {command,indexCaptureId:c.id,complete:true,count:c.index.totalCount,inventoryHash:c.index.inventoryHash,configurationWrites:0};});
 if(command==='coverage-live'){
  try{const previous=state.captures[o.local],fresh=await readLocal();let localId=o.local;
   if(previous?.inventoryHash!==inventoryFingerprint(fresh.cards))localId=(await archive.capture(fresh,attrs(o))).id;
   return await ownerFactory({mode:'read',scopeIds:[],authority},async request=>{const index=await captureProductionIndex({archive,request,authority,...attrs(o)});return coverageGate({archive,localCaptureId:localId,indexCaptureId:index.id,manifest:o.manifest?privateJson(o.manifest):null,expectedManifestHash:o['manifest-sha256']});});
  }catch(error){return {...coverageGate({archive,localCaptureId:o.local,indexCaptureId:null}),reason:'COVERAGE_PREREQUISITE_UNAVAILABLE',failure:safeFailure(error)};}
 }
 const scopeIds=o.ids?idsFile(o.ids):command==='refresh-published'?Object.keys(state.baselines):[];demand(scopeIds.length>0,'EXPLICIT_IDS_OR_EXISTING_PUBLISHED_CACHE_REQUIRED');
 if(['refresh-production','refresh-published'].includes(command))return ownerFactory({mode:'read',scopeIds,authority},async request=>{const c=await refreshPublishedCache({archive,request,authority,ids:scopeIds,...attrs(o)});return {command,captureId:c.id,count:c.entries.length,coverage:c.coverage.kind,baselineAdvanced:false,localDatabaseWrites:0};});
 if(command==='reconcile')return ownerFactory({mode:'read',scopeIds,authority,pendingKeys:scopeIds.map(id=>state.pending[id]?.requestKey).filter(Boolean)},request=>reconcilePublication({archive,request,authority,ids:scopeIds,...attrs(o)}));
 demand(o.manifest&&o['manifest-sha256']&&o['approve-release'],'EXPLICIT_RELEASE_MANIFEST_APPROVAL_REQUIRED');
 const manifest=privateJson(o.manifest),expectedManifestHash=o['manifest-sha256'],approval=`APPLY ${o['approve-release']} ${expectedManifestHash}`;
 validateReleaseManifest(manifest,{expectedHash:expectedManifestHash,approval,scopeIds,requireWrite:true});
 const audiences=o.audiences?privateJson(o.audiences):Object.fromEntries(manifest.actions.filter(a=>scopeIds.includes(a.id)).map(a=>[a.id,a.audience]));
 demand(state.plans[o.plan]?.planHash===o.hash,'APPROVED_PLAN_HASH_REQUIRED');
 return ownerFactory({mode:'publish',scopeIds,authority,archiveRoot:archive.root,planId:o.plan,expectedPlanHash:o.hash,manifest,expectedManifestHash,approval},request=>publishIncremental({archive,request,authority,planId:o.plan,expectedPlanHash:o.hash,scopeIds,audiences,manifest,expectedManifestHash,approval,readLocal,...attrs(o)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 process.exitCode=await runCliMain(process.argv.slice(2));
}
