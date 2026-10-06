import crypto, { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import type { CommerceCardVersion, CommerceKnowledgeDocument, CommercePromptVersion, CommerceReleaseManifest, CommerceRoutePolicy } from '../shared/configuration-types';
import { billingQuantity, getJobBillingState, providerCost, quoteCost, quotePrice } from './billing';
import { cardAcceptanceKey, cardContractHash, cardQualityDimensions, commerceCardAcceptanceIndex, validateCardQualityScorecard, type CardAcceptanceScenario } from './card-acceptance';
import { validateCommerceCardContractInput } from './configuration-admin';
import { stableJson } from './configuration-platform';
import { directorCanaryQualityIssues, parseDirectorOutput, DIRECTOR_OUTPUT_PROTOCOL } from './director-output';
import { createJob, job, runJob, type CardCanaryExecutionContext, type JobInput } from './jobs';
import { requireCommerceModelAcceptance } from './model-acceptance';
import { selectedModel, type Kind, type Model } from './models';
import { assetBytes, readAsset } from './assets';
import { getImageInputContract, normalizeImageFormat } from '../image-input-contract';
import { inspectGeneratedImageOutput } from './image-output-contract';
import { get, put, transaction } from './store';
import { stageCardCanaryImageTextWorkflow } from './image-workflow-context';

type Row=Record<string,unknown>;
type DirectorRevisionTarget={shotId:string;field:'speech'|'visual'|'camera';replacement:string};
type CardCanaryQuote={
  schema:'commerce-card-canary-quote/v1'|'commerce-card-canary-quote/v2';id:string;actorId:string;owner:string;marker:string;releaseId:string;releaseVersion:number;manifestSha256:string;
  cardVersionId:string;cardContractHash:string;stableKey:string;input:JobInput;contractInput:{materials:Record<string,unknown[]>;fields:Record<string,unknown>};inputFingerprint:string;
  context:CardCanaryExecutionContext;modelId:string;modelConfigHash:string;publicPrice:number;costPrice:number;billingUnit:Model['billingUnit'];quantity:number;
  scenarioKind?:CardAcceptanceScenario;sourceCanaryJobId?:string;sourceOutputHash?:string;revisionTarget?:DirectorRevisionTarget;
  imageScriptText?:string;imageScriptTextHash?:string;
  estimatedProviderCost:number;ordinaryUserPrice:number;qualityDimensions:string[];createdAt:number;expiresAt:number;status:'quoted'|'submitted'|'completed';jobId?:string;
};

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function object(value:unknown):Row{return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};}
function strings(value:unknown):string[]{return Array.isArray(value)?value.map(String):[];}
function fingerprint(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}
function card(row:Row,stableKey:string):CommerceCardVersion{return {id:String(row.id),cardId:String(row.card_id),stableKey,version:Number(row.version),display:object(row.display) as unknown as CommerceCardVersion['display'],materialSlots:(Array.isArray(row.material_slots)?row.material_slots:[]) as CommerceCardVersion['materialSlots'],inputFields:(Array.isArray(row.input_fields)?row.input_fields:[]) as CommerceCardVersion['inputFields'],executorType:row.executor_type as CommerceCardVersion['executorType'],promptVersionId:typeof row.prompt_version_id==='string'?row.prompt_version_id:null,knowledgeDocumentIds:strings(row.knowledge_document_ids),outputContract:object(row.output_contract),qualityRules:object(row.quality_rules),modelPolicy:object(row.model_policy),videoDefaults:object(row.video_defaults),testCases:Array.isArray(row.test_cases)?row.test_cases:[],status:row.status as CommerceCardVersion['status'],validationResult:object(row.validation_result)};}
function prompt(row:Row):CommercePromptVersion{return {id:String(row.id),promptKey:String(row.prompt_key),version:Number(row.version),name:String(row.name),content:String(row.content),source:String(row.source),status:row.status as CommercePromptVersion['status']};}
function knowledge(row:Row):CommerceKnowledgeDocument{return {id:String(row.id),knowledgeKey:String(row.knowledge_key),version:Number(row.version),name:String(row.name),content:String(row.content),enabled:row.enabled===true,applicableCardKeys:strings(row.applicable_card_keys),status:row.status as CommerceKnowledgeDocument['status']};}
function route(row:Row):CommerceRoutePolicy{return {id:String(row.id),operationId:String(row.operation_id),version:Number(row.version),label:String(row.label),modelKind:row.model_kind as CommerceRoutePolicy['modelKind'],primaryModelId:String(row.primary_model_id),fallbackModelIds:strings(row.fallback_model_ids),capabilityRequirements:object(row.capability_requirements),userSelectable:row.user_selectable===true,status:row.status as CommerceRoutePolicy['status']};}
function publicQuote(value:CardCanaryQuote){return {id:value.id,marker:value.marker,releaseId:value.releaseId,releaseVersion:value.releaseVersion,cardVersionId:value.cardVersionId,cardContractHash:value.cardContractHash,stableKey:value.stableKey,scenarioKind:value.scenarioKind||'standard',sourceCanaryJobId:value.sourceCanaryJobId,revisionTarget:value.revisionTarget,kind:value.input.kind,modelId:value.modelId,modelConfigHash:value.modelConfigHash,inputFingerprint:value.inputFingerprint,imageScriptTextHash:value.imageScriptTextHash,billingUnit:value.billingUnit,quantity:value.quantity,estimatedProviderCost:value.estimatedProviderCost,ordinaryUserPrice:value.ordinaryUserPrice,adminWalletCharge:value.ordinaryUserPrice,qualityDimensions:value.qualityDimensions,expiresAt:value.expiresAt,status:value.status,jobId:value.jobId};}

