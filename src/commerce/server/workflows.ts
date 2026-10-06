import {get,put,list,db,transaction,claim} from './store';
import {assertCanvasExecutionAllowed} from './canvas-import-review';
import {createJob,runJob,refreshJob,job,type JobInternalContext} from './jobs';
import {readAsset} from './assets';
import {IMAGE_SKILLS} from '../components/commerce-agent/catalog';
import {selectDependencies,nodeFingerprints} from './workflow-selection';
import {graphOrder,executionEdges} from '../shared/canvas-schema';
import {verifyWorkflowRoles,workflowInput,canvasJobInput} from './workflow-inputs';
import {verifyPlanAssetBytes,type AgentPlanExecution} from './agent-plan-compiler';
import {selectedModel} from './models';
import {resolveOperation} from './operation-routing';
import {billingQuantity,quoteCost,quotePrice,chargeAggregateQuoteAtConfirm,refundAggregateQuoteBeforeDispatch,releaseAggregateUnallocatedLines,type CommerceAggregateBillingLine} from './billing';
import {createHash} from 'node:crypto';
import {assertPublishedCommercePaidJobsReady,currentPublishedCommerceConfiguration,primePublishedCommerceConfiguration,stableJson} from './configuration-platform';
import {readMaterializedCanvasCertification} from './discovery-canvas-certification';
import {requireCommerceModelAcceptance} from './model-acceptance';
import {assertCuratedMainCatalogExecutionReady,usesCuratedMainCatalogDirectExecution} from './commerce-curated-model-profiles';
type Node={id:string;data:{label:string;kind:'text'|'image'|'video'|'audio';prompt:string;modelId?:string;skillId?:string;mode?:string;assetIds?:string[];resolution?:string;aspectRatio?:string;duration?:number;outputFormat?:string;generateAudio?:boolean;}};
type Edge={source:string;target:string;data?:{role?:string;edgeType?:'instruction'|'reference'|'derived'}};
type Output={text:string;assets:{id:string;slot:string}[];};
type CanvasStepBillingSnapshot={nodeId:string;label:string;kind:'agent'|'image'|'video';operationId:string;modelId:string;modelName:string;modelConfigHash:string;billingUnit:'per_use'|'output_second';quantity:number;unitCost:number;estimatedTotalCost:number;unitPrice:number;payableTotal:number};
type CanvasQuoteExecution={quoteId:string;quoteFingerprint:string;clientRequestId:string;releaseId?:string;releaseVersion?:number;manifestSha256?:string;steps:Record<string,CanvasStepBillingSnapshot>};
type MaterializedSnapshotExecution={sourceSha256:string;graphSha256:string;billingMode:'zero-cost-owned-assets'};
type CanvasWorkflowQuote={version:1;id:string;owner:string;canvasId:string;selected?:string[];graphFingerprint:string;executionMode:'generation'|'materialized-snapshot';materializedSnapshot?:MaterializedSnapshotExecution;createdAt:number;expiresAt:number;currency:'CNY';estimatedTotalCost:number;payableTotal:number;profitAmount:number;releaseId?:string;releaseVersion?:number;manifestSha256?:string;status:'quoted'|'consumed'|'expired';items:CanvasStepBillingSnapshot[];clientRequestId?:string;workflowId?:string};
type WorkflowRetryBillingAttempt={quoteId:string;quoteFingerprint:string;clientRequestId:string;releaseId?:string;releaseVersion?:number;manifestSha256?:string;snapshot:CanvasStepBillingSnapshot};
type WorkflowStep={requestId:string;jobId?:string;status:string;output?:Output;fingerprint?:string;reused?:boolean;billingAttempt?:WorkflowRetryBillingAttempt;billingRelease?:{quoteId:string;lineKey:string;amount:number;refundedAt:number}};
type WorkflowRetryItem=CanvasStepBillingSnapshot&{sourceJobId?:string;retryReason:'failed'|'released-unstarted'};
type WorkflowRetryQuote={schema:'commerce-workflow-retry-quote/v1';id:string;owner:string;workflowId:string;workflowFingerprint:string;createdAt:number;expiresAt:number;currency:'CNY';estimatedTotalCost:number;payableTotal:number;profitAmount:number;releaseId?:string;releaseVersion?:number;manifestSha256?:string;status:'quoted'|'consumed'|'expired';items:WorkflowRetryItem[];clientRequestId?:string};
export type Workflow={agentPlanExecution?:AgentPlanExecution;canvasQuoteExecution?:CanvasQuoteExecution;materializedSnapshotExecution?:MaterializedSnapshotExecution;id:string;owner:string;canvasId:string;title:string;nodes:Node[];edges:Edge[];createdAt:number;updatedAt:number;status:'running'|'waiting'|'succeeded'|'blocked'|'paused';error?:string;steps:Record<string,WorkflowStep>;};
const state=globalThis as unknown as {commerceActiveWorkflows?:Set<string>};const running=state.commerceActiveWorkflows||=new Set<string>();
type AggregateStepBillingSnapshot=Pick<CanvasStepBillingSnapshot,'nodeId'|'kind'|'modelId'|'modelConfigHash'|'billingUnit'|'quantity'|'estimatedTotalCost'|'payableTotal'>;
function aggregateLine(snapshot:AggregateStepBillingSnapshot):CommerceAggregateBillingLine{return {key:snapshot.nodeId,kind:snapshot.kind,modelId:snapshot.modelId,modelConfigHash:snapshot.modelConfigHash,billingUnit:snapshot.billingUnit,quantity:snapshot.quantity,estimatedTotalCost:snapshot.estimatedTotalCost,payableTotal:snapshot.payableTotal};}
function aggregateJobContext(quoteId:string,quoteFingerprint:string,clientRequestId:string,nodeId:string,snapshot:AggregateStepBillingSnapshot,release?:{releaseId?:string;releaseVersion?:number;manifestSha256?:string}):JobInternalContext{return {aggregateBilling:{quoteId,quoteFingerprint,clientRequestId,nodeId,item:aggregateLine(snapshot),...(release?.releaseId?{releaseId:release.releaseId,releaseVersion:release.releaseVersion,manifestSha256:release.manifestSha256}:{})}};}
export function workflows(owner:string){return list<Workflow>('workflows',owner);}
export function publicWorkflow(value:Workflow){const {owner:_,agentPlanExecution:__,canvasQuoteExecution:___,materializedSnapshotExecution:____,...rest}=value;return {...rest,steps:Object.fromEntries(Object.entries(rest.steps).map(([id,{billingAttempt:_____,billingRelease:______,...step}])=>[id,step])),nodes:rest.nodes.map((node)=>node.data.kind==='video'?node:{...node,data:Object.fromEntries(Object.entries(node.data).filter(([key])=>key!=='modelId')) as Node['data']})};}
async function verifyPlanBillingSnapshot(node:Node,input:ReturnType<typeof canvasJobInput>,execution:AgentPlanExecution,planStep:NonNullable<AgentPlanExecution['steps'][string]>){
 const snapshot=planStep.billingSnapshot;if(!execution.quoteId||!execution.quoteFingerprint||!execution.clientRequestId||!snapshot)throw Error('执行计划缺少已确认的服务端报价快照');
 const route=resolveOperation(input),model=await selectedModel(input.kind,route.modelId);
 if(route.id!==snapshot.operationId||route.modelId!==snapshot.modelId||node.data.modelId!==snapshot.modelId||model.configHash!==snapshot.modelConfigHash||model.billingUnit!==snapshot.billingUnit||Number(model.publicPrice)!==snapshot.unitPrice||Number(model.costPrice)!==snapshot.unitCost)throw Error('执行计划对应的模型配置或价格已经变化，请重新报价');
 if(billingQuantity(input,model)!==snapshot.quantity||quoteCost(input,model)!==snapshot.estimatedTotalCost||quotePrice(input,model)!==snapshot.payableTotal)throw Error('执行计划计费数量已经变化，请重新报价');
}
async function verifyCanvasBillingSnapshot(input:ReturnType<typeof canvasJobInput>,execution:CanvasQuoteExecution,snapshot:CanvasStepBillingSnapshot){
 const route=resolveOperation(input),model=await selectedModel(input.kind,route.modelId);
 if(route.id!==snapshot.operationId||route.modelId!==snapshot.modelId||model.configHash!==snapshot.modelConfigHash||model.billingUnit!==snapshot.billingUnit||Number(model.publicPrice)!==snapshot.unitPrice||Number(model.costPrice)!==snapshot.unitCost)throw Error(`“${snapshot.label}”的模型配置或价格已经变化，请重新报价`);
 if(billingQuantity(input,model)!==snapshot.quantity||quoteCost(input,model)!==snapshot.estimatedTotalCost||quotePrice(input,model)!==snapshot.payableTotal)throw Error(`“${snapshot.label}”的计费数量已经变化，请重新报价`);
 if(!execution.quoteId||!execution.quoteFingerprint||!execution.clientRequestId)throw Error('画布执行缺少已确认的父报价快照');
}
async function verifyRetryBillingSnapshot(input:ReturnType<typeof canvasJobInput>,attempt:WorkflowRetryBillingAttempt){
 const execution:CanvasQuoteExecution={quoteId:attempt.quoteId,quoteFingerprint:attempt.quoteFingerprint,clientRequestId:attempt.clientRequestId,...(attempt.releaseId?{releaseId:attempt.releaseId,releaseVersion:attempt.releaseVersion,manifestSha256:attempt.manifestSha256}:{}),steps:{[attempt.snapshot.nodeId]:attempt.snapshot}};
 await verifyCanvasBillingSnapshot(input,execution,attempt.snapshot);
}
function canvasWorkflowHistory(owner:string,canvasId:string):Workflow[]{return db().prepare("SELECT value FROM records WHERE bucket='workflows' AND owner=? AND json_extract(value,'$.canvasId')=? ORDER BY updated DESC").all(owner,canvasId).map(row=>JSON.parse(String(row.value)));}
function verifyPreviousWorkflowTerminals(owner:string,history:Workflow[]){
 for(const prior of history)for(const step of Object.values(prior.steps)){
  if(!step.jobId){if(['unknown','save_failed'].includes(step.status))throw Error('原画布存在尚未确认的任务，请先核对原执行记录');continue;}
  const original=job(step.jobId,owner);
  if(!original)throw Error('原画布任务记录无法确认，请先核对原执行记录');
  if(original.status==='save_failed')throw Error('原画布已有生成结果待保存，请先保存原结果，不能重新提交');
  if(original.status!=='succeeded'&&original.status!=='failed')throw Error('原画布任务尚未结束或结果未知，请先核对原执行记录，不能重新提交');
 }
}
export function validateGraph(nodes:Node[],edges:Edge[],limit=30){if(!nodes.length)throw Error('请选择有效执行节点');return graphOrder(nodes,edges,limit);}
function prepareWorkflow(owner:string,canvasId:string,selected?:string[]){
 const canvas=get<{id:string;title:string;nodes:Node[];edges:Edge[]}>('canvases',canvasId,owner);if(!canvas)throw Error('请先保存画布');
 assertCanvasExecutionAllowed(owner,canvasId,canvas.nodes);
 const history=canvasWorkflowHistory(owner,canvasId),ongoing=history.find(w=>['running','waiting','paused'].includes(w.status));if(ongoing)throw Error('这份画布已有未结束的执行记录，请先暂停、恢复或等待原任务');
 verifyPreviousWorkflowTerminals(owner,history);validateGraph(canvas.nodes,canvas.edges,100);
 const selection=selected?.length?[...new Set(selected)].sort():undefined;
 const {nodes,edges}=selectDependencies(canvas.nodes,canvas.edges,selection);validateGraph(nodes,edges);verifyWorkflowRoles(nodes,edges);
 const fingerprints=nodeFingerprints(nodes,edges);
 for(const n of nodes){if(n.data.kind==='audio'&&n.data.mode!=='input')throw Error('音频节点当前作为参考素材输入，请连接支持音频的视频模型');if(n.data.mode==='input'&&n.data.kind!=='text'&&!n.data.assetIds?.length)throw Error(`请为“${n.data.label}”选择输入素材`);if(n.data.mode!=='input'&&n.data.kind==='video'&&!n.data.modelId)throw Error(`请为“${n.data.label}”选择视频模型`);for(const id of n.data.assetIds||[])if(!readAsset(id,owner))throw Error('节点引用的素材不存在');}
 const steps:Workflow['steps']=Object.fromEntries(nodes.map(n=>[n.id,{requestId:crypto.randomUUID(),status:'pending',fingerprint:fingerprints[n.id]}]));
 if(selection?.length)for(const n of nodes){if(selection.includes(n.id))continue;for(const prior of history){const step=prior.steps[n.id];if(step?.status!=='succeeded'||!step.output||step.fingerprint!==fingerprints[n.id])continue;if(step.jobId&&job(step.jobId,owner)?.status!=='succeeded')continue;if(step.output.assets.some(a=>!readAsset(a.id,owner)))continue;steps[n.id]={...step,reused:true};break;}}
 const graphFingerprint=createHash('sha256').update(stableJson({canvasId,title:canvas.title,nodes,edges,selection,fingerprints,reused:Object.entries(steps).filter(([,step])=>step.reused).map(([id])=>id).sort()})).digest('hex');
 return {canvas,history,nodes,edges,selection,fingerprints,steps,graphFingerprint};
}
function publicCanvasQuote(value:CanvasWorkflowQuote){return {id:value.id,canvasId:value.canvasId,graphFingerprint:value.graphFingerprint,executionMode:value.executionMode,currency:value.currency,payableTotal:value.payableTotal,releaseVersion:value.releaseVersion,expiresAt:value.expiresAt,status:value.status,items:value.items.map(item=>({nodeId:item.nodeId,label:item.label,kind:item.kind,model:{...(item.kind==='video'?{id:item.modelId}:{}),displayName:item.modelName},billingUnit:item.billingUnit,quantity:item.quantity,payableTotal:item.payableTotal}))};}
export async function quoteCanvasWorkflow(owner:string,canvasId:string,selected?:string[]){
 const materialized=readMaterializedCanvasCertification(owner,canvasId);
 if(workflows(owner).filter(r=>['running','waiting'].includes(r.status)).length>=2)throw Error('已有两份画布正在运行');
 const prepared=prepareWorkflow(owner,canvasId,selected);
 const needsPublishedVideo=!materialized&&prepared.nodes.some(node=>!prepared.steps[node.id].reused&&node.data.mode!=='input'&&node.data.kind==='video');
 if(!materialized)await primePublishedCommerceConfiguration({required:needsPublishedVideo&&process.env.SHARED_CONFIGURATION_ENABLED==='1'});
 if(needsPublishedVideo)assertPublishedCommercePaidJobsReady();
 const published=needsPublishedVideo?currentPublishedCommerceConfiguration():undefined,certification=materialized&&readMaterializedCanvasCertification(owner,canvasId),items:CanvasStepBillingSnapshot[]=[];
 for(const node of prepared.nodes){const step=prepared.steps[node.id];if(step.reused||node.data.mode==='input'||node.data.kind==='text'&&node.data.mode!=='generate')continue;if(node.data.kind==='audio')throw Error('音频生成模型尚未配置');const draft=canvasJobInput(node,{prompt:node.data.prompt,references:[]});const route=resolveOperation(draft),model=await selectedModel(draft.kind,route.modelId),catalogDirect=usesCuratedMainCatalogDirectExecution(draft.kind);if(catalogDirect)assertCuratedMainCatalogExecutionReady(model);if(!model.configHash)throw Error(`“${node.data.label}”的模型配置哈希缺失，已停止报价`);if(published&&!catalogDirect)await requireCommerceModelAcceptance(model,`“${node.data.label}”使用的模型`);const input={...draft,modelId:route.modelId},quantity=billingQuantity(input,model),estimatedTotalCost=quoteCost(input,model),payableTotal=quotePrice(input,model);if(payableTotal<estimatedTotalCost)throw Error(`“${node.data.label}”的模型售价低于成本`);if(payableTotal===0&&model.capabilities.explicitlyFree!==true)throw Error(`“${node.data.label}”的 0 元模型没有明确标记免费`);items.push({nodeId:node.id,label:node.data.label,kind:input.kind,operationId:route.id,modelId:model.id,modelName:model.displayName,modelConfigHash:model.configHash,billingUnit:model.billingUnit,quantity,unitCost:Number(model.costPrice),estimatedTotalCost,unitPrice:Number(model.publicPrice),payableTotal});}
 if(!items.length&&!certification)throw Error('所选范围没有需要调用模型的节点');
 const now=Date.now(),estimatedTotalCost=Math.round(items.reduce((sum,item)=>sum+item.estimatedTotalCost,0)*10000)/10000,payableTotal=Math.round(items.reduce((sum,item)=>sum+item.payableTotal,0)*10000)/10000;
 const value:CanvasWorkflowQuote={version:1,id:crypto.randomUUID(),owner,canvasId,selected:prepared.selection,graphFingerprint:prepared.graphFingerprint,executionMode:certification?'materialized-snapshot':'generation',...(certification?{materializedSnapshot:{sourceSha256:certification.sourceSha256,graphSha256:certification.graphSha256,billingMode:certification.billingMode}}:{}),createdAt:now,expiresAt:now+600000,currency:'CNY',estimatedTotalCost,payableTotal,profitAmount:Math.round((payableTotal-estimatedTotalCost)*10000)/10000,...(published&&!certification?{releaseId:published.releaseId,releaseVersion:published.releaseVersion,manifestSha256:published.manifestSha256}:{}),status:'quoted',items};
 put('canvas-workflow-quotes',value.id,owner,value);return publicCanvasQuote(value);
}
export async function confirmCanvasWorkflow(owner:string,quoteId:string,clientRequestId:string,graphFingerprint:string){
 if(!/^[a-f0-9-]{36}$/i.test(quoteId)||!/^[a-f0-9-]{36}$/i.test(clientRequestId))throw Error('画布报价或客户端请求号无效');
 const quote=get<CanvasWorkflowQuote>('canvas-workflow-quotes',quoteId,owner);if(!quote)throw Error('画布报价不存在或不属于当前账号');if(quote.graphFingerprint!==graphFingerprint)throw Error('画布报价指纹不一致');
 if(quote.workflowId){if(quote.clientRequestId!==clientRequestId)throw Error('该画布报价已由另一客户端请求确认');const previous=get<Workflow>('workflows',quote.workflowId,owner);if(!previous)throw Error('画布报价已确认但执行记录待对账');return previous;}
 if(quote.expiresAt<Date.now()){put('canvas-workflow-quotes',quote.id,owner,{...quote,status:'expired'});throw Error('画布报价已过期，请重新报价');}
 const needsPublishedVideo=quote.executionMode!=='materialized-snapshot'&&quote.items.some(item=>item.kind==='video');
 if(quote.executionMode!=='materialized-snapshot')await primePublishedCommerceConfiguration({force:Boolean(quote.releaseId),required:needsPublishedVideo&&process.env.SHARED_CONFIGURATION_ENABLED==='1'});
 if(needsPublishedVideo)assertPublishedCommercePaidJobsReady();
 const prepared=prepareWorkflow(owner,quote.canvasId,quote.selected);if(prepared.graphFingerprint!==quote.graphFingerprint)throw Error('画布或所选节点已变化，请重新报价');
 const published=needsPublishedVideo?currentPublishedCommerceConfiguration():undefined;if(quote.releaseId&&(!published||published.releaseId!==quote.releaseId||published.releaseVersion!==quote.releaseVersion||published.manifestSha256!==quote.manifestSha256))throw Error('画布报价对应的配置版本已经变化，请重新报价');
 const chargeNodes=prepared.nodes.filter(node=>!prepared.steps[node.id].reused&&node.data.mode!=='input'&&!(node.data.kind==='text'&&node.data.mode!=='generate'));
 if(chargeNodes.length!==quote.items.length||chargeNodes.some(node=>!quote.items.some(item=>item.nodeId===node.id)))throw Error('画布执行节点与报价不一致');
 const certification=quote.executionMode==='materialized-snapshot'?readMaterializedCanvasCertification(owner,quote.canvasId):undefined;
 if(quote.executionMode==='materialized-snapshot'&&(!quote.materializedSnapshot||!certification||certification.sourceSha256!==quote.materializedSnapshot.sourceSha256||certification.graphSha256!==quote.materializedSnapshot.graphSha256||certification.billingMode!==quote.materializedSnapshot.billingMode||quote.items.length||chargeNodes.length||quote.payableTotal!==0||quote.estimatedTotalCost!==0))throw Error('素材快照认证已经变化，请重新报价');
 if(quote.executionMode!=='materialized-snapshot')for(const item of quote.items){const node=prepared.nodes.find(value=>value.id===item.nodeId)!;const draft=canvasJobInput(node,{prompt:node.data.prompt,references:[]}),route=resolveOperation(draft),model=await selectedModel(draft.kind,route.modelId),input={...draft,modelId:route.modelId};if(usesCuratedMainCatalogDirectExecution(draft.kind))assertCuratedMainCatalogExecutionReady(model);if(route.id!==item.operationId||model.id!==item.modelId||model.configHash!==item.modelConfigHash||model.billingUnit!==item.billingUnit||Number(model.costPrice)!==item.unitCost||Number(model.publicPrice)!==item.unitPrice||billingQuantity(input,model)!==item.quantity||quoteCost(input,model)!==item.estimatedTotalCost||quotePrice(input,model)!==item.payableTotal)throw Error(`“${item.label}”的模型、能力或价格已经变化，请重新报价`);}
 if(quote.executionMode!=='materialized-snapshot')await chargeAggregateQuoteAtConfirm({id:quote.id,owner:quote.owner,payableTotal:quote.payableTotal,estimatedTotalCost:quote.estimatedTotalCost,items:quote.items.map(item=>({key:item.nodeId,kind:item.kind,modelId:item.modelId,modelConfigHash:item.modelConfigHash,billingUnit:item.billingUnit,quantity:item.quantity,estimatedTotalCost:item.estimatedTotalCost,payableTotal:item.payableTotal}))},`带货Agent 画布执行 · ${quote.items.length} 个生成节点`);
 try{return transaction(()=>{const current=get<CanvasWorkflowQuote>('canvas-workflow-quotes',quote.id,owner)!;if(current.workflowId){if(current.clientRequestId!==clientRequestId)throw Error('该画布报价已由另一客户端请求确认');const previous=get<Workflow>('workflows',current.workflowId,owner);if(!previous)throw Error('画布执行记录待对账');return previous;}const confirmation=claim(`${owner}:canvas-workflow-quote:${quote.id}`,quote.graphFingerprint,clientRequestId);if(!confirmation.created&&confirmation.id!==clientRequestId)throw Error('该画布报价已由另一客户端请求确认');const execution:CanvasQuoteExecution|undefined=quote.executionMode==='materialized-snapshot'?undefined:{quoteId:quote.id,quoteFingerprint:quote.graphFingerprint,clientRequestId,...(quote.releaseId?{releaseId:quote.releaseId,releaseVersion:quote.releaseVersion,manifestSha256:quote.manifestSha256}:{}),steps:Object.fromEntries(quote.items.map(item=>[item.nodeId,item]))};const workflow=createWorkflowInTransaction(owner,quote.canvasId,quote.selected,undefined,execution,quote.materializedSnapshot);put('canvas-workflow-quotes',quote.id,owner,{...current,status:'consumed',clientRequestId,workflowId:workflow.id});return workflow;});}catch(error){const currentQuote=get<CanvasWorkflowQuote>('canvas-workflow-quotes',quote.id,owner);if(quote.executionMode!=='materialized-snapshot'&&!currentQuote?.workflowId)await refundAggregateQuoteBeforeDispatch(owner,quote.id);throw error;}
}

