import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Archive,PRIVATE_ROOT,PROJECT,fields,hash,bytesHash,classify,assertPrivatePath,safeFailure} from './agent-catalog-release-core.mjs';
import {checkedAuthority,captureProduction,refreshPublishedCache,localQuery,decodeLocalRow} from './agent-catalog-release-readers.mjs';
import {publishIncremental,reconcilePublication} from './agent-catalog-release-publish.mjs';
import {runCli,runCliMain,cliExitCode} from './agent-catalog-release-cli.mjs';
import {bindIndexCapture,expectedManifestIndex,coverageGate} from './agent-catalog-release-gate.mjs';
const author='offline-test',reason='离线合同场景，零网络零真实数据库写入';
const attrs={author,reason};
const authority={origin:'https://zyuani8.com',profileId:'formal-production-owner-v1',version:{sourceVersion:'fixture-r1631',buildId:'fixture-build',releaseId:'fixture-release',deployCommitSha:'a'.repeat(40)}};
const localIdentity={profileId:'formal-local-postgres-readonly-v1',database:'zimeiti_local',databaseOid:'16393',runtimeProfileSha256:bytesHash('fixture-only'),querySha256:bytesHash('fixture-query'),projectionSourceSha256:bytesHash('fixture-projection')};
function card(id='agent-fixture-alpha',revision=1,prompt='Synthetic private prompt for offline tests only',overrides={}){
 const values={...Object.fromEntries(fields.map(k=>[k,null])),name:'Synthetic agent',category:'自用',source:'llm',model:'fixture-model',model_id:'00000000-0000-4000-8000-000000000001',system_prompt:prompt,is_active:false,user_access:'hidden',enable_knowledge_base:false,output_style:{},preset_fields:[],...overrides};
 return {id,revision,fields:values,sourceHash:hash(values),deleted:false};
}
function inventory(cards,environment='formal-local',scope=cards.map(c=>c.id)){
 return {environment,readOnly:true,complete:environment==='formal-local',observedAt:new Date().toISOString(),identity:environment==='formal-local'?localIdentity:checkedAuthority(authority),coverage:{kind:environment==='formal-local'?'full':'scope',ids:scope},cards};
}
function store(){const a=new Archive(path.join(PRIVATE_ROOT,'offline-tests',crypto.randomUUID()));a.init(author,reason);return a;}
async function seed(archive,localCards,remoteCards){const l=await archive.capture(inventory(localCards),attrs),r=await archive.capture(inventory(remoteCards,'formal-production',[...new Set([...localCards,...remoteCards].map(c=>c.id))]),attrs);return {l,r};}
function fullIndex(cards){const entries=cards.map(c=>({id:c.id,revision:c.revision,sourceHash:c.sourceHash,promptHash:bytesHash(c.fields.system_prompt??''),deleted:c.deleted===true,isActive:c.fields.is_active,userAccess:c.fields.user_access,category:c.fields.category,portability:c.portability??[]})).sort((a,b)=>a.id<b.id?-1:1);return {schema:'agent-catalog-production-index.v1',complete:true,database:{database:'zimeiti_prod',oid:'57747'},observedAt:new Date().toISOString(),totalCount:entries.length,counts:{active:entries.filter(e=>!e.deleted&&e.isActive).length,hidden:entries.filter(e=>!e.deleted&&e.userAccess==='hidden').length,tombstones:entries.filter(e=>e.deleted).length},entries,inventoryHash:hash(entries)};}
async function recordIndex(archive,cards,mutate=x=>x){return archive.locked(state=>{const data={id:crypto.randomUUID(),identity:checkedAuthority(authority),index:mutate(fullIndex(cards))};archive.append(state,'index-capture',data,author,reason);return data;});}
async function baseline(archive,capture,cards){return archive.acceptBaseline(capture.id,{ids:cards.map(c=>c.id),expectedHashes:Object.fromEntries(cards.map(c=>[c.id,c.sourceHash])),...attrs});}
function mockServer(initial,{disconnectAfterCommit=[],rejectIds=[],driftBeforeApply=[],readbackForbidden=[],extraAfterPlan=null,extraAfterWrite=null}={}){
 const rows=new Map(initial.map(c=>[c.id,structuredClone(c)])),receipts=new Map(),calls=[],writes=[];
 const request=async req=>{
  calls.push(structuredClone(req));
  if(req.method==='GET'&&req.path==='/api/version')return {status:200,body:authority.version};
  if(req.method==='GET'&&req.path==='/api/admin/agent-catalog-publications?view=index')return {status:200,body:{ok:true,index:fullIndex([...rows.values()])}};
  const u=new URL(req.path,authority.origin);
  if(req.method==='GET'&&u.searchParams.has('requestKey'))return {status:200,body:{ok:true,receipt:receipts.get(u.searchParams.get('requestKey'))??null}};
  if(req.method==='GET'&&u.searchParams.has('agentId')){
   const id=u.searchParams.get('agentId');if(readbackForbidden.includes(id)&&writes.includes(id))return {status:403,body:{ok:false,code:'CATALOG_SOURCE_FORBIDDEN',error:'PRIVATE_SECRET_CANARY'}};
   const c=rows.get(id)??null;return {status:200,body:{ok:true,source:c&&!c.deleted?{id:c.id,revision:c.revision,fields:c.fields,sourceHash:c.sourceHash}:null,deleted:c?.deleted??false,portability:c?.portability??[]}};
  }
  assert.equal(req.method,'POST');assert.equal(req.path,'/api/admin/agent-catalog-publications');const b=req.body,c=rows.get(b.source.id)??null;
  const targetFields={...b.source.fields,...(b.audience==='owner-only'?{user_access:'hidden'}:{}),...(b.lifecycle==='catalog-only'?{model:'',model_id:null,is_active:false,user_access:b.audience==='owner-only'||b.source.fields.user_access==='hidden'?'hidden':'view_only'}:{})};
  const operation=!c?'create':hash(c.fields)===hash(targetFields)?'noop':'update';
  const core={id:b.source.id,requestKey:b.requestKey,operation,sourceHash:b.source.sourceHash,currentRevision:c?.revision??null,currentHash:c?.sourceHash??null,targetHash:hash(targetFields),audience:b.audience,lifecycle:b.lifecycle??'executable',stripPortability:b.stripPortability??[]};
  const p={...core,planHash:hash(core),eligible:true,blockers:[]};
  if(b.action==='plan'){if(extraAfterPlan){rows.set(extraAfterPlan.id,extraAfterPlan);extraAfterPlan=null;}return {status:200,body:{ok:true,plan:p}};}
  assert.equal(b.action,'apply');
  if(rejectIds.includes(b.source.id))return {status:409,body:{ok:false,code:'CATALOG_MODEL_INELIGIBLE',error:'PRIVATE_SECRET_CANARY'}};
  if(driftBeforeApply.includes(b.source.id)){const changed=card(b.source.id,(c?.revision??0)+1,'Concurrent remote change');rows.set(changed.id,changed);return {status:409,body:{ok:false,code:'CATALOG_PRODUCTION_BASELINE_CONFLICT'}};}
  assert.equal(b.planHash,p.planHash);const next={id:b.source.id,revision:c?c.revision+1:1,fields:targetFields,sourceHash:p.targetHash,deleted:false};rows.set(next.id,next);writes.push(next.id);if(extraAfterWrite){rows.set(extraAfterWrite.id,extraAfterWrite);extraAfterWrite=null;}
  const receipt={id:next.id,requestKey:b.requestKey,planHash:p.planHash,sourceHash:b.source.sourceHash,targetHash:next.sourceHash,revision:next.revision,operation,audience:b.audience,lifecycle:b.lifecycle??'executable',stripPortability:b.stripPortability??[],providerCalls:0,billingEvidence:'configuration-only'};receipts.set(b.requestKey,receipt);
  if(disconnectAfterCommit.includes(next.id))throw new Error('socket hung up PRIVATE_SECRET_CANARY');
  return {status:200,body:{ok:true,receipt,replayed:false}};
 };
 return {request,rows,receipts,calls,writes};
}
async function makePlan(archive,localCards,remoteCards,{adopt=true,policies={}}={}){
 const {r}=await seed(archive,localCards,remoteCards);if(adopt&&remoteCards.length)await baseline(archive,r,remoteCards);
 await recordIndex(archive,remoteCards);
 // Refresh local after baseline adoption to attach the correct draft ancestry.
 const current=await archive.capture(inventory(localCards),attrs);return archive.plan(current.id,r.id,{...attrs,policies});
}
const publishArgs=(archive,p,localCards,server,scopeIds=p.cards.filter(c=>['new','update'].includes(c.kind)).map(c=>c.id),policies={})=>{
 const actions=scopeIds.map(id=>{const c=p.cards.find(c=>c.id===id);return {id,operation:c?.kind==='new'?'create':c?.kind==='retire'?'retire':'update',local:{revision:c?.local?.revision??1,hash:c?.local?.hash??hash('missing'),promptHash:c?.local?archive.version(c.local.version).promptHash:hash('missing')},production:c?.baseline??null,audience:policies[id]?.audience??'source',lifecycle:policies[id]?.lifecycle??'executable',stripPortability:policies[id]?.stripPortability??[]};});
 const idx=Object.values(archive.load().indexes).at(-1),manifest={schema:'agent-catalog-release-manifest.v1',releaseId:'synthetic-release',mode:'full',authority,localInventoryHash:p.localInventoryHash,productionIndexHash:idx.index.inventoryHash,productionIndexBinding:bindIndexCapture(idx),actions,authorization:{kind:'user-explicit',referenceHash:hash('OFFLINE_SYNTHETIC_APPROVAL_ONLY'),approvedAt:new Date().toISOString(),scopeIds}};
 const expectedManifestHash=hash(manifest);return {archive,request:server.request,authority,planId:p.id,expectedPlanHash:p.planHash,scopeIds,manifest,expectedManifestHash,approval:`APPLY ${manifest.releaseId} ${expectedManifestHash}`,audiences:Object.fromEntries(actions.map(a=>[a.id,a.audience])),readLocal:async()=>inventory(localCards),...attrs};
};
function cliPublishArgs(args,command='apply-release'){
 const files={ids:args.archive.file('cli-ids.json'),authority:args.archive.file('cli-authority.json'),manifest:args.archive.file('cli-manifest.json')};
 fs.writeFileSync(files.ids,JSON.stringify(args.scopeIds));fs.writeFileSync(files.authority,JSON.stringify(args.authority));fs.writeFileSync(files.manifest,JSON.stringify(args.manifest));
 return [command,'--archive',args.archive.root,'--plan',args.planId,'--hash',args.expectedPlanHash,'--ids',files.ids,'--authority',files.authority,'--manifest',files.manifest,'--manifest-sha256',args.expectedManifestHash,'--approve-release',args.manifest.releaseId,'--author',author,'--reason',reason];
}
function cliOutput(){const stdout=[],stderr=[];return {stdout,stderr,io:{stdout:text=>stdout.push(text),stderr:text=>stderr.push(text)}};}