function revisionTarget(value:unknown):DirectorRevisionTarget{
  const raw=object(value),shotId=String(raw.shotId||'').trim(),field=String(raw.field||''),replacement=String(raw.replacement||'').trim();
  if(!shotId||shotId.length>200||!['speech','visual','camera'].includes(field)||!replacement||replacement.length>1000)throw Error('局部改稿目标必须指定镜头、字段和替换正文');
  return {shotId,field:field as DirectorRevisionTarget['field'],replacement};
}

export function directorRevisionQualityIssues(sourceText:string,revisedText:string,target:DirectorRevisionTarget,context:{skillKey:string;selections:Record<string,string|string[]|boolean|number>;spokenLanguage:string;durationSeconds:number;generateAudio:boolean},references:{id:string;slot:string;name?:string;type?:string}[]=[]){
  const source=parseDirectorOutput(sourceText,context,references,DIRECTOR_OUTPUT_PROTOCOL),revised=parseDirectorOutput(revisedText,context,references,DIRECTOR_OUTPUT_PROTOCOL),issues:string[]=[];
  if(source.replyType!=='script'||!source.script||revised.replyType!=='script'||!revised.script)return ['局部改稿的来源或结果不是完整脚本'];
  const sourceClone=structuredClone(source),revisedClone=structuredClone(revised),sourceShot=sourceClone.script!.shots.find((shot)=>shot.id===target.shotId),revisedShot=revisedClone.script!.shots.find((shot)=>shot.id===target.shotId);
  if(!sourceShot||!revisedShot)return [`局部改稿目标镜头 ${target.shotId} 不存在`];
  if(sourceShot[target.field]===target.replacement)issues.push('局部改稿替换正文与来源相同');
  if(revisedShot[target.field]!==target.replacement)issues.push(`局部改稿没有精确写入 ${target.shotId}.${target.field}`);
  revisedShot[target.field]=sourceShot[target.field];
  const sourceLast=sourceClone.script!.shots.at(-1),sourceClose=sourceClone.script!.conversionClose||'',revisedCloseRaw=revisedClone.script!.conversionClose||'';
  if(target.field==='speech'&&sourceLast?.id===target.shotId&&sourceClose!==revisedCloseRaw){
    const spokenBody=target.replacement.replace(/^.*?[：:]/u,'').replace(/[\s，。！？,.!?]/gu,'');
    const revisedClose=revisedCloseRaw.replace(/[\s，。！？,.!?“”]/gu,'');
    if(!spokenBody||!revisedClose.includes(spokenBody))issues.push('末镜口播修改后的转化摘要没有包含新口播');
    sourceClone.script!.conversionClose=revisedCloseRaw;
  }
  if(stableJson(sourceClone)!==stableJson(revisedClone))issues.push('局部改稿改变了目标字段之外的脚本内容');
  return issues;
}

