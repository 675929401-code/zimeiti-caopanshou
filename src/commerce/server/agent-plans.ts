import {createHash,randomUUID} from 'node:crypto';
import {get,put,list,transaction,claim} from './store';
import {job} from './jobs';
import {readAsset} from './assets';
import {models,type Model} from './models';
import {resolveOperation} from './operation-routing';
import {validateImageInput} from '../image-input-contract';
import {parseAgentPlan,type AgentPlanSpec} from './agent-plan-schema';
import {compileAgentPlan,verifyPlanAssetBytes,type PlanPreview,type PlanStepBillingSnapshot} from './agent-plan-compiler';
import {createWorkflowInTransaction,validateGraph,type Workflow} from './workflows';
import {billingQuantity,quoteCost,quotePrice} from './billing';
import {chargeAggregateQuoteAtConfirm,refundAggregateQuoteBeforeDispatch} from './billing';
import {assertPublishedCommercePaidJobsReady,currentPublishedCommerceConfiguration,primePublishedCommerceConfiguration,stableJson} from './configuration-platform';
import {requireCommerceModelAcceptance} from './model-acceptance';
import {assertCuratedMainCatalogExecutionReady,curatedMainCatalogExecutionReadiness} from './commerce-curated-model-profiles';

export type AgentPlan={
  id:string;
  owner:string;
  sourceJobId:string;
  conversationId?:string;
  spec:AgentPlanSpec;
  createdAt:number;
  updatedAt:number;
  workflowId?:string;
  canvasId?:string;
  bindings:Record<string,string>;
  preview?:PlanPreview;
  confirmationFingerprint?:string;
  quoteId?:string;
};

type AgentPlanQuoteStep=PlanStepBillingSnapshot&{stepId:string;label:string;kind:'image'|'video';modelDisplayName:string};
type StoredAgentPlanQuote={
  schema:'commerce-agent-plan-quote/v1';
  id:string;
  owner:string;
  planId:string;
  previewFingerprint:string;
  fingerprint:string;
  spec:AgentPlanSpec;
  bindings:Record<string,string>;
  steps:AgentPlanQuoteStep[];
  payableTotal:number;
  estimatedTotalCost:number;
  profitAmount:number;
  currency:'CNY';
  releaseId?:string;
  releaseVersion?:number;
  manifestSha256?:string;
  createdAt:number;
  expiresAt:number;
  status:'quoted'|'consumed'|'expired';
  clientRequestId?:string;
  workflowId?:string;
};

type ConfirmationInput={spec?:AgentPlanSpec;bindings?:Record<string,string>;confirmationFingerprint?:string;quoteId?:string;clientRequestId?:string};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const round=(value:number)=>Math.round(value*10000)/10000;

export const agentPlans=(owner:string)=>list<AgentPlan>('agent-plans',owner);

export function publicAgentPlan(plan:AgentPlan){
  const videoStepIds=new Set(plan.spec.steps.filter((step)=>step.kind==='video').map((step)=>step.id));
  const preview=plan.preview?{...plan.preview,steps:plan.preview.steps.map(({modelId,...step})=>({...step,...(step.kind==='video'&&modelId?{modelId}:{})}))}:undefined;
  const {owner:_,bindings,confirmationFingerprint:__,...rest}=plan;
  return {...rest,...(preview?{preview}:{}),bindings:Object.fromEntries(Object.entries(bindings).filter(([stepId])=>videoStepIds.has(stepId)))};
}

function publicQuote(quote:StoredAgentPlanQuote){
  return {
    id:quote.id,schema:quote.schema,planId:quote.planId,previewFingerprint:quote.previewFingerprint,
    steps:quote.steps.map((step)=>({stepId:step.stepId,label:step.label,kind:step.kind,model:{...(step.kind==='video'?{id:step.modelId}:{}),displayName:step.modelDisplayName},billingUnit:step.billingUnit,quantity:step.quantity,unitPrice:step.unitPrice,payableTotal:step.payableTotal})),
    payableTotal:quote.payableTotal,currency:quote.currency,releaseVersion:quote.releaseVersion,expiresAt:quote.expiresAt,status:quote.status,workflowId:quote.workflowId,
  };
}