test('three-way results distinguish new, update, unchanged, remote update and conflict by hash/revision',()=>{
 const h=s=>hash(s),b={hash:h('base'),revision:3},l={hash:h('base'),revision:30},r={hash:h('base'),revision:3};
 assert.equal(classify({baseline:null,local:l,remote:null}).kind,'new');
 assert.equal(classify({baseline:b,local:l,remote:r}).kind,'unchanged');
 assert.equal(classify({baseline:b,local:{...l,hash:h('local')},remote:r}).kind,'update');
 assert.equal(classify({baseline:b,local:l,remote:{...r,revision:4}}).kind,'remote-update');
 assert.equal(classify({baseline:b,local:{...l,hash:h('local')},remote:{hash:h('remote'),revision:4}}).kind,'conflict');
 assert.equal(classify({baseline:b,local:l,remote:null}).kind,'missing-remote');
});
test('archive rejects public, Git and arbitrary storage; metadata contains hashes rather than prompt/URL',async()=>{
 assert.throws(()=>assertPrivatePath(path.join(PROJECT,'public','prompt-backup')),/PRIVATE_RUNTIME_ROOT_REQUIRED/);
 assert.throws(()=>assertPrivatePath('C:/Users/Administrator/Documents/catalog-cache'),/PRIVATE_RUNTIME_ROOT_REQUIRED/);
 const archive=store(),c=card(undefined,1,'DO_NOT_PRINT_PRIVATE_PROMPT',{cover_url:'https://private.example/do-not-copy'});
 const capture=await archive.capture(inventory([c]),attrs),ref=capture.entries[0].version,m=archive.version(ref);
 assert.equal(archive.prompt(ref),c.fields.system_prompt);const raw=JSON.stringify(m);assert.ok(!raw.includes('DO_NOT_PRINT')&&!raw.includes('https://')&&!raw.includes('private.example'));assert.equal(m.fieldHashes.cover_url,hash(c.fields.cover_url));
 assert.throws(()=>archive.init('person@example.com',reason),/AUTHOR_HANDLE_REQUIRED/);
});
test('append-only hash chain catches corruption and never replaces an old prompt version',async()=>{
 const archive=store(),first=await archive.capture(inventory([card()]),attrs),before=fs.readFileSync(archive.file('agents',first.entries[0].id,'versions',first.entries[0].version.versionHash,'prompt.md'));
 await archive.capture(inventory([card(undefined,2,'Changed synthetic prompt')]),attrs);assert.equal(archive.load().sequence,2);assert.deepEqual(fs.readFileSync(archive.file('agents',first.entries[0].id,'versions',first.entries[0].version.versionHash,'prompt.md')),before);
 const name=fs.readdirSync(archive.file('changelog'))[0];fs.appendFileSync(archive.file('changelog',name),'broken');assert.throws(()=>archive.load());
});
test('a second process-style transaction cannot acquire the archive lock and no stale lock is auto cleared',async()=>{
 const archive=store();let unblock;const gate=new Promise(r=>{unblock=r;});let entered;const started=new Promise(r=>{entered=r;});
 const first=archive.locked(async()=>{entered();await gate;});await started;
 await assert.rejects(archive.locked(()=>{}),/ARCHIVE_LOCKED_REVIEW_OWNER_NO_AUTO_UNLOCK/);unblock();await first;
 fs.writeFileSync(archive.file('.lock'),JSON.stringify({pid:-1,token:'fixture-old'}));await assert.rejects(archive.locked(()=>{}),/ARCHIVE_LOCKED/);assert.ok(fs.existsSync(archive.file('.lock')));
});
test('a child junction cannot redirect prompt writes into code/public',async()=>{
 const archive=store(),target=path.join(PRIVATE_ROOT,'offline-tests','junction-target-'+crypto.randomUUID());fs.mkdirSync(target,{recursive:true});fs.symlinkSync(target,archive.file('agents'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(archive.capture(inventory([card()]),attrs),/ARCHIVE_SYMLINK_FORBIDDEN/);assert.deepEqual(fs.readdirSync(target),[]);
});
test('complete local inventory detects a new ID and prompt delta even when production scope did not read it',async()=>{
 const archive=store(),a=card(),{r}=await seed(archive,[a],[a]);await baseline(archive,r,[a]);
 const l=await archive.capture(inventory([card(a.id,2,'Changed prompt'),card('agent-fixture-added')]),attrs),remote=await archive.capture(inventory([a],'formal-production',[a.id]),attrs),p=await archive.plan(l.id,remote.id,attrs);
 assert.equal(p.cards.find(c=>c.id===a.id).localDelta,'prompt-update');const added=p.cards.find(c=>c.id==='agent-fixture-added');assert.equal(added.kind,'unobserved');assert.equal(added.localDelta,'new');assert.deepEqual(p.coverage.unobservedIds,['agent-fixture-added']);
});
test('deleting a local row is never retirement and preserves its previous private version',async()=>{
 const archive=store(),a=card(),{r}=await seed(archive,[a],[a]);await baseline(archive,r,[a]);
 const empty=await archive.capture(inventory([]),attrs),p=await archive.plan(empty.id,r.id,attrs);assert.equal(p.cards[0].kind,'missing-local');assert.ok(archive.load().drafts[a.id]);assert.equal(archive.prompt(archive.load().drafts[a.id].version),a.fields.system_prompt);
});
test('a disappeared production row is not automatically recreated',async()=>{
 const archive=store(),a=card(),{l,r}=await seed(archive,[a],[a]);await baseline(archive,r,[a]);const missing=await archive.capture(inventory([],'formal-production',[a.id]),attrs);const p=await archive.plan(l.id,missing.id,attrs);assert.equal(p.cards[0].kind,'missing-remote');
});
test('retire requires explicit prior revision/hash and remains a native soft-delete plan only',async()=>{
 const archive=store(),a=card(),{l,r}=await seed(archive,[a],[a]);await baseline(archive,r,[a]);await assert.rejects(archive.retireIntent(a.id,{baselineRevision:2,baselineHash:a.sourceHash,...attrs}),/RETIRE_BASELINE_MISMATCH/);
 await archive.retireIntent(a.id,{baselineRevision:1,baselineHash:a.sourceHash,...attrs});await recordIndex(archive,[a]);const p=await archive.plan(l.id,r.id,attrs);assert.equal(p.cards[0].kind,'retire');const server=mockServer([a]);await assert.rejects(publishIncremental(publishArgs(archive,p,[a],server,[a.id])),/MANIFEST_SOURCE_PLAN_MISMATCH|SCOPE_REQUIRES_NEW_PLAN/);assert.equal(server.calls.length,0);
});
test('normal remote refresh updates published cache without moving baseline or overwriting draft',async()=>{
 const archive=store(),a=card(),{r}=await seed(archive,[a],[a]);await baseline(archive,r,[a]);const l=await archive.capture(inventory([card(a.id,2,'My local draft')]),attrs),prior=archive.load().drafts[a.id].version;
 const server=mockServer([card(a.id,2,'New cloud prompt')]);const remote=await refreshPublishedCache({archive,request:server.request,authority,ids:[a.id],...attrs});const state=archive.load();assert.deepEqual(state.drafts[a.id].version,prior);assert.equal(archive.version(state.baselines[a.id]).sourceHash,a.sourceHash);
 const p=await archive.plan(l.id,remote.id,attrs);assert.equal(p.cards[0].kind,'conflict');assert.ok(server.calls.every(c=>c.method==='GET'));
 await baseline(archive,remote,[server.rows.get(a.id)]);const after=await archive.plan(l.id,remote.id,attrs);assert.equal(after.cards[0].kind,'conflict');
});
test('new stable ID publishes once with native plan hash, production r1 and exact readback',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([]);assert.equal(p.cards[0].kind,'new');
 const result=await publishIncremental(publishArgs(archive,p,[a],server));assert.equal(result.applyAttempts,1);assert.equal(result.results[0].status,'verified');assert.equal(server.rows.get(a.id).revision,1);assert.equal(Object.keys(archive.load().pending).length,0);assert.equal(archive.version(archive.load().baselines[a.id]).sourceHash,a.sourceHash);assert.equal(server.writes.length,1);
});
test('update binds the original production revision and verifies a single increment',async()=>{
 const archive=store(),old=card(undefined,7,'Before image original prompt',{description:'Previous product display',base_fee:2.75,cost_per_message:9,profit_margin:15,guide_message:'Previous guide',avatar:'https://public.example/avatar.png',output_style:{tone:'previous'}}),local=card(old.id,200,'Updated local prompt'),p=await makePlan(archive,[local],[old]),server=mockServer([old]);
 assert.equal(p.cards[0].kind,'update');const result=await publishIncremental(publishArgs(archive,p,[local],server));assert.equal(result.results[0].revision,8);const apply=server.calls.find(c=>c.body?.action==='apply');assert.equal(apply.body.baseline.revision,7);assert.equal(apply.body.source.revision,200);
 const ref=Object.values(archive.load().beforeImages)[0],image=archive.beforeImage(ref);assert.equal(ref.fieldCount,38);assert.deepEqual(image.fields,old.fields);assert.equal(image.fields.base_fee,2.75);assert.equal(image.fields.model_id,old.fields.model_id);assert.equal(image.fields.description,'Previous product display');assert.ok(archive.load().confirmedPublications[0].beforeImage);
});
test('disconnect after commit leaves durable pending; read-only reconciliation confirms without a second apply',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([],{disconnectAfterCommit:[a.id]});const result=await publishIncremental(publishArgs(archive,p,[a],server));assert.equal(result.results[0].status,'pending');const pending=archive.load().pending[a.id];assert.ok(pending?.requestKey);assert.equal(server.writes.length,1);
 await assert.rejects(publishIncremental(publishArgs(archive,p,[a],server)),/SCOPE_REQUIRES_NEW_PLAN|RELEASE_PENDING_RECONCILIATION_REQUIRED/);
 const count=server.calls.filter(c=>c.body?.action==='apply').length,reconciled=await reconcilePublication({archive,request:server.request,authority,ids:[a.id],...attrs});assert.equal(reconciled.results[0].status,'verified');assert.equal(server.calls.filter(c=>c.body?.action==='apply').length,count);assert.equal(server.writes.length,1);assert.equal(Object.keys(archive.load().pending).length,0);
});
test('an authoritative rejection without index changes does not stop an independent card',async()=>{
 const archive=store(),a=card(),b=card('agent-fixture-beta'),p=await makePlan(archive,[a,b],[]),server=mockServer([],{rejectIds:[a.id]});const result=await publishIncremental(publishArgs(archive,p,[a,b],server));assert.equal(result.results[0].status,'rejected');assert.equal(result.results[1].status,'verified');assert.deepEqual(server.writes,[b.id]);assert.equal(Object.keys(archive.load().pending).length,0);
});
test('post-commit readback 403 remains pending and cannot be mislabeled as a rejected write',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([],{readbackForbidden:[a.id]});const result=await publishIncremental(publishArgs(archive,p,[a],server));assert.equal(result.results[0].status,'pending');assert.equal(result.results[0].writeAcknowledged,true);assert.ok(archive.load().pending[a.id].acknowledgedReceipt);assert.equal(server.writes.length,1);assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET_CANARY'));
});
test('full local inventory drift and unknown scope prevent every dispatch',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([]);
 await assert.rejects(publishIncremental({...publishArgs(archive,p,[a],server),readLocal:async()=>inventory([a,card('agent-fixture-new-after-plan')])}),/LOCAL_COMPLETE_INVENTORY_DRIFT/);assert.equal(server.calls.length,0);
 await assert.rejects(publishIncremental(publishArgs(archive,p,[a],server,['agent-not-approved'])),/MANIFEST_SOURCE_PLAN_MISMATCH|SCOPE_REQUIRES_NEW_PLAN|UPDATE_PRODUCTION_CAS_REQUIRED/);assert.equal(server.calls.length,0);
});
test('owner-only normalized target is recorded separately from local source and is not republished endlessly',async()=>{
 const archive=store(),a=card(undefined,1,undefined,{user_access:'available'}),p=await makePlan(archive,[a],[]),server=mockServer([]);const result=await publishIncremental(publishArgs(archive,p,[a],server,undefined,{[a.id]:{audience:'owner-only'}}));assert.equal(result.results[0].status,'verified');assert.equal(server.rows.get(a.id).fields.user_access,'hidden');
 const l=await archive.capture(inventory([a]),attrs),r=await archive.capture(inventory([server.rows.get(a.id)],'formal-production'),attrs),after=await archive.plan(l.id,r.id,attrs);assert.equal(after.cards[0].kind,'unchanged');
});
test('read-only API capture rejects runtime drift and can never claim global completeness',async()=>{
 const a=card(),server=mockServer([a]);const c=await captureProduction({request:server.request,authority,ids:[a.id]});assert.equal(c.complete,false);assert.equal(c.coverage.kind,'scope');assert.ok(server.calls.every(r=>r.method==='GET'));
 await assert.rejects(captureProduction({request:server.request,authority:{...authority,version:{...authority.version,buildId:'wrong-build'}},ids:[a.id]}),/PRODUCTION_VERSION_DRIFT/);
 assert.ok(!/conversations|users|SELECT \*/iu.test(localQuery()));assert.ok(localQuery().includes('system_prompt'));assert.ok(localQuery().includes('PRIVATE_AGENT_PROXY'));
});
test('authoritative local projection preserves exact JSON decimals and flags values that lose precision',()=>{
 const c=card(undefined,1,undefined,{base_fee:1.25}),numericText={...Object.fromEntries(fields.map(k=>[k,c.fields[k]===null?null:String(c.fields[k])])),nestedNumbers:[]};
 const row={id:c.id,revision:1,deleted:false,fields:c.fields,numericText,portability:[]};assert.deepEqual(decodeLocalRow({jsonb_build_object:row}).portability,[]);
 const changed={...row,fields:{...c.fields,base_fee:1.2345678901234567},numericText:{...numericText,base_fee:'1.234567890123456789'}};assert.ok(decodeLocalRow({jsonb_build_object:changed}).portability.includes('DECIMAL_NOT_EXACT_IN_JSON'));
});