async function loadContext(releaseId:string,cardVersionId:string):Promise<CardCanaryExecutionContext>{
  if(!UUID.test(releaseId)||!UUID.test(cardVersionId))throw Error('发布候选或卡片版本 ID 无效');const db=getSupabaseAdminClient();
  const releaseResult=await db.from('commerce_config_releases').select('*').eq('id',releaseId).maybeSingle();if(releaseResult.error||!releaseResult.data||!['draft','validated'].includes(String(releaseResult.data.status))||releaseResult.data.is_current===true)throw Error('卡片 canary 只能绑定未发布候选');
  const manifest=releaseResult.data.manifest as CommerceReleaseManifest;if(!manifest.cardVersionIds.includes(cardVersionId))throw Error('卡片版本不在该发布候选中');
  const identity=await db.from('commerce_card_versions').select('*').eq('id',cardVersionId).maybeSingle();if(identity.error||!identity.data)throw Error('卡片版本不存在');
  const cardIdentity=await db.from('commerce_cards').select('stable_key').eq('id',identity.data.card_id).maybeSingle();if(cardIdentity.error||!cardIdentity.data)throw Error('卡片身份不存在');
  const stableKey=String(cardIdentity.data.stable_key||'');const cardValue=card(identity.data,stableKey);if(!['pending_validation','validated'].includes(cardValue.status))throw Error('请先完成卡片合同测试');
  const validation=object(identity.data.validation_result);if(validation.contractTestsPassed!==true)throw Error('卡片的三个服务端合同测试尚未通过');
  if(!cardValue.promptVersionId||!manifest.promptVersionIds.includes(cardValue.promptVersionId))throw Error('卡片提示词没有进入同一候选');
  const promptResult=await db.from('commerce_prompt_versions').select('*').eq('id',cardValue.promptVersionId).maybeSingle();if(promptResult.error||!promptResult.data)throw Error('卡片提示词版本不可用');
  const knowledgeIds=cardValue.knowledgeDocumentIds;if(knowledgeIds.some((id)=>!manifest.knowledgeDocumentIds.includes(id)))throw Error('卡片知识版本没有进入同一候选');
  const knowledgeResult=knowledgeIds.length?await db.from('commerce_knowledge_documents').select('*').in('id',knowledgeIds):{data:[],error:null};if(knowledgeResult.error||(knowledgeResult.data||[]).length!==knowledgeIds.length)throw Error('卡片知识版本不完整');
  const operationId=String(cardValue.modelPolicy.operationId||'');const routesResult=await db.from('commerce_operation_routes').select('*').in('id',manifest.operationRouteIds).eq('operation_id',operationId);if(routesResult.error||(routesResult.data||[]).length!==1)throw Error('卡片功能路由没有唯一进入同一候选');
  const routeValue=route((routesResult.data||[])[0]);const expectedKind:Kind=cardValue.executorType==='director'||cardValue.executorType==='agent_plan'?'agent':cardValue.executorType==='image_skill'?'image':'video';if(routeValue.modelKind!==expectedKind)throw Error('卡片执行器与模型路由类型不匹配');
  return {releaseId:String(releaseResult.data.id),releaseVersion:Number(releaseResult.data.release_version),manifestSha256:String(releaseResult.data.manifest_sha256),card:cardValue,prompt:prompt(promptResult.data),knowledge:(knowledgeResult.data||[]).map(knowledge),route:routeValue};
}