export function prepareAgentPlan(owner:string,jobId:string){
  const previous=get<AgentPlan>('agent-plans',jobId,owner);if(previous)return previous;
  const source=job(jobId,owner);if(!source||source.input.kind!=='agent'||source.status!=='succeeded')throw Error('请先完成 Agent 对话');
  const spec=parseAgentPlan(source.text||'',source.input.references?.length||0);if(!spec)throw Error('这条回复没有执行计划，请让 Agent 根据素材整理可执行的创作计划');
  const value:AgentPlan={id:jobId,owner,sourceJobId:jobId,conversationId:source.input.conversationId,spec,createdAt:Date.now(),updatedAt:Date.now(),bindings:{}};
  for(const step of spec.steps){try{value.bindings[step.id]=resolveOperation({kind:step.kind,skillId:step.skillId}).modelId;}catch{value.bindings[step.id]='';}}
  put('agent-plans',value.id,owner,value);return value;
}

function validateStep(step:AgentPlanSpec['steps'][number],model:Model,sourceTypes:string[]){
  const caps=model.capabilities;if(caps.available===false||caps.executionSupported===false)throw Error(`${step.label}：模型暂不可用`);
  if(Array.isArray(caps.aspectRatios)&&!caps.aspectRatios.includes(step.aspectRatio))throw Error(`${step.label}：该模型不支持 ${step.aspectRatio}`);
  if(Array.isArray(caps.resolutionOptions)&&step.resolution&&!caps.resolutionOptions.some(r=>String(r).toLowerCase()===step.resolution!.toLowerCase()))throw Error(`${step.label}：该模型不支持 ${step.resolution}`);
  if(step.kind==='image'){const refs=step.references.map((r,i)=>({id:'ref-'+i,slot:r.slot}));validateImageInput({skillId:step.skillId,prompt:step.prompt,references:refs},refs.map((r,i)=>({id:r.id,type:sourceTypes[i]})),caps);return;}
  const durations=caps.nativeDurations||caps.durationOptions;if(Array.isArray(durations)&&durations.length&&!durations.includes(step.duration))throw Error(`${step.label}：请选择该模型支持的时长 ${durations.join('/')} 秒`);
  const imageCount=sourceTypes.filter(s=>s.startsWith('image/')).length,maximum=caps.maxReferenceImages===undefined?1:Number(caps.maxReferenceImages);
  if(!Number.isFinite(maximum)||maximum<0||imageCount>maximum)throw Error(`${step.label}：参考图超出模型限制`);
  const minimum=Math.max(caps.requiresImage?1:0,caps.minReferenceImages===undefined?0:Number(caps.minReferenceImages));
  if(!Number.isFinite(minimum)||minimum<0)throw Error(`${step.label}：模型参考图最低数量无效`);
  if(imageCount<minimum||caps.requiresLastFrame&&imageCount<2)throw Error(`${step.label}：缺少参考图或尾帧`);
  if(sourceTypes.some(s=>s.startsWith('audio/')))throw Error('普通 Agent 计划尚不支持音频，请先提供文字');
  const videoCount=sourceTypes.filter(s=>s.startsWith('video/')).length;if(videoCount&&(!caps.supportsSourceVideoInput||videoCount>1)||caps.requiresSourceVideo&&!videoCount)throw Error(step.label+'：源视频与模型能力不符');
  if(step.references.some(r=>r.slot!=='reference'))throw Error(step.label+'：普通视频计划引用请选择 reference 角色');
}

