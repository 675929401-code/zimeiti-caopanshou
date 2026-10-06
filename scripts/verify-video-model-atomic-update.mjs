import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root=process.cwd(), require=createRequire(path.join(root,'package.json'));
const configPath=process.env.LOCAL_DATA_RUNTIME_CONFIG;
if(!configPath) throw Error('LOCAL_DATA_RUNTIME_CONFIG_REQUIRED');
const runtime=JSON.parse(fs.readFileSync(configPath,'utf8'));
if(!runtime.localOnly || !['127.0.0.1','localhost'].includes(new URL(runtime.databaseUrl).hostname)
  || !['127.0.0.1','localhost'].includes(new URL(runtime.supabaseUrl).hostname)) throw Error('LOCAL_TEST_DATABASE_REQUIRED');
const {Client}=require('pg'), {createClient}=require('@supabase/supabase-js'), ts=require('typescript');
const sql=new Client({connectionString:runtime.databaseUrl}); await sql.connect();
const id='rpc-regression-'+crypto.randomUUID();
const observations=[];
const transport=async(url,options)=>{
  if(String(url).includes('/rpc/')) observations.push({urlLength:String(url).length,method:options?.method,bodyBytes:Buffer.byteLength(String(options?.body||''))});
  return fetch(url,{...options,signal:AbortSignal.timeout(15000)});
};
const db=createClient(runtime.supabaseUrl,runtime.serviceRoleKey,{auth:{persistSession:false},global:{fetch:transport}});
const anon=createClient(runtime.supabaseUrl,runtime.anonKey,{auth:{persistSession:false}});
const compiled=ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/video-model-atomic-update.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {updateVideoModelAtomic}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const read=async()=>{const r=await db.from('video_models').select('*').eq('id',id).single();assert.equal(r.error,null);return r.data;};
const checks=[];
try {
  await sql.query(`INSERT INTO public.video_models SELECT (jsonb_populate_record(NULL::public.video_models,
    to_jsonb(v)||jsonb_build_object('id',$1::text,'name','Local atomic update regression','api_key','test-only-not-a-secret',
    'api_endpoint','https://example.invalid/test-only','is_active',false,'is_hidden',true,
    'api_protocol_config','{}'::jsonb,'total_requests',37,'price_per_use',0,'cost_price',0))).*
    FROM public.video_models v ORDER BY v.id LIMIT 1`,[id]);
  let current=await read();
  const large={test:'x'.repeat(100000),nested:{retained:true}};
  let r=await updateVideoModelAtomic(db,current,{id,api_protocol_config:large});
  assert.equal(r.error,null);assert.equal(r.data.api_protocol_config.test.length,100000);checks.push('large-config-post');
  current=await read();
  const denial=await anon.rpc('update_video_model_configuration_atomic',{p_model_id:id,p_expected:{api_protocol_config:large},p_updates:{is_hidden:false}});
  assert.ok(denial.error);assert.equal((await read()).is_hidden,true);checks.push('anonymous-denied');
  const parallel=await Promise.all([updateVideoModelAtomic(db,current,{price_per_use:0.11}),updateVideoModelAtomic(db,current,{price_per_use:0.22})]);
  assert.ok(parallel.every(x=>!x.error));assert.equal(parallel.filter(x=>x.data).length,1);checks.push('concurrent-writers-single-winner');
  r=await updateVideoModelAtomic(db,current,{is_active:true,is_hidden:false});
  assert.equal(r.error,null);assert.equal(r.data,null);checks.push('stale-price-cannot-publish');
  current=await read();
  await sql.query('UPDATE public.video_models SET api_protocol_config=api_protocol_config||$2::jsonb WHERE id=$1',[id,JSON.stringify({extra:true})]);
  r=await updateVideoModelAtomic(db,current,{name:'must not replace newer nested config'});
  assert.equal(r.error,null);assert.equal(r.data,null);checks.push('nested-addition-invalidates-snapshot');
  current=await read();
  await sql.query('UPDATE public.video_models SET api_key=$2 WHERE id=$1',[id,'another-test-only-value']);
  r=await updateVideoModelAtomic(db,current,{is_active:true});
  assert.equal(r.error,null);assert.equal(r.data,null);checks.push('credential-change-invalidates-snapshot');
  current=await read();
  await sql.query('UPDATE public.video_models SET total_requests=total_requests+1 WHERE id=$1',[id]);
  r=await updateVideoModelAtomic(db,current,{name:'Counter preserved'});
  assert.equal(r.error,null);assert.equal(r.data.total_requests,38);checks.push('counter-updates-preserved');
  for(const patch of [{id:'wrong-id'},{total_requests:0},{"name = 'bad' --":'rejected'}]){
    const denied=await db.rpc('update_video_model_configuration_atomic',{p_model_id:id,p_expected:{api_protocol_config:(await read()).api_protocol_config},p_updates:patch});
    assert.equal(denied.error?.code,'22023');
  }
  checks.push('identity-counter-and-unsafe-fields-denied');
  assert.throws(()=>updateVideoModelAtomic(db,current,{id:'different'}),/VIDEO_MODEL_ID_MISMATCH/);checks.push('helper-id-boundary');
  assert.ok(observations.some(x=>x.bodyBytes>100000));assert.ok(observations.every(x=>x.method==='POST'&&x.urlLength<500));checks.push('bounded-url-real-transport');
  console.log(JSON.stringify({passed:true,checks,realPostgres:true,realPostgrest:true,paidCalls:0,productionWrites:0}));
} finally {
  await sql.query('DELETE FROM public.video_models WHERE id=$1',[id]);
  await sql.end();
}
