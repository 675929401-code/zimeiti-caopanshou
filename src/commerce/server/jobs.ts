import sharp from 'sharp';
import {captureConversationContext,snapshotChatMessages,type ConversationContextSnapshot} from './conversation-context';
import type {ImageReferenceDocument} from '../shared/image-reference-mentions';
import {prepareImageReferenceInput,verifyImageReferenceSnapshot,verifyImageReferenceBytes,imageMentionBinding,type ImageReferenceSnapshot} from './image-reference-context';
import {claimImageRevision,verifyImageRevisionDispatch,findUnsettledImageRevision} from './image-revision-claim';
import {claimDepthClone,verifyDepthDispatch,verifyDepthBytes} from './depth-video-clone-claim';
import {DEPTH_PURPOSE,type DepthSnapshot} from './depth-video-clone-schema';
import {prepareDepthPublicInputs} from './depth-video-preprocess';
import {parseDetailAnalysis,detailConfig} from './detail-set-schema';
import {claimDetailSet,verifyDetailDispatch} from './detail-set-claim';
import {parseProductAnalysis} from './prompt-assist-schema';
import {modelIdentity,ModelChangedBeforeDispatch} from './model-identity';
import {chargeJobAtDispatch,refundFailedJob,recordJobRevenue,recordFailedProviderCost,getJobBillingState,providerCost,publicBillingState,bindJobToAggregateCharge,type CommerceAggregateBillingLine,type PublicCommerceBillingState} from './billing';
import {claimAssist,verifyAssistDispatch,verifyAssistApplication} from './prompt-assist-claim';
import {DIRECTOR_REFERENCE_LIMIT,type DirectorTurnContext} from './director-conversation-schema';
import {claimDirectorTurn,currentDirectorScriptContext,verifyDirectorApplication,verifyDirectorAudioReferences} from './director-turn-claim';
import {parseReferenceBreakdown,parseRemixScript} from './reference-video-schema';
import {readCreativeVideoEvidence,creativeVideoEvidenceBytes} from './creative-video-evidence';
import {resolveOperation,validateDirector} from './operation-routing';
import {findDirectorCard} from './director-catalog';
import {ensureProviderReference} from './media-reference';
import {videoFrames} from './video-frames';
import {directorProviderResponseFormat,submitProvider,pollProvider,buildProviderRequest,type ProviderInput,type ProviderResult} from './providers';
import {createHash} from 'node:crypto';
import {db,get,put,list,claim,claimQueuedJob,transaction,claimRecordLease,renewRecordLease,recordLeaseIsCurrent,releaseRecordLease,type DurableRecordLease} from './store';
import {selectedModel,modelSecret,gateway,assertMainGatewayReady,type Model,type Kind} from './models';
import {assertCuratedMainCatalogExecutionReady,classifyCommerceCuratedModel,isCuratedConfigurationSelectable,usesCuratedMainCatalogDirectExecution} from './commerce-curated-model-profiles';
import {readAsset,readIdempotentAsset,assertAssetIntegrity,mutateAsset,assetBytes,storeAsset,downloadResult,publicFetch,type Asset} from './assets';
import {baselinePromptTemplates,template} from './prompts';
import {validateImageInputShape,validateImageInput,normalizeImageFormat} from '../image-input-contract';
import {resolveImageTextProvenance,imageTextSourceInstruction,type ImageExecutionContext,type ImageTextProvenance} from './image-workflow-context';
import {assertPublishedCommercePaidJobsReady,currentPublishedCommerceConfiguration,primePublishedCommerceConfiguration,stableJson} from './configuration-platform';
import {compileCommercePrompt} from './prompt-compiler';
import {enforceVideoAudioPolicy} from './video-audio-policy';
import {normalizeGeneratedImageOutput} from './image-output-contract';
import {providerImageReferenceDataUrl} from './image-reference-payload';
import {confirmedFailureProviderCost,isExplicitProviderRejection} from './provider-failure-classification';
import {assertRollingTailFrameCapacity,assertVideoReferenceCapabilities} from './video-reference-capabilities';
import {assertCommerceVideoAudioSetting,assertCommerceVideoResolution,commerceVideoNativeDurationOptions,COMMERCE_VIDEO_MAX_TOTAL_DURATION,resolveCommerceVideoDurationPlan} from '../shared/video-generation-capabilities';
import type {RollingExecutionPermit} from './rolling-video';
import type {CommerceCardVersion,CommerceKnowledgeDocument,CommercePromptPackageIdentity,CommercePromptVersion,CommerceRoutePolicy} from '../shared/configuration-types';
import {assertFrozenPrequoteSelection,type PrequoteModelSelectionSnapshot} from './prequote-model-selection';
import {resolveCommercePromptPackageIdentity,sameCommercePromptPackageIdentity} from './prompt-package-identity';
export type JobInput={requestId:string;kind:Kind;modelId:string;prompt:string;skillId?:string;aspectRatio?:string;resolution?:string;format?:string;duration?:number;references?:{id:string;slot:string;instanceId?:string}[];imageReferenceDocument?:ImageReferenceDocument;imageRevisionQuoteId?:string;conversationId?:string;purpose?:string;director?:string;spokenLanguage?:string;scriptDuration?:number;parentJobId?:string;regenerationOf?:string;requestedAspectRatio?:string;promptOrigin?:'user'|'default-director';assistQuoteId?:string;creativeEvidenceId?:string;assistApplicationId?:string;directorTurn?:DirectorTurnContext;directorApplicationId?:string;generateAudio?:boolean;detailQuoteId?:string;detailRunId?:string;detailRowId?:string;depthQuoteId?:string;depthSnapshot?:DepthSnapshot;rollingChild?:boolean;rollingParentJobId?:string;rollingSegmentIndex?:number;rollingPlan?:{segments:number[]};configuredFields?:Record<string,unknown>;};
export type CommerceJobConfigurationSnapshot={configurationSource?:'published-release'|'curated-main-catalog'|'legacy-local';releaseId?:string;releaseVersion?:number;manifestSha256?:string;cardVersionId?:string;cardVersion?:number;promptVersionId:string;promptVersion:number;promptPackage?:CommercePromptPackageIdentity;knowledgeVersionIds:string[];routeVersionId:string;routeVersion:number;modelConfigHash:string;quoteId?:string;inputFingerprint?:string;clientRequestId?:string;modelSelection?:PrequoteModelSelectionSnapshot};
export type CardCanaryExecutionContext={releaseId:string;releaseVersion:number;manifestSha256:string;card:CommerceCardVersion;prompt:CommercePromptVersion;knowledge:CommerceKnowledgeDocument[];route:CommerceRoutePolicy;canaryScenario?:{kind:'standard'|'revision'|'minimum';sourceJobId?:string;currentScript?:string}};
export type QuotedModelSelectionContext={quoteId:string;operationId:string;routeRevision:number;modelId:string;modelConfigHash:string;snapshot:PrequoteModelSelectionSnapshot};
export type JobInternalContext={rollingParentId?:string;segmentIndex?:number;adminCanaryModelId?:string;cardCanary?:CardCanaryExecutionContext;quotedModelSelection?:QuotedModelSelectionContext;quotedPromptPackage?:CommercePromptPackageIdentity;quoteBinding?:{quoteId:string;inputFingerprint:string;clientRequestId:string};aggregateBilling?:{quoteId:string;quoteFingerprint:string;nodeId:string;item:CommerceAggregateBillingLine;clientRequestId:string;releaseId?:string;releaseVersion?:number;manifestSha256?:string}};
export type DirectorApplicationSnapshot={kind:'director';applicationId:string;sourceJobId:string;sourceMessageId:string;sourceContentHash:string;sourceConfigurationHash:string};
export type JobRoute=Omit<ReturnType<typeof resolveOperation>,'modelCandidateIds'|'selection'>&{modelCandidateIds?:string[];selection:string};
export type Job={id:string;owner:string;conversationContext?:ConversationContextSnapshot;imageReferenceSnapshot?:ImageReferenceSnapshot;imageTextProvenance?:ImageTextProvenance;directorApplicationSnapshot?:DirectorApplicationSnapshot;input:JobInput;model:Model;configurationSnapshot?:CommerceJobConfigurationSnapshot;status:'queued'|'running'|'processing'|'saving'|'succeeded'|'failed'|'unknown'|'save_failed';createdAt:number;updatedAt:number;startedAt?:number;dispatchedAt?:number;error?:string;text?:string;assetIds:string[];providerTaskId?:string;pollPath?:string;providerUrl?:string;usage?:unknown;promptVersion:number;compiledPrompt:string;route?:JobRoute;events?:{at:number;stage:string}[];billing?:PublicCommerceBillingState;billingError?:string;billingRetries?:number;undispatchedRecovery?:{attempt:number;recoveredAt:number};rollingState?:{childIds:string[];segmentIndex:number;segmentAssetIds:string[];tailFrameAssetIds?:string[];temporaryAssetsCleanupStatus?:'pending'|'complete'|'failed';temporaryAssetsCleanupAttempts?:number;temporaryAssetsCleanupRetryAt?:number;temporaryAssetsCleanedAt?:number;temporaryAssetsCleanupError?:string;finalEvidence?:{durationSeconds:number;fps:number;hasAudio:boolean;segmentOrder:string[]};retakingSegment?:number;retakeChildId?:string;retakeAttempt?:number;restitchAttempts?:number;restitchRetryAt?:number};};
export type Conversation={id:string;title:string;createdAt:number;updatedAt:number;messages:{id:string;role:'user'|'assistant';content:string;jobId?:string;assetIds?:string[]}[]};
const processState=globalThis as unknown as {commerceActiveJobs?:Set<string>};const active=processState.commerceActiveJobs||=new Set<string>();
const JOB_EXECUTION_LEASE_BUCKET='commerce-job-execution-leases';
const jobExecutionHolder=`${process.pid}:${crypto.randomUUID()}`;
const jobExecutionLeaseMs=()=>{const value=Number(process.env.COMMERCE_JOB_EXECUTION_LEASE_MS||120_000);return Number.isFinite(value)?Math.max(30_000,Math.min(600_000,Math.trunc(value))):120_000;};
export type JobExecutionPermit={lease:DurableRecordLease;isCurrent:()=>boolean};
async function withJobExecutionLease<T>(id:string,owner:string,work:(permit:JobExecutionPermit)=>Promise<T>){
 const duration=jobExecutionLeaseMs(),lease=claimRecordLease(JOB_EXECUTION_LEASE_BUCKET,id,owner,jobExecutionHolder,Date.now(),duration);
 if(!lease)return undefined;
 let current=true;
 const permit:JobExecutionPermit={lease,isCurrent:()=>current&&recordLeaseIsCurrent(lease)};
 const heartbeat=setInterval(()=>{if(current)try{current=renewRecordLease(lease,Date.now(),duration);}catch{current=false;}},Math.max(5_000,Math.floor(duration/3)));
 heartbeat.unref?.();
 try{return await work(permit);}finally{clearInterval(heartbeat);if(current)try{releaseRecordLease(lease);}catch{/* A later token owns recovery. */}}
}
export function jobs(owner:string){return list<Job>('jobs',owner);}
export function job(id:string,owner:string){return get<Job>('jobs',id,owner);}
export function jobOwnsWalletCharge(value:Pick<Job,'input'>){return value.input.rollingChild!==true;}
export function publicJob(value:Job){const {compiledPrompt:_,providerUrl:__,owner:___,pollPath:____,conversationContext:_____,configurationSnapshot,route:______,directorApplicationSnapshot:_______,undispatchedRecovery:________,model,input,...rest}=value;const publicInput=value.input.kind==='video'?input:Object.fromEntries(Object.entries(input).filter(([key])=>key!=='modelId')) as JobInput;return {...rest,input:publicInput,configuration:configurationSnapshot?{source:configurationSnapshot.configurationSource,releaseId:configurationSnapshot.releaseId,releaseVersion:configurationSnapshot.releaseVersion,manifestSha256:configurationSnapshot.manifestSha256,cardVersion:configurationSnapshot.cardVersion,promptVersion:configurationSnapshot.promptVersion,promptPackage:configurationSnapshot.promptPackage,routeVersion:configurationSnapshot.routeVersion,quoteId:configurationSnapshot.quoteId}:undefined,model:{...(model.kind==='video'?{id:model.id}:{}),displayName:model.displayName,source:model.source,publicPrice:model.publicPrice}};}
export function persistJob(value:Job,executionPermit?:JobExecutionPermit){
 const save=()=>{
  if(executionPermit&&!recordLeaseIsCurrent(executionPermit.lease))throw Error('COMMERCE_JOB_EXECUTION_LEASE_LOST');
  value.updatedAt=Date.now();value.events||=[];
  if(value.events.at(-1)?.stage!==value.status)value.events.push({at:value.updatedAt,stage:value.status});
  put('jobs',value.id,value.owner,value);
 };
 if(executionPermit)return transaction(save);
 save();
}
function persistJobStage(value:Job,stage:string,executionPermit?:JobExecutionPermit){
 const save=()=>{if(executionPermit&&!recordLeaseIsCurrent(executionPermit.lease))throw Error('COMMERCE_JOB_EXECUTION_LEASE_LOST');value.updatedAt=Date.now();value.events||=[];if(value.events.at(-1)?.stage!==stage)value.events.push({at:value.updatedAt,stage});put('jobs',value.id,value.owner,value);};
 if(executionPermit)return transaction(save);save();
}
function assertJobQuoteSnapshotCurrent(value:Job){const snapshot=value.configurationSnapshot;const assertBinding=(quote:{id?:string;inputFingerprint?:string;contentFingerprint?:string;modelSelection?:PrequoteModelSelectionSnapshot}|undefined,expectedFingerprint?:string)=>{if(!snapshot?.quoteId||!snapshot.inputFingerprint||!snapshot.clientRequestId||!quote||quote.id!==snapshot.quoteId||snapshot.inputFingerprint!==(expectedFingerprint||quote.inputFingerprint))throw new ModelChangedBeforeDispatch();};if(snapshot?.modelSelection){const quote=get<{id:string;inputFingerprint:string;modelSelection:PrequoteModelSelectionSnapshot}>('commerce-quotes',snapshot.quoteId||'',value.owner);assertBinding(quote);if(!quote||stableJson(quote.modelSelection)!==stableJson(snapshot.modelSelection))throw new ModelChangedBeforeDispatch();}if(value.input.purpose==='commerce-card-canary'){const quote=get<{id:string;inputFingerprint:string}>('card-canary-quotes',snapshot?.quoteId||'',value.owner);assertBinding(quote);}else if(value.input.purpose==='commerce-canary'){const quote=get<{id:string;inputFingerprint:string}>('model-canary-quotes',snapshot?.quoteId||'',value.owner);assertBinding(quote);}else if(value.input.detailQuoteId){const quote=get<{id:string;contentFingerprint:string}>('detail-set-quotes',value.input.detailQuoteId,value.owner);assertBinding(quote,quote?.contentFingerprint);}else if(value.input.depthQuoteId){const quote=get<{id:string;inputFingerprint:string}>('depth-video-quotes',value.input.depthQuoteId,value.owner);assertBinding(quote);}}
async function assertJobModelSnapshotCurrent(value:Job){assertJobQuoteSnapshotCurrent(value);const current=await selectedModel(value.input.kind,value.model.id);if(modelIdentity(current)!==modelIdentity(value.model))throw new ModelChangedBeforeDispatch();if(value.configurationSnapshot?.modelSelection&&value.route)assertFrozenPrequoteSelection(value.configurationSnapshot.modelSelection,value.route,current);if(usesCuratedMainCatalogDirectExecution(value.input.kind)&&!['commerce-canary','commerce-card-canary'].includes(value.input.purpose||''))assertCuratedMainCatalogExecutionReady(current);return current;}
type BillingAction='charge'|'refund'|'revenue'|'status';
async function applyJobBilling(value:Job,action:BillingAction,executionPermit?:JobExecutionPermit){
  try{
    const state=action==='charge'?await chargeJobAtDispatch(value):action==='refund'?await refundFailedJob(value):action==='revenue'?await recordJobRevenue(value):getJobBillingState(value);
    if(state)value.billing=publicBillingState(state);
    value.billingError=undefined;
    persistJob(value,executionPermit);
    return state;
  }catch(error){
    value.billingError=error instanceof Error?error.message:'主站账务处理失败';
    value.billingRetries=Number(value.billingRetries||0)+1;
    persistJob(value,executionPermit);
    throw error;
  }
}
async function applyTerminalBilling(value:Job,action:'refund'|'revenue',executionPermit?:JobExecutionPermit){try{await applyJobBilling(value,action,executionPermit);}catch{/* 业务终态保留，账务错误已持久化，等待安全对账。 */}}
async function applyConfirmedFailureBilling(value:Job,executionPermit?:JobExecutionPermit){
 await applyTerminalBilling(value,'refund',executionPermit);
 const incurredCost=confirmedFailureProviderCost(value.error,providerCost(value).amount);
 if(value.dispatchedAt&&!value.input.rollingChild&&incurredCost>0){try{const state=await recordFailedProviderCost(value,incurredCost);if(state)value.billing=publicBillingState(state);persistJob(value,executionPermit);}catch(error){value.billingError=[value.billingError,error instanceof Error?error.message:'平台成本记录失败'].filter(Boolean).join('；');value.billingRetries=Number(value.billingRetries||0)+1;persistJob(value,executionPermit);}}
}
async function applyRollingFailureCost(value:Job,executionPermit?:JobExecutionPermit){try{const {rollingIncurredCost}=await import('./rolling-video');const state=await recordFailedProviderCost(value,rollingIncurredCost(value,value.owner));if(state)value.billing=publicBillingState(state);persistJob(value,executionPermit);}catch(error){value.billingError=[value.billingError,error instanceof Error?error.message:'平台成本记录失败'].filter(Boolean).join('；');value.billingRetries=Number(value.billingRetries||0)+1;persistJob(value,executionPermit);}}
export function conversation(id:string,owner:string){return get<Conversation>('conversations',id,owner);}
export function videoNativeDurationOptions(capabilities:Record<string,unknown>):number[]{
 return commerceVideoNativeDurationOptions(capabilities);
}
export function validateVideoDurationPlan(input:JobInput,capabilities:Record<string,unknown>,refs:Array<Pick<Asset,'type'>>){
 const minimum=input.purpose===DEPTH_PURPOSE?4:1;
 const plan=resolveCommerceVideoDurationPlan(capabilities,input.duration,{minimum,maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION,allowRolling:input.purpose!==DEPTH_PURPOSE&&!input.rollingChild});
 if(input.rollingPlan){
  if(input.purpose===DEPTH_PURPOSE||input.rollingChild)throw Error('当前任务不允许嵌套视频分段');
  const segments=input.rollingPlan.segments;
  if(plan.native||!Array.isArray(segments)||segments.length!==plan.segments.length||segments.some((value,index)=>Math.abs(value-plan.segments[index])>1e-8))throw Error('视频分段计划与模型原生时长不匹配');
  assertRollingTailFrameCapacity(capabilities,refs);
  return;
 }
 if(!plan.native)throw Error('视频分段计划缺失');
}
function validate(input:JobInput,model:Model,refs:Asset[]){if(!/^[a-f0-9-]{36}$/.test(input.requestId)||!['agent','image','video'].includes(input.kind)||typeof input.prompt!=='string'||input.prompt.length>20000)throw Error('创作参数无效');if(input.purpose==='director'&&(!Number.isInteger(input.scriptDuration)||Number(input.scriptDuration)<4||Number(input.scriptDuration)>COMMERCE_VIDEO_MAX_TOTAL_DURATION||!['中文','英文','泰国','马来西亚','巴西','不限'].includes(input.spokenLanguage||'')))throw Error(`请选择有效的编导语言和 4–${COMMERCE_VIDEO_MAX_TOTAL_DURATION} 秒脚本时长`);const caps=model.capabilities;if(!input.prompt.trim()&&input.kind!=='image')throw Error('请填写创作要求');if(refs.length>(input.kind==='video'?15:DIRECTOR_REFERENCE_LIMIT))throw Error('参考素材过多');const images=refs.filter(a=>a.type.startsWith('image/'));if(input.kind==='image')validateImageInput(input,refs,caps);validateDirector(input,refs);if(input.kind==='agent'&&input.purpose!=='director'&&refs.some(a=>a.type.startsWith('audio/')))throw Error('请先提供音频文字；当前对话接口尚未接入语音转写');if(input.kind==='agent'&&refs.some(a=>a.type.startsWith('image/')||a.type.startsWith('video/'))&&!caps.imageParsing)throw Error('当前对话模型不支持图片理解，请选择支持看图的模型');if(input.kind==='video'){assertVideoReferenceCapabilities(caps,refs);validateVideoDurationPlan(input,caps,refs);assertCommerceVideoAudioSetting(caps,input.generateAudio);assertCommerceVideoResolution(caps,input.resolution);}if(input.kind!=='agent'){const ratios=caps.aspectRatios;if(Array.isArray(ratios)&&ratios.length&&!ratios.includes(input.aspectRatio))throw Error('模型不支持该画幅');if(input.kind==='image'){const resolutions=caps.resolutionOptions;if(Array.isArray(resolutions)&&resolutions.length&&!resolutions.some(r=>String(r).toLowerCase()===String(input.resolution).toLowerCase()))throw Error('模型不支持该分辨率');}}}
function validatedQuoteBinding(context?:JobInternalContext){const binding=context?.quoteBinding;if(!binding)return undefined;if(!/^[a-f0-9-]{36}$/i.test(binding.quoteId)||!/^[a-f0-9-]{36}$/i.test(binding.clientRequestId)||!/^[a-f0-9]{64}$/i.test(binding.inputFingerprint))throw Error('任务报价绑定无效');if(context?.aggregateBilling)throw Error('任务不能同时绑定独立报价和聚合报价');if(context?.quotedModelSelection&&context.quotedModelSelection.quoteId!==binding.quoteId)throw Error('模型选择报价与任务报价绑定不一致');return binding;}
function assertQuoteBindingSnapshot(value:Pick<Job,'configurationSnapshot'>,binding:NonNullable<JobInternalContext['quoteBinding']>){const snapshot=value.configurationSnapshot;if(!snapshot||snapshot.quoteId!==binding.quoteId||snapshot.inputFingerprint!==binding.inputFingerprint||snapshot.clientRequestId!==binding.clientRequestId)throw Error('原任务的报价快照缺失或与本次确认不一致');}
export async function createJob(owner:string,input:JobInput,executionContext?:ImageExecutionContext,internalContext?:JobInternalContext){const quoteBinding=validatedQuoteBinding(internalContext);const quotedModelSelection=internalContext?.quotedModelSelection;const cardCanary=internalContext?.cardCanary;const adminCanaryModelId=String(internalContext?.adminCanaryModelId||'').trim();const adminCanary=Boolean(adminCanaryModelId)&&['commerce-canary','commerce-card-canary'].includes(input.purpose||'');const catalogDirect=!adminCanary&&!cardCanary&&usesCuratedMainCatalogDirectExecution(input.kind);if(adminCanaryModelId&&!adminCanary)throw Error('管理员 canary 模型覆盖只能用于受控验收任务');if(cardCanary&&input.purpose!=='commerce-card-canary'||input.purpose==='commerce-card-canary'&&(!cardCanary||!adminCanaryModelId))throw Error('卡片 canary 必须绑定完整的服务端草稿快照');const sharedConfigurationRequired=!adminCanary&&!cardCanary&&!input.rollingChild&&process.env.SHARED_CONFIGURATION_ENABLED==='1';await primePublishedCommerceConfiguration({required:sharedConfigurationRequired});if(sharedConfigurationRequired)assertPublishedCommercePaidJobsReady();let rollingParent:Job|undefined;if(input.rollingChild){const rollingParentId=internalContext?.rollingParentId,segmentIndex=internalContext?.segmentIndex;if(!rollingParentId||typeof segmentIndex!=='number'||!Number.isInteger(segmentIndex)||input.rollingParentJobId!==rollingParentId||input.rollingSegmentIndex!==segmentIndex)throw Error('滚动子任务只能由已确认的父任务创建');rollingParent=job(rollingParentId,owner);if(!rollingParent?.input.rollingPlan||rollingParent.input.kind!=='video'||!['running','unknown','succeeded'].includes(rollingParent.status)||rollingParent.model.id!==input.modelId||rollingParent.model.configHash!==String(rollingParent.configurationSnapshot?.modelConfigHash||rollingParent.model.configHash))throw Error('滚动父任务快照不存在或已经变化');}else if(input.rollingParentJobId!==undefined||input.rollingSegmentIndex!==undefined)throw Error('滚动任务内部字段无效');if(input.kind==='image')validateImageInputShape(input);const preparedImage=prepareImageReferenceInput(owner,input);input=preparedImage.input;await verifyImageReferenceBytes(owner,input,preparedImage.snapshot);await verifyDepthBytes(owner,input);verifyAssistApplication(owner,input);verifyDirectorApplication(owner,input);if(input.generateAudio!==undefined&&typeof input.generateAudio!=='boolean')throw Error('视频声音设置无效');if(input.kind==='agent'&&input.purpose==='director'&&input.directorTurn)await verifyDirectorAudioReferences(owner,input.directorTurn.settings,input.directorTurn.references);if(input.kind==='agent'&&input.purpose==='director'&&typeof input.prompt==='string'&&!input.prompt.trim()&&input.references?.length)input={...input,prompt:'请分析所提供的参考素材，根据当前编导场景、语言与目标时长生成完整脚本。',promptOrigin:'default-director'};const canaryPromptId=input.kind==='agent'?'agent':input.kind==='image'?'default':'video.generate';const directQuoteModelId=quoteBinding&&!quotedModelSelection&&!adminCanary&&!cardCanary?input.modelId:undefined;const route=input.rollingChild&&rollingParent?.route?rollingParent.route:cardCanary?{id:cardCanary.route.operationId,label:cardCanary.route.label,kind:cardCanary.route.modelKind,promptId:cardCanary.prompt.promptKey,modelId:adminCanaryModelId,revision:cardCanary.route.version,stages:['绑定草稿卡片','受控报价','单次真实派发','结果持久化','质量证据登记'],userSelectable:false,selection:'admin-card-canary'}:adminCanary?{id:`commerce-canary.${input.kind}`,label:`管理员 ${input.kind} 模型 canary`,kind:input.kind,promptId:canaryPromptId,modelId:adminCanaryModelId,revision:1,stages:['受控报价','单次真实派发','结果持久化','账务终结','证据登记'],userSelectable:false,selection:'admin-canary'}:quotedModelSelection?resolveOperation({...input,modelId:quotedModelSelection.snapshot.selectionSource==='user-selection'?quotedModelSelection.snapshot.selectedConfiguredId:undefined}):directQuoteModelId?(()=>{const base=resolveOperation({...input,modelId:undefined});return base.userSelectable?resolveOperation(input):base;})():resolveOperation(input);input={...input,modelId:quotedModelSelection?.modelId||directQuoteModelId||route.modelId};const model=input.rollingChild&&rollingParent?rollingParent.model:await selectedModel(input.kind,input.modelId);if(directQuoteModelId&&!route.userSelectable){const routedModel=await selectedModel(input.kind,route.modelId);if(routedModel.id!==model.id||routedModel.configHash!==model.configHash)throw Error('报价对应的固定模型路由已经变化，请重新报价');}if(quotedModelSelection){if(quotedModelSelection.operationId!==route.id||quotedModelSelection.routeRevision!==route.revision||quotedModelSelection.modelId!==model.id||quotedModelSelection.modelConfigHash!==model.configHash)throw Error('报价对应的模型路由或配置已经变化，请重新报价');assertFrozenPrequoteSelection(quotedModelSelection.snapshot,route,model);}if(!adminCanary&&!cardCanary&&(input.kind==='agent'||input.kind==='image')&&(!classifyCommerceCuratedModel(model)||!isCuratedConfigurationSelectable(input.kind,model.id)))throw Error('所选模型未通过带货 Agent 白名单身份核对');if(catalogDirect)assertCuratedMainCatalogExecutionReady(model);input={...input,modelId:model.id};const refs=(input.references||[]).map(ref=>{const asset=readAsset(ref.id,owner);if(!asset)throw Error('参考素材已删除或不属于当前账号');return asset;});if(input.parentJobId){const parent=job(input.parentJobId,owner);if(!parent||parent.status!=='succeeded'||parent.input.kind!=='agent')throw Error('来源脚本不存在或尚未完成');}if(input.kind==='image'&&['auto','自适应'].includes(input.aspectRatio||'')){const first=refs.find(a=>a.type.startsWith('image/'));let ratio=1;if(first){const info=await sharp(await assetBytes(first)).metadata();ratio=(Number(info.width)||1)/(Number(info.height)||1);}const choices:string[]=Array.isArray(model.capabilities.aspectRatios)?model.capabilities.aspectRatios.map(String):['1:1','16:9','9:16','4:3','3:4','3:2','2:3'];const selected=choices.reduce((best,r)=>{const [w,h]=r.split(':').map(Number),[bw,bh]=best.split(':').map(Number);return Math.abs(Math.log((w/h)/ratio))<Math.abs(Math.log((bw/bh)/ratio))?r:best;},choices[0]||'1:1');input={...input,requestedAspectRatio:input.aspectRatio,aspectRatio:selected};}if(input.kind==='video'&&input.purpose!==DEPTH_PURPOSE&&!input.rollingChild&&!input.rollingPlan&&input.duration!==undefined){const plan=resolveCommerceVideoDurationPlan(model.capabilities,input.duration,{minimum:1,maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION});if(!plan.native)input={...input,rollingPlan:{segments:plan.segments}};}validate(input,model,refs);return transaction(()=>{verifyImageReferenceSnapshot(owner,input,preparedImage.snapshot);const imageTextProvenance=resolveImageTextProvenance(owner,input,executionContext);verifyAssistApplication(owner,input);const directorApplication=verifyDirectorApplication(owner,input);if(input.regenerationOf){const source=job(input.regenerationOf,owner);if(input.kind!=='image'||!source||source.input.kind!=='image'||source.status!=='succeeded'||!source.assetIds.length)throw Error('重生成来源不存在或不属于当前账号');if(!input.imageRevisionQuoteId&&!(input.purpose==='detail-set.generate'&&input.detailQuoteId))throw Error('单图重生成需要先查看费用并确认');const ongoing=findUnsettledImageRevision(owner,input.regenerationOf,input.requestId);if(ongoing)throw Error('这张图仍有未结束或保存失败的重生成任务，请先查看或重存原结果');}const current=jobs(owner).filter(j=>['queued','running','processing','saving','unknown'].includes(j.status));if(current.length>=3&&!current.some(j=>j.input.requestId===input.requestId))throw Error('当前有 3 个未结束的任务，请等待结果或先核对未知任务');const id=crypto.randomUUID();const fingerprintInput=input.kind==='image'&&input.format!==undefined?{...input,format:normalizeImageFormat(input.format)}:input;const fingerprint=createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');const claimed=claim(`${owner}:${input.requestId}`,fingerprint,id);if(!claimed.created){const previous=job(claimed.id,owner);if(!previous)throw Error('原任务正在创建，请稍后查询');if(quoteBinding)assertQuoteBindingSnapshot(previous,quoteBinding);if(quotedModelSelection&&stableJson(previous.configurationSnapshot?.modelSelection)!==stableJson(quotedModelSelection.snapshot))throw Error('原任务缺少报价时冻结的模型选择快照');return previous;}claimAssist(owner,input,id,model);claimDetailSet(owner,input,id,model);claimDirectorTurn(owner,input,id);const currentScript=cardCanary?.canaryScenario?.currentScript||currentDirectorScriptContext(owner,input);claimDepthClone(owner,input,id,model);claimImageRevision(owner,input,id,model,preparedImage.snapshot);const conversationContext=input.kind==='agent'?captureConversationContext(owner,input.conversationId,id,input.prompt,input.references):undefined;const prompt=input.rollingChild&&rollingParent?{id:rollingParent.configurationSnapshot?.promptVersionId||rollingParent.route?.promptId||'rolling-parent',content:rollingParent.compiledPrompt,version:rollingParent.promptVersion}:cardCanary?{id:cardCanary.prompt.id,content:cardCanary.prompt.content,version:cardCanary.prompt.version}:adminCanary?baselinePromptTemplates().find(item=>item.id===route.promptId)||(()=>{throw Error('管理员 canary 基线提示词不存在');})():template(route.promptId);const binding=(input.references||[]).map((r,index)=>{const source=directorApplication?.sourceReferences[index];return `参考${index+1}：${source?`编导素材职责 ${source.slot}；下游输入职责 ${r.slot}`:r.slot}，文件 ${refs[index].name}`;}).join('\n');const published=currentPublishedCommerceConfiguration();const publishedRoute=cardCanary?.route||published?.routes.find(item=>item.operationId===route.id);const cardKey=cardCanary?.card.stableKey||(input.purpose==='director'?findDirectorCard(input.director||'')?.key:undefined);const publishedCard=cardCanary?.card||(!rollingParent&&cardKey?published?.cards.find(item=>item.stableKey===cardKey):undefined);const publishedPrompt=cardCanary?.prompt||published?.prompts.find(item=>item.promptKey===route.promptId);const knowledge=cardCanary?cardCanary.knowledge:rollingParent?[]:published?.knowledge.filter(item=>item.enabled&&(item.applicableCardKeys.length===0||!!cardKey&&item.applicableCardKeys.includes(cardKey)))||[];const promptPackage=rollingParent?.configurationSnapshot?.promptPackage||resolveCommercePromptPackageIdentity(input,{prompt,promptVersionId:cardCanary?.prompt.id||publishedPrompt?.id,authority:cardCanary||published?'published-release':catalogDirect?'curated-main-catalog':'legacy-local'});if(internalContext?.quotedPromptPackage&&!sameCommercePromptPackageIdentity(internalContext.quotedPromptPackage,promptPackage))throw Error('报价对应的提示词或技能版本已经变化，请重新报价');const directorRules=input.purpose==='director'||cardCanary?.card.executorType==='director'?`本次脚本目标总时长 ${input.scriptDuration} 秒，语言 ${input.spokenLanguage}。允许多轮修订；未要求修改的镜头必须保留。声音参考未提供给文字模型收听或转写，只能作为后续视频模型的声线或音轨参考；不得声称听到了音频内容，也不得据此编造台词、人物身份或事实。`:'';const mediaRules=input.kind==='image'?imageMentionBinding(preparedImage.snapshot)+imageTextSourceInstruction(imageTextProvenance,input.prompt):input.kind==='video'?'应用已确认脚本时保持素材顺序、时长、画幅、清晰度、声音设置和来源脚本身份。':'';const compiledPrompt=compileCommercePrompt({systemPrompt:prompt.content+'\n'+directorRules+'\n'+mediaRules,knowledge,card:publishedCard,materialBindings:binding,configuredFields:{...(input.configuredFields||{}),spokenLanguage:input.spokenLanguage,scriptDuration:input.scriptDuration,aspectRatio:input.aspectRatio,resolution:input.resolution,duration:input.duration,generateAudio:input.generateAudio,directorSettings:input.directorTurn?.settings},userRequest:input.prompt,verifiedHistory:conversationContext?JSON.stringify(conversationContext.messages.slice(0,-1)):'',currentScript});const configurationSnapshot:CommerceJobConfigurationSnapshot=rollingParent?.configurationSnapshot?{...rollingParent.configurationSnapshot}:cardCanary?{configurationSource:'published-release',releaseId:cardCanary.releaseId,releaseVersion:cardCanary.releaseVersion,manifestSha256:cardCanary.manifestSha256,cardVersionId:cardCanary.card.id,cardVersion:cardCanary.card.version,promptVersionId:cardCanary.prompt.id,promptVersion:cardCanary.prompt.version,promptPackage,knowledgeVersionIds:cardCanary.knowledge.map(item=>item.id),routeVersionId:cardCanary.route.id,routeVersion:cardCanary.route.version,modelConfigHash:model.configHash}:published&&publishedRoute&&publishedPrompt?{configurationSource:'published-release',releaseId:published.releaseId,releaseVersion:published.releaseVersion,manifestSha256:published.manifestSha256,...(publishedCard?{cardVersionId:publishedCard.id,cardVersion:publishedCard.version}:{}),promptVersionId:publishedPrompt.id,promptVersion:publishedPrompt.version,promptPackage,knowledgeVersionIds:knowledge.map(item=>item.id),routeVersionId:publishedRoute.id,routeVersion:publishedRoute.version,modelConfigHash:model.configHash}:catalogDirect?{configurationSource:'curated-main-catalog',promptVersionId:promptPackage.promptVersionId,promptVersion:prompt.version,promptPackage,knowledgeVersionIds:[],routeVersionId:route.id,routeVersion:route.revision,modelConfigHash:model.configHash}:{configurationSource:'legacy-local',promptVersionId:promptPackage.promptVersionId,promptVersion:prompt.version,promptPackage,knowledgeVersionIds:[],routeVersionId:route.id,routeVersion:route.revision,modelConfigHash:model.configHash};if(quotedModelSelection)configurationSnapshot.modelSelection=structuredClone(quotedModelSelection.snapshot);if(quoteBinding){configurationSnapshot.quoteId=quoteBinding.quoteId;configurationSnapshot.inputFingerprint=quoteBinding.inputFingerprint;configurationSnapshot.clientRequestId=quoteBinding.clientRequestId;}const aggregateBilling=internalContext?.aggregateBilling;if(aggregateBilling){if(aggregateBilling.clientRequestId!==input.requestId)throw Error('父报价客户端请求号与任务不一致');if(aggregateBilling.releaseId&&(configurationSnapshot.releaseId!==aggregateBilling.releaseId||configurationSnapshot.releaseVersion!==aggregateBilling.releaseVersion||configurationSnapshot.manifestSha256!==aggregateBilling.manifestSha256))throw Error('父报价对应的发布配置已经变化，请重新报价');configurationSnapshot.quoteId=aggregateBilling.quoteId;configurationSnapshot.inputFingerprint=createHash('sha256').update(stableJson({quoteFingerprint:aggregateBilling.quoteFingerprint,nodeId:aggregateBilling.nodeId,input,billing:aggregateBilling.item})).digest('hex');configurationSnapshot.clientRequestId=aggregateBilling.clientRequestId;}const value:Job={id,owner,input,model,route,...(configurationSnapshot?{configurationSnapshot}:{}),...(conversationContext?{conversationContext}:{}),...(preparedImage.snapshot?{imageReferenceSnapshot:preparedImage.snapshot}:{}),...(imageTextProvenance?{imageTextProvenance: imageTextProvenance}:{}),...(directorApplication?.sourceContentHash&&directorApplication.sourceConfigurationHash?{directorApplicationSnapshot:{kind:'director' as const,applicationId:directorApplication.id,sourceJobId:directorApplication.jobId,sourceMessageId:directorApplication.messageId,sourceContentHash:directorApplication.sourceContentHash,sourceConfigurationHash:directorApplication.sourceConfigurationHash}}:{}),events:[{at:Date.now(),stage:'validated'},{at:Date.now(),stage:'queued'}],status:'queued',createdAt:Date.now(),updatedAt:Date.now(),assetIds:[],promptVersion:prompt.version,compiledPrompt};if(aggregateBilling)value.billing=publicBillingState(bindJobToAggregateCharge(value,aggregateBilling.quoteId,aggregateBilling.item));put('jobs',id,owner,value);if(input.kind==='agent'&&input.conversationId){let chat=conversation(input.conversationId,owner);if(!chat)chat={id:input.conversationId,title:input.prompt.slice(0,32)||'新对话',createdAt:Date.now(),updatedAt:Date.now(),messages:[]};chat.messages.push({id:crypto.randomUUID(),role:'user',content:input.prompt,jobId:id,assetIds:refs.map(a=>a.id)});chat.updatedAt=Date.now();put('conversations',chat.id,owner,chat);}return value;});}
async function inputs(value:Job,executionPermit?:JobExecutionPermit){
 const images:string[]=[],audios:string[]=[],videos:string[]=[],guard=executionPermit?.isCurrent;
 if(value.input.purpose===DEPTH_PURPOSE){await verifyDepthBytes(value.owner,value.input);if(!value.input.depthSnapshot)throw Error('深度复刻缺少冻结输入');return prepareDepthPublicInputs(value.owner,value.input.depthSnapshot,guard);}
 if(value.input.purpose==='prompt-assist.breakdown'){const evidence=await readCreativeVideoEvidence(value.owner,value.input.creativeEvidenceId||'');const request=JSON.parse(value.input.prompt);if(evidence.source.assetId!==request.evidence.assetId||evidence.source.sha256!==request.evidence.sha256)throw new ModelChangedBeforeDispatch();for(const frame of evidence.frames)images.push('data:image/jpeg;base64,'+(await creativeVideoEvidenceBytes(value.owner,evidence.id,frame.file)).toString('base64'));return {images,audios,videos};}
 const refs=[...(value.input.references||[])].sort((a,b)=>(a.slot==='last-frame'?1:0)-(b.slot==='last-frame'?1:0));
 for(const ref of refs){
  const asset=readAsset(ref.id,value.owner);if(!asset)throw Error('参考素材不存在');await assertAssetIntegrity(asset);if(guard?.()===false)throw Error('参考素材所属任务的执行租约已经失效');
  if(value.input.kind==='video'){const prepared=await ensureProviderReference(asset,guard),url=prepared.providerReferenceUrl!;(asset.type.startsWith('image/')?images:asset.type.startsWith('audio/')?audios:videos).push(url);}
  else if(asset.type.startsWith('video/')&&value.input.kind==='agent')images.push(...await videoFrames(asset,value.id,executionPermit?.lease.token,guard));
  else if(asset.type.startsWith('image/')){if(value.model.source==='custom'&&['secure-image-native','seedream-image'].includes(value.model.protocol||'')){const prepared=await ensureProviderReference(asset,guard);images.push(prepared.providerReferenceUrl!);}else images.push((await providerImageReferenceDataUrl(await assetBytes(asset),asset.type)).dataUrl);}
 }
 return {images,audios,videos};
}
async function failConfirmed(value:Job,error:unknown,executionPermit?:JobExecutionPermit){if(executionPermit&&!executionPermit.isCurrent())return;value.status='failed';value.error=error instanceof Error?error.message:String(error);persistJob(value,executionPermit);await applyConfirmedFailureBilling(value,executionPermit);}
async function complete(value:Job,result:Record<string,unknown>,executionPermit?:JobExecutionPermit){if(executionPermit&&!executionPermit.isCurrent())return;if(result.usage!==undefined)value.usage=result.usage;if(value.input.kind==='agent'){value.text=String(result.text||'');if(!value.text.trim())throw Error('模型未返回正文');value.usage=result.usage;if(value.input.purpose==='prompt-assist.breakdown'||value.input.purpose==='prompt-assist.remix-script'){try{const request=JSON.parse(value.input.prompt);if(value.input.purpose==='prompt-assist.breakdown')parseReferenceBreakdown(value.text,request.evidence);else parseRemixScript(value.text,value.input.references||[],request.videoSettings);}catch(error){await failConfirmed(value,error,executionPermit);return;}}if(value.input.purpose==='detail-set.analyze'){try{const request=JSON.parse(value.input.prompt);parseDetailAnalysis(value.text,value.input.references||[],detailConfig(request.config));}catch(error){await failConfirmed(value,error,executionPermit);return;}}if(value.input.purpose==='prompt-assist.analyze'){try{parseProductAnalysis(value.text,value.input.references||[]);}catch(error){await failConfirmed(value,error,executionPermit);return;}}if(value.input.conversationId){const chat=conversation(value.input.conversationId,value.owner);if(chat&&!chat.messages.some(m=>m.role==='assistant'&&m.jobId===value.id)){chat.messages.push({id:crypto.randomUUID(),role:'assistant',content:value.text,jobId:value.id});chat.updatedAt=Date.now();put('conversations',chat.id,value.owner,chat);}}}else{value.providerUrl=String(result.url||result.videoUrl||'');if(!value.providerUrl)throw Error('模型未返回可保存的媒体');value.status='saving';persistJob(value,executionPermit);try{const assetKey=`job-result:${value.id}`;let asset=readIdempotentAsset(value.owner,assetKey);if(asset){if(asset.jobId!==value.id||!asset.type.startsWith(`${value.input.kind}/`))throw Error('已落地生成资产与任务身份不一致');try{await assertAssetIntegrity(asset);}catch{asset=undefined;}}if(!asset){let downloaded:{bytes:Buffer;type:string}=await downloadResult(value.providerUrl,value.input.kind);if(value.input.kind==='video')downloaded=await enforceVideoAudioPolicy(downloaded,value.input.generateAudio);if(value.input.kind==='image')downloaded=await normalizeGeneratedImageOutput(downloaded,value.input.aspectRatio,value.input.resolution,value.input.format);const extension=downloaded.type.split('/')[1].replace('jpeg','jpg');asset=await storeAsset(value.owner,downloaded.bytes,downloaded.type,`${value.input.kind==='image'?'图片':'视频'}-${value.id.slice(0,8)}.${extension}`,'generated',value.id,undefined,assetKey,executionPermit?.isCurrent);}if(value.providerUrl.startsWith('https://')&&!asset.providerReferenceUrl){asset=await mutateAsset(value.owner,asset.id,current=>({...current,providerReferenceUrl:value.providerUrl}),executionPermit?.isCurrent);}if(executionPermit&&!executionPermit.isCurrent())return;value.assetIds=[asset.id];}catch(error){if(executionPermit&&!executionPermit.isCurrent())return;value.status='save_failed';value.error=error instanceof Error?error.message:'结果保存失败';persistJob(value,executionPermit);return;}}if(executionPermit&&!executionPermit.isCurrent())return;value.status='succeeded';value.error=undefined;persistJob(value,executionPermit);await applyTerminalBilling(value,'revenue',executionPermit);}
function endpoint(base:string,route:string){return `${base.replace(/\/$/,'').replace(/\/(chat\/completions|images\/generations|contents\/generations\/tasks)$/,'')}/${route}`;}
async function customResult(value:Job,result:ProviderResult,executionPermit?:JobExecutionPermit){if(executionPermit&&!executionPermit.isCurrent())return;if(result.status==='success'){await complete(value,result as unknown as Record<string,unknown>,executionPermit);return;}if(executionPermit&&!executionPermit.isCurrent())return;value.status=result.status==='failed'?'failed':'processing';value.providerTaskId=result.taskId||value.providerTaskId;value.pollPath=result.pollPath||value.pollPath;if(result.status==='failed')value.error='上游返回失败或没有有效结果';persistJob(value,executionPermit);if(value.status==='failed')await applyConfirmedFailureBilling(value,executionPermit);}
export function chatMessages(value:Job,images:string[]){if(value.input.kind==='agent'&&value.conversationContext)return snapshotChatMessages(value.conversationContext,value.id,value.input.prompt,value.compiledPrompt,images);const history=value.input.conversationId?conversation(value.input.conversationId,value.owner)?.messages.filter(m=>!m.jobId||m.jobId===value.id||job(m.jobId,value.owner)?.status==='succeeded').slice(-20):undefined;const messages:{role:string;content:unknown}[]=[{role:'system',content:value.compiledPrompt},...(history?.length?history.map(m=>({role:m.role,content:m.content})):[{role:'user',content:value.input.prompt}])];if(images.length)messages[messages.length-1]={role:'user',content:[{type:'text',text:value.input.prompt},...images.map(url=>({type:'image_url',image_url:{url}}))]};return messages;}
async function verifyDispatchSnapshot(value:Job){
 const current=await assertJobModelSnapshotCurrent(value);await verifyImageReferenceBytes(value.owner,value.input,value.imageReferenceSnapshot);await verifyDepthBytes(value.owner,value.input);
 if(value.input.imageRevisionQuoteId)verifyImageRevisionDispatch(value.owner,value.input,current,value.imageReferenceSnapshot);
 if(value.input.purpose===DEPTH_PURPOSE)verifyDepthDispatch(value.owner,value.input,current);
 verifyAssistApplication(value.owner,value.input);verifyDirectorApplication(value.owner,value.input);
 if(value.input.assistQuoteId)verifyAssistDispatch(value.owner,value.input,current);
 if(value.input.detailQuoteId)verifyDetailDispatch(value.owner,value.input,current);
 for(const reference of value.input.references||[]){const asset=readAsset(reference.id,value.owner);if(!asset)throw Error('参考素材不存在');await assertAssetIntegrity(asset);}
 return current;
}
type PreparedDispatchPayload={images:string[];audios:string[];videos:string[];messages:{role:string;content:unknown}[];responseFormat?:'json_object';providerInput:ProviderInput;customModel?:Model;gatewayInput:Record<string,unknown>};
async function prepareDispatchPayload(value:Job,executionPermit:JobExecutionPermit):Promise<PreparedDispatchPayload>{
 await verifyDispatchSnapshot(value);const {images,audios,videos}=await inputs(value,executionPermit);if(!executionPermit.isCurrent())throw Error('任务执行租约已经失效');
 const messages=chatMessages(value,value.input.kind==='agent'?images:[]),responseFormat=directorProviderResponseFormat(value.input),providerInput:ProviderInput={id:value.id,prompt:value.input.kind==='agent'?value.input.prompt:value.compiledPrompt,system:String(messages[0]?.content||value.compiledPrompt),...(value.input.kind==='agent'?{messages}:{}),images,audios,videos,aspectRatio:value.input.aspectRatio,resolution:value.input.resolution,duration:value.input.duration,generateAudio:value.input.generateAudio,responseFormat};
 let customModel:Model|undefined;
 if(value.model.source==='custom'){customModel=get<Model>('models',value.model.id,'system');if(!customModel?.enabled||modelIdentity(customModel)!==modelIdentity(value.model))throw new ModelChangedBeforeDispatch();await modelSecret(customModel.id);buildProviderRequest(customModel,providerInput);}
 else await assertMainGatewayReady();
 return {images,audios,videos,messages,responseFormat,providerInput,customModel,gatewayInput:{stream:value.input.kind==='agent'&&!responseFormat,responseFormat,action:'invoke',id:value.id,kind:value.input.kind,modelId:value.model.id,modelConfigHash:value.model.configHash,prompt:value.compiledPrompt,messages,images,audios,videos,aspectRatio:value.input.aspectRatio,resolution:value.input.resolution,duration:value.input.duration,generateAudio:value.input.generateAudio}};
}
async function verifyPreparedDispatchPayload(value:Job,prepared:PreparedDispatchPayload){await verifyDispatchSnapshot(value);if(value.model.source==='custom'){const current=get<Model>('models',value.model.id,'system');if(!current?.enabled||modelIdentity(current)!==modelIdentity(value.model)||!prepared.customModel||modelIdentity(prepared.customModel)!==modelIdentity(current))throw new ModelChangedBeforeDispatch();await modelSecret(current.id);buildProviderRequest(current,prepared.providerInput);}else await assertMainGatewayReady();}
async function invokeCustom(value:Job,prepared:PreparedDispatchPayload,onDispatch:()=>void,executionPermit:JobExecutionPermit){const config=prepared.customModel;if(!config?.enabled||modelIdentity(config)!==modelIdentity(value.model))throw new ModelChangedBeforeDispatch();verifyAssistDispatch(value.owner,value.input,config);verifyDetailDispatch(value.owner,value.input,config);verifyDepthDispatch(value.owner,value.input,config);verifyImageRevisionDispatch(value.owner,value.input,config,value.imageReferenceSnapshot);await verifyImageReferenceBytes(value.owner,value.input,value.imageReferenceSnapshot);onDispatch();await customResult(value,await submitProvider(config,prepared.providerInput,value.input.kind==='agent'&&!prepared.responseFormat?text=>{value.text=text;const now=Date.now();if(executionPermit.isCurrent()&&now-value.updatedAt>100)persistJob(value,executionPermit);}:undefined),executionPermit);}
async function runJobWithExecutionLease(id:string,owner:string,rollingPermit:RollingExecutionPermit|undefined,executionPermit:JobExecutionPermit){
 if(!executionPermit.isCurrent())return;
 const pending=job(id,owner);if(pending?.input.rollingPlan&&!pending.input.rollingChild&&!rollingPermit)return;if(active.has(id))return;
 const value=claimQueuedJob<Job>(id,owner);if(!value)return;
 active.add(id);let dispatched=false,billingCommitted=Boolean(value.billing);
 try{
  value.status='running';value.startedAt=Date.now();persistJob(value,executionPermit);
  const prepared=await prepareDispatchPayload(value,executionPermit);
  persistJobStage(value,'inputs-ready',executionPermit);
  if(value.input.rollingPlan&&!value.input.rollingChild){
   const {runRollingJob,preflightRollingJob}=await import('./rolling-video');preflightRollingJob(value);
   await applyJobBilling(value,'charge',executionPermit);billingCommitted=true;
   persistJobStage(value,'billing-committed',executionPermit);
   await verifyPreparedDispatchPayload(value,prepared);
   await runRollingJob(value,owner,rollingPermit);
   const rollingStatus=(job(value.id,owner)||value).status;
   if(rollingStatus==='succeeded')await applyTerminalBilling(value,'revenue',executionPermit);
   else if(rollingStatus==='failed'){await applyTerminalBilling(value,'refund',executionPermit);await applyRollingFailureCost(value,executionPermit);}
   return;
  }
  if(jobOwnsWalletCharge(value)){await applyJobBilling(value,'charge',executionPermit);billingCommitted=true;persistJobStage(value,'billing-committed',executionPermit);}
  await verifyPreparedDispatchPayload(value,prepared);
  if(value.model.source==='custom'){
   await invokeCustom(value,prepared,()=>{dispatched=true;value.dispatchedAt=Date.now();persistJobStage(value,'provider-dispatched',executionPermit);},executionPermit);return;
  }
  dispatched=true;value.dispatchedAt=Date.now();persistJobStage(value,'provider-dispatched',executionPermit);
  const receipt=await gateway(prepared.gatewayInput,undefined,undefined,value.input.kind==='agent'&&!prepared.responseFormat?text=>{value.text=text;if(executionPermit.isCurrent()&&Date.now()-value.updatedAt>100)persistJob(value,executionPermit);}:undefined);
  await applyReceipt(value,receipt,executionPermit);
 }catch(error){
  if(!executionPermit.isCurrent())return;
  value.status=dispatched&&!(error instanceof ModelChangedBeforeDispatch)&&!isExplicitProviderRejection(error)?'unknown':'failed';value.error=error instanceof Error?error.message:'请求结果暂时未知';persistJob(value,executionPermit);
  if(value.status==='failed'&&(billingCommitted||Boolean(value.billing))){await applyConfirmedFailureBilling(value,executionPermit);if(value.input.rollingPlan&&!value.input.rollingChild)await applyRollingFailureCost(value,executionPermit);}
 }finally{active.delete(id);}
}
async function applyReceipt(value:Job,receipt:{status:string;result?:Record<string,unknown>;error?:string},executionPermit?:JobExecutionPermit){if(executionPermit&&!executionPermit.isCurrent())return;if(receipt.status==='success'){await complete(value,receipt.result||{},executionPermit);return;}if(executionPermit&&!executionPermit.isCurrent())return;value.status=receipt.status==='failed'?'failed':['processing','queued'].includes(receipt.status)?'processing':'unknown';value.error=receipt.error;if(receipt.result?.taskId)value.providerTaskId=String(receipt.result.taskId);persistJob(value,executionPermit);if(value.status==='failed')await applyConfirmedFailureBilling(value,executionPermit);}
async function refreshJobWithExecutionLease(id:string,owner:string,rollingPermit:RollingExecutionPermit|undefined,executionPermit:JobExecutionPermit){
 if(!executionPermit.isCurrent())return;
 const value=job(id,owner);if(!value||active.has(id)||Date.now()-value.updatedAt<5000)return;
 if(value.input.rollingPlan&&!value.input.rollingChild&&!rollingPermit)return;
 if(value.status==='queued'){await runJobWithExecutionLease(id,owner,rollingPermit,executionPermit);return;}
 if(!['processing','unknown','running'].includes(value.status))return;
 if(value.status==='unknown'&&isExplicitProviderRejection(value.error)){await failConfirmed(value,new Error(value.error),executionPermit);return;}
 active.add(id);
 try{
  if(value.input.rollingPlan&&!value.input.rollingChild){
   if(value.status==='unknown'){
    const existingBilling=getJobBillingState(value);
    if(!existingBilling||!['charged','zero_price','exempt'].includes(existingBilling.status))return;
    value.billing=publicBillingState(existingBilling);
    const {runRollingJob}=await import('./rolling-video');await runRollingJob(value,owner,rollingPermit);
    const rollingStatus=(job(value.id,owner)||value).status;
    if(rollingStatus==='succeeded')await applyTerminalBilling(value,'revenue',executionPermit);
    else if(rollingStatus==='failed'){await applyTerminalBilling(value,'refund',executionPermit);await applyRollingFailureCost(value,executionPermit);}
    return;
   }
   let billingCommitted=Boolean(value.billing);
   try{
    const prepared=await prepareDispatchPayload(value,executionPermit);
    const {runRollingJob,preflightRollingJob}=await import('./rolling-video');preflightRollingJob(value);
    persistJobStage(value,'inputs-ready',executionPermit);
    await applyJobBilling(value,'charge',executionPermit);billingCommitted=true;persistJobStage(value,'billing-committed',executionPermit);
    await verifyPreparedDispatchPayload(value,prepared);
    await runRollingJob(value,owner,rollingPermit);
    const rollingStatus=(job(value.id,owner)||value).status;
    if(rollingStatus==='succeeded')await applyTerminalBilling(value,'revenue',executionPermit);
    else if(rollingStatus==='failed'){await applyTerminalBilling(value,'refund',executionPermit);await applyRollingFailureCost(value,executionPermit);}
   }catch(error){
    if(!executionPermit.isCurrent())return;
    value.status='failed';value.error=error instanceof Error?error.message:'滚动任务恢复前置检查失败';persistJob(value,executionPermit);
    if(billingCommitted){await applyTerminalBilling(value,'refund',executionPermit);await applyRollingFailureCost(value,executionPermit);}
   }
   return;
  }
  if(value.model.source==='main'){const receipt=value.status==='processing'?await gateway({action:'poll',id:value.id,kind:value.input.kind,modelId:value.model.id,modelConfigHash:value.model.configHash}):await gateway(undefined,value.id);await applyReceipt(value,receipt,executionPermit);}
  else if(value.providerTaskId&&value.pollPath){const config=get<Model>('models',value.model.id,'system');if(!config||modelIdentity(config)!==modelIdentity(value.model))return;await customResult(value,await pollProvider(config,value.pollPath),executionPermit);}
 }catch{ /* Keep the original request; never dispatch it again on poll failure. */ }
 finally{active.delete(id);}
}

export async function runJob(id:string,owner:string,rollingPermit?:RollingExecutionPermit){
 return withJobExecutionLease(id,owner,permit=>runJobWithExecutionLease(id,owner,rollingPermit,permit));
}

export async function refreshJob(id:string,owner:string,rollingPermit?:RollingExecutionPermit){
 return withJobExecutionLease(id,owner,permit=>refreshJobWithExecutionLease(id,owner,rollingPermit,permit));
}

export async function advanceRollingParentWithLease(id:string,owner:string,permit:RollingExecutionPermit){let value=job(id,owner);if(!value?.input.rollingPlan||value.input.rollingChild)throw Error('滚动父任务不存在');if(!permit.isCurrent())return value;if(['save_failed','saving'].includes(value.status)){const {restitchRollingJob}=await import('./rolling-video');value=await restitchRollingJob(value,owner,permit);if(value.status==='succeeded')await reconcileJobBilling(id,owner);return job(id,owner)||value;}if(value.status==='queued')await runJob(id,owner,permit);else await refreshJob(id,owner,permit);return job(id,owner)||value;}

function undispatchedRecoveryLeaseMs(value=Number(process.env.COMMERCE_UNDISPATCHED_RECOVERY_MS||300_000)){
  return Number.isFinite(value)?Math.max(60_000,Math.min(1_800_000,Math.trunc(value))):300_000;
}

/** Recover only a stale pre-dispatch execution. The transaction is the CAS:
 * after one worker changes running to queued, every competing worker fails the
 * same predicate. Provider-accepted/unknown work is excluded by dispatchedAt. */
export function claimStaleUndispatchedCommerceJob(id:string,owner:string,now=Date.now(),leaseMs=undispatchedRecoveryLeaseMs()){
  return transaction(()=>{
    const value=job(id,owner);
    if(!value||value.input.rollingPlan||value.status!=='running'||value.dispatchedAt!=null)return undefined;
    const executionLease=get<DurableRecordLease>(JOB_EXECUTION_LEASE_BUCKET,id,owner);
    if(executionLease&&executionLease.expiresAt>now)return undefined;
    const billing=getJobBillingState(value),cutoff=now-leaseMs;
    const startedAt=Number(value.startedAt||value.updatedAt),jobUpdatedAt=Number(value.updatedAt),billingUpdatedAt=Number(billing?.updatedAt);
    if(billing&&!['charge_pending','charged','zero_price','exempt'].includes(billing.status))return undefined;
    if(![startedAt,jobUpdatedAt].every(Number.isFinite)||billing&&!Number.isFinite(billingUpdatedAt)||startedAt>cutoff||jobUpdatedAt>cutoff||billing&&billingUpdatedAt>cutoff)return undefined;
    value.status='queued';
    value.startedAt=undefined;
    value.error=undefined;
    value.undispatchedRecovery={attempt:Number(value.undispatchedRecovery?.attempt||0)+1,recoveredAt:now};
    value.updatedAt=now;
    value.events||=[];
    value.events.push({at:now,stage:'recovered-undispatched-billing'});
    put('jobs',value.id,value.owner,value);
    return value;
  });
}

export async function reconcileStaleUndispatchedCommerceJobs(now=Date.now(),limit=4){
  const cutoff=now-undispatchedRecoveryLeaseMs();
  const rows=db().prepare(`SELECT id,owner FROM records WHERE bucket='jobs'
    AND json_extract(value,'$.input.rollingPlan') IS NULL
    AND json_extract(value,'$.dispatchedAt') IS NULL
    AND ((json_extract(value,'$.status')='running' AND updated<=?)
      OR (json_extract(value,'$.status')='queued' AND json_extract(value,'$.undispatchedRecovery.recoveredAt') IS NOT NULL))
    ORDER BY updated ASC LIMIT ?`).all(cutoff,Math.max(1,Math.min(20,Math.trunc(limit)||4)));
  for(const row of rows){
    const id=String(row.id),owner=String(row.owner),value=job(id,owner);
    if(value?.status==='queued'&&value.undispatchedRecovery)await runJob(id,owner);
    else if(claimStaleUndispatchedCommerceJob(id,owner,now))await runJob(id,owner);
  }
}

export async function reconcileJobBilling(id:string,owner:string){
 const reconciled=await withJobExecutionLease(id,owner,async permit=>{const value=job(id,owner);if(!value)throw Error('任务不存在');await applyJobBilling(value,'status',permit);if(value.status==='failed'){await applyJobBilling(value,'refund',permit);if(value.input.rollingPlan)await applyRollingFailureCost(value,permit);}else if(value.status==='succeeded')await applyJobBilling(value,'revenue',permit);return job(id,owner)||value;});
 const current=reconciled||job(id,owner);if(!current)throw Error('任务不存在');return current;
}
export async function recoverSavingJob(id:string,owner:string){
 const recovered=await withJobExecutionLease(id,owner,async permit=>{
  const value=job(id,owner);
  if(!value||value.input.rollingPlan||value.status!=='saving'||!value.providerUrl)return value;
  await complete(value,{url:value.providerUrl,videoUrl:value.providerUrl},permit);
  return job(id,owner)||value;
 });
 return recovered;
}

export async function retrySave(id:string,owner:string){
 const value=job(id,owner);
 if(value?.input.rollingPlan&&!value.input.rollingChild){
  if(value.status!=='save_failed')throw Error('滚动父任务当前没有可重新拼接的结果');
  const {processCommerceRollingJob}=await import('./rolling-video-worker');
  const recovered=await processCommerceRollingJob(id,owner,`manual-restitch:${process.pid}:${crypto.randomUUID()}`,{forceRestitch:true});
  if(!recovered)throw Error('滚动父任务正在由后台安全恢复，请稍后查看原任务');
  return recovered;
 }
 const recovered=await withJobExecutionLease(id,owner,async permit=>{
  const current=job(id,owner);
  if(!current||current.status!=='save_failed'||!current.providerUrl)throw Error('没有可重试保存的结果');
  await complete(current,{url:current.providerUrl,videoUrl:current.providerUrl},permit);
  return job(id,owner)||current;
 });
 if(!recovered)throw Error('原结果正在由后台安全保存，请稍后查看');
 return recovered;
}
