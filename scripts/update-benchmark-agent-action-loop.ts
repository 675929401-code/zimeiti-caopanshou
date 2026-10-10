import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from 'pg';

import {BIP_CONFIGS} from '../src/lib/business-ip/prompts';
import {BENCHMARK_ACTION_REVISION} from '../src/lib/business-ip/followup-roles';

const TARGET_ID='agent-1787163731976-5xntwm';
const EXPECTED_BASELINE_PROMPT_SHAS=[
 'bbedc564c4c68d6c5de10fdbb37d38d7a5d8c876e86b94ac9bd5e039f9bd6acf',
 '6ebfd4bf7bd79b46e49e71ca7b933d4b19ddf05f9282931bbe244f3c32d18448',
];
const CONFIRM_FLAG='--confirm-local-only-benchmark-agent';
const EVIDENCE_KEY='benchmark-action-loop-20260928';
const FIELDS='id,name,description,system_prompt,guide_message,preset_fields,category,sort_order,model,model_id,max_reply_tokens,temperature,is_active,user_access,deleted_at,config_revision,updated_at';

const sha256=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');

async function main(){
 const apply=process.argv.includes('--apply');
 if(apply)assert.ok(process.argv.includes(CONFIRM_FLAG),`本地写入必须同时传入 ${CONFIRM_FLAG}`);

 const config=BIP_CONFIGS.find(candidate=>candidate.id===TARGET_ID);
 assert.ok(config,'源码中缺少对标账号拆解配置');
 assert.equal(config.name,'对标账号拆解','目标智能体名称漂移');
 assert.match(config.system_prompt,/【用户迷茫时主动带路】/u);
 assert.match(config.system_prompt,/BENCHMARK-ACTION-PACK v1/u);

 const projectRoot=path.resolve('.');
 const storageRoot=path.resolve('../../..');
 const runtimePath=path.join(storageRoot,'运行数据/自媒体操盘手/local-data-20260902/config/runtime.json');
 const runtime=JSON.parse(fs.readFileSync(runtimePath,'utf8').replace(/^\uFEFF/u,'')) as {supabaseUrl?:string;serviceRoleKey?:string;databaseUrl?:string};
 assert.equal(runtime.supabaseUrl,'http://127.0.0.1:54321','只允许写入本地验收数据库');
 assert.ok(runtime.serviceRoleKey,'本地验收数据库缺少service role');
 assert.ok(runtime.databaseUrl,'本地验收数据库缺少直连地址');
 const databaseUrl=new URL(runtime.databaseUrl);
 assert.ok(['127.0.0.1','localhost'].includes(databaseUrl.hostname),'只允许直连本机数据库');

 const headers={
  apikey:runtime.serviceRoleKey,
  Authorization:`Bearer ${runtime.serviceRoleKey}`,
  'Content-Type':'application/json',
  Prefer:'return=representation',
 };
 async function db(table:string,query:Record<string,string>,method='GET',body?:unknown){
  const response=await fetch(`${runtime.supabaseUrl}/rest/v1/${table}?${new URLSearchParams(query)}`,{
   method,headers,body:body===undefined?undefined:JSON.stringify(body),
  });
  if(!response.ok)throw new Error(`Local ${table} ${method} failed: HTTP ${response.status} ${await response.text()}`);
  return response.status===204?[]:await response.json();
 }

 const ids=BIP_CONFIGS.map(candidate=>candidate.id);
 const beforeRows=await db('agents',{select:FIELDS,id:`in.(${ids.join(',')})`}) as Array<Record<string,unknown>>;
 assert.equal(beforeRows.length,ids.length,'商业IP七张卡本地配置不完整');
 const before=beforeRows.find(row=>row.id===TARGET_ID);
 assert.ok(before,'本地数据库缺少对标账号拆解');
 assert.equal(before.name,config.name,'本地目标智能体名称漂移');
 assert.equal(before.deleted_at??null,null,'目标智能体已删除，停止写入');
 assert.equal(before.is_active,true,'目标智能体未启用，停止写入');
 assert.ok(before.updated_at,'目标智能体缺少updated_at，无法CAS');

 const beforePrompt=String(before.system_prompt||'');
 const beforePromptSha=sha256(beforePrompt);
 const newPromptSha=sha256(config.system_prompt);
 assert.ok(
  EXPECTED_BASELINE_PROMPT_SHAS.includes(beforePromptSha)||beforePromptSha===newPromptSha,
  `目标智能体提示词已漂移，当前SHA=${beforePromptSha}`,
 );

 const plan={
  runId:randomUUID(),
  target:'local-acceptance',
  scope:'benchmark-agent-only',
  apply,
  agent:{id:TARGET_ID,name:config.name},
  agentPromptRevision:BENCHMARK_ACTION_REVISION,
  beforePromptSha256:beforePromptSha,
  nextPromptSha256:newPromptSha,
  fieldsToChange:['description','system_prompt','guide_message','updated_at'],
  protectedAgentIds:ids.filter(id=>id!==TARGET_ID),
  productionWritten:false,
 };
 console.log(JSON.stringify(plan));
 if(!apply)return;

 const backupDir=path.join(projectRoot,'.codex-backups',EVIDENCE_KEY,plan.runId);
 const evidenceDir=path.join(projectRoot,'.codex-evidence',EVIDENCE_KEY);
 fs.mkdirSync(backupDir,{recursive:true});
 fs.mkdirSync(evidenceDir,{recursive:true});
 const promptHistoryBefore=await db('prompt_versions',{select:'id,agent_id,prompt,created_at',agent_id:`eq.${TARGET_ID}`,order:'created_at.asc'}) as Array<Record<string,unknown>>;
 const beforeRaw=JSON.stringify({capturedAt:new Date().toISOString(),rows:beforeRows,promptVersions:promptHistoryBefore},null,2);
 fs.writeFileSync(path.join(backupDir,'agents.before.json'),beforeRaw,{encoding:'utf8',flag:'wx'});
 fs.writeFileSync(path.join(backupDir,'agents.before.json.sha256'),sha256(beforeRaw),{encoding:'utf8',flag:'wx'});

 async function latestHistory(){
  const rows=await db('prompt_versions',{select:'id,agent_id,prompt,created_at',agent_id:`eq.${TARGET_ID}`,order:'created_at.desc',limit:'1'}) as Array<Record<string,unknown>>;
  return rows[0];
 }
 const client=new Client({connectionString:runtime.databaseUrl});
 let historyBeforeInserted=false;
 let historyAfterInserted=false;
 let promptHistoryLatestId:unknown=null;
 await client.connect();
 try{
  await client.query('begin');
  const locked=await client.query('select id, name, description, system_prompt, guide_message, config_revision, updated_at from public.agents where id=$1 for update',[TARGET_ID]);
  assert.equal(locked.rowCount,1,'事务内未找到目标智能体');
  const lockedRow=locked.rows[0] as Record<string,unknown>;
  assert.equal(lockedRow.name,before.name,'事务内目标名称发生变化');
  assert.equal(lockedRow.description,before.description,'事务开始前目标描述已并发变化');
  assert.equal(lockedRow.system_prompt,before.system_prompt,'事务开始前目标提示词已并发变化');
  assert.equal(lockedRow.guide_message,before.guide_message,'事务开始前目标欢迎语已并发变化');
  assert.equal(Number(lockedRow.config_revision),Number(before.config_revision),'事务开始前目标配置版本已并发变化');

  const latestBefore=await client.query('select id, prompt from public.prompt_versions where agent_id=$1 order by created_at desc limit 1',[TARGET_ID]);
  if(String(latestBefore.rows[0]?.prompt||'')!==beforePrompt){
   const inserted=await client.query('insert into public.prompt_versions (agent_id,prompt) values ($1,$2) returning id',[TARGET_ID,beforePrompt]);
   historyBeforeInserted=true;
   promptHistoryLatestId=inserted.rows[0]?.id??null;
  }else{
   promptHistoryLatestId=latestBefore.rows[0]?.id??null;
  }

  if(beforePromptSha!==newPromptSha||before.description!==config.description||before.guide_message!==config.guide_message){
   const updated=await client.query(
    'update public.agents set description=$1, system_prompt=$2, guide_message=$3, updated_at=$4 where id=$5 and config_revision=$6 returning id,config_revision',
    [config.description,config.system_prompt,config.guide_message,new Date().toISOString(),TARGET_ID,Number(before.config_revision)],
   );
   assert.equal(updated.rowCount,1,'目标智能体事务更新未命中');
  }

  const latestAfterUpdate=await client.query('select id, prompt from public.prompt_versions where agent_id=$1 order by created_at desc limit 1',[TARGET_ID]);
  if(String(latestAfterUpdate.rows[0]?.prompt||'')!==config.system_prompt){
   const inserted=await client.query('insert into public.prompt_versions (agent_id,prompt) values ($1,$2) returning id',[TARGET_ID,config.system_prompt]);
   historyAfterInserted=true;
   promptHistoryLatestId=inserted.rows[0]?.id??null;
  }else{
   promptHistoryLatestId=latestAfterUpdate.rows[0]?.id??null;
  }
  await client.query('commit');
 }catch(error){
  await client.query('rollback');
  throw error;
 }finally{
  await client.end();
 }

 const afterRows=await db('agents',{select:FIELDS,id:`in.(${ids.join(',')})`}) as Array<Record<string,unknown>>;
 const after=afterRows.find(row=>row.id===TARGET_ID);
 assert.ok(after,'更新后目标智能体消失');
 const readbackMatches=after.description===config.description&&after.system_prompt===config.system_prompt&&after.guide_message===config.guide_message;
 assert.ok(readbackMatches,'目标智能体更新后读回不一致');

 const latest=await latestHistory();
 assert.equal(latest?.prompt,config.system_prompt,'最新提示词历史与运行配置不一致');

 const protectedFields=FIELDS.split(',');
 for(const id of ids.filter(candidate=>candidate!==TARGET_ID)){
  const left=beforeRows.find(row=>row.id===id);
  const right=afterRows.find(row=>row.id===id);
  assert.ok(left&&right,`受保护智能体缺失：${id}`);
  for(const field of protectedFields)assert.deepEqual(right[field],left[field],`越界修改：${id}.${field}`);
 }
 for(const field of protectedFields.filter(field=>!['description','system_prompt','guide_message','updated_at'].includes(field))){
  assert.deepEqual(after[field],before[field],`目标智能体受保护字段被修改：${field}`);
 }

 const report={
  ...plan,
  completed:true,
  changed:beforePromptSha!==newPromptSha||before.description!==config.description||before.guide_message!==config.guide_message,
  beforeUpdatedAt:before.updated_at,
  afterUpdatedAt:after.updated_at,
  afterPromptSha256:sha256(String(after.system_prompt||'')),
  promptHistoryBeforeInserted:historyBeforeInserted,
  promptHistoryAfterInserted:historyAfterInserted,
  promptHistoryLatestId:promptHistoryLatestId??latest?.id??null,
  promptHistoryBackedUp:promptHistoryBefore.length,
  transactionCommitted:true,
  protectedAgentsVerified:ids.length-1,
  readback:true,
  paidRequests:0,
  productionWritten:false,
 };
 assert.equal(report.afterPromptSha256,newPromptSha,'最终提示词SHA不一致');
 const reportRaw=JSON.stringify(report,null,2);
 fs.writeFileSync(path.join(evidenceDir,`runtime-sync-${plan.runId}.json`),reportRaw,{encoding:'utf8',flag:'wx'});
 fs.writeFileSync(path.join(evidenceDir,'runtime-sync.json'),reportRaw,'utf8');
 console.log(JSON.stringify(report));
}

main().catch(error=>{
 console.error(error instanceof Error?error.stack||error.message:String(error));
 process.exitCode=1;
});
