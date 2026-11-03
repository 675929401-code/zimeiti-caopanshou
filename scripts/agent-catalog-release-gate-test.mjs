import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Archive,PRIVATE_ROOT,PROJECT,fields,hash,bytesHash} from './agent-catalog-release-core.mjs';
import {checkedAuthority} from './agent-catalog-release-readers.mjs';
import {coverageGate,validateProductionIndex,validateReleaseManifest,manifestTemplate,bindIndexCapture} from './agent-catalog-release-gate.mjs';
import {createCatalogOwnerFactory,createCatalogRequestPolicy} from './agent-catalog-release-owner.mjs';
import {runCli,cliExitCode} from './agent-catalog-release-cli.mjs';
const attrs={author:'offline-gate-test',reason:'合成数据的覆盖与正常认证合同测试'};
const authority={origin:'https://zyuani8.com',profileId:'formal-production-owner-v1',version:{sourceVersion:'fixture-r1631',buildId:'fixture-build',releaseId:'fixture-release',deployCommitSha:'a'.repeat(40)}};
const localIdentity={profileId:'formal-local-postgres-readonly-v1',database:'zimeiti_local',databaseOid:'16393',runtimeProfileSha256:hash('fixture-profile'),querySha256:hash('fixture-query'),projectionSourceSha256:hash('fixture-sql')};
function card(id='agent-gate-alpha',revision=1,prompt='Synthetic plain prompt',overrides={}){const value={...Object.fromEntries(fields.map(k=>[k,null])),name:'Synthetic',category:'自用',source:'llm',model:'fixture-model',model_id:'00000000-0000-4000-8000-000000000001',system_prompt:prompt,is_active:true,user_access:'available',enable_knowledge_base:false,preset_fields:[],output_style:{},...overrides};return {id,revision,fields:value,sourceHash:hash(value),deleted:false,portability:[]};}
function local(cards){return {environment:'formal-local',readOnly:true,complete:true,observedAt:new Date().toISOString(),identity:localIdentity,coverage:{kind:'full',ids:cards.map(c=>c.id)},cards};}
function index(cards){const entries=cards.map(c=>({id:c.id,revision:c.revision,sourceHash:c.sourceHash,promptHash:bytesHash(c.fields.system_prompt??''),deleted:c.deleted,isActive:c.fields.is_active,userAccess:c.fields.user_access,category:c.fields.category,portability:c.portability??[]})).sort((a,b)=>a.id<b.id?-1:1);return {schema:'agent-catalog-production-index.v1',complete:true,database:{database:'zimeiti_prod',oid:'57747'},observedAt:new Date().toISOString(),totalCount:entries.length,counts:{active:entries.filter(e=>!e.deleted&&e.isActive).length,hidden:entries.filter(e=>!e.deleted&&e.userAccess==='hidden').length,tombstones:entries.filter(e=>e.deleted).length},entries,inventoryHash:hash(entries)};}
function store(){const a=new Archive(path.join(PRIVATE_ROOT,'offline-tests',crypto.randomUUID()));a.init(attrs.author,attrs.reason);return a;}
async function indexCapture(a,idx){return a.locked(state=>{const d={id:crypto.randomUUID(),schema:'agent-catalog-private-index-capture.v1',identity:checkedAuthority(authority),index:idx};a.append(state,'index-capture',d,attrs.author,attrs.reason);return d;});}
function manifest(a,l,r,actions=[]){return {...manifestTemplate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,authority,releaseId:'synthetic-gate-release'}),actions};}
function action(c,r=null,overrides={}){return {id:c.id,operation:r?'update':'create',local:{revision:c.revision,hash:c.sourceHash,promptHash:bytesHash(c.fields.system_prompt??'')},production:r?{revision:r.revision,hash:r.sourceHash}:null,audience:'source',lifecycle:'executable',stripPortability:[],...overrides};}
function approve(m){const w=m.actions.filter(a=>['create','update','retire'].includes(a.operation)).map(a=>a.id);m={...m,authorization:{kind:'user-explicit',referenceHash:hash('SYNTHETIC_OFFLINE_APPROVAL'),approvedAt:new Date().toISOString(),scopeIds:w}};const sha=hash(m);return {manifest:m,expectedManifestHash:sha,approval:`APPLY ${m.releaseId} ${sha}`};}
function policyBinding(){const i=index([]),capture={id:crypto.randomUUID(),identity:checkedAuthority(authority),index:i};return {productionIndexHash:i.inventoryHash,productionIndexBinding:bindIndexCapture(capture)};}

