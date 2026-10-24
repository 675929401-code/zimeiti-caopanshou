import type { StoryboardVisualAssetPlan } from '@/lib/storyboard-workbench';
import type { StoryboardVisualAssetCandidate } from '@/lib/storyboard-visual-asset-workspace';
import { affectedVisualAssetCards, mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, requestedVisualAssetIds, type SelectionCard } from '@/lib/storyboard-visual-asset-selection';
import type { VisualAssetUrl } from '@/lib/storyboard-visual-asset-binding';

type VisibleCandidate = { assetId: string; planId: string; projectId?: string };
/** Match the drawer's visible choice, including its local generated-result precedence. */
export function visibleStoryboardReference<T extends VisibleCandidate>(planId: string, projectId: string, generated: readonly T[], candidates: readonly T[], selected: readonly T[]): T | undefined {
  const matches = (asset: T) => asset.planId === planId && (asset.projectId || '') === (projectId || '');
  return generated.find(matches) || candidates.find(matches) || selected.find(asset => asset.planId === planId);
}

// These fields are written by image submission/recovery or video pending/submission/polling,
// not by createCard. Even zero/false/null denotes a receipt or incomplete request fact.
const downstreamFactFields = [
  'imageUrl', 'imageRef', 'imageRecordId', 'imageDeliveryMode', 'imageAssetId', 'imageStorageKey',
  'imageWidth', 'imageHeight', 'videoSourceImageUrl', 'imageSubmittedAt', 'imageValidatedAt',
  'imageModelIdUsed', 'imageModelNameUsed', 'imageClientRequestId', 'imageClientTraceId',
  'imageClientRequestFingerprint', 'imageRequestSnapshot', 'imagePriceCharged',
  'videoUrl', 'videoTaskId', 'videoClientRequestId', 'videoClientRequestFingerprint',
  'videoTaskModelId', 'videoTaskModelName', 'videoTaskDuration', 'videoSupportsRemoteCancel',
  'videoContentUrl', 'videoProgress', 'videoStartedAt', 'videoLastCheckedAt', 'videoStatusDetail',
  'videoPollFailures', 'videoMonitoringPaused', 'videoLifecycle', 'videoLifecycleError',
  'videoRetryable', 'videoPriceCharged',
] as const;
type InitialCard = SelectionCard & Partial<Record<typeof downstreamFactFields[number], unknown>> & {
  imageStatus?: string; imageRecoveryReady?: boolean; imageRetryBlocked?: boolean;
  imageAttemptOrdinal?: number; videoStatus?: string;
  imageBillingState?: string; videoBillingState?: string;
};
export type InitialAdoptionDocument<T extends InitialCard> = {
  id: string; cards: T[]; visualAssetPlan?: StoryboardVisualAssetPlan;
  visualAssetWorkspace?: { candidates: StoryboardVisualAssetCandidate[] };
};
export function hasInitialReferenceDownstream(card: InitialCard): boolean {
  const knownUnsubmittedStatus = (status: unknown) => status === undefined || status === 'idle' || status === 'failed';
  const noRecovery = (flag: unknown) => flag === undefined || flag === false;
  const noChargeFact = (state: unknown) => state === undefined || state === 'not_charged';
  return downstreamFactFields.some(field => card[field] !== undefined)
    || !knownUnsubmittedStatus(card.imageStatus) || !knownUnsubmittedStatus(card.videoStatus)
    || !noRecovery(card.imageRecoveryReady) || !noRecovery(card.imageRetryBlocked)
    || (card.imageAttemptOrdinal !== undefined && card.imageAttemptOrdinal !== 0)
    || !noChargeFact(card.imageBillingState) || !noChargeFact(card.videoBillingState);
}

