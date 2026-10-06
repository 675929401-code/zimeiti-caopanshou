import crypto from 'node:crypto';
import { stableJson, currentPublishedCommerceConfiguration, primePublishedCommerceConfiguration, assertPublishedCommercePaidJobsReady } from './configuration-platform';
import { resolveOperation } from './operation-routing';
import { models, selectedModel, type Kind } from './models';
import { billingQuantity, quoteCost, quotePrice } from './billing';
import { claim, get, put } from './store';
import { createJob, job, type Job, type JobInput } from './jobs';
import { findDirectorCard } from './director-catalog';
import { readAsset } from './assets';
import type { CommercePromptPackageIdentity, CommerceQuoteSnapshot } from '../shared/configuration-types';
import { requireCommerceModelAcceptance } from './model-acceptance';
import {ensureProviderReference} from './media-reference';
import {assertRollingTailFrameCapacity,assertVideoReferenceCapabilities} from './video-reference-capabilities';
import {assertCuratedMainCatalogExecutionReady,classifyCommerceCuratedModel,isCuratedConfigurationSelectable,usesCuratedMainCatalogDirectExecution} from './commerce-curated-model-profiles';
import {DEPTH_PURPOSE} from './depth-video-clone-schema';
import {assertCommerceVideoAudioSetting,assertCommerceVideoResolution,COMMERCE_VIDEO_MAX_TOTAL_DURATION,resolveCommerceVideoDurationPlan} from '../shared/video-generation-capabilities';
import {assertFrozenPrequoteSelection,selectPrequoteModel,type PrequoteModelSelectionSnapshot} from './prequote-model-selection';
import {template} from './prompts';
import {resolveCommercePromptPackageIdentity,sameCommercePromptPackageIdentity} from './prompt-package-identity';

type QuoteInput = Omit<JobInput, 'requestId'>;
type StoredQuote = CommerceQuoteSnapshot & { input: QuoteInput; taskRequestId?: string; routeVersion?: number; promptVersionId?: string; promptPackage:CommercePromptPackageIdentity; modelSelection: PrequoteModelSelectionSnapshot };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INPUT_KEYS = new Set([
  'kind', 'modelId', 'prompt', 'skillId', 'aspectRatio', 'resolution', 'format', 'duration', 'references',
  'imageReferenceDocument', 'imageRevisionQuoteId', 'conversationId', 'purpose', 'director', 'spokenLanguage',
  'scriptDuration', 'parentJobId', 'regenerationOf', 'requestedAspectRatio', 'promptOrigin', 'assistQuoteId',
  'creativeEvidenceId', 'assistApplicationId', 'directorTurn', 'directorApplicationId', 'generateAudio',
  'detailQuoteId', 'detailRunId', 'detailRowId', 'depthQuoteId', 'depthSnapshot', 'configuredFields',
]);

function parseInput(raw: unknown): QuoteInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('报价参数无效');
  const source = raw as Record<string, unknown>;
  const forbidden = ['requestId', 'rollingChild', 'rollingPlan', 'rollingParentJobId', 'rollingSegmentIndex', 'cost', 'price', 'amount', 'profit'];
  if (forbidden.some((key) => key in source)) throw Error('报价包含客户端无权指定的字段');
  const unknown = Object.keys(source).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length) throw Error(`报价包含不支持的字段：${unknown.slice(0, 3).join('、')}`);
  if (!['agent', 'image', 'video'].includes(String(source.kind)) || typeof source.prompt !== 'string') throw Error('报价参数无效');
  return structuredClone(source) as QuoteInput;
}

function fingerprint(input: QuoteInput): string {
  return crypto.createHash('sha256').update(stableJson(input)).digest('hex');
}