async function prepareCompilation(owner:string,id:string,input:ConfirmationInput){
  await primePublishedCommerceConfiguration({required:false});
  const plan=get<AgentPlan>('agent-plans',id,owner);if(!plan)throw Error('执行计划不存在');
  const source=job(plan.sourceJobId,owner);if(!source)throw Error('计划来源已删除或不属于当前账号');
  const spec=parseAgentPlan('```commerce-plan\n'+JSON.stringify(input.spec||plan.spec)+'\n```',source.input.references?.length||0)!;
  if(input.bindings!==undefined&&(!input.bindings||typeof input.bindings!=='object'||Array.isArray(input.bindings)||Object.entries(input.bindings).some(([key,value])=>!spec.steps.some(s=>s.id===key&&s.kind==='video')||typeof value!=='string')))throw Error('只有视频步骤允许选择模型');
  const bindings={...plan.bindings,...input.bindings},all=(await Promise.all(['image','video'].map(kind=>models(kind as 'image'|'video')))).flat(),selected:Model[]=[];
  for(const step of spec.steps){
    const routed=resolveOperation({kind:step.kind,skillId:step.skillId,...(step.kind==='video'?{modelId:bindings[step.id]}:{})});
    bindings[step.id]=routed.modelId;
    const model=all.find(m=>m.id===routed.modelId&&m.kind===step.kind);if(!model)throw Error(`${step.label}：请选择可用模型`);if(step.kind==='image')assertCuratedMainCatalogExecutionReady(model);
    step.resolution||=String(model.capabilities.defaultResolution||(step.kind==='image'?'1K':'720p'));
    const types=step.references.map(ref=>{if(ref.step)return 'image/png';const a=readAsset(source.input.references![ref.source!-1].id,owner);if(!a)throw Error('计划参考素材已删除');return a.type;});
    validateStep(step,model,types);selected.push(model);
  }
  const compiled=compileAgentPlan(owner,id,source,spec,bindings);validateGraph(compiled.nodes,compiled.edges);
  for(const [index,step] of compiled.preview.steps.entries()){
    const model=selected[index],settings=spec.steps[index];
    Object.assign(step,{...(settings.kind==='video'?{modelId:model.id}:{}),modelLabel:model.displayName,referencePrice:quotePrice({kind:settings.kind,duration:settings.duration},model),aspectRatio:settings.aspectRatio,resolution:settings.resolution,...(settings.duration?{duration:settings.duration}:{})});
  }
  compiled.preview.fingerprint=createHash('sha256').update(JSON.stringify({compiled:compiled.preview.fingerprint,models:selected.map(({secret:_,...m})=>m)})).digest('hex');
  return {plan,source,spec,bindings,selected,compiled};
}

async function quoteSteps(value:Awaited<ReturnType<typeof prepareCompilation>>):Promise<AgentPlanQuoteStep[]>{
  const published=value.selected.some(model=>model.kind==='video')?currentPublishedCommerceConfiguration():undefined;
  return Promise.all(value.spec.steps.map(async(step,index)=>{
    const model=value.selected[index];
    if(!model.configHash)throw Error(`${step.label}：模型配置哈希缺失，已停止报价`);
    if(published&&!curatedMainCatalogExecutionReadiness(model).ready)await requireCommerceModelAcceptance(model,`${step.label}：模型`);
    const route=resolveOperation({kind:step.kind,skillId:step.skillId,...(step.kind==='video'?{modelId:model.id}:{})});
    if(route.modelId!==model.id)throw Error(`${step.label}：模型路由已变化，请重新预览`);
    const quantity=billingQuantity({kind:step.kind,duration:step.duration},model);
    const estimatedTotalCost=quoteCost({kind:step.kind,duration:step.duration},model);
    const payableTotal=quotePrice({kind:step.kind,duration:step.duration},model);
    if(payableTotal<estimatedTotalCost)throw Error(`${step.label}：模型售价低于成本，已停止报价`);
    if(payableTotal===0&&model.capabilities.explicitlyFree!==true)throw Error(`${step.label}：0 元模型未显式标记免费，已停止报价`);
    return {stepId:step.id,label:step.label,kind:step.kind,operationId:route.id,modelId:model.id,modelDisplayName:model.displayName,modelConfigHash:model.configHash,billingUnit:model.billingUnit,quantity,unitCost:Number(model.costPrice),estimatedTotalCost,unitPrice:Number(model.publicPrice),payableTotal};
  }));
}