function inputFor(context:CardCanaryExecutionContext,quoteId:string,marker:string,raw:Row,references:{id:string;slot:string}[],fields:Record<string,unknown>,model:Model,scenarioKind:CardAcceptanceScenario,sourceCanaryJobId?:string):JobInput{
  const request=String(raw.userRequest||fields.prompt||`请对中性虚构商品“云朵杯”执行${context.card.display.name}验收。已确认事实：白色杯身、蓝色圆形图案、无价格与功效承诺。`).trim();if(!request||request.length>12000)throw Error('卡片 canary 用户要求无效');
  const base={requestId:quoteId,kind:context.route.modelKind,modelId:model.id,purpose:'commerce-card-canary',prompt:`[${marker}] ${request}`,references,configuredFields:fields} as JobInput;
  if(context.card.executorType==='director')return {...base,director:context.card.stableKey,spokenLanguage:String(fields.spokenLanguage||'中文'),scriptDuration:Number(fields.scriptDuration||15),generateAudio:fields.generateAudio!==false,...(scenarioKind==='revision'&&sourceCanaryJobId?{parentJobId:sourceCanaryJobId}:{})};
  if(context.card.executorType==='image_skill'){const ratios=Array.isArray(model.capabilities.aspectRatios)?model.capabilities.aspectRatios.map(String):['1:1'];const resolutions=Array.isArray(model.capabilities.resolutionOptions)?model.capabilities.resolutionOptions.map(String):['1K'];return {...base,skillId:context.card.stableKey.replace(/^image\./u,''),aspectRatio:String(raw.aspectRatio||fields.aspectRatio||ratios[0]||'1:1'),resolution:String(raw.resolution||fields.resolution||resolutions[0]||'1K'),format:normalizeImageFormat(raw.outputFormat||fields.outputFormat||'PNG')};}
  throw Error('该卡片执行器的真实 canary 尚未接入');
}

