/** Pure project-default and segment-specific visual asset selection. */
import type { StoryboardVisualAssetPlan, StoryboardVisualAssetRef } from './storyboard-workbench';
import { bindVisualAssetPlan, defaultVisualAssetIdsForCard, removeVisualAssetBindings, visualAssetUrlMatchesSource, type VisualAssetUrl } from './storyboard-visual-asset-binding';

export type SelectionPlan = StoryboardVisualAssetPlan;
export type SelectionCard = {
  id?: string;
  referenceImageUrls: string[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  visualAssetRefsMode?: 'legacy' | 'explicit';
  visualAssetSelectionMode?: 'project' | 'custom';
  sceneId?: string;
  sceneZone?: string;
  imageReferenceState?: 'stale';
};
type Asset = SelectionPlan['assets'][number];
const unique = (ids: readonly string[]) => [...new Set(ids)];

export function validateSelectionPlan(plan?: SelectionPlan): void {
  if (!plan) return;
  if (plan.assets.length > 16) throw new Error('VISUAL_ASSET_PLAN_LIMIT');
  const ids = plan.assets.map(asset => asset.id);
  if (unique(ids).length !== ids.length) throw new Error('VISUAL_ASSET_DUPLICATE_ID');
  if (plan.defaultAssetIds === undefined) return;
  if (plan.defaultAssetIds.length > 16 || unique(plan.defaultAssetIds).length !== plan.defaultAssetIds.length) throw new Error('VISUAL_ASSET_INVALID_DEFAULT_IDS');
  if (plan.defaultAssetIds.some(id => !ids.includes(id))) throw new Error('VISUAL_ASSET_DEFAULT_NOT_IN_PLAN');
  if (plan.assets.filter(asset => asset.role === 'environment' && plan.defaultAssetIds!.includes(asset.id)).length > 1) throw new Error('VISUAL_ASSET_MULTIPLE_DEFAULT_ENVIRONMENTS');
}

/** undefined new fields mean old semantics, never an implicit migration. */
export function requestedVisualAssetIds(card: SelectionCard, plan?: SelectionPlan): string[] {
  validateSelectionPlan(plan);
  if (plan?.mode !== 'selected') return [];
  if (card.visualAssetSelectionMode !== 'project' && card.visualAssetRefs?.some(ref => !plan.assets.some(asset => asset.id === ref.assetId))) {
    throw new Error('VISUAL_ASSET_REFERENCE_NOT_IN_PLAN');
  }
  const ids = unique(defaultVisualAssetIdsForCard(card, plan));
  if (ids.some(id => !plan.assets.some(asset => asset.id === id))) throw new Error('VISUAL_ASSET_REFERENCE_NOT_IN_PLAN');
  return ids;
}

/** Resolve this subset only. An unrelated expired asset must not block this card. */
export function requestedVisualAssetPlan(card: SelectionCard, plan?: SelectionPlan): SelectionPlan | undefined {
  const ids = requestedVisualAssetIds(card, plan);
  return plan && { ...plan, assets: plan.assets.filter(asset => ids.includes(asset.id)), defaultAssetIds: undefined };
}

/** Atomic preparation: errors do not mutate card/plan. The caller owns save/commit. */
export function rebindSelectedCard<T extends SelectionCard>(input: {
  card: T; previousPlan?: SelectionPlan; plan?: SelectionPlan; urls: VisualAssetUrl[]; limit: number;
}): T {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) throw new Error('VISUAL_ASSET_INVALID_REFERENCE_LIMIT');
  const ids = requestedVisualAssetIds(input.card, input.plan);
  const clean = removeVisualAssetBindings(input.card, input.previousPlan);
  clean.referenceImageUrls = unique(clean.referenceImageUrls);
  if (clean.referenceImageUrls.length > input.limit) throw new Error('VISUAL_ASSET_REFERENCE_LIMIT');
  const result = bindVisualAssetPlan(clean, input.plan, input.urls, input.limit, ids);
  if (result.missing.length) throw new Error(`VISUAL_ASSET_SOURCE_UNRESOLVED:${result.missing.join(',')}`);
  if (result.overLimit.length) throw new Error(`VISUAL_ASSET_REFERENCE_LIMIT:${result.overLimit.join(',')}`);
  return { ...result.card, visualAssetRefsMode: input.card.visualAssetSelectionMode
    ? 'explicit' : input.card.visualAssetRefsMode || 'legacy' };
}