function quoteFingerprint(value:Awaited<ReturnType<typeof prepareCompilation>>,steps:AgentPlanQuoteStep[]){
  const published=steps.some(step=>step.kind==='video')?currentPublishedCommerceConfiguration():undefined;
  return createHash('sha256').update(stableJson({planId:value.plan.id,previewFingerprint:value.compiled.preview.fingerprint,steps,releaseId:published?.releaseId,releaseVersion:published?.releaseVersion,manifestSha256:published?.manifestSha256})).digest('hex');
}

export async function previewAgentPlan(owner:string,id:string,input:ConfirmationInput){
  const value=await prepareCompilation(owner,id,input);await verifyPlanAssetBytes(owner,value.compiled.sourceAssets.map(a=>({assetId:a.id,sha256:a.sha256})));return value.compiled.preview;
}

export async function quoteAgentPlan(owner:string,id:string,input:ConfirmationInput){
  const value=await prepareCompilation(owner,id,input);
  const needsPublishedVideo=value.selected.some(model=>model.kind==='video');
  if(needsPublishedVideo){await primePublishedCommerceConfiguration({required:process.env.SHARED_CONFIGURATION_ENABLED==='1'});assertPublishedCommercePaidJobsReady();}
  await verifyPlanAssetBytes(owner,value.compiled.sourceAssets.map(a=>({assetId:a.id,sha256:a.sha256})));
  const steps=await quoteSteps(value),published=needsPublishedVideo?currentPublishedCommerceConfiguration():undefined,now=Date.now();
  const quote:StoredAgentPlanQuote={schema:'commerce-agent-plan-quote/v1',id:randomUUID(),owner,planId:id,previewFingerprint:value.compiled.preview.fingerprint,fingerprint:quoteFingerprint(value,steps),spec:value.spec,bindings:value.bindings,steps,payableTotal:round(steps.reduce((sum,step)=>sum+step.payableTotal,0)),estimatedTotalCost:round(steps.reduce((sum,step)=>sum+step.estimatedTotalCost,0)),profitAmount:round(steps.reduce((sum,step)=>sum+step.payableTotal-step.estimatedTotalCost,0)),currency:'CNY',...(published?{releaseId:published.releaseId,releaseVersion:published.releaseVersion,manifestSha256:published.manifestSha256}:{}),createdAt:now,expiresAt:now+10*60_000,status:'quoted'};
  put('agent-plan-quotes',quote.id,owner,quote);
  return {preview:value.compiled.preview,quote:publicQuote(quote)};
}

async function assertQuoteCurrent(quote:StoredAgentPlanQuote,value:Awaited<ReturnType<typeof prepareCompilation>>){
  const published=currentPublishedCommerceConfiguration();
  if(quote.releaseId&&(!published||published.releaseId!==quote.releaseId||published.releaseVersion!==quote.releaseVersion||published.manifestSha256!==quote.manifestSha256))throw Error('报价对应的配置版本已经变化，请重新报价');
  const steps=await quoteSteps(value);
  if(value.compiled.preview.fingerprint!==quote.previewFingerprint||quoteFingerprint(value,steps)!==quote.fingerprint)throw Error('计划、素材、模型或价格已经变化，请重新报价');
  return steps;
}