export async function createCardCanaryQuote(actorId:string,owner:string,raw:Row){
  const context=await loadContext(String(raw.releaseId||''),String(raw.cardVersionId||''));const model=await selectedModel(context.route.modelKind,context.route.primaryModelId);await requireCommerceModelAcceptance(model,'卡片默认模型');
  if(model.costPrice===null||!Number.isFinite(model.costPrice)||model.costPrice<0||!Number.isFinite(model.publicPrice)||model.publicPrice<model.costPrice)throw Error('卡片默认模型价格不完整');
  const referenceRows=Array.isArray(raw.references)?raw.references.map(object):[];if(referenceRows.length>15)throw Error('卡片 canary 素材过多');const references=referenceRows.map((row)=>({id:String(row.assetId||''),slot:String(row.slot||'')}));
  const materials:Record<string,unknown[]>={};for(const slot of context.card.materialSlots)materials[slot.id]=[];for(const reference of references){const asset=readAsset(reference.id,owner);if(!asset)throw Error('卡片 canary 素材不存在或不属于管理员工作区');if(!Object.hasOwn(materials,reference.slot))throw Error('卡片 canary 素材槽无效');materials[reference.slot].push({mediaType:asset.type.split('/')[0],bytes:asset.size});}
  const fields=object(raw.fields);validateCommerceCardContractInput({material_slots:context.card.materialSlots,input_fields:context.card.inputFields},{materials,fields});
  const scenarioKind=String(raw.scenarioKind||'standard') as CardAcceptanceScenario;if(!['standard','revision','minimum'].includes(scenarioKind))throw Error('卡片 canary 场景无效');
  let sourceCanaryJobId:string|undefined,sourceOutputHash:string|undefined,target:DirectorRevisionTarget|undefined,currentScript:string|undefined,requestRaw=raw;
  const contractHash=cardContractHash(context.card as unknown as Row);
  if(scenarioKind==='revision'){
    if(context.card.executorType!=='director')throw Error('局部改稿 canary 只适用于编导卡片');
    sourceCanaryJobId=String(raw.sourceCanaryJobId||'').trim();const source=job(sourceCanaryJobId,owner);
    if(!source||source.status!=='succeeded'||source.input.purpose!=='commerce-card-canary'||source.configurationSnapshot?.cardVersionId!==context.card.id||!source.text)throw Error('局部改稿必须绑定同一卡片的成功标准 canary');
    if(stableJson(source.input.references||[])!==stableJson(references)||stableJson(source.input.configuredFields||{})!==stableJson(fields))throw Error('局部改稿必须保持标准 canary 的素材与输入字段');
    const acceptance=await commerceCardAcceptanceIndex();if(!acceptance.has(cardAcceptanceKey(context.card.id,contractHash,'standard')))throw Error('请先登记同一卡片当前合同的标准创作 canary 证据');
    target=revisionTarget(raw.revisionTarget);const sourceReply=parseDirectorOutput(source.text,{skillKey:context.card.stableKey,selections:fields as Record<string,string|string[]|boolean|number>,spokenLanguage:String(source.input.spokenLanguage||''),durationSeconds:Number(source.input.scriptDuration||0),generateAudio:source.input.generateAudio!==false},(source.input.references||[]).map((reference)=>{const asset=readAsset(reference.id,owner);return {...reference,name:asset?.name,type:asset?.type};}),DIRECTOR_OUTPUT_PROTOCOL);
    if(sourceReply.replyType!=='script'||!sourceReply.script?.shots.some((shot)=>shot.id===target!.shotId))throw Error('局部改稿目标镜头不在标准脚本中');
    sourceOutputHash=createHash('sha256').update(source.text).digest('hex');currentScript=source.text;
    requestRaw={...raw,userRequest:`只把“${target.shotId}”的 ${target.field} 字段精确改为：${target.replacement}\n必须返回完整 ${DIRECTOR_OUTPUT_PROTOCOL} JSON；除这个字段外，每个字符、数组顺序和约束都保持当前脚本不变。`};
  }
  const quoteId=crypto.randomUUID(),marker=`COMMERCE-CARD-CANARY-${new Date().toISOString().replace(/[-:.TZ]/gu,'').slice(0,14)}-${crypto.randomUUID().slice(0,8)}`,input=inputFor(context,quoteId,marker,requestRaw,references,fields,model,scenarioKind,sourceCanaryJobId),quantity=billingQuantity(input,model),estimatedProviderCost=quoteCost(input,model),ordinaryUserPrice=quotePrice(input,model),now=Date.now(),executionContext:CardCanaryExecutionContext={...context,canaryScenario:{kind:scenarioKind,sourceJobId:sourceCanaryJobId,currentScript}};
  let imageScriptText:string|undefined,imageScriptTextHash:string|undefined;
  if(input.kind==='image'&&getImageInputContract(input.skillId).minTextReferences){
    imageScriptText=String(raw.scriptText||'').trim();
    if(!imageScriptText||imageScriptText.length>20000)throw Error('脚本故事版 canary 需要提供 1—20000 字的完整脚本文本');
    imageScriptTextHash=createHash('sha256').update(imageScriptText).digest('hex');
  }
  const inputFingerprint=fingerprint(imageScriptTextHash?{input,imageScriptTextHash}:input);
  const quote:CardCanaryQuote={schema:'commerce-card-canary-quote/v2',id:quoteId,actorId,owner,marker,releaseId:context.releaseId,releaseVersion:context.releaseVersion,manifestSha256:context.manifestSha256,cardVersionId:context.card.id,cardContractHash:contractHash,stableKey:context.card.stableKey,input,contractInput:{materials,fields},inputFingerprint,context:executionContext,scenarioKind,sourceCanaryJobId,sourceOutputHash,revisionTarget:target,imageScriptText,imageScriptTextHash,modelId:model.id,modelConfigHash:model.configHash,publicPrice:model.publicPrice,costPrice:model.costPrice,billingUnit:model.billingUnit,quantity,estimatedProviderCost,ordinaryUserPrice,qualityDimensions:cardQualityDimensions(context.card.executorType,scenarioKind),createdAt:now,expiresAt:now+10*60_000,status:'quoted'};
  put('card-canary-quotes',quote.id,owner,quote);return publicQuote(quote);
}