test('nested JSON numeric evidence allows exact decimals and blocks rounded, missing or omitted evidence',()=>{
 const c=card(undefined,1,undefined,{output_style:{weights:[0.125,{ratio:1.25}]},preset_fields:[{weight:0.5}]}),numericText={...Object.fromEntries(fields.map(k=>[k,c.fields[k]===null?null:String(c.fields[k])])),nestedNumbers:['0.125','1.25','0.5']},row={id:c.id,revision:1,deleted:false,fields:c.fields,numericText,portability:[]};
 assert.deepEqual(decodeLocalRow({jsonb_build_object:row}).portability,[]);
 const rounded={...row,fields:{...row.fields,output_style:{weights:[0.12345678901234568]}},numericText:{...numericText,nestedNumbers:['0.123456789012345678901','0.5']}};assert.ok(decodeLocalRow({jsonb_build_object:rounded}).portability.includes('DECIMAL_NOT_EXACT_IN_JSON'));
 const missing={...numericText};delete missing.nestedNumbers;assert.ok(decodeLocalRow({jsonb_build_object:{...row,numericText:missing}}).portability.includes('DECIMAL_NOT_EXACT_IN_JSON'));
 assert.ok(decodeLocalRow({jsonb_build_object:{...row,numericText:{...numericText,nestedNumbers:[]}}}).portability.includes('DECIMAL_NOT_EXACT_IN_JSON'));
});
test('production tombstone remains restore-required, never a new stable ID insertion',async()=>{
 const archive=store(),a=card(),server=mockServer([{...a,deleted:true}]);const local=await archive.capture(inventory([a]),attrs),remote=await refreshPublishedCache({archive,request:server.request,authority,ids:[a.id],...attrs});assert.deepEqual(remote.tombstoneIds,[a.id]);const p=await archive.plan(local.id,remote.id,attrs);assert.equal(p.cards[0].kind,'tombstone');assert.equal(server.writes.length,0);
});
test('private channel/dependency presence is archived as a reason and blocks incremental dispatch',async()=>{
 const archive=store(),a={...card(),portability:['PRIVATE_AGENT_PROXY']},p=await makePlan(archive,[a],[]),server=mockServer([]);assert.equal(p.cards[0].kind,'blocked');assert.deepEqual(p.cards[0].portability,['PRIVATE_AGENT_PROXY']);await assert.rejects(publishIncremental(publishArgs(archive,p,[a],server,[a.id])),/SCOPE_REQUIRES_NEW_PLAN|UPDATE_PRODUCTION_CAS_REQUIRED|MANIFEST_SOURCE_PLAN_MISMATCH/);assert.equal(server.calls.length,0);
});
test('explicit catalog-only lifecycle strips only the declared proxy and preserves the same stable ID',async()=>{
 const archive=store(),a={...card(undefined,1,undefined,{user_access:'available'}),portability:['PRIVATE_AGENT_PROXY']},policies={[a.id]:{audience:'source',lifecycle:'catalog-only',stripPortability:['PRIVATE_AGENT_PROXY']}},p=await makePlan(archive,[a],[],{policies}),server=mockServer([]);
 assert.equal(p.cards[0].kind,'new');const result=await publishIncremental(publishArgs(archive,p,[a],server,undefined,policies));assert.equal(result.results[0].status,'verified');const target=server.rows.get(a.id);assert.equal(target.id,a.id);assert.equal(target.fields.model_id,null);assert.equal(target.fields.model,'');assert.equal(target.fields.is_active,false);assert.equal(target.fields.user_access,'view_only');assert.equal(archive.load().publishedPolicies[a.id].lifecycle,'catalog-only');assert.equal(result.providerCalls,0);assert.equal(result.billingEvidence,'configuration-only');
 const l=await archive.capture(inventory([a]),attrs),r=await archive.capture(inventory([target],'formal-production'),attrs),again=await archive.plan(l.id,r.id,{...attrs,policies});assert.equal(again.cards[0].kind,'unchanged');assert.equal(server.writes.length,1);
});
test('standalone CLI requires an explicitly approved release manifest before opening owner credentials',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]);const ids=archive.file('approved-ids.json'),auth=archive.file('authority.json');fs.writeFileSync(ids,JSON.stringify([a.id]));fs.writeFileSync(auth,JSON.stringify(authority));
 await assert.rejects(runCli(['publish','--archive',archive.root,'--plan',p.id,'--hash',p.planHash,'--ids',ids,'--authority',auth,'--author',author,'--reason',reason]),/EXPLICIT_RELEASE_MANIFEST_APPROVAL_REQUIRED/);
 assert.deepEqual(safeFailure(new Error('PRIVATE_SECRET_CANARY https://private.example/session')), {code:'CATALOG_OPERATION_FAILED'});
 let sessions=0;const server=mockServer([]),approved=publishArgs(archive,p,[a],server),manifestFile=archive.file('reviewed-manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(approved.manifest));
 const result=await runCli(['publish','--archive',archive.root,'--plan',p.id,'--hash',p.planHash,'--ids',ids,'--authority',auth,'--manifest',manifestFile,'--manifest-sha256',approved.expectedManifestHash,'--approve-release',approved.manifest.releaseId,'--author',author,'--reason',reason],{readLocal:async()=>inventory([a]),withOwner:async(options,execute)=>{sessions++;assert.equal(options.mode,'publish');assert.deepEqual(options.scopeIds,[a.id]);return execute(server.request);}});assert.equal(sessions,1);assert.equal(result.results[0].status,'verified');
});
test('zero-hash, old frozen index and authority mismatch stop before all configuration writes',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([]),args=publishArgs(archive,p,[a],server);
 const forged={...args.manifest,productionIndexHash:'0'.repeat(64),productionIndexBinding:{...args.manifest.productionIndexBinding,inventoryHash:'0'.repeat(64)}},wrongHash=hash(forged);await assert.rejects(publishIncremental({...args,manifest:forged,expectedManifestHash:wrongHash,approval:`APPLY ${forged.releaseId} ${wrongHash}`}),/MANIFEST_PRODUCTION_INDEX_BINDING_MISMATCH/);
 await recordIndex(archive,[],x=>({...x,observedAt:new Date(Date.now()-11*60000).toISOString()}));const stale=publishArgs(archive,p,[a],server);await assert.rejects(publishIncremental(stale),/FROZEN_PRODUCTION_INDEX_EXPIRED/);
 await assert.rejects(publishIncremental({...args,authority:{...authority,version:{...authority.version,buildId:'wrong-build'}}}),/PLAN_PRODUCTION_AUTHORITY_MISMATCH/);assert.equal(server.writes.length,0);assert.ok(server.calls.every(c=>c.method==='GET'));
});
test('a concurrent unrelated index row added after native preview prevents apply',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([],{extraAfterPlan:card('agent-concurrent-extra')});const result=await publishIncremental(publishArgs(archive,p,[a],server));assert.equal(result.applyAttempts,0);assert.equal(result.results[0].code,'MANIFEST_LIVE_COMPLETE_INDEX_DRIFT');assert.equal(server.writes.length,0);assert.equal(Object.keys(archive.load().pending).length,0);
});
test('persisted receipts advance only their own rows so an approved release resumes in a later batch',async()=>{
 const archive=store(),a=card(),b=card('agent-resume-beta'),p=await makePlan(archive,[a,b],[]),server=mockServer([]),args=publishArgs(archive,p,[a,b],server);
 const first=await publishIncremental({...args,scopeIds:[a.id],audiences:{[a.id]:'source'}});assert.equal(first.results[0].status,'verified');assert.equal(first.status,'partial');assert.equal(first.complete,false);assert.equal(first.scopeComplete,true);assert.deepEqual(first.remainingIds,[b.id]);assert.equal(cliExitCode(first),2);const reloaded=new Archive(archive.root);assert.equal(reloaded.load().confirmedPublications.length,1);
 const future=expectedManifestIndex({state:reloaded.load(),manifest:args.manifest,manifestHash:args.expectedManifestHash,now:Date.now()+11*60000});assert.deepEqual(future.confirmedIds,[a.id]);
 const second=await publishIncremental({...args,archive:reloaded});assert.equal(second.results[0].status,'previously-verified');assert.equal(second.results[1].status,'verified');assert.equal(second.complete,true);assert.equal(cliExitCode(second),0);assert.deepEqual(server.writes,[a.id,b.id]);
 const replay=await publishIncremental({...args,archive:new Archive(archive.root)});assert.equal(replay.applyAttempts,0);assert.ok(replay.results.every(r=>r.status==='previously-verified'));
});
test('a disconnected partial release must reconcile before continuation and cannot bless unrelated changes',async()=>{
 const archive=store(),a=card(),b=card('agent-resume-after-disconnect'),p=await makePlan(archive,[a,b],[]),server=mockServer([],{disconnectAfterCommit:[a.id]}),args=publishArgs(archive,p,[a,b],server);
 const first=await publishIncremental(args);assert.equal(first.results[0].status,'pending');assert.deepEqual(server.writes,[a.id]);await assert.rejects(publishIncremental(args),/RELEASE_PENDING_RECONCILIATION_REQUIRED/);
 const gate=coverageGate({archive,localCaptureId:p.localCaptureId,indexCaptureId:args.manifest.productionIndexBinding.captureId,manifest:args.manifest});assert.equal(gate.webReleaseAllowed,false);assert.equal(gate.reason,'RELEASE_PENDING_RECONCILIATION_REQUIRED');
 const reconciled=await reconcilePublication({archive,request:server.request,authority,ids:[a.id],...attrs});assert.equal(reconciled.results[0].status,'verified');
 const extra=card('agent-external-change');server.rows.set(extra.id,extra);await assert.rejects(publishIncremental(args),/MANIFEST_LIVE_COMPLETE_INDEX_DRIFT/);assert.deepEqual(server.writes,[a.id]);
 server.rows.delete(extra.id);const resumed=await publishIncremental(args);assert.equal(resumed.results[0].status,'previously-verified');assert.equal(resumed.results[1].status,'verified');assert.deepEqual(server.writes,[a.id,b.id]);
});
test('private proxy dependencies and secret strings block update before an incomplete before-image can be claimed',async()=>{
 const archive=store(),old={...card(undefined,3),portability:['PRIVATE_AGENT_PROXY']},next=card(old.id,5,'Changed prompt'),p=await makePlan(archive,[next],[old]),server=mockServer([old]),result=await publishIncremental(publishArgs(archive,p,[next],server));assert.equal(result.applyAttempts,0);assert.equal(result.results[0].code,'BEFORE_IMAGE_PRIVATE_DEPENDENCY_REQUIRES_CONTROLLED_DATABASE_BACKUP');assert.equal(Object.keys(archive.load().beforeImages).length,0);
 const bad={...card('agent-secret-preimage',1,undefined,{guide_message:'https://private.example/file?token=synthetic'}),portability:[]};assert.throws(()=>archive.saveBeforeImage(bad,{requestKey:crypto.randomUUID(),manifestHash:hash('fixture')}),/BEFORE_IMAGE_SECRET/);assert.equal(server.writes.length,0);
});
test('a damaged full before-image blocks release continuation instead of treating its hash as a backup',async()=>{
 const archive=store(),old=card(undefined,4),next=card(old.id,5,'New prompt'),p=await makePlan(archive,[next],[old]),server=mockServer([old]);await publishIncremental(publishArgs(archive,p,[next],server));const ref=Object.values(archive.load().beforeImages)[0];assert.ok(ref);fs.appendFileSync(archive.file('before-images',ref.requestKey,ref.id,'fields.private.json'),'damaged');assert.throws(()=>new Archive(archive.root).load(),/BEFORE_IMAGE_RECOVERY_UNAVAILABLE/);assert.equal(server.writes.length,1);
});

