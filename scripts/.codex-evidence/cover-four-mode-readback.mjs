import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const ROOT='.codex-evidence/cover-paid-20261106-3fd15654/four-modes';
const CASES=['recovered_dog_story','warm_story','funny_action','warm_relationship_layout','funny_fresh_layout','product_description','reference_visual','product_photo_reference','background_layout','person_product_scene'];
const sha=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>Math.abs(Number(a)-Number(b))<1e-8;
export async function main(){
  const base=process.env.COZE_SUPABASE_URL;assert.equal(new URL(base).origin,'http://127.0.0.1:54321');
  const owner=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY||'null').user.id, service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  const read=async(table,select,filters)=>{const u=new URL('/rest/v1/'+table,base);u.searchParams.set('select',select);u.searchParams.set('user_id','eq.'+owner);u.searchParams.set('limit','20');for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service},cache:'no-store',signal:AbortSignal.timeout(20000)});assert.ok(r.ok,'OWNED_READ_FAILED_'+table);const rows=await r.json();assert.ok(Array.isArray(rows)&&rows.length<20);return rows;};
  const one=rows=>{assert.equal(rows.length,1,'EXACTLY_ONE_OWNED_ROW_REQUIRED');return rows[0];};
  const out={at:new Date().toISOString(),scope:'ten-exact-local-parents-and-assets-GET-only',cases:[],passed:false,modelSubmissions:0,databaseWrites:0,totalCredits:0,totalImageYuan:0,actualAnalysisAttempts:0,actualImageRequests:0};
  for(const name of CASES){
    let local=JSON.parse(await fs.readFile(path.join(ROOT,name,'report.json'),'utf8'));
    if(!local.passed && ['funny_action','warm_relationship_layout','product_description'].includes(name)){
      const continuation=JSON.parse(await fs.readFile(path.join(ROOT,name,'continuation-report.json'),'utf8'));
      assert.equal(continuation.operationId,local.operationId);assert.equal(continuation.counts.prepare,0);assert.equal(local.counts.dispatch,0);
      local=continuation;
    }
    if(!local.passed && name==='reference_visual'){
      assert.equal(local.counts.analyze,0);assert.equal(local.counts.prepare,0);
      local=JSON.parse(await fs.readFile(path.join(ROOT,name,'free-retry-report.json'),'utf8'));
    }
    assert.equal(local.passed,true,'CASE_NOT_ACCEPTED_'+name);
    const id=local.operationId, key='coverwb_'+id;
    const parent=one(await read('cover_prepare_operations','id,state,analysis_request_id,analysis_attempt_id,billing,preparation,result,error_code',{id:'eq.'+id}));assert.equal(parent.state,'plan_ready');
    if(local.analysisDisplay?.contentBreakdown)assert.deepEqual(parent.result.analysis.contentBreakdown,local.analysisDisplay.contentBreakdown);
    if(name==='warm_relationship_layout')assert.equal(parent.result.analysisTransportNormalization.kind,'single_premature_envelope_closure');
    const credits=Number(parent.billing.credits_charged||0);
    let analysisRecord;
    if(credits>0){
      const child=one(await read('llm_request_attempts','record_id,state,attempt_no,http_status,payload_fingerprint,response_fingerprint,result_reference',{client_request_id:'eq.'+parent.analysis_request_id}));
      assert.equal(child.state,'succeeded');assert.equal(child.http_status,200);assert.equal(child.attempt_no,1);assert.equal(child.record_id,sha(owner+'\0'+parent.analysis_request_id));
      assert.equal(child.payload_fingerprint,parent.preparation.analysisPayloadFingerprint);assert.equal(child.result_reference,`llm-result:${child.record_id}:1:${child.response_fingerprint}`);
      const operation=one(await read('wallet_operations','id,wallet,operation_kind,amount,delta,status,idempotency_key',{id:'eq.'+parent.billing.operation_id}));
      assert.equal(operation.status,'completed');assert.equal(operation.wallet,'credits');assert.equal(operation.operation_kind,'credit_charge');assert.ok(same(operation.amount,credits)&&same(operation.delta,-credits));
      const ledger=one(await read('wallet_ledger_entries','id,operation_id,delta,idempotency_key',{operation_id:'eq.'+operation.id}));assert.ok(same(ledger.delta,operation.delta));assert.equal(ledger.idempotency_key,operation.idempotency_key);
      analysisRecord={recordId:child.record_id,attemptNo:child.attempt_no,walletOperationId:String(operation.id)};out.actualAnalysisAttempts++;
    }else assert.ok(parent.preparation.reuseAnalysisOperationId,'ZERO_ANALYSIS_REQUIRES_EXPLICIT_REUSE');
    const history=one(await read('cover_generation_history','asset_id,background_asset_id,history_record_id,output_width,output_height,source_width,source_height,plan,hidden_at',{asset_id:'eq.'+local.receipt.assetId}));
    assert.equal(history.history_record_id,local.receipt.historyRecordId);assert.equal(Number(history.output_width),local.expected.width);assert.equal(Number(history.output_height),local.expected.height);assert.equal(history.plan.planVersion,2);assert.equal(history.hidden_at,null);
    const ids=[history.asset_id,history.background_asset_id];
    const files=await read('user_files','id,storage_provider,file_category,content_type,file_size',{id:'in.('+ids.join(',')+')'});assert.equal(files.length,new Set(ids).size);assert.ok(files.every(file=>file.storage_provider==='tencent_cos'&&file.file_category==='image'&&Number(file.file_size)>0));
    const media=one(await read('conversation_messages','id,agent_id,role',{id:'eq.'+history.history_record_id}));assert.equal(media.agent_id,'image-workbench');assert.equal(media.role,'assistant');
    const noNewImage=['product_photo_reference','background_layout'].includes(name);
    const imageRows=await read('image_generation_requests','record_id,state,delivery_state,client_idempotency_key,publicModelId:request_snapshot->>publicModelId,quotedPriceYuan:request_snapshot->>quotedPriceYuan,dispatchReceiptId:provider_dispatch_receipt->>receiptId,submissionReceiptId:provider_submission_receipt->>receiptId',{client_idempotency_key:'eq.'+key});
    let imageRecord, cash=0;
    if(noNewImage)assert.equal(imageRows.length,0,'RETAINED_LAYOUT_MUST_NOT_GENERATE_IMAGE');
    else{
      const image=one(imageRows);assert.equal(image.record_id,sha(owner+'\0'+key));assert.equal(image.state,'completed');assert.equal(image.delivery_state,'delivered');assert.ok(image.dispatchReceiptId&&image.submissionReceiptId);
      const attempt=one(await read('cover_generation_attempts','id,state,background_asset_id,result_asset_id,history_record_id',{client_idempotency_key:'eq.'+key,client_trace_id:'eq.'+key}));assert.equal(attempt.state,'completed');assert.equal(attempt.result_asset_id,history.asset_id);assert.equal(attempt.background_asset_id,history.background_asset_id);assert.equal(attempt.history_record_id,history.history_record_id);
      const billingKey='image:h3_'+sha(owner+':'+key).slice(0,48);
      const operation=one(await read('wallet_operations','id,wallet,operation_kind,amount,delta,status,idempotency_key',{idempotency_key:'eq.'+billingKey}));assert.equal(operation.status,'completed');assert.equal(operation.wallet,'cash');assert.equal(operation.operation_kind,'cash_charge');assert.ok(same(operation.amount,image.quotedPriceYuan)&&same(operation.delta,-Number(operation.amount)));
      const ledger=one(await read('wallet_ledger_entries','id,delta,idempotency_key',{operation_id:'eq.'+operation.id}));assert.ok(same(ledger.delta,operation.delta));assert.equal(ledger.idempotency_key,operation.idempotency_key);
      cash=Number(operation.amount);imageRecord={recordId:image.record_id,walletOperationId:String(operation.id),publicModelId:image.publicModelId};out.actualImageRequests++;
    }
    const downloaded=await fs.readFile(path.join(ROOT,name,'downloaded-cover.png'));assert.equal(sha(downloaded),local.download.sha256);
    out.totalCredits+=credits;out.totalImageYuan+=cash;
    out.cases.push({case:name,passed:true,operationId:id,route:parent.preparation.route,analysisRecord,imageRecord,creditsCharged:credits,imageYuan:cash,
      assetId:history.asset_id,backgroundAssetId:history.background_asset_id,historyRecordId:history.history_record_id,width:history.output_width,height:history.output_height,downloadSha256:sha(downloaded),ownedCloudFilesVerified:true,mediaHistoryVerified:true});
  }
  out.totalCredits=Number(out.totalCredits.toFixed(4));out.totalImageYuan=Number(out.totalImageYuan.toFixed(4));out.passed=out.cases.length===CASES.length;
  const json=JSON.stringify(out,null,2);assert.ok(!json.includes(service)&&!json.includes(process.env.LOCAL_NAV_ADMIN_TOKEN));
  await fs.writeFile(path.join(ROOT,'billing-ownership-readback.json'),json+'\n',{flag:'wx'});console.log(JSON.stringify(out));
}
