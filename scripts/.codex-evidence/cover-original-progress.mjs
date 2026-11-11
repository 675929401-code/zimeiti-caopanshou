import assert from 'node:assert/strict';
export async function main(){
  const base=process.env.COZE_SUPABASE_URL;assert.equal(new URL(base).origin,'http://127.0.0.1:54321');
  const user=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY||'null')?.user;
  assert.ok(user?.id&&process.env.COZE_SUPABASE_SERVICE_ROLE_KEY);
  const url=new URL('/rest/v1/cover_generation_attempts',base);
  url.searchParams.set('select','state,error_code,background_asset_id,result_asset_id,history_record_id,updated_at');
  url.searchParams.set('user_id','eq.'+user.id);url.searchParams.set('client_idempotency_key','eq.coverwb_aa965c59-85fe-4826-b7b7-a28eb6182cab');
  const service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  const r=await fetch(url,{headers:{apikey:service,Authorization:'Bearer '+service},signal:AbortSignal.timeout(10000)});assert.equal(r.ok,true);
  console.log(JSON.stringify({event:'original-cover-database-progress',rows:await r.json(),readOnly:true,modelSubmissions:0}));
  if(process.argv.includes('--read-api')){
    const q=new URLSearchParams({clientIdempotencyKey:'coverwb_aa965c59-85fe-4826-b7b7-a28eb6182cab',clientTraceId:'coverwb_aa965c59-85fe-4826-b7b7-a28eb6182cab'});
    const response=await fetch('http://127.0.0.1:5000/api/cover/attempt?'+q,{headers:{Authorization:'Bearer '+process.env.LOCAL_NAV_ADMIN_TOKEN},signal:AbortSignal.timeout(60000)});
    const body=await response.json();
    console.log(JSON.stringify({event:'original-api-readback',httpStatus:response.status,completed:body.completed,code:body.code,state:body.activeAttempt?.state,error:body.error,persisted:body.result?.persisted,assetId:body.result?.assetId}));
  }
}