test('CLI exit classification fails closed for incomplete publication, pending reconciliation and identity failure',()=>{
 const good={operation:'publish',status:'complete',complete:true,scopeComplete:true,remainingIds:[],remainingPendingIds:[],finalIdentityVerified:true,results:[{id:'agent-fixture',status:'verified'}]};assert.equal(cliExitCode(good),0);
 for(const status of ['pending','not-dispatched','verified-with-index-drift','rejected','noop','unexpected'])assert.equal(cliExitCode({...good,results:[{status}]}),2);
 for(const status of ['pending','not-dispatched','index-drift','partial']){assert.equal(cliExitCode({...good,status,complete:false}),2);assert.equal(cliExitCode({...good,status}),2);}
 assert.equal(cliExitCode({...good,finalIdentityVerified:false}),2);assert.equal(cliExitCode({...good,results:[]}),2);assert.equal(cliExitCode({...good,complete:undefined}),2);
 assert.equal(cliExitCode({...good,remainingIds:['agent-unfinished']}),2);assert.equal(cliExitCode({...good,remainingPendingIds:['agent-pending']}),2);assert.equal(cliExitCode({...good,scopeComplete:false}),2);
 const reconciled={operation:'reconcile-read-only',status:'complete',complete:true,scopeComplete:true,remainingPendingIds:[],finalIdentityVerified:true,results:[{status:'no-pending'},{status:'verified'}]};assert.equal(cliExitCode(reconciled),0);assert.equal(cliExitCode({...reconciled,results:[{status:'pending'}]}),2);assert.equal(cliExitCode({...reconciled,finalIdentityVerified:false}),2);
 assert.equal(cliExitCode({webReleaseAllowed:false,status:'UNKNOWN'}),3);assert.equal(cliExitCode(null),2);
});

