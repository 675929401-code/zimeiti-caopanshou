import { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { stableJson } from './configuration-platform';

type Row = Record<string, unknown>;
export type CardAcceptanceScenario = 'standard'|'revision'|'minimum';
type EvidenceEvent = Row & { card_version_id:string;card_contract_hash:string;scenario_kind?:CardAcceptanceScenario;status:'passed'|'invalidated' };

const DIMENSIONS:Record<string,string[]>={
  director:['facts','materialRoles','productConsistency','hook','rhythm','shotFunction','actions','camera','sound','timeline','prohibitions','conversionClose','format','revisionPreservation'],
  image_skill:['facts','materialRoles','productConsistency','subjectIdentity','instructionAdherence','composition','detailQuality','textAccuracy','format','artifactControl'],
  agent_plan:['facts','materialRoles','planCompleteness','dependencyOrder','modelRouting','pricingClarity','recovery','format'],
  video_entry:['facts','materialRoles','productConsistency','motion','camera','sound','timeline','format'],
  fixed_pipeline:['facts','materialRoles','dependencyOrder','outputCompleteness','recovery','format'],
};

function object(value:unknown):Row{return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};}
function strings(value:unknown):string[]{return Array.isArray(value)?value.map(String):[];}
export function cardAcceptanceKey(versionId:string,contractHash:string,scenario:CardAcceptanceScenario='standard'){return `${versionId}:${contractHash}:${scenario}`;}
export function cardQualityDimensions(executorType:unknown,scenario:CardAcceptanceScenario='standard'){
  const value=DIMENSIONS[String(executorType)];if(!value)throw Error('卡片执行器没有质量评分维度');
  return String(executorType)==='director'&&scenario!=='revision'?value.filter((key)=>key!=='revisionPreservation'):[...value];
}

/** Hash only fields that can affect input, prompt compilation, execution or output. */
export function cardContractHash(card:Row){
  const payload={
    id:String(card.id||''),cardId:String(card.card_id||card.cardId||''),version:Number(card.version||0),
    display:object(card.display),materialSlots:card.material_slots??card.materialSlots??[],inputFields:card.input_fields??card.inputFields??[],
    executorType:String(card.executor_type||card.executorType||''),promptVersionId:card.prompt_version_id??card.promptVersionId??null,
    knowledgeDocumentIds:card.knowledge_document_ids??card.knowledgeDocumentIds??[],outputContract:object(card.output_contract??card.outputContract),
    qualityRules:object(card.quality_rules??card.qualityRules),modelPolicy:object(card.model_policy??card.modelPolicy),videoDefaults:object(card.video_defaults??card.videoDefaults),
  };
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export function validateCardQualityScorecard(card:Row,raw:unknown,scenario:CardAcceptanceScenario='standard'){
  const scorecard=object(raw),scores=object(scorecard.scores),required=cardQualityDimensions(card.executor_type||card.executorType,scenario),provided=Object.keys(scores);
  if(provided.some((key)=>!required.includes(key))||required.some((key)=>!provided.includes(key)))throw Error(`质量评分必须完整包含 ${required.join('、')}`);
  const normalized:Record<string,number>={};
  for(const key of required){const score=Number(scores[key]);if(!Number.isFinite(score)||score<0||score>100)throw Error(`质量维度 ${key} 分数无效`);normalized[key]=Math.round(score*100)/100;}
  const hardErrors=strings(scorecard.hardErrors).map((value)=>value.trim()).filter(Boolean);if(hardErrors.length)throw Error(`存在硬性质量错误：${hardErrors.join('；')}`);
  const note=String(scorecard.reviewerNote||'').trim();if(note.length<20||note.length>2000)throw Error('质量评语需为 20 到 2000 字');
  const minimum=Number(object(card.quality_rules??card.qualityRules).minimumScore||90);
  const overall=Math.round(required.reduce((sum,key)=>sum+normalized[key],0)/required.length*100)/100;
  if(required.some((key)=>normalized[key]<80))throw Error('每个质量维度均须达到 80 分');
  if(overall<minimum||overall<90)throw Error(`综合质量分 ${overall} 未达到发布门槛`);
  return {scores:normalized,hardErrors:[],reviewerNote:note,dimensions:required,overallScore:overall,minimumScore:Math.max(90,minimum)};
}

/** Input must be newest-first. An invalidation event supersedes a pass. */
export function currentPassedCardAcceptanceRows(rows:EvidenceEvent[]){
  const latest=new Map<string,EvidenceEvent>();for(const row of rows){const key=cardAcceptanceKey(String(row.card_version_id),String(row.card_contract_hash),row.scenario_kind||'standard');if(!latest.has(key))latest.set(key,row);}
  return [...latest.values()].filter((row)=>row.status==='passed');
}

export async function commerceCardAcceptanceIndex(){
  const {data,error}=await getSupabaseAdminClient().from('commerce_card_acceptance_evidence').select('*').order('verified_at',{ascending:false}).order('created_at',{ascending:false}).limit(2000);
  if(error)throw Error(`COMMERCE_CARD_ACCEPTANCE_UNAVAILABLE:${error.message}`);
  return new Map(currentPassedCardAcceptanceRows((data||[]) as EvidenceEvent[]).map((row)=>[cardAcceptanceKey(String(row.card_version_id),String(row.card_contract_hash),row.scenario_kind||'standard'),row]));
}