test('coverage is UNKNOWN without a legal complete production index and the standalone gate exits nonzero',async()=>{
 const a=store(),l=await a.capture(local([card()]),attrs),g=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:'missing'});assert.equal(g.status,'UNKNOWN');assert.equal(g.webReleaseAllowed,false);assert.equal(g.claimsFullParity,false);
 const child=spawnSync(process.execPath,[path.join(PROJECT,'scripts/agent-catalog-release-cli.mjs'),'coverage-gate','--archive',a.root,'--local',l.id,'--index','missing'],{encoding:'utf8',windowsHide:true});assert.equal(child.status,3);assert.equal(JSON.parse(child.stdout).status,'UNKNOWN');
});
test('index rejects truncated, wrong database, duplicate and digest-corrupt summaries',()=>{
 const original=index([card()]);assert.equal(validateProductionIndex(original),original);
 for(const bad of [{...original,totalCount:2},{...original,database:{database:'zimeiti_prod',oid:'wrong'}},{...original,entries:[...original.entries,...original.entries],totalCount:2},{...original,inventoryHash:hash('wrong')},{...original,unexpectedOriginal:'SYNTHETIC_PROMPT'}])assert.throws(()=>validateProductionIndex(bad));
});
test('complete matching inventories plus an explicit manifest verify scoped full parity',async()=>{
 const a=store(),c=card(),l=await a.capture(local([c]),attrs),r=await indexCapture(a,index([c])),m=manifest(a,l,r),g=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:m,expectedManifestHash:hash(m)});assert.equal(g.status,'VERIFIED');assert.equal(g.claimsFullParity,true);assert.equal(g.complete,true);assert.equal(g.readyToPush,true);assert.equal(g.webReleaseAllowed,true);assert.equal(cliExitCode(g),0);assert.equal(g.configurationWrites,0);
});
test('matching values cannot conceal a forged, stale, time-modified, scope-modified or wrong-authority manifest index binding',async()=>{
 const a=store(),c=card(),l=await a.capture(local([c]),attrs),r=await indexCapture(a,index([c])),m=manifest(a,l,r),zero='0'.repeat(64);
 const cases=[{...m,productionIndexHash:zero},{...m,productionIndexHash:zero,productionIndexBinding:{...m.productionIndexBinding,inventoryHash:zero}},{...m,productionIndexBinding:{...m.productionIndexBinding,observedAt:new Date(Date.now()-60000).toISOString()}},{...m,productionIndexBinding:{...m.productionIndexBinding,scope:'visible-only'}},{...m,authority:{...authority,version:{...authority.version,buildId:'other-build'}}}];
 for(const forged of cases){const result=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:forged,expectedManifestHash:hash(forged)});assert.equal(result.status,'UNKNOWN');assert.equal(result.webReleaseAllowed,false);assert.equal(result.claimsFullParity,false);}
 const newer={...index([c]),observedAt:new Date(Date.now()+1000).toISOString()},fresh=await indexCapture(a,newer);const staleManifest={...m,productionIndexBinding:{...m.productionIndexBinding,observedAt:new Date(Date.now()-86400000).toISOString()}};assert.equal(coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:fresh.id,manifest:staleManifest}).claimsFullParity,false);
});
test('local new ID and unshipped prompt changes are individually visible and block Web parity',async()=>{
 const a=store(),old=card(),changed=card(old.id,2,'Synthetic changed prompt'),added=card('agent-gate-added'),l=await a.capture(local([changed,added]),attrs),r=await indexCapture(a,index([old])),m=manifest(a,l,r,[action(changed,old),action(added)]),g=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:m,expectedManifestHash:hash(m)});
 assert.equal(g.rows.find(v=>v.id===old.id).kind,'prompt-unpublished');assert.equal(g.rows.find(v=>v.id===added.id).kind,'local-new-unpublished');assert.equal(g.catalogWriteAllowed,true);assert.equal(g.claimsFullParity,false);assert.equal(g.webReleaseAllowed,false);
});
test('production-only and production-changed rows remain protected and require explicit preservation',async()=>{
 const a=store(),c=card(),l=await a.capture(local([c]),attrs),cloud=card(c.id,2,'Synthetic newer cloud prompt'),extra=card('agent-cloud-only'),r=await indexCapture(a,index([cloud,extra]));
 const baselineCapture=await a.capture({environment:'formal-production',readOnly:true,complete:false,observedAt:new Date().toISOString(),identity:checkedAuthority(authority),coverage:{kind:'scope',ids:[c.id]},cards:[c]},attrs);await a.acceptBaseline(baselineCapture.id,{ids:[c.id],expectedHashes:{[c.id]:c.sourceHash},...attrs});
 const empty=manifest(a,l,r),blocked=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:empty});assert.equal(blocked.rows.find(v=>v.id===c.id).kind,'production-changed');assert.equal(blocked.rows.find(v=>v.id===extra.id).kind,'production-only');assert.equal(blocked.webReleaseAllowed,false);
 const selected={...empty,mode:'selected',allowSelectiveWebRelease:true,actions:[cloud,extra].map(v=>({id:v.id,operation:'preserve-remote',production:{revision:v.revision,hash:v.sourceHash}}))};const preserved=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:selected});assert.equal(preserved.status,'ACCOUNTED_DIFFERENCES');assert.equal(preserved.claimsFullParity,false);assert.equal(preserved.complete,false);assert.equal(preserved.readyToPush,true);assert.equal(preserved.webReleaseAllowed,true);assert.equal(cliExitCode(preserved),0);assert.ok(preserved.rows.every(v=>!v.writeCandidate));
});