/** Pure preparation. Existing sources stay byte-for-byte; no library export or guessed candidate. */
export function prepareInitialReferenceAdoption<T extends InitialCard, D extends InitialAdoptionDocument<T>>(input: {
  document: D; visibleIds: Record<string, string>; busy: boolean;
}): { plan: StoryboardVisualAssetPlan | undefined; selected: StoryboardVisualAssetCandidate[]; affected: T[] } {
  const before = input.document.visualAssetPlan;
  if (before?.mode !== 'selected') return { plan: before, selected: [], affected: [] };
  const required = before.generationPolicy?.initialRequiredAssetIds;
  if (!required) throw new Error('首轮参考策略尚未确认，请保留当前项目后重试；本次未提交生图');
  const missing = required.map(id => { const asset = before.assets.find(asset => asset.id === id); if (!asset) throw new Error('首轮参考计划不一致，本次未提交生图'); return asset; }).filter(asset => !asset.source);
  if (!missing.length) return { plan: before, selected: [], affected: [] };
  if (input.busy) throw new Error('参考请求、上传或保存尚待确认，本次未提交生图');
  let plan = before;
  const selected = missing.map(asset => {
    const visibleId = input.visibleIds[asset.id];
    if (!visibleId) throw new Error(`请先生成并查看${asset.name}参考图；当前可见候选未确认，本次未提交生图`);
    const matches = (input.document.visualAssetWorkspace?.candidates || []).filter(candidate => candidate.assetId === visibleId
      && candidate.projectId === input.document.id && candidate.planId === asset.id && candidate.role === asset.role);
    if (matches.length !== 1) throw new Error(`${asset.name}候选归属或选择尚未确认，本次未提交生图`);
    const candidate = matches[0];
    if (candidate.source === 'platform-preset' || (!candidate.storageKey && !/^[a-f0-9]{64}$/u.test(candidate.historyRecordId || ''))) throw new Error(`${asset.name}缺少可核验的原图凭证，本次未提交生图`);
    plan = mutateVisualAssetSlot(plan, { type: 'upsert', asset: { ...asset, source: {
      kind: 'generated-image-history', assetId: candidate.assetId, historyRecordId: candidate.historyRecordId,
      storageKey: candidate.storageKey, librarySaved: candidate.saved, modelId: candidate.modelId, modelName: candidate.modelName,
      quotedPrice: candidate.quotedPrice, createdAt: candidate.createdAt,
    } } });
    return candidate;
  });
  const affected = affectedVisualAssetCards(input.document.cards, before, plan);
  if (affected.some(hasInitialReferenceDownstream)) throw new Error('当前参考尚未采用：受影响分段已有媒体、任务或待确认账务，需要明确处理旧结果后继续；全部原结果保留，本次未提交生图');
  return { plan, selected, affected };
}

/** One owner-read/one CAS transaction. Commit only after a confirmed save, before callers may charge. */
export async function adoptInitialStoryboardReferences<T extends InitialCard, D extends InitialAdoptionDocument<T>>(input: {
  document: D; visibleIds: Record<string, string>; busy: boolean; limit: number;
  assertCurrent: () => void; resolve: (plan: StoryboardVisualAssetPlan) => Promise<VisualAssetUrl[]>;
  save: (next: D) => Promise<boolean>; commit: (next: D) => void;
}): Promise<D> {
  input.assertCurrent();
  const prepared = prepareInitialReferenceAdoption<T, D>(input);
  if (!prepared.selected.length) return input.document;
  const plan = prepared.plan!;
  // Owner API validates every selected candidate, even if no segment uses this required slot.
  const needed = new Set([...prepared.selected.map(asset => asset.planId), ...prepared.affected.flatMap(card => requestedVisualAssetIds(card, plan))]);
  const urls = await input.resolve({ ...plan, assets: plan.assets.filter(asset => needed.has(asset.id)), defaultAssetIds: undefined });
  input.assertCurrent();
  if (plan.assets.filter(asset => needed.has(asset.id)).some(asset => !urls.some(url => url.assetId === asset.source?.assetId && url.previewUrl.trim()))) throw new Error('参考原图归属或可读性未确认，本次未保存或提交生图');
  const affectedIds = new Set(prepared.affected.map(card => card.id));
  const cards = input.document.cards.map(card => {
    if (!affectedIds.has(card.id)) return card;
    const result = prepareSelectedCardSourceUpdate({ card, previousPlan: input.document.visualAssetPlan, plan, urls, limit: input.limit });
    if (result.missingIds.length) throw new Error('分段参考尚未全部落实，本次未保存或提交生图');
    return result.card;
  });
  const next = { ...input.document, visualAssetPlan: plan, cards };
  input.assertCurrent();
  if (!await input.save(next)) throw new Error('参考采用保存未确认，原页面与全部结果保留；本次未提交生图，请核对原项目后重试');
  input.assertCurrent();
  input.commit(next);
  return next;
}
