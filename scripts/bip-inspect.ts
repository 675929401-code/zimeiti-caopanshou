import { getSupabaseAdminClient } from '../src/storage/database/supabase-client';
import { configurationSourceStatus } from '../src/storage/database/configuration-source';
import { BIP_CONFIGS } from '../src/lib/business-ip/prompts';
import { BIP_VERSION } from '../src/lib/business-ip/catalog';
async function main() {
 const db=getSupabaseAdminClient();
 console.log(JSON.stringify({version:BIP_VERSION,source:configurationSourceStatus()}));
 const ids=BIP_CONFIGS.map(config=>config.id);
 const a=await db.from('agents').select('id,name,category,sort_order,system_prompt,guide_message,preset_fields,model,model_id,source,is_active,deleted_at,updated_at').in('id',ids);
 if(a.error) throw new Error(a.error.message);
 console.log(JSON.stringify({agents:a.data?.sort((left:{sort_order?:number|null},right:{sort_order?:number|null})=>Number(left.sort_order)-Number(right.sort_order))}));
 const m=await db.from('llm_models').select('id,name,model_name,is_active,is_hidden').ilike('name','%5.6%');
 console.log(JSON.stringify({models:m.data,error:m.error?.message}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
