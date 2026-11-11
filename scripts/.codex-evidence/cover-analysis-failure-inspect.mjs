import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
export async function main(){
  const base=process.env.COZE_SUPABASE_URL;assert.equal(new URL(base).origin,'http://127.0.0.1:54321');
  const owner=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY||'null')?.user?.id;assert.ok(owner);
  const service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  const get=async(table,select,filters)=>{const u=new URL('/rest/v1/'+table,base);u.searchParams.set('select',select);u.searchParams.set('user_id','eq.'+owner);for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service},signal:AbortSignal.timeout(15000)});assert.ok(r.ok,'READ_FAILED_'+table);return r.json();};
  const rows=await get('cover_prepare_operations','id,state,error_code,created_at,updated_at,analysis_request_id,analysis_attempt_id,materials,billing',{state:'eq.failed',order:'created_at.desc',limit:'4'});
  const result=[];
  for(const r of rows){
    const children=await get('llm_request_attempts','record_id,state,attempt_no,http_status,error_code,response_body,response_fingerprint,result_reference',{client_request_id:'eq.'+r.analysis_request_id,limit:'1'});
    const child=children[0];let body,content='',decoded,parseError;
    try{body=JSON.parse(child?.response_body||'null');content=body?.output_text||body?.content||body?.choices?.[0]?.message?.content||'';if(typeof content!=='string')content='';decoded=JSON.parse(content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{parseError='JSON_DECODE_FAILED';}
    const analysis=decoded?.analysis||decoded;const visuals=decoded?.visualObservations;
    const entry={operationId:r.id,status:r.state,code:r.error_code,createdAt:r.created_at,style:r.materials?.styleKey,ratio:r.materials?.outputRatio,
      materialTextLength:r.materials?.text?.length||0,materialTextSha256:crypto.createHash('sha256').update(r.materials?.text||'').digest('hex'),assetRoles:(r.materials?.assets||[]).map(x=>x.role),
      billing:{creditsCharged:r.billing?.credits_charged,operationId:r.billing?.operation_id},child:child?{state:child.state,httpStatus:child.http_status,attemptNo:child.attempt_no,errorCode:child.error_code,responseBytes:child.response_body?.length||0}:null,
      llmContent:{length:content.length,parseError,rootKeys:decoded&&typeof decoded==='object'?Object.keys(decoded):[],analysisKeys:analysis&&typeof analysis==='object'?Object.keys(analysis):[],schema:analysis?.schemaVersion,status:analysis?.status,
        primaryTitleLength:typeof analysis?.primaryTitle==='string'?analysis.primaryTitle.length:null,secondaryTitleType:typeof analysis?.secondaryTitle,visualBriefKeys:analysis?.visualBrief?Object.keys(analysis.visualBrief):[],
        titleCandidateCount:Array.isArray(analysis?.titleCandidates)?analysis.titleCandidates.length:null,evidenceCount:Array.isArray(analysis?.evidence)?analysis.evidence.length:null,missingInformationCount:Array.isArray(analysis?.missingInformation)?analysis.missingInformation.length:null,visualObservationCount:Array.isArray(visuals)?visuals.length:null}};
    result.push(entry);
    // Scoped operator-only input for deterministic re-parse, never returned to
    // the model or printed; contains this owner's material/analysis, no tokens.
    if(r.id===rows[0]?.id){await fs.mkdir('.codex-evidence/cover-paid-20261106-3fd15654/analysis-failure',{recursive:true});await fs.writeFile('.codex-evidence/cover-paid-20261106-3fd15654/analysis-failure/owned-reparse-input.json',JSON.stringify({operationId:r.id,materials:r.materials,parsed:decoded,rawContent:content},null,2)+'\n');}
  }
  const out={at:new Date().toISOString(),scope:'latest-failed-parents-for-current-verified-owner-only',modelSubmissions:0,parents:result};
  await fs.writeFile('.codex-evidence/cover-paid-20261106-3fd15654/analysis-failure-summary.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
}