/** Save a source incrementally without admitting an incomplete card to generation. */
export function prepareSelectedCardSourceUpdate<T extends SelectionCard>(input: {
  card: T; previousPlan?: SelectionPlan; plan?: SelectionPlan; urls: VisualAssetUrl[]; limit: number;
}): { card: T; missingIds: string[] } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) throw new Error('VISUAL_ASSET_INVALID_REFERENCE_LIMIT');
  const ids = requestedVisualAssetIds(input.card, input.plan);
  const semanticRefs = ids.map(id => {
    const asset = input.plan!.assets.find(item => item.id === id)!;
    const previous = input.card.visualAssetRefs?.find(ref => ref.assetId === id);
    const kinds: StoryboardVisualAssetRef['referenceKinds'] = asset.role === 'environment'
      ? ['environment-wide', 'environment-angle', 'detail'] : asset.role === 'prop' ? ['prop', 'detail'] : ['identity', 'turnaround', 'detail'];
    if (previous && (previous.role !== asset.role || !previous.referenceKinds.length
      || previous.referenceKinds.some(kind => !kinds.includes(kind)))) throw new Error('VISUAL_ASSET_ROLE_MISMATCH');
    return previous || { assetId: id, role: asset.role,
      referenceKinds: [asset.role === 'environment' ? asset.cameraCoverage && asset.cameraCoverage !== 'wide' ? 'environment-angle' : 'environment-wide'
        : asset.role === 'prop' ? 'prop' : 'identity'],
      ...(asset.sceneId ? { sceneId: asset.sceneId } : {}),
      ...(asset.sceneZone ? { sceneZone: asset.sceneZone } : {}),
      ...(asset.cameraCoverage ? { cameraCoverage: asset.cameraCoverage } : {}) } satisfies StoryboardVisualAssetRef;
  });
  // Remove the previous owned URLs even if their current source no longer resolves.
  const clean = removeVisualAssetBindings(input.card, input.previousPlan);
  clean.referenceImageUrls = unique(clean.referenceImageUrls);
  if (clean.referenceImageUrls.length > input.limit) throw new Error('VISUAL_ASSET_REFERENCE_LIMIT');
  const result = bindVisualAssetPlan(clean, input.plan, input.urls, input.limit, ids);
  if (result.overLimit.length) throw new Error(`VISUAL_ASSET_REFERENCE_LIMIT:${result.overLimit.join(',')}`);
  const visualAssetRefs = semanticRefs.map(ref => {
    const bound = result.card.visualAssetRefs?.find(item => item.assetId === ref.assetId);
    return { ...ref, ownedReferenceUrl: bound?.ownedReferenceUrl ?? '', boundReferenceUrl: bound?.boundReferenceUrl ?? '' };
  });
  return { card: { ...result.card, visualAssetRefs, visualAssetRefsMode: input.card.visualAssetSelectionMode
    ? 'explicit' : input.card.visualAssetRefsMode || 'legacy' }, missingIds: result.missing };
}

/** Custom selection is an explicit operation, including []. Preserve old refs for URL ownership removal. */
export function chooseCustomAssets<T extends SelectionCard>(input: {
  card: T; plan: SelectionPlan; assetIds: string[]; urls: VisualAssetUrl[]; limit: number;
}): T {
  validateSelectionPlan(input.plan);
  const ids = unique(input.assetIds);
  if (ids.some(id => !input.plan.assets.some(asset => asset.id === id))) throw new Error('VISUAL_ASSET_REFERENCE_NOT_IN_PLAN');
  const clean = removeVisualAssetBindings(input.card, input.plan);
  const refs: StoryboardVisualAssetRef[] = ids.map(id => {
    const asset = input.plan.assets.find(item => item.id === id)!;
    return { assetId: id, role: asset.role, referenceKinds: [asset.role === 'environment' ? 'environment-wide' : asset.role === 'prop' ? 'prop' : 'identity'], ownedReferenceUrl: '' };
  });
  return rebindSelectedCard({ ...input, previousPlan: input.plan, card: { ...clean, visualAssetRefs: refs, visualAssetRefsMode: 'explicit', visualAssetSelectionMode: 'custom' } });
}

