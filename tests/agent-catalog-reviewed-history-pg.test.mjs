import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), require=createRequire(path.join(project,'package.json'));
require('tsx/cjs/api').register({tsconfig:path.join(project,'tsconfig.json')});
const contract=require(path.join(project,'src/lib/server/agent-catalog-publication.ts'));
const {llmModelValidationConfigurationHash}=require(path.join(project,'src/lib/llm-model-validation-gate.ts'));
const modelId='97f7feee-08f8-4174-a918-770758ddf7d6',agentId='agent-1793171231055-r9qzu6',owner='b5cccb94-1d77-4e14-9391-fb3e6f823486',token='f'.repeat(64);
const realHash='8021c56dcd535c180a78b8060ba17a33eee5f75f53be6dc987a1b2cc559cdbac';
const bin=process.env.TEST_POSTGRES_BIN||(process.platform==='win32'?'F:/tools/zimeiti-local-data/postgresql-15.19/pgsql/bin':'');
const run=(name,args,input)=>spawnSync(bin?path.join(bin,name+(process.platform==='win32'?'.exe':'')):name,args,{encoding:'utf8',windowsHide:true,timeout:30000,input,env:{...process.env,PGCLIENTENCODING:'UTF8'}});
const quote=s=>"'"+String(s).replaceAll("'","''")+"'",json=v=>quote(JSON.stringify(v))+'::jsonb';
const migration=name=>fs.readFileSync(path.join(project,'supabase/migrations',name+'.sql'),'utf8');
function fieldType(k){
  if(['is_active','enable_think_tags','enable_web_search','token_billing_enabled','enable_knowledge_base','enable_memory'].includes(k))return 'boolean';
  if(['base_fee','cost_per_message','deduct_deep_think','max_context_rounds','max_context_tokens','max_reply_tokens','timeout','deep_thinking_type','sort_order','frequency_limit','token_rounding_unit','input_cost_per_million','output_cost_per_million','cached_cost_per_million','profit_margin','temperature'].includes(k))return 'numeric';
  if(['preset_fields','output_style'].includes(k))return 'jsonb';
  return k==='model_id'?'uuid':'text';
}
test('native reviewed-history activation and one-card promotion in isolated PostgreSQL',{skip:run('initdb',['--version']).status!==0&&'initdb unavailable'},async()=>{
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=String(socket.address().port);await new Promise(resolve=>socket.close(resolve));
  const tmp=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(tmp,'reviewed-text-pg-')),data=path.join(root,'data');
  const must=result=>{assert.equal(result.status,0,String(result.stderr||result.error).slice(0,1200));return result.stdout.trim();};
  const pg=(sql,error)=>{const r=run('psql',['-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],sql);
    if(!error)return must(r);assert.notEqual(r.status,0);assert.ok(r.stderr.includes(error),r.stderr.slice(0,1200));};
  let started=false;
  try{
    must(run('initdb',['-D',data,'-A','trust','-U','postgres','-E','UTF8','--no-locale','--no-sync']));
    must(run('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-o','-h 127.0.0.1 -p '+port,'-w','start']));started=true;
    assert.equal(fs.realpathSync(pg('SHOW data_directory')),fs.realpathSync(data));
    pg("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE TABLE users(id varchar(36) PRIMARY KEY,role text,is_active boolean,status text,created_at timestamptz,allowed_categories jsonb,updated_at timestamptz);INSERT INTO users VALUES("+quote(owner)+",'admin',true,'active',now(),'[]',now());"+
      "CREATE TABLE agents(id text PRIMARY KEY,"+contract.CATALOG_PUBLICATION_FIELDS.map(k=>k+' '+fieldType(k)).join(',')+",proxy_url text,bot_id text,coze_coding_api_token text,coze_coding_api_url text,coze_coding_project_id text,knowledge_base_id text,deleted_at timestamptz,updated_at timestamptz);"+
      "CREATE TABLE prompt_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agent_id text,prompt text,created_at timestamptz DEFAULT now());"+
      "CREATE TABLE llm_models(id uuid PRIMARY KEY,name text,model_name text,api_key text,api_endpoint text,proxy_url text,billing_mode text,token_billing_enabled boolean,input_cost_per_million numeric,output_cost_per_million numeric,cached_cost_per_million numeric,profit_margin numeric,max_context_rounds integer,max_context_tokens integer,max_reply_tokens integer,timeout integer,deep_thinking_type integer,enable_web_search boolean,api_protocol_config jsonb,is_active boolean,is_hidden boolean,user_access text,updated_at timestamptz);"+
      "CREATE TABLE categories(id text,name text,is_active boolean,visibility text);CREATE TABLE user_files(user_id text,storage_key text,file_category text,meta jsonb);CREATE TABLE agent_skills(agent_id text);CREATE TABLE agent_skill_installations(agent_id text);"+
      "CREATE TABLE model_pool_config_releases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),is_current boolean,status text,snapshot jsonb);CREATE UNIQUE INDEX one_current ON model_pool_config_releases(is_current) WHERE is_current;"+
      "CREATE TABLE platform_model_credential_bindings(model_key text UNIQUE,credential_ref text UNIQUE,secret_value text);CREATE TABLE llm_model_validation_evidence(model_id uuid,configuration_hash text,checked_at timestamptz);");
    for(const name of ['20261001221000_super_admin_governance','20261005183000_admin_step_up_maintenance_lock','20261010123000_shared_agent_config_revision','20261001003000_member_permission_snapshots','20261001010000_admin_business_permissions','20261103010000_agent_catalog_publications'])pg(migration(name));
    const reg="'public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb)'::regprocedure";
    const identity=()=>pg("SELECT jsonb_build_array(oid,proowner,proacl,proconfig,prosecdef) FROM pg_proc WHERE oid="+reg);
    const initial=identity();
    // Use the release driver's wire behavior. psql normalizes CRLF before PostgreSQL sees a dollar-quoted span.
    const client=new (require('pg').Client)({host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres'});
    await client.connect();
    try{await client.query(migration('20261104010000_reviewed_text_history').replace(/\r?\n/g,'\r\n'));}finally{await client.end();}
    assert.equal(identity(),initial);
    pg("GRANT SELECT,UPDATE,INSERT ON agents,llm_models,prompt_versions,model_pool_config_releases,llm_model_validation_evidence,categories,user_files TO service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON agent_skills,agent_skill_installations TO service_role;GRANT SELECT ON platform_model_credential_bindings TO service_role;");
    assert.equal(pg("SELECT has_table_privilege('service_role','admin_governance_audit','UPDATE') OR has_table_privilege('service_role','platform_model_credential_bindings','UPDATE')"),'f');
    for(const role of ['anon','authenticated'])assert.equal(pg("SELECT has_function_privilege("+quote(role)+",'public.activate_reviewed_deepseek_history_v1(text,text,uuid,text,text,text)','EXECUTE')"),'f');
    const permissions=['agents.manage','prompts.view','prompts.edit','models.manage','internal_tools.manage','backups.manage'];
    pg("SELECT create_admin_step_up_session("+quote(owner)+","+quote(token)+","+json(permissions)+",1,'login_password','','',now()+interval '10 minutes')");
    const fakeSecret='isolated-synthetic-credential', fakeTime=new Date(Date.now()-3600000).toISOString();
    const model={id:modelId,name:'fixture',model_name:'deepseek-flash',api_key:fakeSecret,api_endpoint:'https://api.deepseek.com/',billing_mode:'token',api_protocol_config:{protocol:'openai_chat',provider:'deepseek_official',auth_scheme:'bearer',connection_group:'test'},is_active:true,is_hidden:false,user_access:'pending_model_activation'};
    const fixtureHash=llmModelValidationConfigurationHash({...Object.fromEntries(['max_context_rounds','max_context_tokens','max_reply_tokens','timeout','deep_thinking_type','input_cost_per_million','output_cost_per_million','cached_cost_per_million','profit_margin'].map(k=>[k,null])),...model},fakeSecret);
    pg("INSERT INTO llm_models SELECT * FROM jsonb_populate_record(NULL::llm_models,"+json(model)+");INSERT INTO categories VALUES('public','marketing',true,'normal');"+
      "INSERT INTO platform_model_credential_bindings VALUES("+[ 'llm_models:'+modelId,'secret://platform-model/llm_models/'+modelId,fakeSecret ].map(quote).join(',')+");"+
      "INSERT INTO model_pool_config_releases(is_current,status,snapshot) VALUES(true,'published',"+json({models:[{kind:'agent',catalogState:'enabled',id:'llm:'+modelId,modelName:'deepseek-flash',provider:'deepseek_official',protocol:'openai_chat',endpoint:model.api_endpoint,configuration:{legacyTable:'llm_models',legacyId:modelId,protocolConfig:model.api_protocol_config},credentialRef:'secret://platform-model/llm_models/'+modelId}]})+");");
    const version=()=>pg("SELECT xmin::text FROM llm_models WHERE id="+quote(modelId));
    const activate=(hash,rev=version(),step=token,actor=owner)=>"SET ROLE service_role;SELECT activate_reviewed_deepseek_history_v1("+[actor,step,modelId,agentId,hash,rev].map(quote).join(',')+")";
    pg(activate(realHash),'CATALOG_CURRENT_MODEL');pg(activate(fixtureHash),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    // Only the isolated fixture substitutes its own binding fingerprint and business timestamp. The real migration above rejects the fixture credential.
    const helper="'public.lock_reviewed_deepseek_history_v1(text,uuid,text,text,text)'::regprocedure",shipped=pg('SELECT pg_get_functiondef('+helper+')');
    assert.equal(shipped.split(realHash).length,2);assert.equal(shipped.split('2026-11-02T18:18:19.863Z').length,3);
    pg(shipped.replaceAll(realHash,fixtureHash).replaceAll('2026-11-02T18:18:19.863Z',fakeTime));
    pg(activate(fixtureHash,'0'),'CATALOG_CURRENT_MODEL_REQUIRED');pg(activate(fixtureHash,version(),'e'.repeat(64)),'CATALOG_STEP_UP_REQUIRED');
    pg("UPDATE platform_model_credential_bindings SET secret_value='changed'");pg(activate(fixtureHash),'CATALOG_CURRENT_MODEL_REQUIRED');
    pg("UPDATE platform_model_credential_bindings SET secret_value="+quote(fakeSecret));
    pg("UPDATE model_pool_config_releases SET snapshot=jsonb_set(snapshot,'{models,0,provider}',to_jsonb('wrong'::text))");pg(activate(fixtureHash),'CATALOG_CURRENT_MODEL_REQUIRED');
    pg("UPDATE model_pool_config_releases SET snapshot=jsonb_set(snapshot,'{models,0,provider}',to_jsonb('deepseek_official'::text))");
    pg("CREATE FUNCTION refuse_adoption() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'REFUSED_TEST_AUDIT';END;$$;CREATE TRIGGER refuse BEFORE INSERT ON admin_governance_audit FOR EACH ROW EXECUTE FUNCTION refuse_adoption();");
    pg(activate(fixtureHash),'REFUSED_TEST_AUDIT');assert.equal(pg('SELECT user_access FROM llm_models'),'pending_model_activation');
    pg('DROP TRIGGER refuse ON admin_governance_audit');const accepted=JSON.parse(pg(activate(fixtureHash)));
    assert.equal(accepted.idempotent,false);assert.equal(accepted.acceptance.checkedAt,fakeTime);
    assert.equal(JSON.parse(pg(activate(fixtureHash))).acceptance.id,accepted.acceptance.id);
    assert.equal(pg("SELECT count(*) FROM admin_governance_audit WHERE action='accept_reviewed_text_history'"),'1');assert.equal(pg("SELECT count(*) FROM llm_model_validation_evidence"),'0');
    pg("INSERT INTO agents(id,name,category,source,model,is_active,user_access,system_prompt) VALUES("+quote(agentId)+",'fixture','marketing','llm','',false,'view_only','fixture prompt')");
    const current=JSON.parse(pg("SELECT read_agent_catalog_publication_v1("+quote(agentId)+")"));
    const fields={...current.fields,is_active:true,user_access:'available',model_id:modelId,model:'deepseek-flash'};
    const admission={auditId:accepted.acceptance.id,source:accepted.acceptance.source,checkedAt:accepted.acceptance.checkedAt,auditCreatedAt:accepted.acceptance.auditCreatedAt};
    const request={action:'plan',requestKey:randomUUID(),source:{id:agentId,revision:7,fields,sourceHash:contract.publicationHash(fields)},baseline:{revision:current.revision,hash:contract.publicationHash(current.fields)},audience:'source',lifecycle:'executable',stripPortability:[]};
    const plan=contract.makePublicationPlan(request,current,fields,[],{previous:{visibility:'normal'},target:{visibility:'normal'}});
    plan.reviewedModelAdmission=admission;plan.planHash=contract.publicationHash({fieldsPlan:plan.planHash,modelVersion:version(),validatedAt:fakeTime,reviewedModelAdmission:admission});
    const proof={rowVersion:version(),configurationHash:fixtureHash,checkedAt:fakeTime,reviewedModelAdmission:admission};
    const apply=(p,f,pr)=>"SET ROLE service_role;SELECT apply_agent_catalog_publication_v1("+quote(owner)+","+quote(token)+","+json(p)+","+json(f)+","+quote(current.rowDigest)+","+json(pr)+")";
    pg(apply(plan,fields,{...proof,reviewedModelAdmission:{...admission,auditId:randomUUID()}}),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    pg(apply(plan,fields,{...proof,checkedAt:new Date().toISOString()}),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    const extra={...admission,unverified:true};pg(apply({...plan,reviewedModelAdmission:extra},fields,{...proof,reviewedModelAdmission:extra}),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    pg(apply(plan,fields,{...proof,configurationHash:realHash}),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    pg(apply({...plan,baseline:{...plan.baseline,revision:99}},fields,proof),'CATALOG_PRODUCTION_BASELINE_CONFLICT');
    const done=JSON.parse(pg(apply(plan,fields,proof)));assert.equal(done.receipt.revision,current.revision+1);assert.deepEqual(done.receipt.reviewedModelAdmission,admission);
    assert.equal(JSON.parse(pg(apply(plan,fields,proof))).replayed,true);assert.equal(pg("SELECT count(*) FROM llm_model_validation_evidence"),'0');

    // Test the shipped r2 hash veto first. Substitute only these two hashes in the disposable instance.
    const legacyId='705eab71-df2d-4e4d-ab1d-ab2de6cc8ddd';
    const registeredR2={id:agentId,config_revision:2,name:'fixture',category:'marketing',source:'llm',
      model:'deepseek-v4-flash',model_id:legacyId,is_active:false,user_access:'view_only',system_prompt:'fixture prompt',proxy_url:'https://api.deepseek.com'};
    const seedR2=(overrides={})=>pg("DELETE FROM agents WHERE id="+quote(agentId)+";INSERT INTO agents SELECT * FROM jsonb_populate_record(NULL::agents,"+json({...registeredR2,...overrides})+")");
    seedR2();
    const old=JSON.parse(pg("SELECT read_agent_catalog_publication_v1("+quote(agentId)+")"));
    const next={...old.fields,is_active:true,user_access:'available',model_id:modelId,model:'deepseek-flash'};
    const oldHash=contract.publicationHash(old.fields),nextHash=contract.publicationHash(next);
    const r2Request={...request,requestKey:randomUUID(),source:{...request.source,fields:next,sourceHash:nextHash},baseline:{revision:2,hash:oldHash}};
    const r2Plan=contract.makePublicationPlan(r2Request,old,next,[],{previous:{visibility:'normal'},target:{visibility:'normal'}});
    r2Plan.reviewedModelAdmission=admission;r2Plan.planHash=contract.publicationHash({fieldsPlan:r2Plan.planHash,modelVersion:version(),validatedAt:fakeTime,reviewedModelAdmission:admission});
    const executeR2=(plan=r2Plan,values=next,modelProof=proof,digest=old.rowDigest)=>
      "SET ROLE service_role;SELECT apply_agent_catalog_publication_v1("+[quote(owner),quote(token),json(plan),json(values),quote(digest),json(modelProof)].join(',')+")";
    const refused='CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW';
    pg(executeR2(),refused);
    const native=pg('SELECT pg_get_functiondef('+reg+')');
    const beforeR2='e4a1cb0a4f0c7360e597f9ce0b200c51bfc200b9bbd5730ef1933e7fa02d64e0';
    const afterR2='ff7387aa0c1ab87aecd885f84c546ebd6499b49da2967f7ade0bb2c11f49c027';
    assert.equal(native.split(beforeR2).length,2);assert.equal(native.split(afterR2).length,2);
    pg(native.replace(beforeR2,oldHash).replace(afterR2,nextHash));
    assert.equal(identity(),initial);
    const plainProof={rowVersion:proof.rowVersion,configurationHash:fixtureHash,checkedAt:fakeTime};
    pg("INSERT INTO llm_model_validation_evidence VALUES("+[modelId,fixtureHash,fakeTime].map(quote).join(',')+")");
    pg(executeR2(r2Plan,next,plainProof),refused);
    const {reviewedModelAdmission:unusedAdmission,...plainPlan}=r2Plan;
    pg(executeR2(plainPlan),refused);
    pg("DELETE FROM llm_model_validation_evidence");
    pg(executeR2({...r2Plan,sourceHash:'a'.repeat(64)}),refused);
    pg(executeR2(r2Plan,next,{...proof,reviewedModelAdmission:{...admission,auditId:randomUUID()}}),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    pg(executeR2(r2Plan,next,{...proof,checkedAt:new Date().toISOString()}),'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED');
    pg(executeR2(r2Plan,next,{...proof,rowVersion:'0'}),'CATALOG_CURRENT_MODEL_REQUIRED');
    pg(executeR2(r2Plan,next,proof,'0'.repeat(64)),'CATALOG_PRODUCTION_BASELINE_CONFLICT');
    pg(executeR2({...r2Plan,targetHash:contract.publicationHash({...next,cost_per_message:4})},{...next,cost_per_message:4}),refused);
    for(const proxy of ['https://user@api.deepseek.com','https://api.deepseek.com/v1','https://api.deepseek.com/?q=1','https://api.deepseek.com.evil.invalid','https://api.deepseek.com//','']){
      seedR2({proxy_url:proxy});pg(executeR2(),refused);
    }
    for(const k of ['bot_id','coze_coding_api_token','coze_coding_api_url','coze_coding_project_id','knowledge_base_id']){
      seedR2({[k]:'fixture-private-channel'});pg(executeR2(),refused);
    }
    seedR2({config_revision:3});pg(executeR2(),'CATALOG_PRODUCTION_BASELINE_CONFLICT');
    seedR2();
    for(const table of ['agent_skills','agent_skill_installations']){
      pg("INSERT INTO "+table+" VALUES("+quote(agentId)+")");pg(executeR2(),refused);pg("DELETE FROM "+table+" WHERE agent_id="+quote(agentId));
    }
    const beforePrompts=pg("SELECT count(*) FROM prompt_versions WHERE agent_id="+quote(agentId));
    const {Client}=require('pg');
    const cfg={host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres'};
    const publisher=new Client(cfg),writer=new Client(cfg);
    const applySql=executeR2().replace(/^SET ROLE service_role;/,'');
    const relationTables=['agent_skill_installations','agent_skills'];
    const snapshot=()=>pg("SELECT config_revision||':'||coalesce(model_id::text,'')||':'||(SELECT count(*) FROM admin_governance_audit) FROM agents WHERE id="+quote(agentId));
    let r2Done;
    await publisher.connect();await writer.connect();
    try{
      await publisher.query("SET ROLE service_role;SET statement_timeout='4s'");
      await writer.query("SET ROLE service_role;SET lock_timeout='200ms'");
      const original=snapshot();
      // Each pending insertion or deletion already holds RowExclusiveLock on its relation.
      for(const table of relationTables){
        for(const action of ['INSERT','DELETE']){
          if(action==='DELETE')await writer.query("INSERT INTO "+table+" VALUES ($1)",[agentId]);
          await writer.query('BEGIN');
          if(action==='INSERT')await writer.query("INSERT INTO "+table+" VALUES ($1)",[agentId]);
          else await writer.query("DELETE FROM "+table+" WHERE agent_id=$1",[agentId]);
          await assert.rejects(publisher.query(applySql),error=>error.code==='55P03'&&error.message==='CATALOG_SKILL_RELATION_BUSY');
          assert.equal(snapshot(),original);
          await writer.query('ROLLBACK');
          if(action==='DELETE')await writer.query("DELETE FROM "+table+" WHERE agent_id=$1",[agentId]);
        }
      }
      // Even after the writer commits, a repeatable-read transaction can retain an older snapshot of the relationships.
      await publisher.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await publisher.query('SELECT count(*) FROM agent_skills');
      await writer.query('INSERT INTO agent_skills VALUES ($1)',[agentId]);
      await assert.rejects(publisher.query(applySql),error=>error.message==='CATALOG_R2_FRESH_SKILL_SNAPSHOT_REQUIRED');
      await publisher.query('ROLLBACK');
      await assert.rejects(publisher.query(applySql),error=>error.message===refused);
      assert.equal(snapshot(),original);
      await writer.query('DELETE FROM agent_skills WHERE agent_id=$1',[agentId]);

      await publisher.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      r2Done=(await publisher.query(applySql)).rows[0].apply_agent_catalog_publication_v1;
      for(const table of relationTables){
        const locks=await publisher.query("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation=$1::regclass AND mode='ShareLock' AND granted",[table]);
        assert.equal(locks.rowCount,1);
        await assert.rejects(writer.query("INSERT INTO "+table+" VALUES ($1)",[agentId]),error=>error.code==='55P03'&&error.message.includes('lock timeout'));
      }
      await publisher.query('COMMIT');
      for(const table of relationTables){
        assert.equal((await writer.query("INSERT INTO "+table+" VALUES ($1)",[agentId])).rowCount,1);
        assert.equal((await writer.query("DELETE FROM "+table+" WHERE agent_id=$1",[agentId])).rowCount,1);
      }
    }finally{
      await Promise.allSettled([publisher.end(),writer.end()]);
    }
    assert.equal(r2Done.receipt.revision,3);assert.deepEqual(r2Done.receipt.reviewedModelAdmission,admission);
    assert.equal(JSON.parse(pg(executeR2())).replayed,true);
    assert.equal(pg("SELECT count(*) FROM prompt_versions WHERE agent_id="+quote(agentId)),beforePrompts);
    assert.equal(pg("SELECT count(*) FROM llm_model_validation_evidence"),'0');
    assert.equal(pg("SELECT proxy_url FROM agents WHERE id="+quote(agentId)),registeredR2.proxy_url);
  }finally{
    if(started)must(run('pg_ctl',['-D',data,'-m','fast','-w','stop']));
    assert.equal(path.dirname(fs.realpathSync(root)),tmp);assert.ok(path.basename(root).startsWith('reviewed-text-pg-'));fs.rmSync(root,{recursive:true,force:true});
  }
});