export async function confirmCardCanaryQuote(actorId:string,owner:string,quoteId:string,inputFingerprint:string){
  const quote=get<CardCanaryQuote>('card-canary-quotes',quoteId,owner);if(!quote||quote.actorId!==actorId)throw Error('卡片 canary 报价不存在或不属于当前管理员');if(quote.inputFingerprint!==inputFingerprint)throw Error('卡片 canary 输入指纹不一致');if(quote.expiresAt<Date.now())throw Error('卡片 canary 报价已过期，请重新报价');if(quote.jobId){const existing=job(quote.jobId,owner);if(!existing)throw Error('原卡片 canary 任务正在创建，请按原任务核对');if(existing.configurationSnapshot?.quoteId!==quote.id||existing.configurationSnapshot.inputFingerprint!==quote.inputFingerprint||existing.configurationSnapshot.clientRequestId!==quote.id)throw Error('原卡片 canary 任务缺少完整报价快照');return {quote:publicQuote(quote),job:existing};}
  const currentContext=await loadContext(quote.releaseId,quote.cardVersionId),model=await selectedModel(quote.input.kind,quote.modelId);if(cardContractHash(currentContext.card as unknown as Row)!==quote.cardContractHash||currentContext.manifestSha256!==quote.manifestSha256||currentContext.prompt.id!==quote.context.prompt.id||currentContext.route.id!==quote.context.route.id||model.configHash!==quote.modelConfigHash||model.publicPrice!==quote.publicPrice||model.costPrice!==quote.costPrice||model.billingUnit!==quote.billingUnit)throw Error('卡片、提示词、路由、模型或价格已经变化，请重新报价');
  if((quote.scenarioKind||'standard')==='revision'){
    const source=job(quote.sourceCanaryJobId||'',owner);if(!source?.text||source.status!=='succeeded'||createHash('sha256').update(source.text).digest('hex')!==quote.sourceOutputHash)throw Error('局部改稿来源脚本已经变化');
  }
  await requireCommerceModelAcceptance(model,'卡片默认模型');
  const stagedText=stageCardCanaryImageTextWorkflow(owner,quote.input,quote.imageScriptText);
  let created;
  try{
    created=await createJob(owner,quote.input,stagedText?.executionContext,{adminCanaryModelId:quote.modelId,cardCanary:{...currentContext,canaryScenario:quote.context.canaryScenario},quoteBinding:{quoteId:quote.id,inputFingerprint:quote.inputFingerprint,clientRequestId:quote.id}});
  }finally{
    stagedText?.cleanup();
  }
  if(stagedText&&stagedText.scriptTextHash!==quote.imageScriptTextHash)throw Error('脚本故事版 canary 来源指纹已经变化');
  if(!created.configurationSnapshot||created.configurationSnapshot.cardVersionId!==quote.cardVersionId)throw Error('卡片 canary 任务没有绑定草稿快照');
  transaction(()=>{const current=get<CardCanaryQuote>('card-canary-quotes',quote.id,owner);if(!current)throw Error('卡片 canary 报价状态丢失');current.status='submitted';current.jobId=created.id;put('card-canary-quotes',current.id,owner,current);});void runJob(created.id,owner).catch(()=>{});return {quote:publicQuote({...quote,status:'submitted',jobId:created.id}),job:created};
}

