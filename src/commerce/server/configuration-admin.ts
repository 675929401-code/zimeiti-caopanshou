import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { modelMatchesIdentifier,models, type Kind } from './models';
import { invalidatePublishedCommerceConfiguration, manifestHash, primePublishedCommerceConfiguration } from './configuration-platform';
import type { CommerceReleaseManifest } from '../shared/configuration-types';
import { commerceModelAcceptanceIndex, commerceModelAcceptanceKey } from './model-acceptance';
import { cardAcceptanceKey, cardContractHash, commerceCardAcceptanceIndex } from './card-acceptance';
import { DIRECTOR_REFERENCE_LIMIT } from './director-conversation-schema';
import { DEPTH_MODEL_CAPABILITY_REQUIREMENTS, DEPTH_PURPOSE } from './depth-video-clone-schema';
import {curatedMainCatalogExecutionReadiness,isCuratedConfigurationSelectable,usesCuratedMainCatalogDirectExecution} from './commerce-curated-model-profiles';
import {createHash} from 'node:crypto';

type Row = Record<string, unknown>;
const KEY = /^[a-z0-9][a-z0-9.-]{2,79}$/;
const FORM_KEY = /^[a-z0-9][a-z0-9._-]{1,79}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const EXECUTORS = new Set(['director', 'agent_plan', 'image_skill', 'video_entry', 'fixed_pipeline']);
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document']);
const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'boolean']);
const EXECUTABLE_KEYS = new Set(['javascript', 'script', 'shell', 'sql', 'code', 'callbackurl', 'webhookurl', 'callback', 'webhook']);