function withValidatedVideoPlan(input: QuoteInput, capabilities: Record<string, unknown>): QuoteInput {
  if (input.kind !== 'video') return input;
  const depth = input.purpose === DEPTH_PURPOSE;
  const plan = resolveCommerceVideoDurationPlan(capabilities, input.duration, { minimum: depth ? 4 : 1, maximum: COMMERCE_VIDEO_MAX_TOTAL_DURATION, allowRolling: !depth });
  assertCommerceVideoAudioSetting(capabilities, input.generateAudio);
  assertCommerceVideoResolution(capabilities, input.resolution);
  return plan.native ? input : { ...input, rollingPlan: { segments: plan.segments } };
}

function publicQuote(quote: StoredQuote) {
  return {
    id: quote.id,
    schema: quote.schema,
    operationId: quote.operationId,
    inputFingerprint: quote.inputFingerprint,
    model: { ...(quote.input.kind==='video'?{id:quote.modelId}:{}), displayName: quote.modelDisplayName },
    billingUnit: quote.billingUnit,
    quantity: quote.quantity,
    unitPrice: quote.unitPrice,
    payableTotal: quote.payableTotal,
    currency: quote.currency,
    releaseVersion: quote.releaseVersion,
    releaseId: quote.releaseId,
    manifestSha256: quote.manifestSha256,
    promptPackage: quote.promptPackage,
    expiresAt: quote.expiresAt,
    status: quote.status,
    jobId: quote.jobId,
    modelSelection: {
      fallbackUsed: quote.modelSelection.fallbackUsed,
      reason: quote.modelSelection.reason,
      candidateOrder: quote.modelSelection.candidates.map((candidate, index) => ({
        ...(quote.input.kind==='video'?{id:candidate.modelId||candidate.configuredId}:{}),
        displayName: candidate.displayName,
        selected: index === quote.modelSelection.selectedIndex,
        ready: candidate.ready,
        reason: candidate.reason,
      })),
    },
  };
}