export async function confirmAgentPlan(owner:string,id:string,input:ConfirmationInput){
  const quoteId=String(input.quoteId||''),clientRequestId=String(input.clientRequestId||'');
  if(!UUID.test(quoteId)||!UUID.test(clientRequestId))throw Error('计划报价或客户端请求号无效');
  const quote=get<StoredAgentPlanQuote>('agent-plan-quotes',quoteId,owner);if(!quote||quote.planId!==id)throw Error('计划报价不存在或不属于当前账号');
  if(quote.workflowId){if(quote.clientRequestId!==clientRequestId)throw Error('该计划报价已由另一客户端请求确认');const existing=get<Workflow>('workflows',quote.workflowId,owner);if(existing)return existing;throw Error('原执行记录不可用，请核对原任务');}
  if(quote.expiresAt<Date.now()){put('agent-plan-quotes',quote.id,owner,{...quote,status:'expired'});throw Error('计划报价已过期，请重新报价');}
  const original=get<AgentPlan>('agent-plans',id,owner);if(!original)throw Error('执行计划不存在');
  if(original.workflowId){const existing=get<Workflow>('workflows',original.workflowId,owner);if(existing)return existing;throw Error('原执行记录不可用，请核对原任务');}
  const needsPublishedVideo=quote.steps.some(step=>step.kind==='video');
  await primePublishedCommerceConfiguration({force:Boolean(quote.releaseId),required:needsPublishedVideo&&process.env.SHARED_CONFIGURATION_ENABLED==='1'});
  if(needsPublishedVideo)assertPublishedCommercePaidJobsReady();
  const videoBindings=Object.fromEntries(Object.entries(quote.bindings).filter(([stepId])=>quote.spec.steps.some((step)=>step.id===stepId&&step.kind==='video')));
  const value=await prepareCompilation(owner,id,{spec:quote.spec,bindings:videoBindings});
  if(input.confirmationFingerprint!==quote.previewFingerprint)throw Error('计划预览与正式报价不一致，请重新报价');
  const steps=await assertQuoteCurrent(quote,value);
  await verifyPlanAssetBytes(owner,value.compiled.sourceAssets.map(a=>({assetId:a.id,sha256:a.sha256})));
  await chargeAggregateQuoteAtConfirm({
    id:quote.id,owner:quote.owner,payableTotal:quote.payableTotal,estimatedTotalCost:quote.estimatedTotalCost,
    items:quote.steps.map(step=>({key:step.stepId,kind:step.kind,modelId:step.modelId,modelConfigHash:step.modelConfigHash,billingUnit:step.billingUnit,quantity:step.quantity,estimatedTotalCost:step.estimatedTotalCost,payableTotal:step.payableTotal})),
  },`带货Agent 执行计划 · ${quote.steps.length} 个生成步骤`);
  for(const step of steps)value.compiled.execution.steps[step.stepId].billingSnapshot=step;
  Object.assign(value.compiled.execution,{quoteId:quote.id,quoteFingerprint:quote.fingerprint,clientRequestId,...(quote.releaseId?{releaseId:quote.releaseId,releaseVersion:quote.releaseVersion,manifestSha256:quote.manifestSha256}:{})});
  try{
    return transaction(()=>{
      const confirmation=claim(`${owner}:agent-plan-quote:${quote.id}`,quote.fingerprint,clientRequestId);if(!confirmation.created&&confirmation.id!==clientRequestId)throw Error('该计划报价已由另一客户端请求确认');
      const latest=get<AgentPlan>('agent-plans',id,owner);if(!latest)throw Error('执行计划已删除');
      if(latest.workflowId){const existing=get<Workflow>('workflows',latest.workflowId,owner);if(!existing)throw Error('原执行记录不可用');return existing;}
      const current=job(value.source.id,owner);if(!current||current.status!=='succeeded'||current.text!==value.source.text||JSON.stringify(current.input)!==JSON.stringify(value.source.input))throw Error('来源对话已改变，请重新报价');
      for(const old of value.compiled.sourceAssets){const a=readAsset(old.id,owner);if(!a||a.sha256!==old.sha256||a.type!==old.type)throw Error('计划参考素材已改变，请重新报价');}
      const canvasId=latest.canvasId||randomUUID();put('canvases',canvasId,owner,{id:canvasId,title:value.spec.title,nodes:value.compiled.nodes,edges:value.compiled.edges,createdAt:Date.now(),updatedAt:Date.now(),sourcePlanId:id});
      const workflow=createWorkflowInTransaction(owner,canvasId,undefined,value.compiled.execution);
      put('agent-plan-quotes',quote.id,owner,{...quote,status:'consumed',clientRequestId,workflowId:workflow.id});
      put('agent-plans',id,owner,{...latest,canvasId,workflowId:workflow.id,spec:value.spec,bindings:value.bindings,preview:value.compiled.preview,confirmationFingerprint:quote.previewFingerprint,quoteId:quote.id,updatedAt:Date.now()});
      return workflow;
    });
  }catch(error){
    const currentQuote=get<StoredAgentPlanQuote>('agent-plan-quotes',quote.id,owner);
    if(!currentQuote?.workflowId)await refundAggregateQuoteBeforeDispatch(owner,quote.id);
    throw error;
  }
}
