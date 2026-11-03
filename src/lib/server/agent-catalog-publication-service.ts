import path from "node:path";
import { stat } from "node:fs/promises";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { configurationSourceStatus,sharedConfigurationConnection } from "@/storage/database/configuration-source";
import { canonicalAgentModelBinding } from "@/lib/agent-model-binding";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { assertFreshLlmModelValidationEvidence, llmModelValidationConfigurationHash } from "@/lib/llm-model-validation-gate";
import { verifyOwnedAgentImageReference } from "@/lib/storage";
import { invalidateBotsCache } from "@/lib/bots-cache";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { hasCurrentSelfUseGrant, isUnboundCatalogAgent } from "@/lib/agent-catalog-lifecycle";
import { PENDING_TEXT_USER_ACCESS } from "@/lib/model-activation-gate";
import {
  makePublicationPlan, publicationFieldHashes, publicationHash, PublicationFailure, record, reviewedFields, validatePortableNestedFields, hasExactCatalogDecimals, checkedPublicationIndex,
  type PublicationFields, type PublicationRequest, type PublicationSnapshot,
} from "./agent-catalog-publication";

function client() {
  // Table routing and RPC routing must address the same authority. Refuse legacy split-cloud profiles.
  if(process.env.LOCAL_RUNTIME_PROFILE==="formal-local-shared")throw new PublicationFailure("CATALOG_LOCAL_CLOUD_CLIENT_FORBIDDEN",403);
  if(process.env.LOCAL_ACCEPTANCE_PREVIEW==="true" && configurationSourceStatus().configuration!=="local-acceptance")throw new PublicationFailure("CATALOG_LOCAL_AUTHORITY_NOT_ISOLATED",503);
  const shared=sharedConfigurationConnection();
  if(shared && new URL(shared.url).href!==new URL(process.env.COZE_SUPABASE_URL||"").href)throw new PublicationFailure("CATALOG_SPLIT_CONFIGURATION_AUTHORITY",503);
  return getSupabaseAdminClient();
}
function dbFailure(error: unknown): never {
  const code=record(error)?String(error.code||""):"";
  if(["42883","PGRST202"].includes(code))throw new PublicationFailure("CATALOG_MIGRATION_REQUIRED",503);
  const msg=record(error)?String(error.message||""):"";
  if(/^(CATALOG_[A-Z0-9_]{2,80})$/u.test(msg))throw new PublicationFailure(msg,/OWNER|STEP_UP/u.test(msg)?403:409);
  if(code==="23505"||code==="40001")throw new PublicationFailure("CATALOG_PRODUCTION_BASELINE_CONFLICT",409);
  throw new PublicationFailure("CATALOG_DATABASE_UNAVAILABLE",503);
}
export async function readSnapshot(id:string):Promise<PublicationSnapshot|null>{
  const {data,error}=await client().rpc("read_agent_catalog_publication_v1",{p_agent_id:id});
  if(error)dbFailure(error);
  if(data===null)return null;
  if(!record(data)||data.id!==id||!Number.isSafeInteger(data.revision)||!record(data.fields)||typeof data.rowDigest!=="string"||!Array.isArray(data.portability))throw new PublicationFailure("CATALOG_SOURCE_READBACK_INVALID",503);
  const snapshot=data as PublicationSnapshot;
  if(!hasExactCatalogDecimals(snapshot.fields,data.numericText))snapshot.portability.push("DECIMAL_NOT_EXACT_IN_JSON");
  return snapshot;
}
export async function sourceProjection(id:string,includeFields:boolean){
  const row=await readSnapshot(id);
  if(!row||row.deleted)return {source:null,deleted:Boolean(row?.deleted),fieldHashes:null,portability:[]};
  if(row.portability.includes("DECIMAL_NOT_EXACT_IN_JSON"))throw new PublicationFailure("CATALOG_DECIMAL_PRECISION_NOT_PORTABLE",409);
  if(includeFields)validatePortableNestedFields(row.fields);
  const source={id:row.id,revision:row.revision,sourceHash:publicationHash(row.fields),...(includeFields?{fields:row.fields}:{})};
  return {source,fieldHashes:publicationFieldHashes(row.fields),deleted:false,portability:row.portability};
}
export async function readReceipt(actor:string,requestKey:string){
  const {data,error}=await client().from("admin_governance_audit").select("metadata").eq("actor_id",actor)
    .eq("request_key","agent-catalog-publication:"+requestKey).eq("action","agent_catalog_publication").eq("result","success").maybeSingle();
  if(error)dbFailure(error);
  return data?.metadata??null;
}
export async function readPublicationIndex(actor:string,stepHash:string){
  const {data,error}=await client().rpc("read_agent_catalog_publication_index_v1",{p_actor:actor,p_step_hash:stepHash});
  if(error)dbFailure(error);
  return checkedPublicationIndex(data);
}
async function invalidatePublishedCard(id:string) {
  invalidateBotsCache();
  const {invalidateAgentConfigCache}=await import("@/app/api/llm/llm-state");
  invalidateAgentConfigCache(id);
}
function needsModel(fields:PublicationFields,current:PublicationSnapshot|null){
  return !current || current.fields.model_id!==fields.model_id || current.fields.model!==fields.model
    || (fields.is_active===true&&current.fields.is_active!==true) || (fields.user_access==="available"&&current.fields.user_access!=="available");
}
type ModelProof={rowVersion:string;configurationHash:string;checkedAt:string};
type CatalogOnlyProof={rowVersion:string;proposedModelId:string;proposedModelName:string};
async function verifyPendingCandidate(source:PublicationFields):Promise<CatalogOnlyProof>{
  const db=client(),id=String(source.model_id);
  const {data:model,error}=await db.from("llm_models").select("id,model_name,user_access").eq("id",id).maybeSingle();
  if(error)dbFailure(error);
  if(!model||model.id!==id||model.model_name!==source.model||model.user_access!==PENDING_TEXT_USER_ACCESS)
    throw new PublicationFailure("CATALOG_ONLY_REQUIRES_REGISTERED_PENDING_MODEL",409);
  const version=await db.rpc("read_agent_catalog_model_guard_v1",{p_model_id:id});
  if(version.error)dbFailure(version.error);
  if(typeof version.data?.rowVersion!=="string")throw new PublicationFailure("CATALOG_ONLY_REQUIRES_REGISTERED_PENDING_MODEL",409);
  return {rowVersion:version.data.rowVersion,proposedModelId:id,proposedModelName:String(source.model)};
}
async function qualifyModel(fields:PublicationFields):Promise<ModelProof>{
  const id=String(fields.model_id),db=client();
  const guard=async()=>{
    const {data,error}=await db.rpc("read_agent_catalog_model_guard_v1",{p_model_id:id});
    if(error)dbFailure(error);
    if(!data||data.poolCount!==1||typeof data.rowVersion!=="string")throw new PublicationFailure("CATALOG_CURRENT_MODEL_REQUIRED",409);
    return data.rowVersion as string;
  };
  const before=await guard();
  const {data:model,error}=await db.from("llm_models")
    .select("id,name,model_name,description,category,is_active,is_hidden,user_access,api_key,api_endpoint,proxy_url,billing_mode,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,deep_thinking_type,enable_web_search,api_protocol_config")
    .eq("id",id).maybeSingle();
  if(error)dbFailure(error);
  if(model?.user_access!=="available")throw new PublicationFailure("CATALOG_CURRENT_MODEL_REQUIRED",409);
  let configurationHash:string,resolved:string;
  try{
    const bound=canonicalAgentModelBinding(id,model);
    if(bound.model!==fields.model)throw Error("BINDING");
    resolved=String(resolveProviderSecret(String(model.api_key||""))||"").trim();
    if(!resolved)throw Error("CREDENTIAL");
    configurationHash=llmModelValidationConfigurationHash(model,resolved);
  }catch{throw new PublicationFailure("CATALOG_CURRENT_MODEL_REQUIRED",409);}
  const {data:evidence,error:readError}=await db.from("llm_model_validation_evidence").select("model_id,configuration_hash,checked_at")
    .eq("model_id",id).eq("configuration_hash",configurationHash).order("checked_at",{ascending:false}).limit(1).maybeSingle();
  if(readError)dbFailure(readError);
  try{assertFreshLlmModelValidationEvidence(model,resolved,evidence);}
  catch{throw new PublicationFailure("CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED",409);}
  if(before!==await guard())throw new PublicationFailure("CATALOG_MODEL_CHANGED_DURING_PLAN",409);
  return {rowVersion:before,configurationHash,checkedAt:evidence.checked_at};
}
async function validateAssets(fields:PublicationFields,previous:PublicationSnapshot|null,actor:string){
  for(const [key,purpose] of [["avatar","avatar"],["cover_url","cover"]] as const){
    const value=fields[key];if(!value||previous?.fields[key]===value)continue;
    if(typeof value!=="string")throw new PublicationFailure("CATALOG_ASSET_REFERENCE_INVALID",409);
    if(purpose==="avatar" && /^\/avatars\/[a-zA-Z0-9/_-]+\.(?:png|jpe?g|webp)$/u.test(value)){
      const file=await stat(path.join(process.cwd(),"public",value.slice(1))).catch(()=>null);
      if(!file?.isFile())throw new PublicationFailure("CATALOG_TARGET_ASSET_REQUIRED",409);
      continue;
    }
    if(purpose==="avatar" && value.length<=8 && !/[/.\\]/u.test(value))continue;
    if(!value.startsWith("agent-images/"+purpose+"/"))throw new PublicationFailure("CATALOG_TARGET_ASSET_REQUIRED",409);
    try{await verifyOwnedAgentImageReference(value,actor,purpose);}catch{throw new PublicationFailure("CATALOG_TARGET_ASSET_REQUIRED",409);}
  }
}
export async function runPublication(request:PublicationRequest,actor:string,stepHash:string){
  if(request.action==="apply"){
    const receipt=await readReceipt(actor,request.requestKey);
    if(receipt){
      if(receipt.id!==request.source.id||receipt.sourceRevision!==request.source.revision||receipt.sourceHash!==request.source.sourceHash||receipt.planHash!==request.planHash||receipt.audience!==request.audience||(receipt.lifecycle??"executable")!==request.lifecycle
        ||publicationHash(receipt.stripPortability??[])!==publicationHash(request.stripPortability)||publicationHash(receipt.baseline)!==publicationHash(request.baseline))throw new PublicationFailure("CATALOG_REQUEST_KEY_REUSED",409);
      await invalidatePublishedCard(request.source.id);
      return {receipt,replayed:true};
    }
  }
  const current=await readSnapshot(request.source.id),blockers:string[]=[];
  let fields:PublicationFields;
  try{fields=reviewedFields(request,current);}catch{fields={...request.source.fields};blockers.push("CATALOG_DIRECTOR_CONTRACT_REVIEW_REQUIRED");}
  const db=client(),names=[...new Set([String(fields.category),...(current?[String(current.fields.category)]:[])])];
  const categories=await db.from("categories").select("name,visibility,is_active").in("name",names);
  if(categories.error)dbFailure(categories.error);
  type CategoryMeta={name:string;visibility:string;is_active:boolean};
  const values=(categories.data??[]) as CategoryMeta[];
  const unique=(name:unknown)=>{const found=values.filter(row=>row.name===name);return found.length===1?found[0]:undefined;};
  const target=unique(fields.category),previous=current?unique(current.fields.category):undefined;
  const known=(item?:CategoryMeta)=>!!item&&["normal","private","view_only"].includes(item.visibility);
  if(!target?.is_active||!known(target))blockers.push("CATALOG_TARGET_CATEGORY_MISSING");
  if(request.lifecycle==="executable" && fields.category==="自用" && target?.visibility==="view_only" && request.audience==="owner-only"
    && !hasCurrentSelfUseGrant(await readMemberPermissionSnapshot(actor,{knownRole:"admin"})))blockers.push("CATALOG_OWNER_SELF_USE_GRANT_REQUIRED");
  if(current && !known(previous))blockers.push("CATALOG_PREVIOUS_CATEGORY_UNVERIFIED");
  if(current?.fields.source!=="llm"&&current)blockers.push("CATALOG_EXISTING_SOURCE_REQUIRES_REVIEW");
  if(current?.portability.includes("DECIMAL_NOT_EXACT_IN_JSON"))blockers.push("CATALOG_DECIMAL_PRECISION_NOT_PORTABLE");
  if(!current || current.fields.name!==fields.name){
    const sameName=await db.from("agents").select("id").eq("name",fields.name).neq("id",request.source.id).limit(1);
    if(sameName.error)dbFailure(sameName.error);
    if(sameName.data?.length)blockers.push("CATALOG_NAME_ALREADY_IN_USE");
  }
  let modelProof:ModelProof|CatalogOnlyProof|null=null;
  if(request.lifecycle==="catalog-only"){
    if(current && !isUnboundCatalogAgent(current.fields))blockers.push("CATALOG_ONLY_CANNOT_REPLACE_EXECUTABLE_CARD");
    try{modelProof=await verifyPendingCandidate(request.source.fields);}
    catch(error){if(!(error instanceof PublicationFailure)||error.status>=500)throw error;blockers.push(error.code);}
  }else if(needsModel(fields,current)){
    if(current?.portability.some(s=>["PRIVATE_AGENT_CREDENTIAL_OR_CHANNEL","PRIVATE_AGENT_PROXY"].includes(s)))blockers.push("CATALOG_PRIVATE_CHANNEL_REQUIRES_REVIEW");
    try{modelProof=await qualifyModel(fields);}
    catch(error){if(!(error instanceof PublicationFailure)||error.status>=500)throw error;blockers.push(error.code);}
  }
  try{await validateAssets(fields,current,actor);}catch(error){if(!(error instanceof PublicationFailure))throw error;blockers.push(error.code);}
  const plan=makePublicationPlan(request,current,fields,blockers,{previous,target});
  // Bind the model observation as well as the portable fields; return no credential-derived evidence hashes to the caller.
  plan.planHash=publicationHash({fieldsPlan:plan.planHash,modelVersion:modelProof?.rowVersion??null,validatedAt:modelProof&&"checkedAt" in modelProof?modelProof.checkedAt:null});
  if(request.action==="plan")return {plan};
  if(!plan.eligible)throw new PublicationFailure(plan.blockers[0],409);
  if(plan.planHash!==request.planHash)throw new PublicationFailure("CATALOG_REVIEWED_PLAN_CHANGED",409);
  const {data,error}=await db.rpc("apply_agent_catalog_publication_v1",{p_actor:actor,p_step_hash:stepHash,p_plan:plan,p_fields:fields,p_expected_row_hash:current?.rowDigest??null,p_model_proof:modelProof});
  if(error)dbFailure(error);
  if(!data?.receipt || data.receipt.planHash!==plan.planHash || data.receipt.targetHash!==plan.targetHash)throw new PublicationFailure("CATALOG_OUTCOME_REQUIRES_RECEIPT_READ",503);
  await invalidatePublishedCard(request.source.id);
  return {receipt:data.receipt,replayed:data.replayed===true};
}