export async function createCommerceQuote(owner: string, raw: unknown, internal: { taskRequestId?: string } = {}) {
  let input = parseInput(raw);
  const catalogDirect=usesCuratedMainCatalogDirectExecution(input.kind);
  const sharedConfigurationRequired=process.env.SHARED_CONFIGURATION_ENABLED === '1';
  await primePublishedCommerceConfiguration({ required: sharedConfigurationRequired });
  if(sharedConfigurationRequired)assertPublishedCommercePaidJobsReady();
  const route = resolveOperation(internal.taskRequestId ? { ...input, modelId: undefined } : input);
  const referenceAssets=(input.references||[]).map((ref)=>{const asset=readAsset(ref.id,owner);if(!asset)throw Error('报价引用的素材不存在或不属于当前账号');return asset;});
  const selected=selectPrequoteModel(route,await models(input.kind as Kind),{
    requireCuratedMainCatalog:catalogDirect,
    requireImageParsing:input.kind==='agent'&&referenceAssets.some((asset)=>asset.type.startsWith('image/')||asset.type.startsWith('video/')),
  });
  const model=selected.model;
  if((input.kind==='agent'||input.kind==='image')&&(!classifyCommerceCuratedModel(model)||!isCuratedConfigurationSelectable(input.kind,model.id)))throw Error('所选模型未通过带货 Agent 白名单身份核对');
  if(catalogDirect)assertCuratedMainCatalogExecutionReady(model);
  input = { ...input, modelId: model.id };
  if (!model.configHash) throw Error('模型配置哈希缺失，已停止报价');
  input = withValidatedVideoPlan(input, model.capabilities);
  if(input.kind==='video'){assertVideoReferenceCapabilities(model.capabilities,referenceAssets);if(input.rollingPlan)assertRollingTailFrameCapacity(model.capabilities,referenceAssets);for(const asset of [...new Map(referenceAssets.map(value=>[value.id,value])).values()])await ensureProviderReference(asset);}
  const published = currentPublishedCommerceConfiguration();
  if (published && !catalogDirect) await requireCommerceModelAcceptance(model);
  const quantity = billingQuantity(input, model);
  const totalCost = quoteCost(input, model);
  const payable = quotePrice(input, model);
  if (payable < totalCost) throw Error('模型售价低于成本，已停止报价');
  if (payable === 0 && model.capabilities.explicitlyFree !== true) throw Error('0 元模型未显式标记免费，已停止报价');
  const unitCost = Number(model.costPrice);
  const unitPrice = Number(model.publicPrice);
  const cardKey = input.purpose === 'director' ? findDirectorCard(input.director || '')?.key : undefined;
  const card = cardKey ? published?.cards.find((item) => item.stableKey === cardKey) : undefined;
  const publishedRoute = published?.routes.find((item) => item.operationId === route.id);
  const publishedPrompt = published?.prompts.find((item) => item.promptKey === route.promptId);
  const prompt=template(route.promptId);
  const promptPackage=resolveCommercePromptPackageIdentity(input,{prompt,promptVersionId:publishedPrompt?.id,authority:published?'published-release':catalogDirect?'curated-main-catalog':'legacy-local'});
  const now = Date.now();
  const quote: StoredQuote = {
    schema: 'commerce-quote/v1', id: crypto.randomUUID(), owner, operationId: route.id,
    ...(internal.taskRequestId ? { taskRequestId: internal.taskRequestId } : {}),
    ...(card ? { cardVersionId: card.id } : {}), input, inputFingerprint: fingerprint(input),
    modelId: model.id, modelDisplayName: model.displayName, modelConfigHash: model.configHash,
    modelSelection:selected.snapshot,
    billingUnit: model.billingUnit, quantity, unitCost, estimatedTotalCost: totalCost, unitPrice,
    payableTotal: payable, profitAmount: Math.round((payable - totalCost) * 10000) / 10000,
    profitRate: totalCost > 0 ? Math.round(((payable - totalCost) / totalCost) * 1000000) / 10000 : null,
    currency: 'CNY', ...(published ? { releaseId: published.releaseId, releaseVersion: published.releaseVersion, manifestSha256: published.manifestSha256 } : {}),
    ...(publishedRoute ? { routeVersion: publishedRoute.version } : {}), ...(publishedPrompt ? { promptVersionId: publishedPrompt.id } : {}), promptPackage,
    createdAt: now, expiresAt: now + 10 * 60_000, status: 'quoted',
  };
  put('commerce-quotes', quote.id, owner, quote);
  return publicQuote(quote);
}

export async function createCommerceJobQuote(owner:string,input:JobInput){
  if(!UUID.test(input.requestId))throw Error('内部任务请求号无效');
  const {requestId,...quotedInput}=input;
  return createCommerceQuote(owner,quotedInput,{taskRequestId:requestId});
}

function assertSnapshotCurrent(quote: StoredQuote, input: QuoteInput, route: ReturnType<typeof resolveOperation>, model: Awaited<ReturnType<typeof selectedModel>>) {
  const published = currentPublishedCommerceConfiguration();
  if (quote.releaseId && (!published || published.releaseId !== quote.releaseId || published.releaseVersion !== quote.releaseVersion || published.manifestSha256 !== quote.manifestSha256)) throw Error('报价对应的配置版本已经变化，请重新报价');
  assertFrozenPrequoteSelection(quote.modelSelection,route,model);
  const catalogDirect=usesCuratedMainCatalogDirectExecution(input.kind),currentPrompt=template(route.promptId),publishedPrompt=published?.prompts.find(item=>item.promptKey===route.promptId),currentPackage=resolveCommercePromptPackageIdentity(input,{prompt:currentPrompt,promptVersionId:publishedPrompt?.id,authority:publishedPrompt?'published-release':catalogDirect?'curated-main-catalog':'legacy-local'});
  if(!sameCommercePromptPackageIdentity(quote.promptPackage,currentPackage))throw Error('报价对应的提示词或技能版本已经变化，请重新报价');
  if (route.id !== quote.operationId || model.id !== quote.modelId || model.configHash !== quote.modelConfigHash) throw Error('报价对应的模型路由已经变化，请重新报价');
  if (billingQuantity(input, model) !== quote.quantity || quoteCost(input, model) !== quote.estimatedTotalCost || quotePrice(input, model) !== quote.payableTotal) throw Error('报价对应的模型价格已经变化，请重新报价');
}