/** Defaults changes touch project-following cards only. Custom and legacy card identities are retained. */
export function changeProjectDefaults<T extends SelectionCard>(input: {
  cards: T[]; plan: SelectionPlan; defaultAssetIds: string[]; urls: VisualAssetUrl[]; limit: number;
}): { plan: SelectionPlan; cards: T[] } {
  const plan = { ...input.plan, defaultAssetIds: [...input.defaultAssetIds] };
  validateSelectionPlan(plan);
  const cards = input.cards.map(card => card.visualAssetSelectionMode === 'project'
    ? rebindSelectedCard({ card, previousPlan: input.plan, plan, urls: input.urls, limit: input.limit }) : card);
  return { plan, cards };
}

/** Replace media in a semantic slot. Candidate scene labels cannot change segment assignment. */
export function replaceVisualAssetSource(plan: SelectionPlan, slotId: string, candidate: Pick<Asset, 'role' | 'source'>): SelectionPlan {
  validateSelectionPlan(plan);
  const old = plan.assets.find(asset => asset.id === slotId);
  if (!old) throw new Error('VISUAL_ASSET_REFERENCE_NOT_IN_PLAN');
  if (old.role !== candidate.role) throw new Error('VISUAL_ASSET_ROLE_MISMATCH');
  if (!candidate.source) throw new Error('VISUAL_ASSET_SOURCE_UNRESOLVED');
  const source = { ...candidate.source };
  return { ...plan, assets: plan.assets.map(asset => asset.id === slotId ? { ...asset, source } : asset) };
}

export type VisualAssetSlotMutation = { type: 'upsert'; asset: Asset } | { type: 'remove'; slotId: string };

