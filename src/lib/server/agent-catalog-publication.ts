import { createHash } from "node:crypto";
import { isUnboundCatalogAgent, isViewOnlyAgentAccess, requiresOwnerAgentAccess } from "../agent-catalog-lifecycle";
import { isAgentPromptPushTargetConfigurationValid } from "../storyboard-prompt-push-capability";
import { normalizeStoryboardDirectorContractActivation, STORYBOARD_DIRECTOR_CONTRACT_FIELDS } from "../storyboard-director-contract-activation";

// IDs, provenance/receipt fields and production-only credentials are never part of the portable business fields.
export const CATALOG_PUBLICATION_FIELDS = [
  "name", "description", "avatar", "category", "source", "model", "model_id", "system_prompt", "cost_per_message",
  "sort_order", "is_active", "preset_fields", "base_fee", "output_style", "enable_think_tags", "deep_thinking_type",
  "deduct_deep_think", "max_context_rounds", "max_context_tokens", "max_reply_tokens", "timeout", "enable_web_search",
  "temperature", "response_format", "token_billing_enabled", "input_cost_per_million", "output_cost_per_million",
  "cached_cost_per_million", "profit_margin", "token_rounding_unit", "user_access", "frequency_limit", "image_parsing",
  "file_parsing", "guide_message", "enable_knowledge_base", "enable_memory", "cover_url",
] as const;
export type PublicationFields = Record<(typeof CATALOG_PUBLICATION_FIELDS)[number], unknown>;
export type SourceCard = { id: string; revision: number; sourceHash: string; fields: PublicationFields };
export type PublicationBaseline = { revision: number; hash: string };
export type PublicationAudience = "source" | "owner-only";
export type PublicationLifecycle = "executable" | "catalog-only";
export type PublicationRequest = { action: "plan" | "apply"; source: SourceCard; baseline: PublicationBaseline | null; requestKey: string; audience: PublicationAudience; lifecycle: PublicationLifecycle; stripPortability: string[]; planHash?: string };
export type PublicationSnapshot = { id: string; revision: number; fields: PublicationFields; rowDigest: string; deleted: boolean; portability: string[] };
export const PUBLICATION_ID = /^agent-[a-zA-Z0-9][a-zA-Z0-9_-]{1,115}$/u;
export const PUBLICATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hex = /^[0-9a-f]{64}$/u;
export class PublicationFailure extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
function demand(value: unknown, code: string): asserts value { if (!value) throw new PublicationFailure(code); }
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function publicationHash(value: unknown): string {
  const json = JSON.stringify(value, (_key, entry) => record(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
  return createHash("sha256").update(json).digest("hex");
}
export function publicationFieldHashes(fields: PublicationFields) {
  return Object.fromEntries(CATALOG_PUBLICATION_FIELDS.map(k => [k, publicationHash(fields[k])]));
}
export function checkedPublicationIndex(data:unknown) {
  const reject=()=>{ throw new PublicationFailure("CATALOG_INDEX_INCOMPLETE",503); };
  if(!record(data)||data.schema!=="agent-catalog-production-index.v1"||data.complete!==true||!Array.isArray(data.entries)||data.totalCount!==data.entries.length
    ||!record(data.counts)||!record(data.database)||typeof data.database.database!=="string"||typeof data.database.oid!=="string"||!/^\d+$/u.test(data.database.oid)
    ||typeof data.observedAt!=="string"||!Number.isFinite(Date.parse(data.observedAt)))return reject();
  const keys=["id","revision","sourceHash","promptHash","deleted","isActive","userAccess","category","portability"].sort().join(",");
  const flags=new Set(["NON_LLM_SOURCE","PRIVATE_AGENT_CREDENTIAL_OR_CHANNEL","PRIVATE_AGENT_PROXY","KNOWLEDGE_REFERENCE","SKILL_REFERENCE","DECIMAL_NOT_EXACT_IN_JSON"]);
  let prior:string|undefined,active=0,hidden=0,tombstones=0;
  for(const entry of data.entries){
    if(!record(entry)||Object.keys(entry).sort().join(",")!==keys||typeof entry.id!=="string"||!entry.id||(prior!==undefined&&prior>=entry.id)
      ||!Number.isSafeInteger(entry.revision)||Number(entry.revision)<1||typeof entry.deleted!=="boolean"||typeof entry.isActive!=="boolean"
      ||typeof entry.promptHash!=="string"||!hex.test(entry.promptHash)||!Array.isArray(entry.portability)||!entry.portability.every(x=>typeof x==="string"&&flags.has(x))
      ||(entry.sourceHash===null?!entry.portability.includes("DECIMAL_NOT_EXACT_IN_JSON"):typeof entry.sourceHash!=="string"||!hex.test(entry.sourceHash))
      ||(entry.category!==null&&typeof entry.category!=="string")||(entry.userAccess!==null&&typeof entry.userAccess!=="string"))return reject();
    prior=entry.id;
    if(entry.deleted)tombstones++;else {if(entry.isActive)active++;if(entry.userAccess==="hidden")hidden++;}
  }
  if(data.counts.active!==active||data.counts.hidden!==hidden||data.counts.tombstones!==tombstones)return reject();
  return {schema:data.schema,complete:true,observedAt:data.observedAt,database:{database:data.database.database,oid:data.database.oid},
    totalCount:data.totalCount,counts:{active,hidden,tombstones},entries:data.entries,inventoryHash:publicationHash(data.entries)};
}
export function requirePublicationDestination(env:Readonly<Record<string,string|undefined>>,hostname:string) {
  const host=hostname.toLowerCase().replace(/\.$/u,"");
  if(env.NODE_ENV!=="production" || env.LOCAL_ACCEPTANCE_PREVIEW==="true" || env.LOCAL_RUNTIME_PROFILE?.startsWith("formal-local")
    || env.LOCAL_RUNTIME_PROFILE==="local-acceptance" || ["localhost","127.0.0.1","[::1]","::1","0.0.0.0"].includes(host) || host.endsWith(".localhost")) {
    throw new PublicationFailure("CATALOG_NATIVE_PRODUCTION_DESTINATION_REQUIRED",403);
  }
}
const integers = new Set(["cost_per_message","sort_order","deep_thinking_type","max_context_rounds","max_context_tokens","max_reply_tokens","timeout","token_rounding_unit","frequency_limit"]);
const decimals = new Set(["base_fee","deduct_deep_think","temperature","input_cost_per_million","output_cost_per_million","cached_cost_per_million","profit_margin"]);
function decimalIdentity(text:string):string|null {
  const m=text.match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu);
  if(!m)return null;
  const digits=(m[2]+(m[3]||"")).replace(/^0+/u,"");
  if(!digits)return "0";
  const coefficient=digits.replace(/0+$/u,"");
  return m[1]+coefficient+"e"+(Number(m[4]||0)-(m[3]?.length||0)+digits.length-coefficient.length);
}
export function parsePublicationJson(text:string):unknown {
  try {
    return JSON.parse(text, (_key,value,context?:{source?:string}) => {
      if(typeof value === "number" && (!context?.source || !isExactJsonNumber(context.source,value)))throw new PublicationFailure("CATALOG_DECIMAL_PRECISION_NOT_PORTABLE");
      return value;
    });
  } catch(error) {
    if(error instanceof PublicationFailure)throw error;
    throw new PublicationFailure("CATALOG_INVALID_JSON");
  }
}
function isExactJsonNumber(raw:unknown,value:number):boolean {
  return typeof raw === "string" && Number.isFinite(value) && decimalIdentity(raw)!==null && decimalIdentity(raw)===decimalIdentity(String(value));
}
export function hasExactCatalogDecimals(fields:PublicationFields,texts:unknown):boolean{
  if(!record(texts) || !Array.isArray(texts.nestedNumbers) || !texts.nestedNumbers.every(raw=>isExactJsonNumber(raw,Number(raw))))return false;
  const observed:string[]=[];
  function collect(value:unknown) {
    if(typeof value==="number")observed.push(String(value));
    else if(value && typeof value==="object")for(const child of Object.values(value))collect(child);
  }
  collect(fields.output_style);collect(fields.preset_fields);
  const expected=texts.nestedNumbers.map(raw=>String(Number(raw))).sort();
  if(observed.length!==expected.length || !observed.sort().every((n,i)=>n===expected[i]))return false;
  return [...decimals].every(k=>{
    const value=fields[k as keyof PublicationFields],raw=texts[k];
    if(value===null)return raw===null;
    return typeof value==="number" && Number.isFinite(value) && typeof raw==="string" && decimalIdentity(raw)!==null && decimalIdentity(raw)===decimalIdentity(String(value));
  });
}
const booleans = new Set(["is_active","enable_think_tags","enable_web_search","token_billing_enabled","enable_knowledge_base","enable_memory"]);
const opaque = /^(?:api[_-]?key|secret|access[_-]?token|refresh[_-]?token|authorization|password|private[_-]?key|coze_coding_api_token|proxy_url|__proto__|constructor|prototype)$/iu;
const secretMaterial = /(?:\b(?:secret|env):\/\/|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{20,}|\bBearer\s+eyJ[A-Za-z0-9_-]{12,}\.)/iu;
function safeNested(value: unknown,depth = 0) {
  demand(depth < 32,"CATALOG_NESTED_VALUE_TOO_DEEP");
  if(typeof value==="string"){demand(!secretMaterial.test(value),"CATALOG_PROTECTED_REFERENCE");return;}
  if (Array.isArray(value)) { for (const item of value) safeNested(item,depth+1); return; }
  if (record(value)) for(const [key,item] of Object.entries(value)) { demand(!opaque.test(key),"CATALOG_PROTECTED_FIELD"); safeNested(item,depth+1); }
}
export function validatePortableNestedFields(fields:PublicationFields) {
  for(const key of CATALOG_PUBLICATION_FIELDS)safeNested(fields[key]);
}
function validateFields(value: unknown): asserts value is PublicationFields {
  demand(record(value) && Object.keys(value).length === CATALOG_PUBLICATION_FIELDS.length
    && CATALOG_PUBLICATION_FIELDS.every(k => Object.hasOwn(value,k)),"CATALOG_COMPLETE_APPROVED_FIELDS_REQUIRED");
  validatePortableNestedFields(value as PublicationFields);
  for(const key of CATALOG_PUBLICATION_FIELDS) {
    const cell=value[key]; if(cell===null)continue;
    if(integers.has(key)) demand(typeof cell==="number" && Number.isSafeInteger(cell) && (cell>=0 || key==="sort_order"),"CATALOG_INTEGER_INVALID");
    else if(decimals.has(key)) demand(typeof cell==="number" && Number.isFinite(cell) && (cell>=0 || key==="temperature"),"CATALOG_DECIMAL_INVALID");
    else if(booleans.has(key)) demand(typeof cell==="boolean","CATALOG_BOOLEAN_INVALID");
    else if(key==="output_style"||key==="preset_fields") continue;
    else demand(typeof cell==="string","CATALOG_TEXT_INVALID");
  }
  demand(value.source==="llm" && typeof value.model==="string" && value.model.trim() && typeof value.model_id==="string" && PUBLICATION_UUID.test(value.model_id),"CATALOG_LLM_BINDING_REQUIRED");
  demand(typeof value.name==="string" && value.name.trim() && value.name.length<=255 && typeof value.category==="string" && value.category.trim() && value.category.length<=255,"CATALOG_IDENTITY_INVALID");
  demand(typeof value.system_prompt==="string" && value.system_prompt.trim() && Buffer.byteLength(value.system_prompt)<=512*1024,"CATALOG_PROMPT_INVALID");
  demand(["available","hidden","view_only"].includes(String(value.user_access)) && typeof value.is_active==="boolean","CATALOG_VISIBILITY_INVALID");
  demand(value.enable_knowledge_base!==true,"CATALOG_KNOWLEDGE_ASSET_NOT_PORTABLE");
  demand(isAgentPromptPushTargetConfigurationValid(value.output_style),"CATALOG_PROMPT_TARGET_INVALID");
}
function exact(object:Record<string, unknown>,keys:string[]) {
  demand(Object.keys(object).every(k=>keys.includes(k)),"CATALOG_UNAPPROVED_ENVELOPE_FIELD");
}
export function parsePublication(raw: unknown): PublicationRequest {
  demand(record(raw),"CATALOG_ENVELOPE_REQUIRED");
  exact(raw,["action","requestKey","source","baseline","audience","lifecycle","stripPortability","planHash"]);
  demand(raw.action==="plan"||raw.action==="apply","CATALOG_ACTION_INVALID");
  demand(typeof raw.requestKey==="string" && PUBLICATION_UUID.test(raw.requestKey),"CATALOG_REQUEST_KEY_INVALID");
  const s=raw.source;
  demand(record(s),"CATALOG_SOURCE_REQUIRED"); exact(s,["id","revision","sourceHash","fields"]);
  demand(typeof s.id==="string" && PUBLICATION_ID.test(s.id) && Number.isSafeInteger(s.revision) && Number(s.revision)>0,"CATALOG_SOURCE_IDENTITY_INVALID");
  validateFields(s.fields);
  demand(typeof s.sourceHash==="string" && hex.test(s.sourceHash) && s.sourceHash===publicationHash(s.fields),"CATALOG_SOURCE_HASH_MISMATCH");
  let baseline: PublicationBaseline | null=null;
  if(raw.baseline!==null){
    demand(record(raw.baseline),"CATALOG_EXPLICIT_BASELINE_REQUIRED"); exact(raw.baseline,["revision","hash"]);
    demand(Number.isSafeInteger(raw.baseline.revision) && Number(raw.baseline.revision)>0 && typeof raw.baseline.hash==="string" && hex.test(raw.baseline.hash),"CATALOG_BASELINE_INVALID");
    baseline={revision:Number(raw.baseline.revision),hash:raw.baseline.hash};
  }
  const audience=raw.audience??"source"; demand(audience==="owner-only"||audience==="source","CATALOG_AUDIENCE_INVALID");
  const lifecycle=raw.lifecycle??"executable";demand(lifecycle==="executable"||lifecycle==="catalog-only","CATALOG_LIFECYCLE_INVALID");
  demand(lifecycle!=="executable" || s.fields.user_access!=="view_only","CATALOG_VIEW_ONLY_NOT_EXECUTABLE");
  const stripPortability=raw.stripPortability??[];
  demand(Array.isArray(stripPortability) && (stripPortability.length===0 || (lifecycle==="catalog-only" && stripPortability.length===1 && stripPortability[0]==="PRIVATE_AGENT_PROXY")),"CATALOG_SOURCE_STRIPPING_INVALID");
  if(raw.action==="apply") demand(typeof raw.planHash==="string" && hex.test(raw.planHash),"CATALOG_PLAN_HASH_REQUIRED");
  return {action:raw.action,requestKey:raw.requestKey,source:{id:s.id,revision:Number(s.revision),fields:s.fields,sourceHash:s.sourceHash},baseline,audience,lifecycle,stripPortability,...(typeof raw.planHash==="string"?{planHash:raw.planHash}:{})};
}
export function reviewedFields(request:PublicationRequest,current:PublicationSnapshot|null) {
  const fields={...request.source.fields};
  // Visibility is a reviewed manifest choice; its business category remains independent.
  if(request.audience==="owner-only")fields.user_access="hidden";
  if(request.lifecycle==="catalog-only"){
    fields.model_id=null;fields.model="";fields.is_active=false;
    if(fields.user_access!=="hidden")fields.user_access="view_only";
  }
  const prev=current?.fields.output_style,next=fields.output_style;
  const contract=(v:unknown)=>record(v)&&STORYBOARD_DIRECTOR_CONTRACT_FIELDS.some(k=>Object.hasOwn(v,k));
  if(contract(prev)||contract(next)){
    // Activating/rolling back a live production contract requires its separate reviewed native action.
    if(!current || !record(prev) || !record(next) || !contract(prev))throw new PublicationFailure("CATALOG_DIRECTOR_CONTRACT_REVIEW_REQUIRED",409);
    const candidate={...next};
    for(const key of STORYBOARD_DIRECTOR_CONTRACT_FIELDS){
      if(Object.hasOwn(prev,key)!==Object.hasOwn(next,key))throw new PublicationFailure("CATALOG_DIRECTOR_CONTRACT_REVIEW_REQUIRED",409);
      if(!Object.hasOwn(prev,key))continue;
      if(key.endsWith("_activated_at"))candidate[key]=prev[key];
      else if(prev[key]!==next[key])throw new PublicationFailure("CATALOG_DIRECTOR_CONTRACT_REVIEW_REQUIRED",409);
    }
    const canonical=normalizeStoryboardDirectorContractActivation({agentId:request.source.id,prompt:fields.system_prompt,
      previousPrompt:current.fields.system_prompt,previousValue:prev,nextValue:candidate,action:"preserve"});
    fields.output_style=canonical;
  }
  return fields;
}
export function makePublicationPlan(request:PublicationRequest,current:PublicationSnapshot|null,fields:PublicationFields,blockers:string[],categoryAccess:{previous?:{visibility?:unknown};target?:{visibility?:unknown}}={}) {
  const currentHash=current?publicationHash(current.fields):null;
  const targetAllowsSelfUse = request.audience === "owner-only" && fields.user_access === "hidden";
  if(current?.deleted)blockers.push("CATALOG_TOMBSTONE_REQUIRES_NATIVE_RESTORE");
  if(current && requiresOwnerAgentAccess(current.fields,categoryAccess.previous) && !requiresOwnerAgentAccess(fields,categoryAccess.target))blockers.push("CATALOG_AUDIENCE_BROADENING_REQUIRES_NATIVE_REVIEW");
  if(request.lifecycle!=="catalog-only" && isViewOnlyAgentAccess(fields,categoryAccess.target,targetAllowsSelfUse))blockers.push("CATALOG_VIEW_ONLY_NOT_EXECUTABLE");
  if(current && request.lifecycle!=="catalog-only" && isViewOnlyAgentAccess(current.fields,categoryAccess.previous,true) && !isViewOnlyAgentAccess(fields,categoryAccess.target,targetAllowsSelfUse)
    && !(current.fields.is_active===false && isUnboundCatalogAgent(current.fields)))blockers.push("CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW");
  if(current && (!request.baseline || request.baseline.revision!==current.revision || request.baseline.hash!==currentHash))blockers.push("CATALOG_PRODUCTION_BASELINE_CONFLICT");
  if(!current && request.baseline)blockers.push("CATALOG_PRODUCTION_ROW_MISSING");
  const changedFields=CATALOG_PUBLICATION_FIELDS.filter(k=>!current||publicationHash(current.fields[k])!==publicationHash(fields[k]));
  const operation=!current?"create":changedFields.length?"update":"noop";
  const fieldChanges=changedFields.map(key=>({key,before:current?publicationHash(current.fields[key]):null,after:publicationHash(fields[key])}));
  const core={schema:"agent-catalog-publication.v1",operation,id:request.source.id,requestKey:request.requestKey,audience:request.audience,lifecycle:request.lifecycle??"executable",
    sourceAccess:request.source.fields.user_access,categoryPolicy:{previous:categoryAccess.previous?.visibility??null,target:categoryAccess.target?.visibility??null},
    stripPortability:request.stripPortability??[],proposedModel:request.lifecycle==="catalog-only"?{id:request.source.fields.model_id,name:request.source.fields.model}:null,
    sourceRevision:request.source.revision,sourceHash:request.source.sourceHash,baseline:request.baseline,
    currentRevision:current?.revision??null,currentHash,targetHash:publicationHash(fields),changedFields,fieldChanges};
  return {...core,planHash:publicationHash(core),eligible:blockers.length===0,blockers,billingEvidence:"configuration-only",providerCalls:0};
}