export async function confirmCommerceQuote(owner: string, raw: { quoteId?: unknown; clientRequestId?: unknown; inputFingerprint?: unknown }): Promise<Job> {
  const quoteId = String(raw.quoteId || '');
  const clientRequestId = String(raw.clientRequestId || '');
  const suppliedFingerprint = String(raw.inputFingerprint || '');
  if (!UUID.test(quoteId) || !UUID.test(clientRequestId)) throw Error('报价或客户端请求号无效');
  const quote = get<StoredQuote>('commerce-quotes', quoteId, owner);
  if (!quote) throw Error('报价不存在或不属于当前账号');
  if (quote.inputFingerprint !== suppliedFingerprint) throw Error('报价输入指纹不一致');
  if (quote.jobId) {
    if (quote.clientRequestId !== clientRequestId) throw Error('该报价已由另一客户端请求确认');
    const previous = job(quote.jobId, owner);
    if (!previous) throw Error('原报价已确认但任务记录待对账');
    if(previous.configurationSnapshot?.quoteId!==quote.id||previous.configurationSnapshot.inputFingerprint!==quote.inputFingerprint||previous.configurationSnapshot.clientRequestId!==clientRequestId||stableJson(previous.configurationSnapshot.modelSelection)!==stableJson(quote.modelSelection))throw Error('原报价任务缺少完整的报价或模型选择快照');
    return previous;
  }
  if (quote.expiresAt < Date.now()) { put('commerce-quotes', quote.id, owner, { ...quote, status: 'expired' }); throw Error('报价已过期，请重新报价'); }
  const catalogDirect=usesCuratedMainCatalogDirectExecution(quote.input.kind);
  const sharedConfigurationRequired=process.env.SHARED_CONFIGURATION_ENABLED === '1';
  await primePublishedCommerceConfiguration({ force: Boolean(quote.releaseId), required: sharedConfigurationRequired });
  if(sharedConfigurationRequired)assertPublishedCommercePaidJobsReady();
  if(!quote.modelSelection)throw Error('报价缺少服务端模型选择快照，请重新报价');
  if(!quote.promptPackage)throw Error('报价缺少提示词技能版本快照，请重新报价');
  const route = resolveOperation({...quote.input,modelId:quote.modelSelection.selectionSource==='user-selection'?quote.modelSelection.selectedConfiguredId:undefined});
  const model = await selectedModel(quote.input.kind, quote.modelId);
  if(catalogDirect)assertCuratedMainCatalogExecutionReady(model);
  assertSnapshotCurrent(quote, quote.input, route, model);
  const confirmation = claim(`${owner}:commerce-quote:${quote.id}`, quote.inputFingerprint, clientRequestId);
  if (!confirmation.created && confirmation.id !== clientRequestId) throw Error('该报价已由另一客户端请求确认');
  const value = await createJob(owner, { ...quote.input, requestId: quote.taskRequestId || quote.id },undefined,{quotedModelSelection:{quoteId:quote.id,operationId:quote.operationId,routeRevision:route.revision,modelId:quote.modelId,modelConfigHash:quote.modelConfigHash,snapshot:quote.modelSelection},quotedPromptPackage:quote.promptPackage,quoteBinding:{quoteId:quote.id,inputFingerprint:quote.inputFingerprint,clientRequestId}});
  put('commerce-quotes', quote.id, owner, { ...quote, status: 'consumed', clientRequestId, jobId: value.id });
  return value;
}

export function readCommerceQuote(owner: string, id: string) {
  const value = get<StoredQuote>('commerce-quotes', id, owner);
  return value ? publicQuote(value) : null;
}
