import dotenv from 'dotenv';
dotenv.config({path:'.env.local',quiet:true});

async function main(){
  const {getSupabaseAdminClient}=await import('../src/storage/database/supabase-client');
  const db=getSupabaseAdminClient();
  const tables=['commerce_cards','commerce_card_versions','commerce_prompt_versions','commerce_knowledge_documents','commerce_operation_routes','commerce_config_releases','commerce_model_acceptance_evidence','commerce_card_acceptance_evidence'] as const;
  const tableChecks=await Promise.all(tables.map(async table=>{const result=await db.from(table).select('id').limit(1);return {table,ready:!result.error,sampleRows:Array.isArray(result.data)?result.data.length:null,errorCode:result.error?.code||null,error:result.error?String(result.error.message||'').replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,240):null};}));
  const negativeControl=await db.from('commerce_definitely_missing_probe').select('id').limit(1);
  const modelChecks=await Promise.all(([['agent','llm_models'],['image','cover_models'],['video','video_models']] as const).map(async([kind,table])=>{const result=await db.from(table).select('*').limit(500);if(result.error)return {kind,ready:false,count:null,active:null,costConfigured:null,errorCode:result.error.code||null};const rows=result.data||[];return {kind,ready:true,count:rows.length,active:rows.filter((row:Record<string,unknown>)=>row.is_active===true).length,costConfigured:rows.filter((row:Record<string,unknown>)=>Number.isFinite(Number(row.cost_price??row.cost_price_yuan??((row.api_protocol_config as Record<string,unknown>|null)?.cost_price)))).length,errorCode:null};}));
  const result={schema:'commerce-configuration-readiness/v1',checkedAt:new Date().toISOString(),databaseConfigured:true,tables:tableChecks,negativeControlRejected:Boolean(negativeControl.error),models:modelChecks,ready:tableChecks.every(item=>item.ready)&&Boolean(negativeControl.error),databaseWrites:0,paidModelCalls:0,credentialsPrinted:false};
  console.log(JSON.stringify(result));if(!result.ready)process.exitCode=2;
}
main().catch(error=>{console.error(JSON.stringify({ready:false,error:error instanceof Error?error.message:'配置库探测失败',databaseWrites:0,paidModelCalls:0,credentialsPrinted:false}));process.exitCode=1;});