function retryWorkflowFingerprint(value:Workflow,items:WorkflowRetryItem[],published?:ReturnType<typeof currentPublishedCommerceConfiguration>){
 return createHash('sha256').update(stableJson({
  workflowId:value.id,canvasId:value.canvasId,nodes:value.nodes,edges:value.edges,
  steps:Object.fromEntries(Object.entries(value.steps).map(([id,step])=>[id,{status:step.status,jobId:step.jobId,fingerprint:step.fingerprint,output:step.output}])),
  retryItems:items.map(item=>({nodeId:item.nodeId,retryReason:item.retryReason,sourceJobId:item.sourceJobId,modelId:item.modelId,modelConfigHash:item.modelConfigHash,billingUnit:item.billingUnit,quantity:item.quantity,estimatedTotalCost:item.estimatedTotalCost,payableTotal:item.payableTotal})),
  releaseId:published?.releaseId,releaseVersion:published?.releaseVersion,manifestSha256:published?.manifestSha256,
 })).digest('hex');
}

function publicWorkflowRetryQuote(value:WorkflowRetryQuote){
 return {schema:value.schema,id:value.id,workflowId:value.workflowId,workflowFingerprint:value.workflowFingerprint,currency:value.currency,payableTotal:value.payableTotal,releaseVersion:value.releaseVersion,expiresAt:value.expiresAt,status:value.status,items:value.items.map(item=>({nodeId:item.nodeId,label:item.label,kind:item.kind,retryReason:item.retryReason,model:{...(item.kind==='video'?{id:item.modelId}:{}),displayName:item.modelName},billingUnit:item.billingUnit,quantity:item.quantity,payableTotal:item.payableTotal}))};
}

