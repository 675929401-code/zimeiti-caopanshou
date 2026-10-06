import {readFile,writeFile} from 'node:fs/promises';import pg from 'pg';
const runtime=JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json','utf8'));
if(!runtime.localOnly||runtime.ownerConnection.host!=='127.0.0.1'||runtime.ownerConnection.port!==54322||runtime.ownerConnection.database!=='zimeiti_local')throw new Error('LOCAL_ONLY');
const db=new pg.Client(runtime.ownerConnection);await db.connect();try{
 const jobs=await db.query('select public_job_id,client_request_id,model_public_id,stage,state,error_code,created_at,updated_at from public.short_drama_jobs where project_id=$1',['5c9786fe-64a9-4123-96a1-ddbca89e7108']);
 const shots=await db.query('select id,status,revision,aspect_ratio from public.short_drama_shots where project_id=$1',['5c9786fe-64a9-4123-96a1-ddbca89e7108']);
 const assets=await db.query('select id,asset_role,provider,byte_size,mime_type,object_key is not null as object_key_present from public.short_drama_assets where project_id=$1',['5c9786fe-64a9-4123-96a1-ddbca89e7108']);
 const settlements=await db.query('select public_job_id,billing_mode,credits_charged,cash_charged,cost_amount from public.short_drama_settlements where project_id=$1',['5c9786fe-64a9-4123-96a1-ddbca89e7108']);
 const summary={observedAt:new Date().toISOString(),jobs:jobs.rows,shots:shots.rows,assets:assets.rows,settlements:settlements.rows};
 await writeFile(`.codex-evidence/manju-production-e2e-20260902/local-state-${Date.now()}.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await db.end();}
