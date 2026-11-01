#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {readDatabaseTargetIdentity} from './lib/database-target-identity.mjs';
import {computeLocalBuildFingerprint} from './local-build-fingerprint.mjs';

const ORIGIN='http://127.0.0.1:5000';
const SOURCE='agent-1785658026345-k6yy99';
const F182='f182534099e8496efcf791f5ff09470500b0d3d320ad801992056f183a32ca35';
const PROMPT='Synthetic administrative prompt-target persistence acceptance only. Never call a provider or use this hidden inactive agent.';
const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'):JSON.stringify(value);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const style=target=>({storyboardPromptHandoff:{enabled:target==='storyboard-workbench',target},fixtureSentinel:{kind:'prompt-target-persistence',nested:{keep:['alpha','beta'],enabled:false}},unrelated_display_label:'Synthetic only'});
function assertDBURL(raw){const u=new URL(raw);assert.ok(['postgres:','postgresql:'].includes(u.protocol));assert.equal(u.search,'');assert.equal(u.hash,'');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'54322');assert.equal(u.pathname,'/zimeiti_local');return u;}
function assertOwned(row,owned){assert.ok(row&&row.id===owned.id&&row.name===owned.name);assert.equal(row.system_prompt,PROMPT);assert.equal(row.model_id,owned.model);assert.equal(row.category,owned.category);assert.equal(row.is_active,false);assert.equal(row.user_access,'hidden');assert.ok(Number.isSafeInteger(row.config_revision)&&row.config_revision>=1);}
function stable(row){return {system_prompt:row.system_prompt,model_id:row.model_id,model:row.model,source:row.source,category:row.category,is_active:row.is_active,user_access:row.user_access};}
function assertMutation(method,body,owned){
 if(method==='POST'){assert.equal(body.name,owned.name);assert.equal(body.system_prompt,PROMPT);assert.equal(body.model_id,owned.model);assert.equal(body.category,owned.category);assert.equal(body.is_active,false);assert.equal(body.user_access,'hidden');assert.deepEqual(Object.keys(body).sort(),['category','is_active','model_id','name','output_style','source','system_prompt','user_access'].sort());return;}
 assert.ok(owned.id);assert.equal(body.agentId,owned.id);assert.ok(Number.isSafeInteger(body.expected_revision)&&body.expected_revision>=1);
 assert.deepEqual(Object.keys(body).sort(),(method==='PUT'?['agentId','expected_revision','output_style']:['agentId','expected_revision']).sort());
}
async function runtime(expectedBuild,expectedFingerprint){
 assert.ok(expectedBuild&&/^[a-f0-9]{64}$/u.test(expectedFingerprint||''),'EXPLICIT_RUNTIME_PINS_REQUIRED');
 const response=await fetch(ORIGIN+'/api/version',{redirect:'error',signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);
 const live=await response.json(),receipt=JSON.parse(await fs.readFile('.next/local-source-fingerprint.v1.json','utf8'));
 assert.equal(live.buildId,expectedBuild);assert.equal((await fs.readFile('.next/BUILD_ID','utf8')).trim(),expectedBuild);assert.equal(receipt.buildId,expectedBuild);assert.equal(receipt.fingerprint,expectedFingerprint);assert.equal(computeLocalBuildFingerprint(process.cwd()).fingerprint,expectedFingerprint);
 return {buildId:expectedBuild,fingerprint:expectedFingerprint,sourceVersion:live.sourceVersion,runningLatest:true};
}
async function databaseIdentity(){
 const u=assertDBURL(process.env.DATABASE_URL);const client=new pg.Client({connectionString:u.toString(),options:'-c default_transaction_read_only=on',application_name:'codex-agent-target-readonly'});
 try{await client.connect();await client.query('BEGIN READ ONLY');assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');const identity=await readDatabaseTargetIdentity(client,u.hostname);assert.equal(identity.fingerprint,F182);await client.query('ROLLBACK');return {fingerprint:identity.fingerprint};}finally{await client.end();}
}
export async function selftest(){
 const owned={id:'agent-fixture-owned',name:'prompt-target-acceptance-test',model:'model-fixture',category:'fixture'};
 const row={id:owned.id,name:owned.name,model_id:owned.model,category:owned.category,system_prompt:PROMPT,is_active:false,user_access:'hidden',config_revision:1,output_style:style('video')};
 assertDBURL('postgres://fixture@127.0.0.1:54322/zimeiti_local');assertOwned(row,owned);
 let negatives=0;for(const url of ['postgres://fixture@example.invalid:54322/zimeiti_local','postgres://fixture@127.0.0.1:5432/zimeiti_local','postgres://fixture@127.0.0.1:54322/other','postgres://fixture@127.0.0.1:54322/zimeiti_local?host=example.invalid','postgres://fixture@127.0.0.1:54322/zimeiti_local?port=5432','postgres://fixture@127.0.0.1:54322/zimeiti_local?options=-csearch_path=other','postgres://fixture@127.0.0.1:54322/zimeiti_local#fragment','http://127.0.0.1:54322/zimeiti_local']){assert.throws(()=>assertDBURL(url));negatives++;}
 for(const patch of [{id:SOURCE},{name:'stable'},{system_prompt:'changed'},{model_id:'other'},{category:'other'},{is_active:true},{user_access:'available'},{config_revision:0}]){assert.throws(()=>assertOwned({...row,...patch},owned));negatives++;}
 const create={name:owned.name,model_id:owned.model,category:owned.category,system_prompt:PROMPT,is_active:false,user_access:'hidden',source:'llm',output_style:style('video')};assertMutation('POST',create,owned);
 for(const patch of [{avatar:'forbidden'},{credential_source_agent_id:SOURCE},{cost_per_message:0},{is_active:true}]){assert.throws(()=>assertMutation('POST',{...create,...patch},owned));negatives++;}
 assertMutation('PUT',{agentId:owned.id,expected_revision:1,output_style:style('storyboard-workbench')},owned);
 assertMutation('DELETE',{agentId:owned.id,expected_revision:2},owned);
 for(const body of [{agentId:SOURCE,expected_revision:2},{agentId:owned.id,expected_revision:2,permanent:true},{agentId:owned.id,expected_revision:0}]){assert.throws(()=>assertMutation('DELETE',body,owned));negatives++;}
 assert.deepEqual(style('video').fixtureSentinel,style('storyboard-workbench').fixtureSentinel);assert.equal(hash(stable(row)),hash(stable({...row,output_style:style('storyboard-workbench')})));
 return {passed:true,negatives,networkCalls:0,databaseWrites:0,providerCalls:0};
}
export async function main(args=[]){
 assert.ok(args.every(x=>['--plan','--execute','--self-test'].includes(x)),'UNSUPPORTED_ARGUMENT');assert.ok(new Set(args).size===args.length,'DUPLICATE_ARGUMENT');assert.ok(args.length<=1,'ONE_MODE_REQUIRED');
 if(args[0]==='--self-test'){const result=await selftest();console.log(JSON.stringify(result));return result;}
 if(args[0]!=='--execute'){const result={mode:'plan',executed:false,sourceId:SOURCE,origin:ORIGIN,workflow:['F182 readonly identity + exact current runtime','read source id/model_id/category only','single POST hidden inactive synthetic agent','REST own-row readback + admin metadata GET','single PUT target video→storyboard with expected_revision','stale409 / invalid400 and unchanged persisted revision','single formal soft DELETE with fresh owned revision','REST and trash GET retired-with-audit readback'],retained:'one soft-deleted owned agent and legitimate prompt/admin audit; no hard delete',requiredEnv:['ROOT_AGENT_PROMPT_TARGET_EXECUTE=1','AGENT_TARGET_EXPECTED_BUILD_ID','AGENT_TARGET_EXPECTED_FINGERPRINT','LOCAL_NAV_ADMIN_TOKEN','LOCAL_ADMIN_STEP_UP_TOKEN','DATABASE_URL','SHARED_CONFIGURATION_SUPABASE_URL','SHARED_CONFIGURATION_SERVICE_ROLE_KEY'],providerCalls:0,businessWrites:0};console.log(JSON.stringify(result,null,2));return result;}
 assert.equal(process.env.ROOT_AGENT_PROMPT_TARGET_EXECUTE,'1','ROOT_EXPLICIT_FIXTURE_AUTHORIZATION_REQUIRED');assert.equal(process.env.LOCAL_NAV_ORIGIN,ORIGIN,'EXACT_LOOPBACK_ORIGIN_REQUIRED');
 const token=process.env.LOCAL_NAV_ADMIN_TOKEN,step=process.env.LOCAL_ADMIN_STEP_UP_TOKEN,service=process.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY;
 assert.ok(token&&step&&service,'CONTROLLED_SESSION_STEPUP_SERVICE_ENV_REQUIRED');const rest=new URL(process.env.SHARED_CONFIGURATION_SUPABASE_URL);assert.equal(rest.origin,'http://127.0.0.1:54321');
 const runId=randomUUID(),owned={name:'prompt-target-acceptance-'+runId,id:null,model:null,category:null};
 const output=path.resolve('.codex-evidence/agent-prompt-target-persistence',runId);await fs.mkdir(output,{recursive:true});
 const report={runId,kind:'actual-local-owned-agent-target-persistence',passed:false,providerCalls:0,walletOperations:0,events:[],unknownOutcome:false,retiredWithAudit:false,recoveryRequired:false,ownNameSha256:hash(owned.name)};
 let queue=Promise.resolve(),lastKnown=null;
 const checkpoint=()=>{const bytes=JSON.stringify(report,null,2);queue=queue.then(async()=>{const temp=path.join(output,'.journal-'+randomUUID());const file=await fs.open(temp,'wx');try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await fs.rename(temp,path.join(output,'report.json'));});return queue;};
 const rows=async(query)=>{const u=new URL('/rest/v1/agents',rest);for(const[k,v]of Object.entries(query))u.searchParams.set(k,v);const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service},redirect:'error',signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const body=await r.json();assert.ok(Array.isArray(body));return body;};
 const ownRow=async()=>{assert.ok(owned.id);const result=await rows({select:'id,name,system_prompt,model_id,model,source,category,output_style,is_active,user_access,deleted_at,config_revision',id:'eq.'+owned.id});assert.equal(result.length,1);assertOwned(result[0],owned);return result[0];};
 const api=async(method,body,phase,expectedStatus=200)=>{
   const event={phase,method,dispatched:false,status:null};report.events.push(event);if(method!=='GET'){assert.equal(report.unknownOutcome,false);assertMutation(method,body,owned);}
   await checkpoint();event.dispatched=true;event.outcome='pending';if(method!=='GET'){report.pendingMutation=phase;report.recoveryRequired=true;}await checkpoint();
   let response,data;try{response=await fetch(ORIGIN+'/api/admin/agents'+(method==='GET'?'?include_internal=1'+(phase==='trash-readback'?'&trash=1':''):''),{method,headers:{Authorization:'Bearer '+token,'x-admin-step-up':step,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});event.status=response.status;data=await response.json();}
   catch{if(method!=='GET')report.unknownOutcome=true;await checkpoint();throw Error('AGENT_TARGET_TRANSPORT_UNKNOWN');}
   if(method!=='GET'&&response.status>=500){report.unknownOutcome=true;await checkpoint();throw Error('AGENT_TARGET_SERVER_OUTCOME_UNKNOWN');}
   event.outcome='known';if(method!=='GET')report.pendingMutation=null;await checkpoint();assert.equal(response.status,expectedStatus,'AGENT_TARGET_HTTP_CONTRACT_FAILED');return data;
 };
 try{
   report.database=await databaseIdentity();report.runtimeBefore=await runtime(process.env.AGENT_TARGET_EXPECTED_BUILD_ID,process.env.AGENT_TARGET_EXPECTED_FINGERPRINT);await checkpoint();
   const source=await rows({select:'id,model_id,category',id:'eq.'+SOURCE});assert.equal(source.length,1);assert.ok(source[0].model_id&&source[0].category);owned.model=source[0].model_id;owned.category=source[0].category;report.sourceBindingSha256=hash(source[0]);
   assert.equal((await rows({select:'id',name:'eq.'+owned.name})).length,0);
   const created=await api('POST',{name:owned.name,model_id:owned.model,category:owned.category,source:'llm',system_prompt:PROMPT,is_active:false,user_access:'hidden',output_style:style('video')},'create');
   if(created?.success!==true||typeof created.agent?.id!=='string'){report.unknownOutcome=true;throw Error('AGENT_TARGET_CREATE_RECEIPT_UNKNOWN');}owned.id=created.agent.id;report.ownId=owned.id;await checkpoint();
   const baseline=await ownRow();assert.equal(baseline.deleted_at,null);assert.deepEqual(baseline.output_style,style('video'));lastKnown=baseline;report.createdRevision=baseline.config_revision;report.promptSha256=hash(baseline.system_prompt);report.stableFieldsSha256=hash(stable(baseline));
   const listed=await api('GET',null,'admin-list-readback');assert.ok(Array.isArray(listed.agents)&&listed.agents.some(x=>x.id===owned.id&&x.is_active===false&&x.user_access==='hidden'));
   const updated=await api('PUT',{agentId:owned.id,expected_revision:baseline.config_revision,output_style:style('storyboard-workbench')},'update-target');assert.equal(updated.success,true);
   const changed=await ownRow();assert.equal(changed.config_revision,baseline.config_revision+1);assert.deepEqual(stable(changed),stable(baseline));assert.deepEqual(changed.output_style,style('storyboard-workbench'));lastKnown=changed;report.updatedRevision=changed.config_revision;
   const stale=await api('PUT',{agentId:owned.id,expected_revision:baseline.config_revision,output_style:style('video')},'stale-revision-negative',409);assert.equal(stale.code,'AGENT_CONFIG_REVISION_CONFLICT');assert.deepEqual(await ownRow(),changed);
   const invalid=await api('PUT',{agentId:owned.id,expected_revision:changed.config_revision,output_style:{...style('video'),storyboardPromptHandoff:{target:'forbidden-fixture-target'}}},'invalid-target-negative',400);assert.equal(invalid.code,'AGENT_PROMPT_PUSH_TARGET_INVALID');assert.deepEqual(await ownRow(),changed);
   const sourceAfter=await rows({select:'id,model_id,category',id:'eq.'+SOURCE});assert.deepEqual(sourceAfter,source);report.sourceBindingUnchanged=true;
 }catch{report.failureCode='AGENT_PROMPT_TARGET_ACCEPTANCE_FAILED';}
 finally{
   try{
     if(report.unknownOutcome){if(!owned.id){const discovered=await rows({select:'id,name,system_prompt,model_id,category,is_active,user_access,config_revision',name:'eq.'+owned.name});if(discovered.length===1){owned.id=discovered[0].id;assertOwned(discovered[0],owned);report.discoveredOwnId=owned.id;}}report.recoveryRequired=true;}
     else if(owned.id&&lastKnown){const fresh=await ownRow();assert.deepEqual(fresh,lastKnown);assert.equal(fresh.deleted_at,null);const deleted=await api('DELETE',{agentId:owned.id,expected_revision:fresh.config_revision},'soft-retire');assert.equal(deleted.success,true);const retired=await ownRow();assert.ok(retired.deleted_at);assert.equal(retired.config_revision,fresh.config_revision+1);assert.deepEqual(stable(retired),stable(fresh));assert.deepEqual(retired.output_style,fresh.output_style);const trash=await api('GET',null,'trash-readback');assert.ok(trash.agents?.some(x=>x.id===owned.id&&x.deleted_at));report.retiredWithAudit=true;report.finalRevision=retired.config_revision;report.retainedAgentSha256=hash(retired);}
     else if(owned.id)report.recoveryRequired=true;
     report.runtimeAfter=await runtime(process.env.AGENT_TARGET_EXPECTED_BUILD_ID,process.env.AGENT_TARGET_EXPECTED_FINGERPRINT);assert.deepEqual(report.runtimeAfter,report.runtimeBefore);report.passed=!report.failureCode&&!report.unknownOutcome&&report.retiredWithAudit;report.recoveryRequired=report.unknownOutcome||Boolean(report.pendingMutation)||!!owned.id&&!report.retiredWithAudit;
   }catch{report.recoveryRequired=true;report.cleanupCode='AGENT_TARGET_RECOVERY_REQUIRED';}
   await checkpoint();
 }
 console.log(JSON.stringify({passed:report.passed,output,ownId:report.ownId,retiredWithAudit:report.retiredWithAudit,recoveryRequired:report.recoveryRequired}));if(!report.passed)process.exitCode=1;return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(()=>{console.error('AGENT_PROMPT_TARGET_SCRIPT_FAILED');process.exitCode=1;});