test('selected Web release cannot treat an approved but unapplied create, update or retire as completed',async()=>{
 const a=store(),old=card(),changed=card(old.id,2,'Synthetic changed prompt'),added=card('agent-selected-added'),retired={...card('agent-selected-retired'),deleted:true},remoteRetired={...retired,deleted:false},l=await a.capture(local([changed,added,retired]),attrs),r=await indexCapture(a,index([old,remoteRetired])),m={...manifest(a,l,r,[action(changed,old),action(added),action(retired,remoteRetired,{operation:'retire'})]),mode:'selected',allowSelectiveWebRelease:true},g=coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:m,expectedManifestHash:hash(m)});
 assert.equal(g.status,'ACCOUNTED_DIFFERENCES');assert.equal(g.readyToPush,false);assert.equal(g.complete,false);assert.equal(g.webReleaseAllowed,false);assert.deepEqual(g.pendingActionIds.sort(),[old.id,added.id,retired.id].sort());assert.equal(cliExitCode(g),3);
});
test('stale index and new local inventory after manifest preparation cannot report full parity',async()=>{
 const a=store(),c=card(),l=await a.capture(local([c]),attrs),r=await indexCapture(a,index([c])),m=manifest(a,l,r);assert.equal(coverageGate({archive:a,localCaptureId:l.id,indexCaptureId:r.id,manifest:m,now:Date.now()+11*60000}).status,'UNKNOWN');
 const next=await a.capture(local([c,card('agent-gate-newer')]),attrs);assert.equal(coverageGate({archive:a,localCaptureId:next.id,indexCaptureId:r.id,manifest:m}).reason,'MANIFEST_COMPLETE_LOCAL_INVENTORY_DRIFT');
});
test('restricted references never enter prompt.md or safe metadata through the SQL archive path',async()=>{
 const a=store(),protectedRef=['secret',':','//','synthetic-reference'].join(''),c=card(undefined,1,protectedRef,{name:protectedRef}),capture=await a.capture(local([c]),attrs),ref=capture.entries[0].version,m=a.version(ref);assert.equal(m.promptStored,false);assert.throws(()=>a.prompt(ref),/RESTRICTED_PROMPT_EXPORT_FORBIDDEN/);assert.ok(!fs.existsSync(a.file('agents',c.id,'versions',ref.versionHash,'prompt.md')));assert.ok(!JSON.stringify(m).includes('synthetic-reference'));assert.ok(m.portability.includes('RESTRICTED_CONTENT_NOT_ARCHIVED'));
});
test('publication approval binds manifest SHA, explicit source audience, lifecycle and exact IDs',()=>{
 const c=card(),m={schema:'agent-catalog-release-manifest.v1',releaseId:'synthetic-owner-release',mode:'full',authority,localInventoryHash:hash('local'),...policyBinding(),actions:[action(c)]},approved=approve(m);
 assert.doesNotThrow(()=>validateReleaseManifest(approved.manifest,{expectedHash:approved.expectedManifestHash,approval:approved.approval,scopeIds:[c.id],requireWrite:true}));
 assert.throws(()=>validateReleaseManifest(approved.manifest,{expectedHash:approved.expectedManifestHash,approval:'wrong',scopeIds:[c.id],requireWrite:true}),/EXPLICIT_RELEASE_APPROVAL_REQUIRED/);
 assert.throws(()=>validateReleaseManifest({...approved.manifest,actions:[{...action(c),audience:undefined}]}),/EXPLICIT_SOURCE_AND_AUDIENCE_REQUIRED/);
 assert.throws(()=>validateReleaseManifest({...approved.manifest,actions:[{...action(c),stripPortability:['KNOWLEDGE_REFERENCE']}]}),/MANIFEST_UNAPPROVED_STRIPPING/);
});
function self(){return {access:{adminLevel:'super_admin',authorityStatus:'ready',integrityValid:true,profileActive:true,revision:2,checksum:hash('profile'),permissionKeys:['backups.manage','agents.view','agents.manage','prompts.view','prompts.edit','models.manage','internal_tools.manage']},maintenanceLock:{status:'ready',enabled:false},stepUp:{status:'ready',authMethod:'login_password',sessionId:'synthetic-stepup',expiresAt:new Date(Date.now()+5*60000).toISOString()}};}
function ownerTransport({ownerSelf=self(),wrongDatabase=false,failUnlock=false}={}){
 const calls=[];let cookie=false,closed=false;
 const request=async req=>{calls.push(structuredClone(req));if(req.path==='/api/version')return {status:200,body:authority.version};
  if(req.path==='/api/auth/login'){cookie=true;const body={success:true,user:{id:'b5cccb94-1d77-4e14-9391-fb3e6f823486',role:'admin'}};Object.defineProperty(body,'token',{get(){throw new Error('TOKEN_MUST_NOT_BE_READ');}});return {status:200,body};}
  if(req.path==='/api/auth/me')return {status:200,body:{user:{id:'b5cccb94-1d77-4e14-9391-fb3e6f823486'}}};
  if(req.path==='/api/admin/access-control/unlock')return failUnlock?{status:429,body:{code:'ADMIN_STEP_UP_RATE_LIMITED',private:'SYNTHETIC_PASSWORD'}}:{status:200,body:{success:true,authMethod:'login_password'}};
  if(req.path==='/api/admin/access-control/self')return {status:200,body:ownerSelf};
  if(req.path==='/api/admin/agent-catalog-publications?view=index'){const i=index([]);if(wrongDatabase)i.database.oid='not-production';return {status:200,body:{ok:true,index:i}};}
  return {status:200,body:{ok:true,source:null,deleted:false,portability:[]}};
 };
 return {request,hasAuthCookie:()=>cookie,close(){closed=true;},calls,isClosed:()=>closed};
}
test('permanent owner runner authenticates once, never reads JWT and closes retained request access',async()=>{
 const transport=ownerTransport();let retained,loads=0;
 const factory=createCatalogOwnerFactory({loadCredentials:async()=>{loads++;return {username:'synthetic-account',password:'SYNTHETIC_PASSWORD'};},requesterFactory:()=>transport});
 const result=await factory({mode:'read',scopeIds:[],authority},async request=>{retained=request;await request({method:'GET',path:'/api/admin/agent-catalog-publications?view=index'});let reads=0;await request({method:'GET',get path(){reads++;return reads===1?'/api/version':'/api/admin/unapproved';}});assert.equal(reads,1);return {passed:true};});
 assert.equal(loads,1);assert.equal(result.ownerSession.loginRequests,1);assert.equal(result.ownerSession.stepUpRequests,1);assert.equal(result.ownerSession.configurationApplyRequests,0);assert.equal(transport.isClosed(),true);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PASSWORD'));await assert.rejects(retained({method:'GET',path:'/api/version'}),/EXISTING_OWNER_SESSION_EXPIRED_NO_REAUTH/);
});
test('owner runner refuses delegated admin, wrong database and rate limit without repeating login',async()=>{
 const delegated=self();delegated.access.adminLevel='admin';
 for(const options of [{ownerSelf:delegated},{wrongDatabase:true},{failUnlock:true}]){const t=ownerTransport(options),f=createCatalogOwnerFactory({loadCredentials:async()=>({username:'synthetic-account',password:'SYNTHETIC_PASSWORD'}),requesterFactory:()=>t});await assert.rejects(f({mode:'read',scopeIds:[],authority},async()=>{assert.fail('callback must not run');}));assert.equal(t.calls.filter(v=>v.path==='/api/auth/login').length,1);assert.equal(t.calls.filter(v=>v.path==='/api/admin/access-control/unlock').length,1);assert.equal(t.isClosed(),true);}
});
test('read policy denies arbitrary write/headers/paths and frozen apply token cannot be replayed',()=>{
 const c=card(),read=createCatalogRequestPolicy({mode:'read',scopeIds:[c.id],authority});assert.throws(()=>read.validate({method:'DELETE',path:'/api/admin/agents?id='+c.id}),/OWNER_CONFIGURATION_WRITES_DISABLED/);assert.throws(()=>read.validate({method:'GET',path:'/api/version',headers:{Authorization:'synthetic'}}),/OWNER_UNAPPROVED_REQUEST/);assert.throws(()=>read.validate({method:'GET',path:'/api/admin/agent-catalog-publications?agentId=agent-unapproved&view=source'}),/OWNER_UNAPPROVED_CARD_READ/);
 const pendingKey=crypto.randomUUID(),scopedReceipt=createCatalogRequestPolicy({mode:'read',scopeIds:[c.id],authority,pendingKeys:[pendingKey]}),readReceipt={method:'GET',path:'/api/admin/agent-catalog-publications?requestKey='+pendingKey};scopedReceipt.validate(readReceipt);assert.throws(()=>scopedReceipt.observe(readReceipt,{status:200,body:{ok:true,receipt:{id:'agent-unapproved'}}}),/OWNER_UNAPPROVED_RECEIPT_SCOPE/);
 const m={schema:'agent-catalog-release-manifest.v1',releaseId:'synthetic-owner-write',mode:'full',authority,localInventoryHash:hash('local'),...policyBinding(),actions:[action(c)]},a=approve(m),policy=createCatalogRequestPolicy({mode:'publish',scopeIds:[c.id],authority,...a});
 const key=crypto.randomUUID(),body={action:'plan',source:{id:c.id,revision:c.revision,sourceHash:c.sourceHash,fields:c.fields},baseline:null,requestKey:key,audience:'source',lifecycle:'executable',stripPortability:[]},req={method:'POST',path:'/api/admin/agent-catalog-publications',body};policy.validate(req);policy.observe(req,{status:200,body:{ok:true,plan:{eligible:true,id:c.id,requestKey:key,sourceHash:c.sourceHash,planHash:hash('native-plan')}}});const apply={...req,body:{...body,action:'apply',planHash:hash('native-plan')}};assert.doesNotThrow(()=>policy.validate(apply));assert.throws(()=>policy.validate(apply),/OWNER_PREVIEW_TOKEN_REQUIRED/);
});
test('expired existing step-up aborts without a new login and paired test injection cannot expose registered credentials',async()=>{
 let now=Date.now();const t=ownerTransport(),f=createCatalogOwnerFactory({loadCredentials:async()=>({username:'synthetic-account',password:'SYNTHETIC_PASSWORD'}),requesterFactory:()=>t,clock:()=>now});await assert.rejects(f({mode:'read',scopeIds:[],authority},async request=>{now+=10*60000;await request({method:'GET',path:'/api/version'});}),/EXISTING_OWNER_SESSION_EXPIRED_NO_REAUTH/);assert.equal(t.calls.filter(v=>v.path==='/api/auth/login').length,1);assert.throws(()=>createCatalogOwnerFactory({requesterFactory:()=>t}),/OWNER_TEST_DEPENDENCIES_MUST_BE_PAIRED/);
});
test('formal scripts have no permanent C case dependency or token/session minting path',()=>{
 const source=['owner','gate','publish','readers','cli','core'].map(n=>fs.readFileSync(path.join(PROJECT,'scripts/agent-catalog-release-'+n+'.mjs'),'utf8')).join('\n');assert.ok(!/Documents[\\/]Codex|work[\\/]catalog-correction|SignJWT|admin_step_up_sessions.*INSERT/iu.test(source));const owner=fs.readFileSync(path.join(PROJECT,'scripts/agent-catalog-release-owner.mjs'),'utf8');assert.ok(owner.includes('rejectUnauthorized:true'));assert.ok(owner.includes("Origin:PRODUCTION_ORIGIN"));assert.ok(!/login\.body\.token|authorization\s*=/iu.test(owner));
});
test('live coverage reports UNKNOWN on an unavailable owner index and canonical manifest hashing remains read-only',async()=>{
 const a=store(),c=card(),l=await a.capture(local([c]),attrs),r=await indexCapture(a,index([c])),m=manifest(a,l,r),authFile=a.file('authority.json'),manifestFile=a.file('manifest.json');fs.writeFileSync(authFile,JSON.stringify(authority));fs.writeFileSync(manifestFile,JSON.stringify(m,null,2));
 const digest=await runCli(['manifest-hash','--archive',a.root,'--manifest',manifestFile]);assert.equal(digest.canonicalSha256,hash(m));assert.equal(digest.writeAuthorized,false);
 const result=await runCli(['coverage-live','--archive',a.root,'--local',l.id,'--authority',authFile,'--manifest',manifestFile,'--manifest-sha256',digest.canonicalSha256,'--author',attrs.author,'--reason',attrs.reason],{readLocal:async()=>local([c]),withOwner:async()=>{throw new Error('CATALOG_MIGRATION_REQUIRED');}});assert.equal(result.status,'UNKNOWN');assert.equal(result.readyToPush,false);assert.equal(result.complete,false);assert.equal(result.webReleaseAllowed,false);assert.equal(cliExitCode(result),3);assert.equal(result.failure.code,'CATALOG_MIGRATION_REQUIRED');
});