async function prepareWorkflowRetry(owner:string,id:string,refresh:boolean){
 const initial=get<Workflow>('workflows',id,owner);if(!initial)throw Error('执行记录不存在');assertCanvasExecutionAllowed(owner,initial.canvasId,initial.nodes);
 if(initial.status!=='blocked')throw Error('只有被明确阻断的执行记录可以为失败节点重新报价');
 if(refresh)for(const step of Object.values(initial.steps))if(step.jobId&&step.status!=='succeeded')await refreshJob(step.jobId,owner);
 let value=get<Workflow>('workflows',id,owner)!;
 // A crash may happen after the wallet accepted an unstarted-line refund but
 // before billingRelease was projected onto the workflow. Replaying uses the
 // same refund key, then rebuilds the workflow projection before retry quote
 // selection so no debited line becomes permanently unreachable.
 await releaseUnstartedWorkflowBilling(value);
 value=get<Workflow>('workflows',id,owner)!;
 const candidates:{nodeId:string;sourceJobId?:string;retryReason:'failed'|'released-unstarted'}[]=[];
 for(const [nodeId,step] of Object.entries(value.steps)){
  if(step.status==='succeeded')continue;
  if(!step.jobId){
   if(['unknown','save_failed'].includes(step.status))throw Error('原执行记录状态尚未确认，不能创建新的付费重试');
   if(step.billingRelease)candidates.push({nodeId,retryReason:'released-unstarted'});
   continue;
  }
  const source=job(step.jobId,owner);if(!source)throw Error('原失败任务记录不存在，已停止重新报价');
  if(source.status==='unknown')throw Error('原任务结果仍未知，只能继续查询原任务，不能重新提交');
  if(source.status==='save_failed')throw Error('原任务已有供应商结果，请先重新保存，不能再次生成');
  if(source.status==='failed')candidates.push({nodeId,sourceJobId:source.id,retryReason:'failed'});
  else if(source.status==='succeeded')throw Error('原任务已经成功，请先核对并恢复原结果');
  else throw Error('原任务仍在运行，只能继续查询原任务，不能重新提交');
 }
 if(!candidates.length)throw Error('没有可重新报价的失败节点或已退款未启动节点');
 const needsPublishedVideo=candidates.some(({nodeId})=>value.nodes.find(node=>node.id===nodeId)?.data.kind==='video');
 await primePublishedCommerceConfiguration({required:needsPublishedVideo&&process.env.SHARED_CONFIGURATION_ENABLED==='1'});
 if(needsPublishedVideo)assertPublishedCommercePaidJobsReady();
 const published=needsPublishedVideo?currentPublishedCommerceConfiguration():undefined,items:WorkflowRetryItem[]=[];
 for(const retryItem of candidates){
  const node=value.nodes.find(candidate=>candidate.id===retryItem.nodeId);if(!node)throw Error('重试节点已经不存在，已停止重新报价');
  const planStep=value.agentPlanExecution?.steps[node.id];if(planStep)await verifyPlanAssetBytes(owner,planStep.references);
  const assembled=workflowInput(owner,node,value.nodes,value.edges,value.steps,planStep),draft=canvasJobInput(node,assembled),route=resolveOperation(draft),model=await selectedModel(draft.kind,route.modelId),input={...draft,modelId:route.modelId},catalogDirect=usesCuratedMainCatalogDirectExecution(draft.kind);
  if(catalogDirect)assertCuratedMainCatalogExecutionReady(model);
  if(!model.configHash)throw Error(`“${node.data.label}”的模型配置哈希缺失，已停止重新报价`);
  if(published&&!catalogDirect)await requireCommerceModelAcceptance(model,`“${node.data.label}”使用的模型`);
  const quantity=billingQuantity(input,model),estimatedTotalCost=quoteCost(input,model),payableTotal=quotePrice(input,model);
  if(payableTotal<estimatedTotalCost)throw Error(`“${node.data.label}”的模型售价低于成本`);
  if(payableTotal===0&&model.capabilities.explicitlyFree!==true)throw Error(`“${node.data.label}”的 0 元模型没有明确标记免费`);
  items.push({nodeId:node.id,...(retryItem.sourceJobId?{sourceJobId:retryItem.sourceJobId}:{}),retryReason:retryItem.retryReason,label:node.data.label,kind:input.kind,operationId:route.id,modelId:model.id,modelName:model.displayName,modelConfigHash:model.configHash,billingUnit:model.billingUnit,quantity,unitCost:Number(model.costPrice),estimatedTotalCost,unitPrice:Number(model.publicPrice),payableTotal});
 }
 return {value,published,items,fingerprint:retryWorkflowFingerprint(value,items,published)};
}