test('apply-release CLI reports nonzero after a rejected card while completing the other independent card',async()=>{
 const archive=store(),a=card(),b=card('agent-cli-independent'),p=await makePlan(archive,[a,b],[]),server=mockServer([],{rejectIds:[a.id]}),args=publishArgs(archive,p,[a,b],server,[a.id,b.id]),out=cliOutput();
 const code=await runCliMain(cliPublishArgs(args),{readLocal:args.readLocal,withOwner:async(_options,execute)=>execute(server.request)},out.io),result=JSON.parse(out.stdout[0]);
 assert.equal(code,2);assert.equal(result.status,'partial');assert.equal(result.complete,false);assert.deepEqual(result.results.map(r=>r.status),['rejected','verified']);assert.deepEqual(result.remainingIds,[a.id]);assert.deepEqual(server.writes,[b.id]);assert.equal(Object.keys(archive.load().pending).length,0);assert.deepEqual(out.stderr,[]);
});

test('CLI disconnect remains nonzero and a pending reconcile does not change journal or retry apply',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([],{disconnectAfterCommit:[a.id]}),args=publishArgs(archive,p,[a],server),out=cliOutput(),dependencies={readLocal:args.readLocal,withOwner:async(_options,execute)=>execute(server.request)};
 assert.equal(await runCliMain(cliPublishArgs(args),dependencies,out.io),2);assert.equal(JSON.parse(out.stdout[0]).status,'pending');const key=archive.load().pending[a.id].requestKey,receipt=server.receipts.get(key);server.receipts.delete(key);const prior=archive.load(),reconcile=['reconcile','--archive',archive.root,'--ids',archive.file('cli-ids.json'),'--authority',archive.file('cli-authority.json'),'--author',author,'--reason',reason],pendingOut=cliOutput();
 assert.equal(await runCliMain(reconcile,dependencies,pendingOut.io),2);assert.equal(JSON.parse(pendingOut.stdout[0]).complete,false);assert.equal(archive.load().head,prior.head);assert.equal(server.calls.filter(c=>c.body?.action==='apply').length,1);
 server.receipts.set(key,receipt);const confirmedOut=cliOutput();assert.equal(await runCliMain(reconcile,dependencies,confirmedOut.io),0);assert.equal(JSON.parse(confirmedOut.stdout[0]).complete,true);assert.equal(server.calls.filter(c=>c.body?.action==='apply').length,1);assert.equal(server.writes.length,1);
 const confirmedHead=archive.load().head,driftOut=cliOutput();let versions=0;const request=async req=>req.path==='/api/version'&&++versions===2?{status:200,body:{...authority.version,buildId:'changed-final-reconcile-build'}}:server.request(req);
 assert.equal(await runCliMain(reconcile,{...dependencies,withOwner:async(_options,execute)=>execute(request)},driftOut.io),2);assert.equal(JSON.parse(driftOut.stdout[0]).finalIdentityVerified,false);assert.equal(archive.load().head,confirmedHead);assert.equal(server.calls.filter(c=>c.body?.action==='apply').length,1);
});

