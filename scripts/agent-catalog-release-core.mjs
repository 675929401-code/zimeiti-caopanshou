import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

export const PROJECT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PRIVATE_ROOT='F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/agent-catalog-release-v1';
const require=createRequire(path.join(PROJECT,'package.json'));
require('tsx/cjs/api').register({tsconfig:path.join(PROJECT,'tsconfig.json')});
const contract=require(path.join(PROJECT,'src/lib/server/agent-catalog-publication.ts'));
export const fields=Object.freeze([...contract.CATALOG_PUBLICATION_FIELDS]);
export const hash=contract.publicationHash;
export const exactDecimals=contract.hasExactCatalogDecimals;
export const portableNested=contract.validatePortableNestedFields;
export const bytesHash=x=>crypto.createHash('sha256').update(x).digest('hex');
const HEX=/^[a-f0-9]{64}$/u,ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,160}$/u;
const safeCode=/^[A-Z][A-Z0-9_]{2,100}$/u;
function fail(code){throw new Error(code);}
function demand(ok,code){if(!ok)fail(code);}
function json(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function clone(x){return JSON.parse(JSON.stringify(x));}
function exists(file){return fs.existsSync(file);}
function regular(file){const s=fs.lstatSync(file);demand(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'ARCHIVE_REGULAR_FILE_REQUIRED');return s;}
function within(root,file){const r=path.relative(root,file);return !r.startsWith('..')&&!path.isAbsolute(r);}
function atomicNew(file,body){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
const textPrivacy=/(?:https?:\/\/|postgres(?:ql)?:\/\/|\b(?:secret|env):\/\/|\bBearer\s|-----BEGIN|\b(?:sk|pk)-[A-Za-z0-9_-]{12,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b1[3-9]\d{9}\b|\beyJ[A-Za-z0-9_-]{16,}\.)/iu;
export function attribution(author,reason){
 demand(typeof author==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/u.test(author),'AUTHOR_HANDLE_REQUIRED');
 demand(typeof reason==='string'&&reason.trim().length>=3&&reason.length<=300&&!textPrivacy.test(reason)&&!/[\r\n\u0000-\u001f]/u.test(reason),'SAFE_REASON_REQUIRED');
 return {author,reason};
}
export function assertPrivatePath(value){
 const root=path.resolve(value),base=path.resolve(PRIVATE_ROOT);
 demand(within(base,root),'PRIVATE_RUNTIME_ROOT_REQUIRED');
 for(let p=root;within(base,p);p=path.dirname(p)){
  if(exists(p))demand(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink(),'ARCHIVE_SYMLINK_FORBIDDEN');
  if(p===base)break;
 }
 demand(!within(PROJECT,root)&&!root.toLowerCase().includes(`${path.sep}public${path.sep}`),'ARCHIVE_OUTSIDE_CODE_REQUIRED');
 return root;
}
function privatePermissions(root,create){
 if(process.platform!=='win32'){fs.chmodSync(root,0o700);return;}
 const script=`$ErrorActionPreference='Stop'; $p='${root.replace(/'/gu,"''")}'; $create=$${create?'true':'false'}; `+String.raw`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $allow=@($sid.Value,'S-1-5-18','S-1-5-32-544'); if($create){ $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in $allow){$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}; [IO.Directory]::SetAccessControl($p,$acl) }; $acl=[IO.Directory]::GetAccessControl($p); foreach($r in $acl.Access){$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($r.AccessControlType -eq 'Allow' -and $allow -notcontains $s){throw 'PRIVATE_ACL_REQUIRED'}}; 'PRIVATE_ACL_OK'`;
 // Only the validated fixed private path enters this encoded command; no credentials or author/reason text.
 try{const out=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});demand(out.includes('PRIVATE_ACL_OK'),'PRIVATE_ACL_REQUIRED');}catch{fail('PRIVATE_ACL_REQUIRED');}
}
function entryMetadata(card,origin,lastPublishedRevision=null){
 demand(ID.test(card.id)&&Number.isSafeInteger(card.revision)&&card.revision>0,'CARD_ID_REVISION_REQUIRED');
 demand(card.fields&&fields.every(k=>Object.hasOwn(card.fields,k))&&Object.keys(card.fields).length===fields.length,'COMPLETE_PUBLICATION_FIELDS_REQUIRED');
 demand(card.sourceHash===hash(card.fields),'SOURCE_HASH_MISMATCH');
 const prompt=card.fields.system_prompt;
 demand(prompt===null||typeof prompt==='string','PROMPT_TEXT_REQUIRED');
 demand(Buffer.byteLength(prompt??'')<=512*1024,'PROMPT_TOO_LARGE');
 const safe={};
 for(const key of ['name','category','source','model','model_id','is_active','user_access']){
  const v=card.fields[key];if((typeof v==='string'&&!textPrivacy.test(v)&&v.length<=255)||typeof v==='boolean'||v===null)safe[key]=v;
 }
 const fieldHashes=Object.fromEntries(fields.map(k=>[k,hash(card.fields[k])]));
 const portability=[...(card.portability??[])];let promptStored=true;
 try{portableNested(card.fields);}catch{promptStored=false;portability.push('RESTRICTED_CONTENT_NOT_ARCHIVED');for(const key of Object.keys(safe))delete safe[key];}
 demand(portability.every(code=>typeof code==='string'&&safeCode.test(code)),'PORTABILITY_CODES_INVALID');
 return {schema:'agent-catalog-private-version.v1',id:card.id,origin,revision:card.revision,sourceHash:card.sourceHash,fieldHashes,safe,portability:[...new Set(portability)].sort(),deleted:Boolean(card.deleted),promptStored,promptIsNull:prompt===null,promptHash:bytesHash(prompt??''),promptBytes:Buffer.byteLength(prompt??''),lastPublishedRevision};
}
function blankState(){return {sequence:0,head:null,captures:{},indexes:{},releaseStarts:{},confirmedPublications:[],beforeImages:{},drafts:{},baselines:{},publishedLocalHashes:{},publishedPolicies:{},publishedCache:{},plans:{},pending:{},retireIntents:{}};}
function evolve(state,event){
 const d=event.data;
 if(event.kind==='capture'){
  state.captures[d.id]=d;
  for(const e of d.entries){
   if(d.environment==='formal-local'){
    const prior=state.drafts[e.id];
    state.drafts[e.id]={version:e.version,base:prior?.base??state.baselines[e.id]??null};
   } else state.publishedCache[e.id]=e.version;
  }
 }
 if(event.kind==='baseline')for(const [id,version]of Object.entries(d.versions)){state.baselines[id]=version;state.publishedLocalHashes[id]=d.hashes[id];}
 if(event.kind==='plan')state.plans[d.id]=d;
 if(event.kind==='index-capture')state.indexes[d.id]=d;
 if(event.kind==='release-started')state.releaseStarts[d.manifestHash]={...d,startedAt:event.at};
 if(event.kind==='before-image')state.beforeImages[d.requestKey]=d;
 if(event.kind==='retire-intent')state.retireIntents[d.id]=d;
 if(event.kind==='dispatch')state.pending[d.id]=d;
 if(event.kind==='receipt-observed'){demand(state.pending[d.id]?.requestKey===d.requestKey,'RECEIPT_WITHOUT_MATCHING_DISPATCH');state.pending[d.id]={...state.pending[d.id],phase:'receipt-observed',acknowledgedReceipt:d.receipt};}
 if(event.kind==='rejected'){demand(state.pending[d.id]?.requestKey===d.requestKey,'REJECT_WITHOUT_MATCHING_DISPATCH');delete state.pending[d.id];}
 if(event.kind==='confirmed'){
  const pending=state.pending[d.id];demand(pending&&pending.requestKey===d.requestKey,'CONFIRM_WITHOUT_MATCHING_DISPATCH');
  if(d.indexEntry)state.confirmedPublications.push({id:d.id,requestKey:d.requestKey,manifestHash:pending.manifestHash,sourceRevision:pending.sourceRevision,baseline:pending.baseline,beforeImage:pending.beforeImage??null,receipt:d.receipt,indexEntry:d.indexEntry,sequence:event.sequence});
  state.baselines[d.id]=d.version;state.publishedCache[d.id]=d.version;
  state.publishedLocalHashes[d.id]=pending.localHash;
  state.publishedPolicies[d.id]={audience:pending.audience,lifecycle:pending.lifecycle??'executable',stripPortability:pending.stripPortability??[],manifestHash:pending.manifestHash,sourceHash:pending.localHash,sourceRevision:pending.sourceRevision,targetHash:d.receipt.targetHash,targetRevision:d.receipt.revision};
  if(state.drafts[d.id]?.version===pending.localVersion)state.drafts[d.id].base=d.version;
  delete state.pending[d.id];
 }
 state.sequence=event.sequence;state.head=event.eventHash;return state;
}
export class Archive {
 constructor(root=PRIVATE_ROOT){this.root=assertPrivatePath(root);}
 file(...parts){
  const p=path.resolve(this.root,...parts);demand(within(this.root,p),'ARCHIVE_PATH_ESCAPE');
  for(let current=p;within(this.root,current);current=path.dirname(current)){if(exists(current))demand(!fs.lstatSync(current).isSymbolicLink(),'ARCHIVE_SYMLINK_FORBIDDEN');if(current===this.root)break;}
  return p;
 }
 init(author,reason){
  attribution(author,reason);const newly=!exists(this.root);fs.mkdirSync(this.root,{recursive:true,mode:0o700});privatePermissions(this.root,newly);
  if(!exists(path.join(this.root,'archive.json')))atomicNew(path.join(this.root,'archive.json'),JSON.stringify({schema:'agent-catalog-private-archive.v1',id:crypto.randomUUID(),storage:'local-private-only',createdAt:new Date().toISOString(),...attribution(author,reason)})+'\n');
  return this.identity();
 }
 identity(){regular(this.file('archive.json'));return json(this.file('archive.json'));}
 load(){
  this.identity();const dir=this.file('changelog');let state=blankState();
  if(!exists(dir))return state;
  const names=fs.readdirSync(dir).sort();
  for(const name of names){
   demand(/^\d{12}-[a-f0-9]{64}\.json$/u.test(name),'UNRECOGNIZED_CHANGELOG_ENTRY');const file=path.join(dir,name);regular(file);const event=json(file),{eventHash,...body}=event;
   demand(event.sequence===state.sequence+1&&event.previous===state.head&&hash(body)===eventHash&&name===`${String(event.sequence).padStart(12,'0')}-${eventHash}.json`,'CHANGELOG_INTEGRITY_FAILURE');
   state=evolve(state,event);
  }for(const ref of Object.values(state.beforeImages)){try{this.beforeImage(ref);}catch{fail('BEFORE_IMAGE_RECOVERY_UNAVAILABLE');}}return state;
 }
 async locked(fn){
  this.identity();privatePermissions(this.root,false);const file=this.file('.lock');let fd;
  try{fd=fs.openSync(file,'wx',0o600);}catch{fail('ARCHIVE_LOCKED_REVIEW_OWNER_NO_AUTO_UNLOCK');}
  const token=crypto.randomUUID();fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,createdAt:new Date().toISOString()}));fs.fsyncSync(fd);
  try{return await fn(this.load());}finally{fs.closeSync(fd);if(exists(file)&&json(file).token===token)fs.unlinkSync(file);}
 }
 append(state,kind,data,author,reason){
  const body={schema:'agent-catalog-private-change.v1',sequence:state.sequence+1,previous:state.head,kind,at:new Date().toISOString(),...attribution(author,reason),data};
  const event={...body,eventHash:hash(body)};
  atomicNew(this.file('changelog',`${String(event.sequence).padStart(12,'0')}-${event.eventHash}.json`),JSON.stringify(event,null,2)+'\n');return evolve(state,event);
 }
 version(ref){
  demand(ref&&ID.test(ref.id)&&HEX.test(ref.versionHash),'VERSION_REFERENCE_REQUIRED');
  const dir=this.file('agents',ref.id,'versions',ref.versionHash),file=this.file('agents',ref.id,'versions',ref.versionHash,'metadata.json');regular(file);const m=json(file);
  demand(hash(m)===ref.versionHash&&m.id===ref.id,'VERSION_INTEGRITY_FAILURE');
  if(m.promptStored===false)demand(!exists(path.join(dir,'prompt.md')),'RESTRICTED_PROMPT_MUST_NOT_EXIST');
  else {regular(this.file('agents',ref.id,'versions',ref.versionHash,'prompt.md'));demand(bytesHash(fs.readFileSync(path.join(dir,'prompt.md')))===m.promptHash,'VERSION_INTEGRITY_FAILURE');}return m;
 }
 prompt(ref){demand(this.version(ref).promptStored!==false,'RESTRICTED_PROMPT_EXPORT_FORBIDDEN');return fs.readFileSync(path.join(this.root,'agents',ref.id,'versions',ref.versionHash,'prompt.md'),'utf8');}
 saveBeforeImage(card,{requestKey,manifestHash}){
  demand(/^[a-f0-9-]{36}$/iu.test(requestKey)&&HEX.test(manifestHash)&&ID.test(card.id),'BEFORE_IMAGE_IDENTITY_REQUIRED');
  demand(!card.deleted&&Array.isArray(card.portability)&&card.portability.length===0,'BEFORE_IMAGE_PRIVATE_DEPENDENCY_REQUIRES_CONTROLLED_DATABASE_BACKUP');
  demand(card.fields&&Object.keys(card.fields).length===fields.length&&fields.every(k=>Object.hasOwn(card.fields,k))&&hash(card.fields)===card.sourceHash,'BEFORE_IMAGE_COMPLETE_FIELDS_REQUIRED');portableNested(card.fields);
  const sensitive=v=>typeof v==='string'?/(?:https?:\/\/[^\s/]+@|[?&](?:api[_-]?key|access[_-]?token|token|secret|password|signature|sig)=|\bBearer\s+\S+)/iu.test(v):Array.isArray(v)?v.some(sensitive):v&&typeof v==='object'?Object.values(v).some(sensitive):false;demand(!sensitive(card.fields),'BEFORE_IMAGE_SECRET_REQUIRES_CONTROLLED_DATABASE_BACKUP');
  const valid=v=>v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||(Array.isArray(v)&&v.every(valid))||(v&&typeof v==='object'&&Object.values(v).every(valid));demand(valid(card.fields),'BEFORE_IMAGE_NON_JSON_VALUE');
  const value={schema:'agent-catalog-controlled-before-image.v1',id:card.id,revision:card.revision,sourceHash:card.sourceHash,deleted:false,fields:card.fields};
  const body=JSON.stringify(value,null,2)+'\n',ref={id:card.id,requestKey,manifestHash,sourceHash:card.sourceHash,revision:card.revision,fileSha256:bytesHash(body),fieldCount:fields.length};
  const dir=this.file('before-images',requestKey,card.id);if(exists(dir)){this.beforeImage(ref);return ref;}
  fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});const temp=this.file('before-images',requestKey,`.pending-${crypto.randomUUID()}`);fs.mkdirSync(temp,{mode:0o700});
  atomicNew(path.join(temp,'fields.private.json'),body);atomicNew(path.join(temp,'metadata.json'),JSON.stringify(ref,null,2)+'\n');fs.renameSync(temp,dir);this.beforeImage(ref);return ref;
 }
 beforeImage(ref){
  demand(ID.test(ref?.id)&&/^[a-f0-9-]{36}$/iu.test(ref?.requestKey??'')&&HEX.test(ref.fileSha256),'BEFORE_IMAGE_REFERENCE_REQUIRED');
  const file=this.file('before-images',ref.requestKey,ref.id,'fields.private.json');regular(file);const body=fs.readFileSync(file);demand(bytesHash(body)===ref.fileSha256,'BEFORE_IMAGE_INTEGRITY_FAILURE');const value=JSON.parse(body);
  demand(value.id===ref.id&&value.revision===ref.revision&&value.sourceHash===ref.sourceHash&&hash(value.fields)===ref.sourceHash&&Object.keys(value.fields).length===fields.length&&fields.every(k=>Object.hasOwn(value.fields,k)),'BEFORE_IMAGE_INTEGRITY_FAILURE');portableNested(value.fields);return value;
 }
 saveVersion(card,origin,state){
  const m=entryMetadata(card,origin,state.baselines[card.id]?this.version(state.baselines[card.id]).revision:null),versionHash=hash(m),ref={id:card.id,versionHash};
  const dir=this.file('agents',card.id,'versions',versionHash);
  if(exists(dir)){this.version(ref);return ref;}
  const parent=path.dirname(dir);fs.mkdirSync(parent,{recursive:true,mode:0o700});
  const temp=path.join(parent,`.pending-${crypto.randomUUID()}`);fs.mkdirSync(temp,{mode:0o700});
  if(m.promptStored)atomicNew(path.join(temp,'prompt.md'),card.fields.system_prompt??'');atomicNew(path.join(temp,'metadata.json'),JSON.stringify(m,null,2)+'\n');fs.renameSync(temp,dir);return ref;
 }
 async capture(inventory,{author,reason}){
  return this.locked(state=>{
   attribution(author,reason);
   demand(['formal-local','formal-production'].includes(inventory.environment),'REGISTERED_ENVIRONMENT_REQUIRED');
   demand(inventory.readOnly===true&&inventory.identity&&inventory.identity.profileId&&Array.isArray(inventory.cards),'READ_ONLY_INVENTORY_REQUIRED');
   const identityKeys=Object.keys(inventory.identity).sort();
   if(inventory.environment==='formal-local')demand(hash(identityKeys)===hash(['database','databaseOid','profileId','runtimeProfileSha256','querySha256','projectionSourceSha256'].sort())&&inventory.identity.profileId==='formal-local-postgres-readonly-v1'&&inventory.identity.database==='zimeiti_local'&&inventory.identity.databaseOid==='16393'&&['runtimeProfileSha256','querySha256','projectionSourceSha256'].every(k=>HEX.test(inventory.identity[k])),'LOCAL_CAPTURE_IDENTITY_INVALID');
   else demand(hash(identityKeys)===hash(['profileId','originSha256','version'].sort())&&inventory.identity.profileId==='formal-production-owner-v1'&&inventory.identity.originSha256===bytesHash('https://zyuani8.com')&&['sourceVersion','buildId','releaseId','deployCommitSha'].every(k=>/^[a-zA-Z0-9._-]{4,160}$/u.test(inventory.identity.version?.[k])),'PRODUCTION_CAPTURE_IDENTITY_INVALID');
   demand(['full','scope'].includes(inventory.coverage?.kind),'EXPLICIT_INVENTORY_COVERAGE_REQUIRED');
   const actual=inventory.cards.map(c=>c.id).sort(),declared=[...inventory.coverage.ids].sort();
   demand(new Set(actual).size===actual.length&&new Set(declared).size===declared.length&&actual.every(id=>declared.includes(id)),'INVENTORY_DUPLICATE_OR_SCOPE_INVALID');
   if(inventory.coverage.kind==='full')demand(inventory.environment==='formal-local'&&inventory.identity.profileId==='formal-local-postgres-readonly-v1'&&inventory.complete===true&&actual.length===declared.length,'FULL_INVENTORY_PROOF_REQUIRED');
   const tombstoneIds=[...(inventory.tombstoneIds??[])];demand(tombstoneIds.every(id=>declared.includes(id)&&!actual.includes(id))&&new Set(tombstoneIds).size===tombstoneIds.length,'TOMBSTONE_SCOPE_INVALID');
   const entries=inventory.cards.map(card=>{const version=this.saveVersion(card,inventory.environment,state);return {id:card.id,revision:card.revision,deleted:Boolean(card.deleted),portability:this.version(version).portability??[],hash:card.sourceHash,version};});
   const data={schema:'agent-catalog-private-capture.v1',id:crypto.randomUUID(),environment:inventory.environment,observedAt:inventory.observedAt,identity:clone(inventory.identity),coverage:clone(inventory.coverage),tombstoneIds,entries,inventoryHash:hash(entries.map(({id,revision,deleted,hash,portability})=>({id,revision,deleted,hash,portability})).sort((a,b)=>a.id.localeCompare(b.id)))};
   this.append(state,'capture',data,author,reason);return clone(data);
  });
 }
 async acceptBaseline(captureId,{ids,expectedHashes,author,reason}){
  return this.locked(state=>{
   const c=state.captures[captureId];demand(c?.environment==='formal-production','PRODUCTION_CAPTURE_REQUIRED');
   const versions={},hashes={};for(const id of ids){const e=c.entries.find(e=>e.id===id);demand(e&&!e.deleted&&expectedHashes[id]===e.hash,'EXPLICIT_REMOTE_HASH_APPROVAL_REQUIRED');versions[id]=e.version;hashes[id]=e.hash;}
   demand(Object.keys(versions).length===ids.length&&ids.length>0,'BASELINE_EXACT_IDS_REQUIRED');
   this.append(state,'baseline',{captureId,versions,hashes},author,reason);return {acceptedIds:ids,preservedDrafts:true,localDatabaseWrites:0};
  });
 }
 async retireIntent(id,{baselineRevision,baselineHash,author,reason}){
  return this.locked(state=>{demand(ID.test(id)&&state.baselines[id],'PUBLISHED_BASELINE_REQUIRED');const b=this.version(state.baselines[id]);demand(b.revision===baselineRevision&&b.sourceHash===baselineHash,'RETIRE_BASELINE_MISMATCH');this.append(state,'retire-intent',{id,baselineRevision,baselineHash},author,reason);return {id,nativeSoftDeleteRequired:true,writes:0};});
 }
 async plan(localCaptureId,remoteCaptureId,{author,reason,policies={}}){
  return this.locked(state=>{
   demand(policies&&typeof policies==='object'&&!Array.isArray(policies)&&Object.entries(policies).every(([id,p])=>ID.test(id)&&p&&hash(Object.keys(p).sort())===hash(['audience','lifecycle','stripPortability'].sort())&&['source','owner-only'].includes(p.audience)&&['executable','catalog-only'].includes(p.lifecycle)&&(hash(p.stripPortability)===hash([])||(p.lifecycle==='catalog-only'&&hash(p.stripPortability)===hash(['PRIVATE_AGENT_PROXY'])))),'REVIEWED_POLICY_MAP_REQUIRED');
   const local=state.captures[localCaptureId],remote=state.captures[remoteCaptureId];
   demand(local?.environment==='formal-local'&&local.coverage.kind==='full','COMPLETE_LOCAL_PRESENT_INVENTORY_REQUIRED');
   demand(remote?.environment==='formal-production','PRODUCTION_CAPTURE_REQUIRED');
   const ids=[...new Set([...local.coverage.ids,...Object.keys(state.baselines),...remote.coverage.ids])].sort();
   const remoteScope=new Set(remote.coverage.ids);
   const cards=ids.map(id=>{
    const l=local.entries.find(e=>e.id===id),r=remote.entries.find(e=>e.id===id),b=state.baselines[id]?this.version(state.baselines[id]):null;
    const pending=state.pending[id],draft=state.drafts[id];
    let result;
    if(pending)result={kind:'pending',reason:'RECONCILE_ORIGINAL_REQUEST_ONLY'};
    else if(!remoteScope.has(id))result={kind:'unobserved',reason:'PRODUCTION_ID_NOT_READ'};
    else if(!l)result={kind:'missing-local',reason:'ABSENCE_NEVER_AUTHORIZES_RETIRE'};
    else if(l.deleted||r?.deleted||remote.tombstoneIds?.includes(id))result={kind:'tombstone',reason:'NATIVE_RESTORE_OR_EXPLICIT_RETIRE_REQUIRED'};
    else if((l.portability??[]).some(code=>!(code==='PRIVATE_AGENT_PROXY'&&policies[id]?.lifecycle==='catalog-only'&&hash(policies[id]?.stripPortability??[])===hash(['PRIVATE_AGENT_PROXY']))))result={kind:'blocked',reason:'LOCAL_NON_PORTABLE_DEPENDENCY'};
    else if(state.retireIntents[id]){
     const intent=state.retireIntents[id];result=r&&r.revision===intent.baselineRevision&&r.hash===intent.baselineHash?{kind:'retire',reason:'EXPLICIT_INTENT_NATIVE_CAS_ONLY'}:{kind:'conflict',reason:'RETIRE_TARGET_DRIFT'};
    }else result=classify({baseline:b?{hash:b.sourceHash,localHash:state.publishedLocalHashes[id]??b.sourceHash,revision:b.revision}:null,local:{hash:l.hash,revision:l.revision},remote:r?{hash:r.hash,revision:r.revision}:null});
    if(['update','unchanged'].includes(result.kind)&&b&&draft?.base&&this.version(draft.base).sourceHash!==b.sourceHash&&l?.hash!==b.sourceHash)result={kind:'conflict',reason:'DRAFT_BASE_CHANGED_BY_REMOTE_REFRESH'};
    if(result.kind==='unchanged'&&policies[id]&&state.publishedPolicies[id]&&hash(policies[id])!==hash({audience:state.publishedPolicies[id].audience,lifecycle:state.publishedPolicies[id].lifecycle,stripPortability:state.publishedPolicies[id].stripPortability}))result={kind:'update',reason:'EXPLICIT_LIFECYCLE_OR_AUDIENCE_CHANGE'};
    const lm=l?this.version(l.version):null,localDelta=!lm?'missing':!b?'new':lm.fieldHashes.system_prompt!==b.fieldHashes.system_prompt?'prompt-update':lm.sourceHash!==b.sourceHash?'metadata-update':'none';
    return {id,...result,localDelta,portability:l?.portability??[],baseline:b?{revision:b.revision,hash:b.sourceHash}:null,local:l?{revision:l.revision,hash:l.hash,version:l.version}:null,remote:r?{revision:r.revision,hash:r.hash,version:r.version}:null};
   });
   const core={schema:'agent-catalog-incremental-plan.v1',localCaptureId,remoteCaptureId,localInventoryHash:local.inventoryHash,remoteInventoryHash:remote.inventoryHash,remoteIdentity:remote.identity,requestedPolicies:policies,coverage:{local:'full',production:'explicit-scope-only',unobservedIds:cards.filter(c=>c.kind==='unobserved').map(c=>c.id)},cards};
   const planHash=hash(core),data={...core,id:`agent-catalog-incremental-v1-${planHash}`,planHash};this.append(state,'plan',data,author,reason);return clone(data);
  });
 }
}
export function classify({baseline:b,local:l,remote:r}){
 if(!l)return {kind:'missing-local',reason:'ABSENCE_NEVER_AUTHORIZES_RETIRE'};
 if(!b){if(!r)return {kind:'new',reason:'PRESENT_LOCAL_ABSENT_TARGET'};return l.hash===r.hash?{kind:'untracked',reason:'EXPLICIT_BASELINE_ADOPTION_REQUIRED'}:{kind:'conflict',reason:'REMOTE_ROW_WITHOUT_PUBLISHED_BASELINE'};}
 if(!r)return {kind:'missing-remote',reason:'TARGET_ROW_DISAPPEARED_NO_AUTOMATIC_RECREATE'};
 const localChanged=l.hash!==(b.localHash??b.hash),remoteChanged=r.hash!==b.hash||r.revision!==b.revision;
 if(!localChanged&&!remoteChanged)return {kind:'unchanged',reason:'THREE_WAY_MATCH'};
 if(localChanged&&!remoteChanged)return {kind:'update',reason:'LOCAL_DELTA_ONLY'};
 if(!localChanged&&remoteChanged)return {kind:'remote-update',reason:'REFRESH_REVIEW_REQUIRED'};
 if(l.hash===r.hash)return {kind:'converged',reason:'EXPLICIT_BASELINE_ADOPTION_REQUIRED'};
 return {kind:'conflict',reason:'LOCAL_AND_PRODUCTION_CHANGED'};
}
export function safeFailure(error){const code=typeof error?.message==='string'&&safeCode.test(error.message)?error.message:'CATALOG_OPERATION_FAILED';return {code,...(Number.isInteger(error?.httpStatus)?{httpStatus:error.httpStatus}:{}),...(typeof error?.officialCode==='string'&&safeCode.test(error.officialCode)?{officialCode:error.officialCode}:{})};}
export function validatePortable(card,baseline,requestKey,audience='source',lifecycle='executable',stripPortability=[]){
 return contract.parsePublication({action:'plan',source:card,baseline,requestKey,audience,lifecycle,stripPortability});
}