export async function registerCardCanaryEvidence(actorId:string,owner:string,jobId:string,rawScorecard:unknown){
  const value=job(jobId,owner);if(!value||value.input.purpose!=='commerce-card-canary'||!value.configurationSnapshot?.cardVersionId)throw Error('只允许登记当前管理员的受控卡片 canary');const quote=get<CardCanaryQuote>('card-canary-quotes',value.configurationSnapshot.quoteId||value.input.requestId,owner);if(!quote||quote.actorId!==actorId||quote.jobId!==value.id||quote.cardVersionId!==value.configurationSnapshot.cardVersionId)throw Error('卡片 canary 报价快照不匹配');
  if(value.status!=='succeeded'||!value.dispatchedAt)throw Error('卡片 canary 尚未成功终结');const billing=getJobBillingState(value);if(!billing||billing.status!=='revenue_recorded'||billing.adminExempt===true)throw Error('卡片 canary 的钱包扣费、供应商成本与收益账务尚未按统一计费规则终结');const context=await loadContext(quote.releaseId,quote.cardVersionId);if(cardContractHash(context.card as unknown as Row)!==quote.cardContractHash)throw Error('卡片合同在 canary 后已经变化');const model=await selectedModel(value.input.kind,value.model.id);if(model.configHash!==value.model.configHash)throw Error('卡片 canary 完成后模型配置已经变化');await requireCommerceModelAcceptance(model,'卡片默认模型');
  const scenarioKind=quote.scenarioKind||'standard';
  let outputValidation:Row;if(context.card.executorType==='director'){const references=(value.input.references||[]).map((reference)=>{const asset=readAsset(reference.id,owner);return {...reference,name:asset?.name,type:asset?.type};}),directorContext={skillKey:context.card.stableKey,selections:quote.contractInput.fields as Record<string,string|string[]|boolean|number>,spokenLanguage:String(value.input.spokenLanguage||''),durationSeconds:Number(value.input.scriptDuration||0),generateAudio:value.input.generateAudio!==false};const reply=parseDirectorOutput(value.text||'',directorContext,references,DIRECTOR_OUTPUT_PROTOCOL);if(reply.replyType!=='script'||!reply.script)throw Error('编导 canary 返回了追问而不是可应用完整脚本');const qualityIssues=directorCanaryQualityIssues(reply);if(qualityIssues.length)throw Error(`编导 canary 自动质检未通过：${qualityIssues.join('；')}`);if(scenarioKind==='revision'){const source=job(quote.sourceCanaryJobId||'',owner);if(!source?.text||!quote.revisionTarget)throw Error('局部改稿来源或目标缺失');const revisionIssues=directorRevisionQualityIssues(source.text,value.text||'',quote.revisionTarget,directorContext,references);if(revisionIssues.length)throw Error(`编导局部改稿保留度未通过：${revisionIssues.join('；')}`);}outputValidation={protocol:reply.schema,replyType:reply.replyType,shots:reply.script.shots.length,materials:reply.script.materials.length,durationSeconds:reply.durationSeconds,deterministicQualityGate:'passed',scenarioKind,...(scenarioKind==='revision'?{sourceCanaryJobId:quote.sourceCanaryJobId,sourceOutputHash:quote.sourceOutputHash,revisionTarget:quote.revisionTarget,revisionPreservation:'exact'}:{})};}else{if(scenarioKind==='revision')throw Error('非编导卡片不能登记局部改稿证据');const imageAssets=value.assetIds.map((id)=>readAsset(id,owner));if(!imageAssets.length||imageAssets.some((asset)=>!asset?.type.startsWith('image/')))throw Error('图片卡片 canary 缺少持久化图片结果');const specifications=await Promise.all(imageAssets.map(async(asset)=>inspectGeneratedImageOutput(await assetBytes(asset!),asset!.type,value.input.aspectRatio,value.input.resolution,value.input.format)));const specificationIssues=specifications.flatMap((item)=>item.issues);if(specificationIssues.length)throw Error(`图片卡片 canary 输出规格未通过：${specificationIssues.join('；')}`);outputValidation={persistedAssets:imageAssets.length,mimeTypes:imageAssets.map((asset)=>asset!.type),specifications,scenarioKind};}
  const scorecard=validateCardQualityScorecard(context.card as unknown as Row,rawScorecard,scenarioKind),cost=providerCost(value).amount,row={card_version_id:quote.cardVersionId,card_contract_hash:quote.cardContractHash,scenario_kind:scenarioKind,source_canary_job_id:quote.sourceCanaryJobId||null,status:'passed',canary_job_id:value.id,quote_id:quote.id,model_kind:value.input.kind,model_id:value.model.id,model_config_hash:value.model.configHash,evidence_asset_ids:value.assetIds,scorecard,overall_score:scorecard.overallScore,hard_errors:[],evidence_summary:{marker:quote.marker,releaseId:quote.releaseId,releaseVersion:quote.releaseVersion,inputFingerprint:quote.inputFingerprint,terminalStatus:value.status,dispatchedAt:value.dispatchedAt,completedAt:value.updatedAt,billingStatus:billing.status,outputValidation},provider_cost:cost,verified_by:actorId,verified_at:new Date().toISOString()};
  const db=getSupabaseAdminClient();const prior=await db.from('commerce_card_acceptance_evidence').select('*').eq('canary_job_id',value.id).eq('status','passed').maybeSingle();if(prior.error)throw Error(`核对卡片 canary 证据失败：${prior.error.message}`);const saved=prior.data?{data:prior.data,error:null}:await db.from('commerce_card_acceptance_evidence').insert(row).select('*').single();if(saved.error)throw Error(`保存卡片 canary 证据失败：${saved.error.message}`);
  const version=await db.from('commerce_card_versions').select('validation_result,status').eq('id',quote.cardVersionId).maybeSingle();if(version.error||!version.data)throw Error('卡片版本在登记后不可读取');const acceptance=await commerceCardAcceptanceIndex(),requiredScenarios:CardAcceptanceScenario[]=context.card.executorType==='director'?['standard','revision']:['standard'],scenarioState=Object.fromEntries(requiredScenarios.map((kind)=>[kind,acceptance.get(cardAcceptanceKey(quote.cardVersionId,quote.cardContractHash,kind))||null])),canaryPassed=requiredScenarios.every((kind)=>Boolean(scenarioState[kind]));const priorValidation=object(version.data.validation_result),priorScenarios=object(priorValidation.cardCanaryScenarios),nextValidation={...priorValidation,qualityScore:canaryPassed?Math.min(...requiredScenarios.map((kind)=>Number(object(scenarioState[kind]).overall_score||0))):scorecard.overallScore,canaryPassed,cardCanaryScenarios:{...priorScenarios,[scenarioKind]:{evidenceId:saved.data.id,jobId:value.id,score:scorecard.overallScore,testedAt:row.verified_at}},cardContractHash:quote.cardContractHash};if(['pending_validation','validated'].includes(String(version.data.status))){const updated=await db.from('commerce_card_versions').update({status:canaryPassed?'validated':'pending_validation',validation_result:nextValidation}).eq('id',quote.cardVersionId).eq('status',version.data.status);if(updated.error)throw Error(`更新卡片验收状态失败：${updated.error.message}`);}
  quote.status='completed';put('card-canary-quotes',quote.id,owner,quote);return saved.data;
}

export function cardCanaryQuoteForJob(owner:string,jobId:string){const value=job(jobId,owner);if(!value)return undefined;const quote=get<CardCanaryQuote>('card-canary-quotes',value.configurationSnapshot?.quoteId||value.input.requestId,owner);return quote?publicQuote(quote):undefined;}