test('CLI returns nonzero for index drift both before dispatch and after a known verified write',async()=>{
 for(const after of [false,true]){
  const archive=store(),a=card(),p=await makePlan(archive,[a],[]),extra=card('agent-cli-concurrent-extra'),server=mockServer([],after?{extraAfterWrite:extra}:{extraAfterPlan:extra}),args=publishArgs(archive,p,[a],server),out=cliOutput();
  assert.equal(await runCliMain(cliPublishArgs(args),{readLocal:args.readLocal,withOwner:async(_options,execute)=>execute(server.request)},out.io),2);const result=JSON.parse(out.stdout[0]);assert.equal(result.status,'index-drift');assert.equal(result.complete,false);assert.equal(result.results[0].status,after?'verified-with-index-drift':'not-dispatched');assert.equal(server.writes.length,after?1:0);assert.equal(Object.keys(archive.load().pending).length,0);
 }
});

test('CLI rejects a final identity failure after verification without replaying the acknowledged write',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([]),args=publishArgs(archive,p,[a],server),out=cliOutput();let postWriteVersions=0;
 const request=async req=>{if(req.path==='/api/version'&&server.writes.length&&++postWriteVersions===3)return {status:200,body:{...authority.version,buildId:'concurrent-final-build'}};return server.request(req);};
 assert.equal(await runCliMain(cliPublishArgs(args),{readLocal:args.readLocal,withOwner:async(_options,execute)=>execute(request)},out.io),2);const result=JSON.parse(out.stdout[0]);assert.equal(result.results[0].status,'verified');assert.equal(result.finalIdentityVerified,false);assert.equal(result.complete,false);assert.equal(result.status,'identity-unverified');assert.equal(server.writes.length,1);assert.equal(Object.keys(archive.load().pending).length,0);
});

test('CLI successful complete release and its receipt-only re-entry both exit zero',async()=>{
 const archive=store(),a=card(),p=await makePlan(archive,[a],[]),server=mockServer([]),args=publishArgs(archive,p,[a],server),argv=cliPublishArgs(args),dependencies={readLocal:args.readLocal,withOwner:async(_options,execute)=>execute(server.request)};
 for(let pass=0;pass<2;pass++){const out=cliOutput();assert.equal(await runCliMain(argv,dependencies,out.io),0);const result=JSON.parse(out.stdout[0]);assert.equal(result.complete,true);assert.equal(result.finalIdentityVerified,true);assert.equal(result.results[0].status,pass?'previously-verified':'verified');assert.deepEqual(result.remainingIds,[]);}
 assert.equal(server.writes.length,1);assert.equal(server.calls.filter(c=>c.body?.action==='apply').length,1);
});
