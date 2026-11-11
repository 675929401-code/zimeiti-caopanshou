import assert from 'node:assert/strict';import fs from 'node:fs/promises';
export async function main(args=[]){
 const name=args.find(x=>x.startsWith('--case='))?.slice(7);assert.ok(['funny_fresh_layout','product_description','reference_visual','product_photo_reference','background_layout','person_product_scene'].includes(name));
 const marker=JSON.parse(await fs.readFile('.codex-evidence/cover-paid-20261106-3fd15654/four-modes/'+name+'/paid-confirmation-consumed.json','utf8'));
 const base=process.env.COZE_SUPABASE_URL;assert.equal(new URL(base).origin,'http://127.0.0.1:54321');
 const service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY,owner=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user.id;
 const get=async(table,fields,key,value)=>{const u=new URL('/rest/v1/'+table,base);u.searchParams.set('select',fields);u.searchParams.set('user_id','eq.'+owner);u.searchParams.set(key,'eq.'+value);const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service}});assert.ok(r.ok);return r.json();};
 const r=await fetch(process.env.LOCAL_NAV_ORIGIN+'/api/cover/prepare?operationId='+marker.operationId,{headers:{Authorization:'Bearer '+process.env.LOCAL_NAV_ADMIN_TOKEN},cache:'no-store'});const dto=await r.json();assert.ok(r.ok);
 const [parent]=await get('cover_prepare_operations','id,state,error_code,analysis_request_id,billing,created_at,updated_at','id',marker.operationId);
 const children=await get('llm_request_attempts','record_id,state,attempt_no,http_status,result_reference,error_code,error_message,provider_call_started_at,created_at,updated_at','client_request_id',parent.analysis_request_id);
 for(const child of children){const message=String(child.error_message||'');child.failureSignals=[...new Set(message.match(/timeout|timed out|abort|socket|reset|quota|rate.?limit|429|502|503|504|insufficient|余额|配额|超时|连接|解析|unterminated|unexpected/gi)||[])];delete child.error_message;}
 console.log(JSON.stringify({case:name,at:new Date().toISOString(),parent,children,dto:{status:dto.status,code:dto.code,analysisIssue:dto.analysisIssue},newModelCalls:0}));
}
