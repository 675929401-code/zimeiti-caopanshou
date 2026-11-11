import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function main(args=[]){
  const origin=process.env.LOCAL_NAV_ORIGIN;assert.equal(origin,'http://127.0.0.1:5000');
  const base=process.env.COZE_SUPABASE_URL;assert.equal(new URL(base).origin,'http://127.0.0.1:54321');
  const actor=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY||'null').user.id;
  const service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  const previous=args.includes('--previous-failed-order');
  const id=previous?'ec3fbcf1-e8d8-46ff-a7da-2024687ef0c5':'910c6b76-312f-4bcb-97f1-b078589f653e';
  const read=async(table,select,filters)=>{const u=new URL('/rest/v1/'+table,base);u.searchParams.set('select',select);u.searchParams.set('user_id','eq.'+actor);for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service},signal:AbortSignal.timeout(20000)});assert.ok(r.ok,'OWNED_READ_FAILED_'+table);return r.json();};
  const parent=async()=>{const rows=await read('cover_prepare_operations','id,state,analysis_request_id,analysis_attempt_id,billing,result,error_code,updated_at',{id:'eq.'+id});assert.equal(rows.length,1);return rows[0];};
  const before=await parent();assert.ok(['failed','plan_ready'].includes(before.state));
  const childrenBefore=await read('llm_request_attempts','record_id,state,attempt_no,response_body,response_fingerprint,result_reference',{client_request_id:'eq.'+before.analysis_request_id});assert.equal(childrenBefore.length,1);assert.equal(childrenBefore[0].state,'succeeded');
  const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
  const response=await fetch(origin+'/api/cover/prepare?operationId='+id,{headers:{Authorization:'Bearer '+process.env.LOCAL_NAV_ADMIN_TOKEN},cache:'no-store',signal:AbortSignal.timeout(90000)});const body=await response.json();
  assert.ok(response.ok,'ORIGINAL_ANALYSIS_QUERY_FAILED');assert.equal(body.operationId,id);assert.equal(body.status,'plan_ready');
  const after=await parent();assert.equal(after.state,'plan_ready');assert.deepEqual(after.billing,before.billing);assert.equal(Number(after.billing.credits_charged),previous?2.64:2.63);
  const childrenAfter=await read('llm_request_attempts','record_id,state,attempt_no,response_body,response_fingerprint,result_reference',{client_request_id:'eq.'+before.analysis_request_id});assert.deepEqual(childrenAfter,childrenBefore);
  assert.equal(after.result.analysis.status,'ready');assert.ok(after.result.renderPlan.title);assert.equal(after.result.generationIdentity.clientIdempotencyKey,'coverwb_'+id);
  const report={passed:true,at:new Date().toISOString(),scope:'original-paid-analysis-recovery-GET-only',operationId:id,beforeState:before.state,afterState:after.state,
    modelSubmissions:0,additionalAnalysisCharges:0,originalCreditsCharged:Number(after.billing.credits_charged),originalWalletOperationId:after.billing.operation_id,
    unchangedChildRecord:childrenBefore[0].record_id,childResponseSha256:sha(childrenBefore[0].response_body),originalRequestId:before.analysis_request_id,
    title:after.result.renderPlan.title,sourceAudit:after.result.analysisSourceAudit,analysisIssue:body.analysisIssue,
    generationKeyUnchanged:true,billingUnchanged:true,childBytesUnchanged:true};
  await fs.writeFile('.codex-evidence/cover-paid-20261106-3fd15654/analysis-failure/'+(previous?'live-recovery-previous.json':'live-recovery.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
}
