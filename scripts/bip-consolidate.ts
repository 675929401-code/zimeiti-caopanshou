import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {BIP_CONFIGS} from '../src/lib/business-ip/prompts';
import {BIP_VERSION} from '../src/lib/business-ip/catalog';
import {BIP_RETIREMENTS} from '../src/lib/business-ip/retirement';

async function main() {
 const positioningOnly=process.argv.includes('--only-positioning');
 const configs=positioningOnly?BIP_CONFIGS.slice(0,1):BIP_CONFIGS;
 const retirements=positioningOnly?[]:BIP_RETIREMENTS;
 const root=path.resolve('../../..');
 const runtime=JSON.parse(fs.readFileSync(path.join(root,'运行数据/自媒体操盘手/local-data-20260902/config/runtime.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(runtime.supabaseUrl,'http://127.0.0.1:54321','Local acceptance database only');
 const headers={apikey:runtime.serviceRoleKey,Authorization:`Bearer ${runtime.serviceRoleKey}`,'Content-Type':'application/json',Prefer:'return=representation'};
 async function db(table:string,query:Record<string,string>,method='GET',body?:unknown) {
  const r=await fetch(`${runtime.supabaseUrl}/rest/v1/${table}?${new URLSearchParams(query)}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  if(!r.ok) throw new Error(`Local ${table} ${method} failed: HTTP ${r.status}`);
  return r.status===204?[]:await r.json();
 }
 const fields='id,name,description,system_prompt,guide_message,preset_fields,category,sort_order,model,model_id,max_reply_tokens,temperature,is_active,user_access,deleted_at,updated_at';
 const ids=[...BIP_CONFIGS,...BIP_RETIREMENTS].map(a=>a.id);
 const rows=await db('agents',{select:fields,id:`in.(${ids.join(',')})`});
 assert.equal(rows.length,ids.length,'All reviewed rows must exist');
 for(const retirement of BIP_RETIREMENTS) assert.equal(rows.find((r:any)=>r.id===retirement.id)?.name,retirement.name,'Retirement name drift');
 for(const config of BIP_CONFIGS){const row=rows.find((r:any)=>r.id===config.id);assert.ok(row?.is_active&&!row.deleted_at,`Active seven-card row required: ${config.name}`);}
 const solReference=rows.find((row:any)=>row.id===BIP_CONFIGS[0].id&&row.model==='gpt-5.6-sol'&&row.model_id)
  ||rows.find((row:any)=>row.model==='gpt-5.6-sol'&&row.model_id);
 assert.ok(solReference?.model_id,'A verified GPT-5.6-Sol model binding is required');
 const targetModel={model:'gpt-5.6-sol',model_id:solReference.model_id};
 const plan={version:BIP_VERSION,scope:positioningOnly?'positioning-only':'full-suite',target:'local-acceptance',model:targetModel,upgrade:configs.map((c,index)=>({id:c.id,name:c.name,category:'商业定位IP',sort_order:(index+1)*10,promptSha256:createHash('sha256').update(c.system_prompt).digest('hex')})),retire:retirements.map(r=>({...r,alreadyDeleted:Boolean(rows.find((a:any)=>a.id===r.id).deleted_at)})),productionWritten:false};
 console.log(JSON.stringify(plan));
 if(!process.argv.includes('--apply'))return;
 const si=process.argv.indexOf('--session');const session=si>=0?process.argv[si+1]:undefined;
 const state=JSON.parse(fs.readFileSync(path.join(root,'01_网页开发项目/自媒体操盘手/协作交接记录/state.json'),'utf8').replace(/^\uFEFF/,''));
 assert.ok(session);assert.equal(state.active?.id,session);assert.equal(state.active?.tool,'Codex');
 const evidenceKey=positioningOnly?`bip-positioning-${BIP_VERSION}`:`bip-${BIP_VERSION}`;
 const snapshotDir=path.resolve(`.codex-backups/${evidenceKey}`);
 const reportDir=path.resolve(`.codex-evidence/${evidenceKey}`);
 fs.mkdirSync(snapshotDir,{recursive:true});fs.mkdirSync(reportDir,{recursive:true});
 const beforeFile=path.join(snapshotDir,'agents.before.json');
 if(!fs.existsSync(beforeFile)){const raw=JSON.stringify(rows,null,2);fs.writeFileSync(beforeFile,raw,{flag:'wx'});fs.writeFileSync(`${beforeFile}.sha256`,createHash('sha256').update(raw).digest('hex'),{flag:'wx'});}
 const report:any={...plan,runId:randomUUID(),at:new Date().toISOString(),changed:[],completed:false};
 const save=()=>{const raw=JSON.stringify(report,null,2);fs.writeFileSync(path.join(reportDir,`consolidation-${report.runId}.json`),raw);fs.writeFileSync(path.join(reportDir,'consolidation.json'),raw);};save();
 async function history(id:string,prompt:string){const latest=await db('prompt_versions',{select:'prompt',agent_id:`eq.${id}`,order:'created_at.desc',limit:'1'});if(latest[0]?.prompt!==prompt)await db('prompt_versions',{},'POST',{agent_id:id,prompt});}
 async function update(row:any,patch:Record<string,unknown>){assert.ok(row.updated_at,'Revision required');const updated=await db('agents',{id:`eq.${row.id}`,updated_at:`eq.${row.updated_at}`,select:'id,updated_at'},'PATCH',{...patch,updated_at:new Date().toISOString()});assert.equal(updated.length,1,'Concurrent row change; stopped without replay');return updated[0];}
 try {
  for(const config of configs){
   const configIndex=BIP_CONFIGS.findIndex(candidate=>candidate.id===config.id);
   const previous=rows.find((r:any)=>r.id===config.id);
   const patch={
    name:config.name,
    system_prompt:config.system_prompt,
    guide_message:config.guide_message,
    description:config.description,
    preset_fields:config.preset_fields,
    category:'商业定位IP',
    sort_order:(configIndex+1)*10,
    model:targetModel.model,
    model_id:targetModel.model_id,
    ...(typeof config.max_reply_tokens==='number'?{max_reply_tokens:config.max_reply_tokens}:{}),
    ...(typeof config.temperature==='number'?{temperature:config.temperature}:{}),
   };
   if(Object.entries(patch).every(([k,v])=>JSON.stringify(previous[k])===JSON.stringify(v))){report.changed.push({id:config.id,action:'already-current'});continue;}
   await history(config.id,previous.system_prompt);
   const written=await update(previous,patch);report.changed.push({...written,action:'upgrade'});save();
   await history(config.id,config.system_prompt);
  }
  // Only retire after every replacement is installed; never delete rows or conversation history.
  for(const retirement of retirements){
   const previous=rows.find((r:any)=>r.id===retirement.id);
   if(previous.deleted_at){report.changed.push({id:retirement.id,action:'already-deleted'});continue;}
   const written=await update(previous,{deleted_at:new Date().toISOString(),is_active:false});
   report.changed.push({...written,action:'recycle'});save();
  }
  const verified=await db('agents',{select:fields,id:`in.(${ids.join(',')})`});
  for(const config of configs){const actual=verified.find((r:any)=>r.id===config.id);const configIndex=BIP_CONFIGS.findIndex(candidate=>candidate.id===config.id);assert.equal(actual.name,config.name);assert.equal(actual.description,config.description);assert.equal(actual.system_prompt,config.system_prompt);assert.equal(actual.guide_message,config.guide_message);assert.deepEqual(actual.preset_fields,config.preset_fields);assert.equal(actual.category,'商业定位IP');assert.equal(actual.sort_order,(configIndex+1)*10);assert.equal(actual.model,targetModel.model);assert.equal(actual.model_id,targetModel.model_id);if(typeof config.max_reply_tokens==='number')assert.equal(actual.max_reply_tokens,config.max_reply_tokens);if(typeof config.temperature==='number')assert.equal(actual.temperature,config.temperature);assert.ok(actual.is_active&&!actual.deleted_at);}
  for(const config of BIP_CONFIGS.filter(candidate=>!configs.some(selected=>selected.id===candidate.id))){
   const before=rows.find((r:any)=>r.id===config.id),actual=verified.find((r:any)=>r.id===config.id);
   for(const field of ['name','description','system_prompt','guide_message','preset_fields','category','sort_order','model','model_id','max_reply_tokens','temperature','updated_at'])assert.deepEqual(actual[field],before[field],`Scoped update touched ${config.name}.${field}`);
  }
  for(const retirement of BIP_RETIREMENTS){const actual=verified.find((r:any)=>r.id===retirement.id),before=rows.find((r:any)=>r.id===retirement.id);if(retirements.some(selected=>selected.id===retirement.id)){assert.ok(actual.deleted_at);if(!before.deleted_at)assert.equal(actual.is_active,false);}else{for(const field of ['is_active','deleted_at','updated_at'])assert.deepEqual(actual[field],before[field],`Scoped update touched retirement ${retirement.name}.${field}`);}}
  const ownerFile=path.resolve(`../运行日志/商业IP闭环2.0.0交付/${positioningOnly?'商业IP定位':'商业IP七智能体完整提示词'}${BIP_VERSION}.md`);
  fs.writeFileSync(ownerFile,`# ${positioningOnly?'商业IP定位':'商业IP七智能体'} ${BIP_VERSION}\n\n仅限平台维护；本地配置已回读，生产未同步。\n\n`+configs.map((c,i)=>`## ${i+1}. ${c.name}\n\n卡片ID：${c.id}\n\n${c.system_prompt}\n\n欢迎语：${c.guide_message}\n`).join('\n'));
  report.ownerPromptFile=ownerFile;
  report.completed=true;report.readback=true;
 } catch(e){report.error=e instanceof Error?e.message:String(e);throw e;} finally {save();}
 console.log(JSON.stringify({version:BIP_VERSION,scope:plan.scope,completed:report.completed,upgraded:report.changed.filter((r:any)=>r.action==='upgrade').length,recycled:report.changed.filter((r:any)=>r.action==='recycle').length,productionWritten:false}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