function clean(value: unknown, max = 200): string { return String(value || '').trim().slice(0, max); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function ids(value: unknown): string[] { const result = array(value).map(String); if (result.some((id) => !UUID.test(id)) || new Set(result).size !== result.length) throw Error('配置版本 ID 无效'); return result; }
const sorted=(values:readonly string[])=>[...new Set(values)].sort((left,right)=>left.localeCompare(right));
const sha256=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type ReleaseCollectionDiff={added:string[];removed:string[];unchanged:string[]};
export type CommerceReleaseDiff={
  schema:'commerce-release-diff/v1';
  cards:ReleaseCollectionDiff;
  prompts:ReleaseCollectionDiff;
  knowledge:ReleaseCollectionDiff;
  routes:ReleaseCollectionDiff;
  defaultModels:{kind:'agent'|'image'|'video';before:string|null;after:string|null;changed:boolean}[];
  changed:boolean;
};
export type CommerceReleasePreview={
  schema:'commerce-release-preview/v1';
  current:{releaseId:string;releaseVersion:number;manifestSha256:string}|null;
  candidate:{releaseId:string;releaseVersion:number;manifestSha256:string;status:string};
  diff:CommerceReleaseDiff;
  previewSha256:string;
};
function collectionDiff(before:readonly string[],after:readonly string[]):ReleaseCollectionDiff{
  const previous=new Set(before),next=new Set(after);
  return {added:sorted(after.filter(id=>!previous.has(id))),removed:sorted(before.filter(id=>!next.has(id))),unchanged:sorted(after.filter(id=>previous.has(id)))};
}
export function diffCommerceReleaseManifests(before:CommerceReleaseManifest|null,after:CommerceReleaseManifest):CommerceReleaseDiff{
  const cards=collectionDiff(before?.cardVersionIds||[],after.cardVersionIds);
  const prompts=collectionDiff(before?.promptVersionIds||[],after.promptVersionIds);
  const knowledge=collectionDiff(before?.knowledgeDocumentIds||[],after.knowledgeDocumentIds);
  const routes=collectionDiff(before?.operationRouteIds||[],after.operationRouteIds);
  const defaultModels=(['agent','image','video'] as const).map(kind=>({kind,before:before?.defaultModels[kind]||null,after:after.defaultModels[kind]||null,changed:(before?.defaultModels[kind]||null)!==(after.defaultModels[kind]||null)}));
  const changed=[cards,prompts,knowledge,routes].some(value=>value.added.length>0||value.removed.length>0)||defaultModels.some(value=>value.changed);
  return {schema:'commerce-release-diff/v1',cards,prompts,knowledge,routes,defaultModels,changed};
}
function rejectExecutableConfiguration(value:unknown,path='配置'):void{if(Array.isArray(value)){value.forEach((item,index)=>rejectExecutableConfiguration(item,`${path}[${index}]`));return;}if(!value||typeof value!=='object')return;for(const [key,nested] of Object.entries(value as Row)){if(EXECUTABLE_KEYS.has(key.toLowerCase()))throw Error(`${path}不能包含可执行字段 ${key}`);rejectExecutableConfiguration(nested,`${path}.${key}`);}}
function fixedOperationRequirements(operationId:string):Record<string,unknown>{return operationId===DEPTH_PURPOSE?DEPTH_MODEL_CAPABILITY_REQUIREMENTS:{};}
type CardContractInput={materials:Record<string,unknown[]>;fields:Record<string,unknown>};
type CardContractCase={id:string;kind:string;status:'passed'|'failed';mode:'deterministic-contract';assertions:string[];checkedAt:string;error?:string};

function valueForField(field:Row,maximum=false):unknown{
  const type=String(field.type||''),validation=object(field.validation);
  if(type==='number'&&maximum&&Number.isFinite(Number(validation.max)))return Number(validation.max);
  if((type==='text'||type==='textarea')&&maximum&&validation.pattern===undefined&&Number.isInteger(Number(validation.maxLength))&&Number(validation.maxLength)>0)return '验'.repeat(Number(validation.maxLength));
  if(type==='select'&&maximum&&array(field.options).length)return array(field.options).at(-1);
  if(type==='boolean'&&maximum)return true;
  if(field.defaultValue!==undefined&&!(field.required===true&&typeof field.defaultValue==='string'&&!field.defaultValue.trim()))return field.defaultValue;
  if(type==='number')return Number.isFinite(Number(validation.min))?Number(validation.min):1;
  if(type==='select')return array(field.options)[0];
  if(type==='boolean')return false;
  return '验收输入';
}
function materialForSlot(slot:Row):Row{
  const mediaType=String(array(slot.mediaTypes)[0]||'');
  const maxBytes=Number(slot.maxFileBytes),minDuration=Number(slot.minDurationSeconds),maxDuration=Number(slot.maxDurationSeconds);
  return {mediaType,...(Number.isFinite(maxBytes)?{bytes:Math.max(1,Math.min(maxBytes,1024))}:{}),...(Number.isFinite(minDuration)||Number.isFinite(maxDuration)?{durationSeconds:Number.isFinite(minDuration)?minDuration:Number.isFinite(maxDuration)?Math.min(maxDuration,1):1}:{})};
}
function synthesizedCardInput(card:Row,maximum=false,standard=false):CardContractInput{
  const materials:Record<string,unknown[]>={},fields:Record<string,unknown>={};
  for(const value of array(card.material_slots)){const slot=object(value),id=String(slot.id||''),min=Number(slot.minCount),max=Number(slot.maxCount);const count=maximum?max:standard&&max>0?Math.max(min,1):min;materials[id]=Array.from({length:count},()=>materialForSlot(slot));}
  for(const value of array(card.input_fields)){const field=object(value);fields[String(field.id||'')]=valueForField(field,maximum);}
  return {materials,fields};
}
export function validateCommerceCardContractInput(card:Row,raw:unknown):string[]{
  const input=object(raw),materials=object(input.materials),fields=object(input.fields),assertions:string[]=[];
  const slots=array(card.material_slots).map(object),inputFields=array(card.input_fields).map(object);
  const slotIds=new Set(slots.map(slot=>String(slot.id))),fieldIds=new Set(inputFields.map(field=>String(field.id)));
  for(const key of Object.keys(materials))if(!slotIds.has(key))throw Error(`未知素材槽 ${key}`);
  for(const key of Object.keys(fields))if(!fieldIds.has(key))throw Error(`未知输入字段 ${key}`);
  for(const slot of slots){const id=String(slot.id||''),items=array(materials[id]),min=Number(slot.minCount),max=Number(slot.maxCount),mediaTypes=array(slot.mediaTypes).map(String),maxBytes=slot.maxFileBytes===undefined?undefined:Number(slot.maxFileBytes),minDuration=slot.minDurationSeconds===undefined?undefined:Number(slot.minDurationSeconds),maxDuration=slot.maxDurationSeconds===undefined?undefined:Number(slot.maxDurationSeconds);if(items.length<min||items.length>max)throw Error(`素材槽 ${id} 数量必须为 ${min}-${max}`);for(const itemValue of items){const item=object(itemValue),mediaType=String(item.mediaType||'');if(!mediaTypes.includes(mediaType))throw Error(`素材槽 ${id} 不接受 ${mediaType||'未知'} 类型`);const bytes=item.bytes===undefined?undefined:Number(item.bytes);if(bytes!==undefined&&(!Number.isFinite(bytes)||bytes<0||maxBytes!==undefined&&bytes>maxBytes))throw Error(`素材槽 ${id} 文件大小超限`);const duration=item.durationSeconds===undefined?undefined:Number(item.durationSeconds);if(duration!==undefined&&(!Number.isFinite(duration)||duration<0||minDuration!==undefined&&duration<minDuration||maxDuration!==undefined&&duration>maxDuration))throw Error(`素材槽 ${id} 时长超限`);}assertions.push(`slot:${id}:accepted`);}
  for(const field of inputFields){const id=String(field.id||''),type=String(field.type||''),value=fields[id],validation=object(field.validation);if(field.required===true&&(value===undefined||value===null||typeof value==='string'&&!value.trim()))throw Error(`输入字段 ${id} 必填`);if(value===undefined||value===null||value===''){assertions.push(`field:${id}:optional`);continue;}if(type==='number'){const number=Number(value);if(!Number.isFinite(number)||validation.min!==undefined&&number<Number(validation.min)||validation.max!==undefined&&number>Number(validation.max))throw Error(`输入字段 ${id} 数值无效`);}else if(type==='select'){if(!array(field.options).includes(value))throw Error(`输入字段 ${id} 选项无效`);}else if(type==='boolean'){if(typeof value!=='boolean')throw Error(`输入字段 ${id} 必须为布尔值`);}else{if(typeof value!=='string')throw Error(`输入字段 ${id} 必须为文本`);if(validation.maxLength!==undefined&&value.length>Number(validation.maxLength))throw Error(`输入字段 ${id} 文本过长`);if(typeof validation.pattern==='string'){let pattern:RegExp;try{pattern=new RegExp(validation.pattern);}catch{throw Error(`输入字段 ${id} 正则无效`);}if(!pattern.test(value))throw Error(`输入字段 ${id} 格式无效`);}}assertions.push(`field:${id}:accepted`);}
  return assertions;
}
function invalidCardInput(card:Row):CardContractInput{
  const input=synthesizedCardInput(card),required=array(card.material_slots).map(object).find(slot=>Number(slot.minCount)>0);
  if(required){input.materials[String(required.id)]=[];return input;}
  const bounded=array(card.material_slots).map(object).find(slot=>Number(slot.maxCount)<20);
  if(bounded){input.materials[String(bounded.id)]=Array.from({length:Number(bounded.maxCount)+1},()=>materialForSlot(bounded));return input;}
  const requiredField=array(card.input_fields).map(object).find(field=>field.required===true);
  if(requiredField){delete input.fields[String(requiredField.id)];return input;}
  input.materials.__unknown__=[];return input;
}
export function evaluateCommerceCardContractTests(card:Row,checkedAt=new Date().toISOString()){
  const configured=array(card.test_cases);const issues:string[]=[],results:CardContractCase[]=[];const seen=new Set<string>();
  if(configured.length<3)issues.push('至少需要三个管理员测试案例');
  for(const [index,value] of configured.entries()){
    const test=object(value),id=clean(test.id||test.name||`case-${index+1}`,100),kind=clean(test.kind,40).toLowerCase(),assertions:string[]=[];let error='';
    if(!id||seen.has(id))error='测试案例 ID 缺失或重复';else seen.add(id);
    try{
      if(error)throw Error(error);
      if(!['minimum','maximum','standard','invalid','revision'].includes(kind))throw Error(`不支持的测试类型 ${kind||'空'}`);
      if(kind==='invalid'){let rejected=false;try{validateCommerceCardContractInput(card,test.input||invalidCardInput(card));}catch{rejected=true;}if(!rejected)throw Error('非法输入没有被合同拒绝');assertions.push('invalid-input-rejected');}
      else{assertions.push(...validateCommerceCardContractInput(card,test.input||synthesizedCardInput(card,kind==='maximum',kind==='standard'||kind==='revision')));if(kind==='revision'){const output=object(card.output_contract);if(String(card.executor_type)!=='director'||output.schema!=='director-script/v2'||output.applicationRequired!==true)throw Error('局部改稿案例要求 director-script/v2 与应用闭环合同');assertions.push('revision-contract-present');}}
    }catch(caught){error=caught instanceof Error?caught.message:'合同测试失败';issues.push(`${id}: ${error}`);}
    results.push({...test,id,kind,status:error?'failed':'passed',mode:'deterministic-contract',assertions,checkedAt,...(error?{error}:{})} as CardContractCase);
  }
  return {ok:issues.length===0&&results.length>=3,issues,testCases:results,checkedAt,mode:'deterministic-contract' as const};
}

export async function runCardContractTests(actorId:string,versionId:string){
  if(!UUID.test(actorId)||!UUID.test(versionId))throw Error('管理员或卡片版本 ID 无效');const db=getSupabaseAdminClient();const selected=await db.from('commerce_card_versions').select('*').eq('id',versionId).maybeSingle();if(selected.error||!selected.data)throw Error('卡片版本不存在');const status=String(selected.data.status);if(!['draft','pending_validation','validated'].includes(status))throw Error('已发布、停用或归档的卡片版本不可修改；请先保存新版本');
  const result=evaluateCommerceCardContractTests(selected.data);const prior=object(selected.data.validation_result),validation={...prior,contractTestsPassed:result.ok,contractTestMode:result.mode,contractTestIssues:result.issues,contractTestedAt:result.checkedAt,contractTestedBy:actorId};const updated=await db.from('commerce_card_versions').update({test_cases:result.testCases,validation_result:validation,status:result.ok?'pending_validation':'draft'}).eq('id',versionId).eq('status',status).select('*').maybeSingle();if(updated.error||!updated.data)throw Error('卡片版本在测试期间已变化，请重新读取');return {version:updated.data,result};
}
function modelRequirementIssues(label:string,model:Awaited<ReturnType<typeof models>>[number]|undefined,migrationBaseline:boolean,accepted:boolean,requirements:Record<string,unknown>={},warnings:string[]=[]):string[]{
  if(!model)return [`${label}不可用`];const issues:string[]=[];
  if(model.capabilities.available===false||model.capabilities.executionSupported===false)issues.push(`${label}生成链路未就绪`);
  const priceIssues:string[]=[];
  if(!Number.isFinite(model.publicPrice)||model.publicPrice<0||model.publicPrice===0&&model.capabilities.explicitlyFree!==true)priceIssues.push(`${label}售价不完整`);
  if(model.costPrice===null||!Number.isFinite(model.costPrice)||model.costPrice<0||model.costPrice===0&&model.capabilities.explicitlyFree!==true)priceIssues.push(`${label}成本不完整`);
  if(migrationBaseline)warnings.push(...priceIssues.map((item)=>`${item}，迁移基线保持付费任务关闭`));else issues.push(...priceIssues);
  if(model.costPrice!==null&&Number.isFinite(model.costPrice)&&model.publicPrice<model.costPrice)issues.push(`${label}售价低于成本`);
  if(!model.configHash)issues.push(`${label}缺少模型配置哈希`);if(!migrationBaseline&&!accepted)issues.push(`${label}尚无当前配置哈希的带货真实 canary 证据`);
  for(const [key,required] of Object.entries(requirements)){const actual=model.capabilities[key];if(Array.isArray(required)){if(!Array.isArray(actual)||required.some((item)=>!actual.includes(item)))issues.push(`${label}不满足能力 ${key}`);}else if(typeof required==='number'){if(!Number.isFinite(Number(actual))||Number(actual)<required)issues.push(`${label}不满足能力 ${key}>=${required}`);}else if(required!==undefined&&actual!==required)issues.push(`${label}不满足能力 ${key}`);}
  return issues;
}
async function nextVersion(table: string, column: string, key: string): Promise<number> { const { data, error } = await getSupabaseAdminClient().from(table).select('version').eq(column, key).order('version', { ascending: false }).limit(1); if (error) throw Error('读取配置版本失败'); return Number(data?.[0]?.version || 0) + 1; }

export async function commerceAdminOverview() {
  const db = getSupabaseAdminClient();
  const [cards, cardVersions, prompts, knowledge, routes, releases, current] = await Promise.all([
    db.from('commerce_cards').select('*').order('updated_at', { ascending: false }),
    db.from('commerce_card_versions').select('*').order('created_at', { ascending: false }).limit(500),
    db.from('commerce_prompt_versions').select('*').order('created_at', { ascending: false }).limit(500),
    db.from('commerce_knowledge_documents').select('*').order('created_at', { ascending: false }).limit(500),
    db.from('commerce_operation_routes').select('*').order('created_at', { ascending: false }).limit(500),
    db.from('commerce_config_releases').select('*').order('release_version', { ascending: false }).limit(100),
    primePublishedCommerceConfiguration({ force: true, required: false }),
  ]);
  for (const result of [cards, cardVersions, prompts, knowledge, routes, releases]) if (result.error) throw Error(`共享配置表不可用：${result.error.message}`);
  return { cards: cards.data || [], cardVersions: cardVersions.data || [], prompts: prompts.data || [], knowledge: knowledge.data || [], routes: routes.data || [], releases: releases.data || [], current: current ? { releaseId: current.releaseId, releaseVersion: current.releaseVersion, manifestSha256: current.manifestSha256, publishedAt: current.publishedAt } : null };
}

export async function saveCardDraft(actorId: string, raw: Row) {
  const stableKey = clean(raw.stableKey, 80).toLowerCase();
  if (!KEY.test(stableKey)) throw Error('卡片唯一键格式无效');
  const display = object(raw.display);
  if (!clean(display.name, 80) || !clean(display.description, 300)) throw Error('卡片名称和简介必填');
  const slots = array(raw.materialSlots);
  const slotIds=new Set<string>();
  for (const value of slots) {
    const slot = object(value); const min = Number(slot.minCount); const max = Number(slot.maxCount);
    const slotId=clean(slot.id,80);const mediaTypes=array(slot.mediaTypes).map(String);const maxBytes=slot.maxFileBytes===undefined?undefined:Number(slot.maxFileBytes);const minDuration=slot.minDurationSeconds===undefined?undefined:Number(slot.minDurationSeconds);const maxDuration=slot.maxDurationSeconds===undefined?undefined:Number(slot.maxDurationSeconds);
    if (!FORM_KEY.test(slotId) || slotIds.has(slotId) || !clean(slot.label, 80) || !clean(slot.responsibility, 300) || !mediaTypes.length || mediaTypes.some((kind)=>!MEDIA_TYPES.has(kind)) || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 20 || maxBytes!==undefined&&(!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>500_000_000) || minDuration!==undefined&&(!Number.isFinite(minDuration)||minDuration<0) || maxDuration!==undefined&&(!Number.isFinite(maxDuration)||maxDuration<(minDuration||0)||maxDuration>3600)) throw Error('素材槽配置无效');
    slotIds.add(slotId);
  }
  const fields=array(raw.inputFields);const fieldIds=new Set<string>();
  for(const value of fields){const field=object(value),fieldId=clean(field.id,80),type=clean(field.type,20),validation=object(field.validation);if(!FORM_KEY.test(fieldId)||fieldIds.has(fieldId)||!FIELD_TYPES.has(type)||!clean(field.title,100)||typeof field.required!=='boolean')throw Error('输入字段配置无效');if(type==='select'&&(!Array.isArray(field.options)||field.options.length<1||field.options.length>100))throw Error(`选择字段 ${fieldId} 缺少合法选项`);if(typeof validation.pattern==='string'&&(validation.pattern.length>120||/[\\][1-9]|\(\?[=!<]/.test(validation.pattern)))throw Error(`输入字段 ${fieldId} 的正则校验超出安全范围`);fieldIds.add(fieldId);}
  const executorType = clean(raw.executorType, 40);
  if (!EXECUTORS.has(executorType)) throw Error('执行器必须选择平台已审核的能力模板');
  if(executorType==='director'&&slots.reduce<number>((sum,value)=>sum+Number(object(value).maxCount||0),0)>DIRECTOR_REFERENCE_LIMIT)throw Error(`编导参考素材总上限不能超过 ${DIRECTOR_REFERENCE_LIMIT} 项`);
  rejectExecutableConfiguration({inputFields:fields,outputContract:object(raw.outputContract),qualityRules:object(raw.qualityRules),modelPolicy:object(raw.modelPolicy),videoDefaults:object(raw.videoDefaults)});
  const db = getSupabaseAdminClient();
  let { data: card } = await db.from('commerce_cards').select('*').eq('stable_key', stableKey).maybeSingle();
  if (!card) {
    const created = await db.from('commerce_cards').insert({ stable_key: stableKey, status: 'draft', created_by: actorId }).select('*').single();
    if (created.error) throw Error(`创建卡片失败：${created.error.message}`);
    card = created.data;
  }
  const version = await nextVersion('commerce_card_versions', 'card_id', String(card.id));
  const payload = {
    card_id: card.id, version,
    display: { name: clean(display.name, 80), description: clean(display.description, 300), category: clean(display.category || '自定义', 80), icon: clean(display.icon || '/commerce/reference/director-custom.png', 500), recommended: display.recommended === true, sortOrder: Number(display.sortOrder) || 0, visibility: ['members', 'admins', 'hidden'].includes(String(display.visibility)) ? display.visibility : 'admins' },
    material_slots: slots, input_fields: fields, executor_type: executorType,
    prompt_version_id: UUID.test(String(raw.promptVersionId || '')) ? raw.promptVersionId : null,
    knowledge_document_ids: ids(raw.knowledgeDocumentIds), output_contract: object(raw.outputContract), quality_rules: object(raw.qualityRules),
    model_policy: object(raw.modelPolicy), video_defaults: object(raw.videoDefaults), test_cases: array(raw.testCases),
    status: 'draft', validation_result: {}, change_note: clean(raw.changeNote, 500), created_by: actorId,
  };
  const inserted = await db.from('commerce_card_versions').insert(payload).select('*').single();
  if (inserted.error) throw Error(`保存卡片版本失败：${inserted.error.message}`);
  await db.from('commerce_cards').update({ status: 'draft', updated_at: new Date().toISOString() }).eq('id', card.id);
  return inserted.data;
}

export async function savePromptDraft(actorId: string, raw: Row) {
  const promptKey = clean(raw.promptKey, 120); const content = clean(raw.content, 50_000); const name = clean(raw.name, 160);
  if (!promptKey || !name || !content) throw Error('提示词标识、名称和正文必填');
  const version = await nextVersion('commerce_prompt_versions', 'prompt_key', promptKey);
  const result = await getSupabaseAdminClient().from('commerce_prompt_versions').insert({ prompt_key: promptKey, version, name, content, source: 'independent-implementation', change_note: clean(raw.changeNote, 500), status: 'draft', created_by: actorId }).select('*').single();
  if (result.error) throw Error(`保存提示词版本失败：${result.error.message}`); return result.data;
}

export async function saveKnowledgeDraft(actorId: string, raw: Row) {
  const knowledgeKey = clean(raw.knowledgeKey, 120); const content = clean(raw.content, 100_000); const name = clean(raw.name, 160);
  if (!knowledgeKey || !name || !content) throw Error('知识标识、名称和正文必填');
  const version = await nextVersion('commerce_knowledge_documents', 'knowledge_key', knowledgeKey);
  const result = await getSupabaseAdminClient().from('commerce_knowledge_documents').insert({ knowledge_key: knowledgeKey, version, name, content, enabled: raw.enabled !== false, applicable_card_keys: array(raw.applicableCardKeys).map(String), change_note: clean(raw.changeNote, 500), status: 'draft', created_by: actorId }).select('*').single();
  if (result.error) throw Error(`保存知识版本失败：${result.error.message}`); return result.data;
}

export async function saveRouteDraft(actorId: string, raw: Row) {
  const operationId = clean(raw.operationId, 160); const kind = clean(raw.modelKind, 20) as Kind;
  if (!operationId || !['agent', 'image', 'video'].includes(kind)) throw Error('功能路由标识或模型类型无效');
  const primaryModelId = clean(raw.primaryModelId, 200); if (!primaryModelId) throw Error('主模型必填');
  const fallbackModelIds=array(raw.fallbackModelIds).map((value)=>clean(value,200)).filter(Boolean);if(new Set(fallbackModelIds).size!==fallbackModelIds.length||fallbackModelIds.includes(primaryModelId))throw Error('候补模型不能重复或与主模型相同');
  if(raw.userSelectable===true&&kind!=='video'&&![primaryModelId,...fallbackModelIds].every(modelId=>isCuratedConfigurationSelectable(kind,modelId)))throw Error('对话或生图普通用户选模只能使用带货 Agent 已审核白名单');
  const available = await models(kind); for(const modelId of [primaryModelId,...fallbackModelIds])if(!available.some((model)=>modelMatchesIdentifier(model,modelId)))throw Error(`模型 ${modelId} 不在主站 ${kind} 模型库`);
  const version = await nextVersion('commerce_operation_routes', 'operation_id', operationId);
  const capabilityRequirements={...object(raw.capabilityRequirements),...fixedOperationRequirements(operationId)};rejectExecutableConfiguration(capabilityRequirements,'能力要求');
  const result = await getSupabaseAdminClient().from('commerce_operation_routes').insert({ operation_id: operationId, version, label: clean(raw.label || operationId, 200), model_kind: kind, primary_model_id: primaryModelId, fallback_model_ids: fallbackModelIds, capability_requirements: capabilityRequirements, user_selectable: raw.userSelectable === true, status: 'draft', change_note: clean(raw.changeNote, 500), created_by: actorId }).select('*').single();
  if (result.error) throw Error(`保存功能路由失败：${result.error.message}`); return result.data;
}

async function rows(table: string, selectedIds: string[]): Promise<Row[]> { if (!selectedIds.length) return []; const result = await getSupabaseAdminClient().from(table).select('*').in('id', selectedIds); if (result.error || (result.data || []).length !== selectedIds.length) throw Error(`${table} 所选版本不完整`); return result.data || []; }

export async function validateReleaseManifest(manifest: CommerceReleaseManifest, migrationBaseline = false) {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (manifest.schema !== 'commerce-config/v1') issues.push('配置协议版本无效');
  const [cards, prompts, knowledge, routes] = await Promise.all([rows('commerce_card_versions', ids(manifest.cardVersionIds)), rows('commerce_prompt_versions', ids(manifest.promptVersionIds)), rows('commerce_knowledge_documents', ids(manifest.knowledgeDocumentIds)), rows('commerce_operation_routes', ids(manifest.operationRouteIds))]);
  const cardAcceptance=migrationBaseline?new Map<string,Row>():await commerceCardAcceptanceIndex();
  if (!cards.length) issues.push('至少需要一张卡片'); if (!prompts.length) issues.push('至少需要一个提示词版本'); if (!routes.length) issues.push('至少需要一条功能路由');
  const promptIds = new Set(prompts.map((row) => String(row.id))); const knowledgeIds = new Set(knowledge.map((row) => String(row.id)));
  for (const card of cards) {
    if (['disabled','archived'].includes(String(card.status))) issues.push(`卡片版本 ${card.id} 已停用或归档`);
    if (card.prompt_version_id && !promptIds.has(String(card.prompt_version_id))) issues.push(`卡片版本 ${card.id} 的提示词未进入同一发布`);
    for (const id of array(card.knowledge_document_ids).map(String)) if (!knowledgeIds.has(id)) issues.push(`卡片版本 ${card.id} 的知识版本未进入同一发布`);
    const testCases=array(card.test_cases);if (!migrationBaseline && (testCases.length < 3||testCases.some((item)=>object(item).status!=='passed'))) issues.push(`卡片版本 ${card.id} 的三个管理员测试案例尚未全部通过`);
    if(!migrationBaseline&&(!Object.keys(object(card.output_contract)).length||!Object.keys(object(card.quality_rules)).length))issues.push(`卡片版本 ${card.id} 缺少输出合同或质检规则`);
    const contractHash=cardContractHash(card),standardEvidence=cardAcceptance.get(cardAcceptanceKey(String(card.id),contractHash,'standard'));
    if (!migrationBaseline && (!standardEvidence || Number(standardEvidence.overall_score) < 90)) issues.push(`卡片版本 ${card.id} 尚未达到 90 分并通过标准创作真实 canary`);
    if (!migrationBaseline && String(card.executor_type)==='director') {
      const revisionEvidence=cardAcceptance.get(cardAcceptanceKey(String(card.id),contractHash,'revision'));
      if(!revisionEvidence||Number(revisionEvidence.overall_score)<90)issues.push(`编导卡片版本 ${card.id} 尚未达到 90 分并通过局部改稿真实 canary`);
    }
  }
  const operationIds=routes.map((route)=>String(route.operation_id));if(new Set(operationIds).size!==operationIds.length)issues.push('同一发布不能包含同一功能的多个路由版本');
  const catalogs=new Map<Kind,Awaited<ReturnType<typeof models>>>();for(const kind of ['agent','image','video'] as const)catalogs.set(kind,await models(kind));
  const acceptance=await commerceModelAcceptanceIndex();
  const accepted=(model:Awaited<ReturnType<typeof models>>[number]|undefined)=>Boolean(model&&(usesCuratedMainCatalogDirectExecution(model.kind)&&curatedMainCatalogExecutionReadiness(model).ready||acceptance.has(commerceModelAcceptanceKey(model.kind,model.id,model.configHash))));
  for (const route of routes) {
    const kind = String(route.model_kind) as Kind;
    if(!['agent','image','video'].includes(kind)){issues.push(`路由 ${route.operation_id} 模型类型无效`);continue;}
    if(['disabled','archived'].includes(String(route.status)))issues.push(`路由 ${route.operation_id} 已停用或归档`);
    if(route.user_selectable===true&&kind!=='video'&&![String(route.primary_model_id),...array(route.fallback_model_ids).map(String)].every(modelId=>isCuratedConfigurationSelectable(kind,modelId)))issues.push(`路由 ${route.operation_id} 的普通用户选模超出带货 Agent 已审核白名单`);
    const fallbackIds=array(route.fallback_model_ids).map(String);if(new Set(fallbackIds).size!==fallbackIds.length||fallbackIds.includes(String(route.primary_model_id)))issues.push(`路由 ${route.operation_id} 的候补模型重复或与主模型相同`);
    const storedRequirements=object(route.capability_requirements),fixedRequirements=fixedOperationRequirements(String(route.operation_id));
    for(const [key,value] of Object.entries(fixedRequirements))if(storedRequirements[key]!==value)issues.push(`路由 ${route.operation_id} 缺少固定能力要求 ${key}`);
    const requirements={...storedRequirements,...fixedRequirements};
    const catalog=catalogs.get(kind)||[];for(const [index,modelId] of [String(route.primary_model_id),...fallbackIds].entries()){const model=catalog.find((entry)=>modelMatchesIdentifier(entry,modelId));issues.push(...modelRequirementIssues(`路由 ${route.operation_id} 的${index===0?'主模型':`候补模型${index}`} ${modelId}`,model,migrationBaseline,accepted(model),requirements,warnings));}
  }
  for (const kind of ['agent', 'image', 'video'] as const){const modelId=manifest.defaultModels[kind];if(!modelId)issues.push(`缺少 ${kind} 默认模型`);else{const model=catalogs.get(kind)?.find((entry)=>modelMatchesIdentifier(entry,modelId));issues.push(...modelRequirementIssues(`${kind} 默认模型 ${modelId}`,model,migrationBaseline,accepted(model),{},warnings));}}
  return { ok: issues.length === 0, issues, warnings: [...new Set(warnings)], counts: { cards: cards.length, prompts: prompts.length, knowledge: knowledge.length, routes: routes.length }, migrationBaseline, checkedAt: new Date().toISOString() };
}

export async function createReleaseDraft(actorId: string, raw: Row) {
  const manifest: CommerceReleaseManifest = { schema: 'commerce-config/v1', cardVersionIds: ids(raw.cardVersionIds), promptVersionIds: ids(raw.promptVersionIds), knowledgeDocumentIds: ids(raw.knowledgeDocumentIds), operationRouteIds: ids(raw.operationRouteIds), defaultModels: object(raw.defaultModels) as CommerceReleaseManifest['defaultModels'] };
  const validation = await validateReleaseManifest(manifest, false);
  const { data: latest, error: latestError } = await getSupabaseAdminClient().from('commerce_config_releases').select('release_version').order('release_version', { ascending: false }).limit(1);
  if (latestError) throw Error('读取发布序号失败');
  const result = await getSupabaseAdminClient().from('commerce_config_releases').insert({ release_version: Number(latest?.[0]?.release_version || 0) + 1, status: validation.ok ? 'validated' : 'draft', is_current: false, manifest, validation_result: validation, manifest_sha256: manifestHash(manifest), created_by: actorId }).select('*').single();
  if (result.error) throw Error(`创建发布候选失败：${result.error.message}`); return result.data;
}

export async function validateReleaseCandidate(releaseId:string){
  if(!UUID.test(releaseId))throw Error('发布版本 ID 无效');
  const db=getSupabaseAdminClient();const existing=await db.from('commerce_config_releases').select('*').eq('id',releaseId).maybeSingle();
  if(existing.error||!existing.data)throw Error('发布候选不存在');
  if(existing.data.is_current===true||!['draft','validated'].includes(String(existing.data.status)))throw Error('只能重新校验未发布候选');
  if(object(existing.data.validation_result).migrationBaseline===true)throw Error('迁移基线使用专门的只读发布门禁');
  const validation=await validateReleaseManifest(existing.data.manifest as CommerceReleaseManifest,false);
  const updated=await db.from('commerce_config_releases').update({status:validation.ok?'validated':'draft',validation_result:validation}).eq('id',releaseId).eq('is_current',false).select('*').maybeSingle();
  if(updated.error||!updated.data)throw Error('发布候选在校验期间已经变化，请重新读取');
  return updated.data;
}

export async function createMigrationBaselineRelease(actorId: string, raw: Row) {
  const sourceReleaseId=clean(raw.sourceReleaseId,80);if(!UUID.test(sourceReleaseId))throw Error('迁移来源版本 ID 无效');
  const db=getSupabaseAdminClient();const [source,current]=await Promise.all([
    db.from('commerce_config_releases').select('*').eq('id',sourceReleaseId).maybeSingle(),
    db.from('commerce_config_releases').select('id').eq('is_current',true).limit(1).maybeSingle(),
  ]);
  if(source.error||!source.data||object(source.data.validation_result).migrationBaseline!==true||!object(source.data.validation_result).migrationSha256)throw Error('迁移来源不是已审计的首个配置草稿');
  if(current.error)throw Error('核对当前配置发布状态失败');if(current.data)throw Error('迁移基线只能在尚无当前发布版本时创建');
  const manifest:CommerceReleaseManifest={schema:'commerce-config/v1',cardVersionIds:ids(raw.cardVersionIds),promptVersionIds:ids(raw.promptVersionIds),knowledgeDocumentIds:ids(raw.knowledgeDocumentIds),operationRouteIds:ids(raw.operationRouteIds),defaultModels:object(raw.defaultModels) as CommerceReleaseManifest['defaultModels']};
  const validation=await validateReleaseManifest(manifest,true);const latest=await db.from('commerce_config_releases').select('release_version').order('release_version',{ascending:false}).limit(1);if(latest.error)throw Error('读取发布序号失败');
  const result=await db.from('commerce_config_releases').insert({release_version:Number(latest.data?.[0]?.release_version||0)+1,status:validation.ok?'validated':'draft',is_current:false,manifest,validation_result:{...validation,migrationBaseline:true,productionCanaryComplete:false,migrationSha256:object(source.data.validation_result).migrationSha256,sourceReleaseId},manifest_sha256:manifestHash(manifest),change_note:'首个共享配置迁移基线；只读验收，付费任务保持关闭',created_by:actorId}).select('*').single();
  if(result.error)throw Error(`创建迁移基线候选失败：${result.error.message}`);return result.data;
}

export async function createMigrationBaselinePatchRelease(actorId:string,raw:Row){
  const sourceReleaseId=clean(raw.sourceReleaseId,80);if(!UUID.test(sourceReleaseId))throw Error('迁移基线版本 ID 无效');
  const db=getSupabaseAdminClient();const [source,history]=await Promise.all([
    db.from('commerce_config_releases').select('*').eq('id',sourceReleaseId).eq('is_current',true).maybeSingle(),
    db.from('commerce_config_releases').select('id,validation_result').order('release_version',{ascending:true}).limit(100),
  ]);
  const sourceValidation=object(source.data?.validation_result);
  if(source.error||!source.data||sourceValidation.migrationBaseline!==true)throw Error('只有当前迁移基线可以创建修订版本');
  if(history.error)throw Error('迁移基线血缘暂不可读取');const provenance=(history.data||[]).find((row:Row)=>object(row.validation_result).migrationBaseline===true&&object(row.validation_result).migrationSha256);
  const migrationSha256=sourceValidation.migrationSha256||object(provenance?.validation_result).migrationSha256;if(!migrationSha256)throw Error('当前迁移基线缺少可验证血缘');
  const manifest:CommerceReleaseManifest={schema:'commerce-config/v1',cardVersionIds:ids(raw.cardVersionIds),promptVersionIds:ids(raw.promptVersionIds),knowledgeDocumentIds:ids(raw.knowledgeDocumentIds),operationRouteIds:ids(raw.operationRouteIds),defaultModels:object(raw.defaultModels) as CommerceReleaseManifest['defaultModels']};
  const validation=await validateReleaseManifest(manifest,true);const latest=await db.from('commerce_config_releases').select('release_version').order('release_version',{ascending:false}).limit(1);if(latest.error)throw Error('读取发布序号失败');
  const result=await db.from('commerce_config_releases').insert({release_version:Number(latest.data?.[0]?.release_version||0)+1,status:validation.ok?'validated':'draft',is_current:false,manifest,validation_result:{...validation,migrationBaseline:true,migrationBaselinePatch:true,productionCanaryComplete:false,migrationSha256,sourceReleaseId,...(!sourceValidation.migrationSha256&&provenance?.id?{migrationProvenanceRecoveredFrom:provenance.id}:{})},manifest_sha256:manifestHash(manifest),change_note:clean(raw.changeNote||'修复迁移基线配置；付费任务保持关闭',500),created_by:actorId}).select('*').single();
  if(result.error)throw Error(`创建迁移基线修订失败：${result.error.message}`);return result.data;
}

export async function previewReleaseDifference(releaseId:string):Promise<CommerceReleasePreview>{
  if(!UUID.test(releaseId))throw Error('发布版本 ID 无效');
  const db=getSupabaseAdminClient();
  const [candidate,current]=await Promise.all([
    db.from('commerce_config_releases').select('*').eq('id',releaseId).maybeSingle(),
    db.from('commerce_config_releases').select('*').eq('is_current',true).eq('status','published').limit(1).maybeSingle(),
  ]);
  if(candidate.error||!candidate.data)throw Error('发布候选不存在');
  if(current.error)throw Error(`读取当前发布失败：${current.error.message}`);
  if(candidate.data.is_current===true||!['draft','validated'].includes(String(candidate.data.status)))throw Error('只能预览未发布候选');
  const candidateManifest=candidate.data.manifest as CommerceReleaseManifest;
  const currentManifest=current.data?.manifest as CommerceReleaseManifest|undefined;
  const value:Omit<CommerceReleasePreview,'previewSha256'>={
    schema:'commerce-release-preview/v1',
    current:current.data?{releaseId:String(current.data.id),releaseVersion:Number(current.data.release_version),manifestSha256:String(current.data.manifest_sha256)}:null,
    candidate:{releaseId:String(candidate.data.id),releaseVersion:Number(candidate.data.release_version),manifestSha256:String(candidate.data.manifest_sha256),status:String(candidate.data.status)},
    diff:diffCommerceReleaseManifests(currentManifest||null,candidateManifest),
  };
  return {...value,previewSha256:sha256(value)};
}

export async function publishRelease(actorId: string, releaseId: string, migrationBaseline = false, expectedPreviewSha256?:string) {
  if (!UUID.test(releaseId)) throw Error('发布版本 ID 无效');
  const preview=await previewReleaseDifference(releaseId);
  if(!expectedPreviewSha256||expectedPreviewSha256!==preview.previewSha256)throw Error('发布差异预览已缺失或过期，请重新预览后再发布');
  const db = getSupabaseAdminClient(); const existing = await db.from('commerce_config_releases').select('*').eq('id', releaseId).maybeSingle();
  if (existing.error || !existing.data) throw Error('发布候选不存在');
  if(String(existing.data.manifest_sha256)!==preview.candidate.manifestSha256)throw Error('发布候选在预览后已经变化，请重新预览');
  if (migrationBaseline && object(existing.data.validation_result).migrationBaseline !== true) throw Error('只有迁移脚本生成的首个基线候选可以使用迁移发布门禁');
  const manifest = existing.data.manifest as CommerceReleaseManifest; const validation = await validateReleaseManifest(manifest, migrationBaseline);const priorValidation=object(existing.data.validation_result);
  const publishedValidation=migrationBaseline?{...validation,migrationBaseline:true,productionCanaryComplete:false,...(priorValidation.migrationSha256?{migrationSha256:priorValidation.migrationSha256}:{}),...(priorValidation.sourceReleaseId?{sourceReleaseId:priorValidation.sourceReleaseId}:{}),...(priorValidation.migrationBaselinePatch?{migrationBaselinePatch:true}:{}),...(priorValidation.migrationProvenanceRecoveredFrom?{migrationProvenanceRecoveredFrom:priorValidation.migrationProvenanceRecoveredFrom}:{})}:validation;
  if (!validation.ok) { await db.from('commerce_config_releases').update({ status: 'draft', validation_result: publishedValidation }).eq('id', releaseId); throw Error(`发布校验未通过：${validation.issues.join('；')}`); }
  const staged=await db.from('commerce_config_releases').update({ status: 'validated', validation_result: publishedValidation }).eq('id', releaseId).eq('is_current',false).in('status',['draft','validated']).select('id,manifest_sha256').maybeSingle();
  if(staged.error||!staged.data||String(staged.data.manifest_sha256)!==preview.candidate.manifestSha256)throw Error('发布候选在校验后已经变化，请重新预览');
  const result = await db.rpc('publish_commerce_config_release_atomic', {
    p_release_id: releaseId,
    p_actor_id: actorId,
    p_expected_candidate_sha: preview.candidate.manifestSha256,
    p_expected_current_id: preview.current?.releaseId||null,
    p_expected_current_sha: preview.current?.manifestSha256||null,
  });
  if (result.error) throw Error(`原子发布失败：${result.error.message}`);
  const readback=await db.from('commerce_config_releases').select('id,status,is_current,manifest_sha256,release_version').eq('id',releaseId).maybeSingle();
  if(readback.error||!readback.data||readback.data.status!=='published'||readback.data.is_current!==true||String(readback.data.manifest_sha256)!==preview.candidate.manifestSha256)throw Error('原子发布后的数据库读回身份不一致');
  invalidatePublishedCommerceConfiguration();
  const runtime=await primePublishedCommerceConfiguration({force:true,required:true});
  if(!runtime||runtime.releaseId!==releaseId||runtime.manifestSha256!==preview.candidate.manifestSha256)throw Error('原子发布后的运行配置读回身份不一致');
  return readback.data;
}

export async function rollbackRelease(actorId: string, targetId: string) {
  if (!UUID.test(targetId)) throw Error('回滚目标 ID 无效');
  const db = getSupabaseAdminClient(); const target = await db.from('commerce_config_releases').select('*').eq('id', targetId).maybeSingle();
  if (target.error || !target.data) throw Error('回滚目标不存在');
  if(target.data.is_current===true||!['published','superseded'].includes(String(target.data.status)))throw Error('回滚目标必须是非当前的历史发布版本');
  const validation = await validateReleaseManifest(target.data.manifest as CommerceReleaseManifest, false);
  if (!validation.ok) throw Error(`回滚目标已不满足当前门禁：${validation.issues.join('；')}`);
  const latest = await db.from('commerce_config_releases').select('release_version').order('release_version', { ascending: false }).limit(1);
  const created = await db.from('commerce_config_releases').insert({ release_version: Number(latest.data?.[0]?.release_version || 0) + 1, status: 'validated', is_current: false, manifest: target.data.manifest, validation_result: { ...validation, rollbackTargetId: targetId }, manifest_sha256: target.data.manifest_sha256, rollback_target_id: targetId, created_by: actorId }).select('*').single();
  if (created.error) throw Error(`创建回滚版本失败：${created.error.message}`);
  return created.data;
}