/** The complete stored plan is authoritative. A sparse candidate display is never a replacement plan. */
export function mutateVisualAssetSlot(previousPlan: SelectionPlan | undefined, mutation: VisualAssetSlotMutation): SelectionPlan {
  validateSelectionPlan(previousPlan);
  const before: SelectionPlan = previousPlan || { mode: 'selected', assets: [] };
  const oldSlot = before.assets.find(asset => asset.id === (mutation.type === 'remove' ? mutation.slotId : mutation.asset.id));
  let plan: SelectionPlan;
  if (mutation.type === 'remove') {
    if (!oldSlot) throw new Error('VISUAL_ASSET_REFERENCE_NOT_IN_PLAN');
    plan = { ...before, mode: 'selected', assets: before.assets.filter(asset => asset.id !== mutation.slotId) };
  } else if (oldSlot) {
    plan = { ...replaceVisualAssetSource(before, oldSlot.id, mutation.asset), mode: 'selected' };
  } else {
    if (!mutation.asset.source) throw new Error('VISUAL_ASSET_SOURCE_UNRESOLVED');
    plan = { ...before, mode: 'selected', assets: [...before.assets, mutation.asset] };
  }
  // Manual adoption uses an existing source. Do not invent a paid first-round queue.
  // Imported plans keep their explicit generation budget and required/deferred IDs.
  if (mutation.type === 'upsert' && !plan.generationPolicy) {
    plan.generationPolicy = { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' };
  }
  const defaults = before.defaultAssetIds === undefined
    ? before.assets.filter(asset => asset.role === 'character' || asset.role === 'pet').map(asset => asset.id)
    : [...before.defaultAssetIds];
  plan.defaultAssetIds = defaults.filter(id => plan.assets.some(asset => asset.id === id));
  if (mutation.type === 'upsert' && !oldSlot) {
    const added = mutation.asset;
    if (added.role === 'character' || added.role === 'pet') {
      plan.defaultAssetIds.push(added.id);
    }
  }
  validateSelectionPlan(plan);
  return plan;
}

function assetBindingIdentity(asset: Asset | undefined) {
  const source = asset?.source;
  // Exclude display-only price/name/timestamps; include all resolver and scene-reference identity.
  return JSON.stringify([asset?.role, asset?.sceneId, asset?.sceneZone, asset?.cameraCoverage,
    source?.kind, source?.assetId, source?.storageKey, source?.historyRecordId, source?.presetId, source?.presetRevision]);
}

/** Determine the whole affected set before resolving or changing anything. Dangling custom refs throw. */
export function affectedVisualAssetCards<T extends SelectionCard>(cards: readonly T[], previousPlan: SelectionPlan | undefined, plan: SelectionPlan): T[] {
  validateSelectionPlan(previousPlan);
  validateSelectionPlan(plan);
  return cards.filter(card => {
    const beforeIds = requestedVisualAssetIds(card, previousPlan);
    const afterIds = requestedVisualAssetIds(card, plan);
    if (beforeIds.length !== afterIds.length || beforeIds.some(id => !afterIds.includes(id))) return true;
    return afterIds.some(id => assetBindingIdentity(previousPlan?.assets.find(asset => asset.id === id))
      !== assetBindingIdentity(plan.assets.find(asset => asset.id === id)));
  });
}

/** Counting requires resolved current sources and a real URL in the card; semantic refs alone are not coverage. */
export function visualAssetBindingSummary(card: SelectionCard, plan: SelectionPlan | undefined, urls: VisualAssetUrl[]) {
  const requestedIds = requestedVisualAssetIds(card, plan);
  const boundIds = requestedIds.filter(id => {
    const asset = plan!.assets.find(item => item.id === id)!;
    const resolved = urls.find(item => item.assetId === asset.source?.assetId && item.previewUrl.trim());
    const ref = card.visualAssetRefs?.find(item => item.assetId === id && item.role === asset.role);
    if (!resolved || !ref) return false;
    const boundUrl = ref.boundReferenceUrl || ref.ownedReferenceUrl;
    return card.referenceImageUrls.some(url => (boundUrl ? boundUrl === url : visualAssetUrlMatchesSource(url, asset.source))
      && (url === resolved.previewUrl || visualAssetUrlMatchesSource(url, asset.source)));
  });
  const missingIds = requestedIds.filter(id => !boundIds.includes(id));
  return { requestedIds, boundIds, missingIds, complete: missingIds.length === 0,
    intentionallyEmpty: plan?.mode === 'selected' && requestedIds.length === 0
      && (card.visualAssetSelectionMode === 'custom' || card.visualAssetSelectionMode === 'project' && plan.defaultAssetIds !== undefined || card.visualAssetSelectionMode === undefined && card.visualAssetRefsMode === 'explicit') };
}

const transactionFields = ['referenceImageUrls', 'visualAssetRefs', 'visualAssetRefsMode', 'visualAssetSelectionMode', 'sceneId', 'sceneZone', 'imageReferenceState'] as const;
/** In-memory compare-and-restore, not a substitute for server revision CAS. Preserve later edits and frozen snapshots. */
export function rollbackSelectionTransaction<T extends { id: string; visualAssetPlan?: SelectionPlan; cards: SelectionCard[] }>(latest: T, before: T, attempted: T): T {
  if (latest.id !== before.id || latest.id !== attempted.id || latest.visualAssetPlan !== attempted.visualAssetPlan) return latest;
  // A later binding edit can depend on the attempted plan. Do not roll that plan out from under it.
  if (latest.cards.some(card => {
    const changed = attempted.cards.find(item => item.id === card.id);
    return !card.id || !changed || transactionFields.some(field => card[field] !== changed[field]);
  })) return latest;
  return { ...latest, visualAssetPlan: before.visualAssetPlan, cards: latest.cards.map(card => {
    const original = before.cards.find(item => item.id === card.id);
    const changed = attempted.cards.find(item => item.id === card.id);
    if (!original || !changed || transactionFields.some(field => card[field] !== changed[field])) return card;
    const patch = Object.fromEntries(transactionFields.map(field => [field, original[field]]));
    return { ...card, ...patch };
  }) };
}