export async function quoteWorkflowRetry(owner:string,id:string){
 const prepared=await prepareWorkflowRetry(owner,id,true),now=Date.now(),estimatedTotalCost=Math.round(prepared.items.reduce((sum,item)=>sum+item.estimatedTotalCost,0)*10000)/10000,payableTotal=Math.round(prepared.items.reduce((sum,item)=>sum+item.payableTotal,0)*10000)/10000;
 const quote:WorkflowRetryQuote={schema:'commerce-workflow-retry-quote/v1',id:crypto.randomUUID(),owner,workflowId:id,workflowFingerprint:prepared.fingerprint,createdAt:now,expiresAt:now+600000,currency:'CNY',estimatedTotalCost,payableTotal,profitAmount:Math.round((payableTotal-estimatedTotalCost)*10000)/10000,...(prepared.published?{releaseId:prepared.published.releaseId,releaseVersion:prepared.published.releaseVersion,manifestSha256:prepared.published.manifestSha256}:{}),status:'quoted',items:prepared.items};
 put('workflow-retry-quotes',quote.id,owner,quote);return publicWorkflowRetryQuote(quote);
}

export async function confirmWorkflowRetry(owner:string,id:string,quoteId:string,clientRequestId:string){
 if(!/^[a-f0-9-]{36}$/i.test(quoteId)||!/^[a-f0-9-]{36}$/i.test(clientRequestId))throw Error('失败节点报价或客户端请求号无效');
 const quote=get<WorkflowRetryQuote>('workflow-retry-quotes',quoteId,owner);if(!quote||quote.workflowId!==id)throw Error('失败节点报价不存在或不属于当前账号');
 if(quote.status==='consumed'){if(quote.clientRequestId!==clientRequestId)throw Error('该失败节点报价已由另一客户端请求确认');const previous=get<Workflow>('workflows',id,owner);if(!previous)throw Error('失败节点执行记录待对账');return previous;}
 if(quote.expiresAt<Date.now()){put('workflow-retry-quotes',quote.id,owner,{...quote,status:'expired'});throw Error('失败节点报价已过期，请重新报价');}
 const prepared=await prepareWorkflowRetry(owner,id,false),published=prepared.published;
 if(quote.releaseId&&(!published||published.releaseId!==quote.releaseId||published.releaseVersion!==quote.releaseVersion||published.manifestSha256!==quote.manifestSha256))throw Error('失败节点报价对应的配置版本已经变化，请重新报价');
 if(prepared.fingerprint!==quote.workflowFingerprint||stableJson(prepared.items)!==stableJson(quote.items))throw Error('失败节点、模型、素材或价格已经变化，请重新报价');
 await chargeAggregateQuoteAtConfirm({id:quote.id,owner:quote.owner,payableTotal:quote.payableTotal,estimatedTotalCost:quote.estimatedTotalCost,items:quote.items.map(item=>({key:item.nodeId,kind:item.kind,modelId:item.modelId,modelConfigHash:item.modelConfigHash,billingUnit:item.billingUnit,quantity:item.quantity,estimatedTotalCost:item.estimatedTotalCost,payableTotal:item.payableTotal}))},`带货Agent 失败节点重试 · ${quote.items.length} 个生成节点`);
 try{return transaction(()=>{
  const currentQuote=get<WorkflowRetryQuote>('workflow-retry-quotes',quote.id,owner)!;if(currentQuote.status==='consumed'){if(currentQuote.clientRequestId!==clientRequestId)throw Error('该失败节点报价已由另一客户端请求确认');return get<Workflow>('workflows',id,owner)!;}
  const confirmation=claim(`${owner}:workflow-retry-quote:${quote.id}`,quote.workflowFingerprint,clientRequestId);if(!confirmation.created&&confirmation.id!==clientRequestId)throw Error('该失败节点报价已由另一客户端请求确认');
  const value=get<Workflow>('workflows',id,owner);if(!value||value.status!=='blocked'||retryWorkflowFingerprint(value,quote.items,published)!==quote.workflowFingerprint)throw Error('失败节点执行状态已经变化，请重新报价');
  for(const item of quote.items){
   const step=value.steps[item.nodeId],source=step?.jobId?job(step.jobId,owner):undefined;
   if(!step)throw Error(`“${item.label}”的重试节点已经不存在，请重新报价`);
   if(item.retryReason==='failed'){
    if(!item.sourceJobId||source?.id!==item.sourceJobId||source.status!=='failed')throw Error(`“${item.label}”的原失败任务已经变化，请重新报价`);
   }else if(step.jobId||!step.billingRelease){
    throw Error(`“${item.label}”的已退款未启动状态已经变化，请重新报价`);
   }
   step.requestId=crypto.randomUUID();step.jobId=undefined;step.status='pending';step.output=undefined;step.billingRelease=undefined;step.billingAttempt={quoteId:quote.id,quoteFingerprint:quote.workflowFingerprint,clientRequestId,...(quote.releaseId?{releaseId:quote.releaseId,releaseVersion:quote.releaseVersion,manifestSha256:quote.manifestSha256}:{}),snapshot:item};
  }
  value.status='waiting';value.error=undefined;save(value,false);put('workflow-retry-quotes',quote.id,owner,{...currentQuote,status:'consumed',clientRequestId});return value;
 })}catch(error){const currentQuote=get<WorkflowRetryQuote>('workflow-retry-quotes',quote.id,owner);if(currentQuote?.status!=='consumed')await refundAggregateQuoteBeforeDispatch(owner,quote.id);throw error;}
}
// Internal composition entry: the caller owns the transaction and all rollback.
export function createWorkflowInTransaction(owner:string,canvasId:string,selected?:string[],agentPlanExecution?:AgentPlanExecution,canvasQuoteExecution?:CanvasQuoteExecution,materializedSnapshotExecution?:MaterializedSnapshotExecution){if(!agentPlanExecution&&!canvasQuoteExecution&&!materializedSnapshotExecution)throw Error('画布执行必须先取得并确认服务端报价');if(materializedSnapshotExecution){const certification=readMaterializedCanvasCertification(owner,canvasId);if(!certification||certification.sourceSha256!==materializedSnapshotExecution.sourceSha256||certification.graphSha256!==materializedSnapshotExecution.graphSha256||certification.billingMode!==materializedSnapshotExecution.billingMode)throw Error('素材快照认证已经变化，请重新报价');}const prepared=prepareWorkflow(owner,canvasId,selected);const value:Workflow={...(agentPlanExecution?{agentPlanExecution}:{}),...(canvasQuoteExecution?{canvasQuoteExecution}:{}),...(materializedSnapshotExecution?{materializedSnapshotExecution}:{}),id:crypto.randomUUID(),owner,canvasId,title:prepared.canvas.title,nodes:prepared.nodes,edges:prepared.edges,createdAt:Date.now(),updatedAt:Date.now(),status:'running',steps:prepared.steps};put('workflows',value.id,owner,value);return value;}
function save(value:Workflow,preservePause=true){if(preservePause&&get<Workflow>('workflows',value.id,value.owner)?.status==='paused')value.status='paused';value.updatedAt=Date.now();put('workflows',value.id,value.owner,value);}
async function releaseUnstartedWorkflowBilling(value:Workflow){
 const groups=new Map<string,string[]>();
 for(const [nodeId,step] of Object.entries(value.steps)){
  if(step.jobId||step.status==='succeeded'||step.reused||step.billingRelease)continue;
  const retry=step.billingAttempt;
  const original=value.agentPlanExecution?.steps[nodeId]?.billingSnapshot&&value.agentPlanExecution?.quoteId
   ?{quoteId:value.agentPlanExecution.quoteId,lineKey:nodeId}
   :value.canvasQuoteExecution?.steps[nodeId]
    ?{quoteId:value.canvasQuoteExecution.quoteId,lineKey:nodeId}
    :undefined;
  const target=retry?{quoteId:retry.quoteId,lineKey:retry.snapshot.nodeId}:original;
  if(!target)continue;
  groups.set(target.quoteId,[...(groups.get(target.quoteId)||[]),target.lineKey]);
 }
 for(const [quoteId,lineKeys] of groups){
  const releases=await releaseAggregateUnallocatedLines(value.owner,quoteId,lineKeys);
  for(const release of releases){
   const step=value.steps[release.lineKey];
   if(step&&!step.jobId&&release.status==='refunded'&&release.refundedAt)step.billingRelease={quoteId,lineKey:release.lineKey,amount:release.amount,refundedAt:release.refundedAt};
  }
 }
 save(value,false);
}
export function pauseWorkflow(id:string,owner:string){const value=get<Workflow>('workflows',id,owner);if(!value)throw Error('执行记录不存在');if(['running','waiting'].includes(value.status)){value.status='paused';save(value);}return value;}
export async function resumeWorkflow(id:string,owner:string,retryFailed=false){
 const original=get<Workflow>('workflows',id,owner);if(!original)throw Error('执行记录不存在');assertCanvasExecutionAllowed(owner,original.canvasId,original.nodes);if(!['blocked','paused'].includes(original.status))return original;
 if(retryFailed)throw Error('失败节点需要重新选择并取得新报价，不能复用旧报价再次扣费');
 for(const step of Object.values(original.steps))if(step.jobId&&step.status!=='succeeded')await refreshJob(step.jobId,owner);
 const database=db();database.exec('BEGIN IMMEDIATE');try{const value=get<Workflow>('workflows',id,owner)!;if(!['blocked','paused'].includes(value.status)){database.exec('COMMIT');return value;}
 for(const step of Object.values(value.steps)){if(!step.jobId||step.status==='succeeded')continue;const current=job(step.jobId,owner);if(!current)throw Error('原任务记录不存在');if(current.status==='failed'){if(!retryFailed)throw Error('原任务已明确失败，可以选择重试失败步骤');step.requestId=crypto.randomUUID();step.jobId=undefined;step.status='pending';step.output=undefined;}else if(current.status==='save_failed')throw Error('原任务已有结果，请先重试保存原结果');else if(current.status==='unknown')throw Error('上游结果仍未确认，已查询原任务，请稍后核对');else step.status='running';}
 value.status='waiting';value.error=undefined;save(value,false);database.exec('COMMIT');return value;}catch(error){database.exec('ROLLBACK');throw error;}
}
export async function advanceWorkflow(id:string,owner:string){
 if(running.has(id))return;const value=get<Workflow>('workflows',id,owner);if(!value||['blocked','succeeded','paused'].includes(value.status))return;running.add(id);
 try{
  assertCanvasExecutionAllowed(owner,value.canvasId,value.nodes);const order=validateGraph(value.nodes,value.edges);
  for(const nodeId of order){
   assertCanvasExecutionAllowed(owner,value.canvasId,value.nodes);if(get<Workflow>('workflows',id,owner)?.status==='paused')return;
   const node=value.nodes.find(n=>n.id===nodeId)!,step=value.steps[nodeId];if(step.status==='succeeded')continue;
   const incoming=executionEdges(value.edges).filter(e=>e.target===nodeId);if(incoming.some(e=>value.steps[e.source].status!=='succeeded')){value.status='waiting';save(value);return;}
   if(node.data.mode==='input'||node.data.kind==='text'&&node.data.mode!=='generate'){step.status='succeeded';step.output={text:node.data.prompt,assets:(node.data.assetIds||[]).map(assetId=>({id:assetId,slot:'reference'}))};save(value);continue;}
   if(node.data.kind==='audio')throw Error('音频生成模型尚未配置');
   if(!step.jobId){
    const planStep=value.agentPlanExecution?.steps[nodeId],canvasSnapshot=value.canvasQuoteExecution?.steps[nodeId],retryAttempt=step.billingAttempt;
    if(planStep)await verifyPlanAssetBytes(owner,planStep.references);
    if(!planStep&&!canvasSnapshot&&!retryAttempt)throw Error(`“${node.data.label}”缺少已确认的服务端报价`);
    const assembled=workflowInput(owner,node,value.nodes,value.edges,value.steps,planStep),jobInput={requestId:step.requestId,...canvasJobInput(node,assembled)};
    let jobContext:JobInternalContext|undefined;
    if(retryAttempt){
     await verifyRetryBillingSnapshot(jobInput,retryAttempt);
     jobContext=aggregateJobContext(retryAttempt.quoteId,retryAttempt.quoteFingerprint,step.requestId,nodeId,retryAttempt.snapshot,retryAttempt);
    }else if(planStep&&value.agentPlanExecution){
     await verifyPlanBillingSnapshot(node,jobInput,value.agentPlanExecution,planStep);
     jobContext=aggregateJobContext(value.agentPlanExecution.quoteId!,value.agentPlanExecution.quoteFingerprint!,step.requestId,nodeId,{nodeId,kind:jobInput.kind,...planStep.billingSnapshot!},value.agentPlanExecution);
    }else if(canvasSnapshot&&value.canvasQuoteExecution){
     await verifyCanvasBillingSnapshot(jobInput,value.canvasQuoteExecution,canvasSnapshot);
     jobContext=aggregateJobContext(value.canvasQuoteExecution.quoteId,value.canvasQuoteExecution.quoteFingerprint,step.requestId,nodeId,canvasSnapshot,value.canvasQuoteExecution);
    }
    const created=await createJob(owner,jobInput,node.data.kind==='image'?{imageWorkflowContext:{workflowId:value.id,targetNodeId:nodeId}}:undefined,jobContext);
    step.jobId=created.id;step.status='running';save(value);await runJob(created.id,owner);
   }else await refreshJob(step.jobId,owner);
   const result=job(step.jobId,owner)!;
   if(result.status==='succeeded'){step.status='succeeded';step.output={text:result.text||node.data.prompt,assets:result.assetIds.map(assetId=>({id:assetId,slot:'reference'}))};save(value);}
    else if(['failed','unknown','save_failed'].includes(result.status)){step.status=result.status;value.status='blocked';value.error=`${node.data.label}：${result.error||'原任务尚未得到可用结果'}。后续节点未提交。`;save(value);if(result.status==='failed')await releaseUnstartedWorkflowBilling(value);return;}
   else{value.status='waiting';save(value);return;}
  }
  value.status='succeeded';save(value);
  }catch(e){value.status='blocked';value.error=e instanceof Error?e.message:'画布执行未完成';save(value);await releaseUnstartedWorkflowBilling(value).catch(()=>undefined);}finally{running.delete(id);}
}
