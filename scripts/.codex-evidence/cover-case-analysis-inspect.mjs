import assert from'node:assert/strict';import fs from'node:fs/promises';
export async function main(args=[]){const name=args.find(x=>x.startsWith('--case='))?.slice(7);assert.ok(['funny_action','warm_story','warm_relationship_layout','funny_fresh_layout','product_description','reference_visual','person_product_scene','product_photo_reference','background_layout'].includes(name));
 const local=JSON.parse(await fs.readFile('.codex-evidence/cover-paid-20261106-3fd15654/four-modes/'+name+'/report.json','utf8'));
 const base=process.env.COZE_SUPABASE_URL;assert.equal(new URL(base).origin,'http://127.0.0.1:54321');const owner=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user.id,service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
 const read=async(table,select,filters)=>{const u=new URL('/rest/v1/'+table,base);u.searchParams.set('select',select);u.searchParams.set('user_id','eq.'+owner);for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service}});assert.ok(r.ok);return r.json();};
 const [parent]=await read('cover_prepare_operations','id,state,error_code,analysis_request_id,materials,billing,result,preparation',{id:'eq.'+local.operationId});
 const [child]=await read('llm_request_attempts','record_id,state,attempt_no,response_body',{client_request_id:'eq.'+parent.analysis_request_id});
 const payload=JSON.parse(child.response_body);let content=payload.output_text||payload.content||payload.choices?.[0]?.message?.content||'';if(Array.isArray(content))content=content.map(x=>x.text||'').join('\n');
 let parsed;try{parsed=JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,''));}catch{parsed={unparsedFinalOutput:content,finishReason:payload.choices?.[0]?.finish_reason,usage:payload.usage};}
 const response=await fetch(process.env.LOCAL_NAV_ORIGIN+'/api/cover/prepare?operationId='+parent.id,{headers:{Authorization:'Bearer '+process.env.LOCAL_NAV_ADMIN_TOKEN}});const dto=await response.json();
 const out={operationId:parent.id,state:parent.state,code:parent.error_code,billing:parent.billing,materials:parent.materials,parsed,issue:dto.analysisIssue,modelSubmissions:0};
 await fs.writeFile('.codex-evidence/cover-paid-20261106-3fd15654/four-modes/'+name+'/analysis-diagnostic.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({case:name,state:parent.state,issue:dto.analysisIssue,analysis:parsed.analysis||parsed,modelSubmissions:0}));
}
