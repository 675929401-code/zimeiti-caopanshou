import { removeVisualAssetBindings, visualAssetUrlMatchesSource, type VisualAssetUrl } from './storyboard-visual-asset-binding';
import { mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, requestedVisualAssetIds, type SelectionCard, type SelectionPlan } from './storyboard-visual-asset-selection';
import { markVisualAssetMediaStale } from './storyboard-visual-asset-media-state';
import type { StoryboardVisualAssetWorkspace } from './storyboard-visual-asset-workspace';

type Card = SelectionCard & { imageUrl?: string; imageRef?: unknown; imageRecordId?: string; videoUrl?: string; videoTaskId?: string };

/** Remove a project reference, never the underlying library asset or paid media. */
export function removeStoryboardReference<C extends Card, R extends {
  id: string; cards: C[]; visualAssetPlan?: SelectionPlan; visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
}>(before: R, slotId: string, removeDraft: boolean): R {
  const oldPlan = before.visualAssetPlan;
  const hasSlot = Boolean(oldPlan?.assets.some(asset => asset.id === slotId));
  let plan = hasSlot ? mutateVisualAssetSlot(oldPlan, { type: 'remove', slotId }) : oldPlan;
  if (hasSlot && oldPlan && plan) plan = { ...plan, mode: oldPlan.mode };
  if (plan?.generationPolicy && hasSlot) plan = { ...plan, generationPolicy: { ...plan.generationPolicy,
    initialRequiredAssetIds: plan.generationPolicy.initialRequiredAssetIds.filter(id => id !== slotId),
    initialDeferredAssetIds: plan.generationPolicy.initialDeferredAssetIds.filter(id => id !== slotId),
  } };
  const cards = before.cards.map(card => {
    const ids = requestedVisualAssetIds(card, oldPlan);
    if (!hasSlot || !plan || !ids.includes(slotId) && !card.visualAssetRefs?.some(ref => ref.assetId === slotId)) return card;
    // Classify owned URLs against the OLD plan before removing semantic IDs.
    // Rebind remaining sources from their exact saved identity, preserving
    // manually supplied URLs, shared images and unrelated reference selections.
    const clean = removeVisualAssetBindings(card, oldPlan);
    const refs = (card.visualAssetRefs || []).filter(ref => ref.assetId !== slotId);
    const urls: VisualAssetUrl[] = [];
    for (const asset of oldPlan!.assets) {
      if (asset.id === slotId || !asset.source) continue;
      const ref = refs.find(item => item.assetId === asset.id);
      if (!ref) continue;
      const bound = ref.boundReferenceUrl || ref.ownedReferenceUrl
        || card.referenceImageUrls.find(url => visualAssetUrlMatchesSource(url, asset.source));
      if (bound && card.referenceImageUrls.includes(bound)) urls.push({ assetId: asset.source.assetId, previewUrl: bound, storageKey: asset.source.storageKey });
    }
    const seed = { ...clean, visualAssetRefs: refs.map(ref => ({ ...ref, ownedReferenceUrl: '', boundReferenceUrl: '' })) };
    // An off plan has no active requested IDs. Preserve the remaining dormant
    // custom choices instead of interpreting that empty active set as deselection.
    const next = plan.mode === 'off' ? seed
      : prepareSelectedCardSourceUpdate({ card: seed, plan, urls, limit: Math.max(card.referenceImageUrls.length, 16) }).card;
    return markVisualAssetMediaStale(card, next, oldPlan, plan);
  });
  const workspace = removeDraft && before.visualAssetWorkspace ? { ...before.visualAssetWorkspace,
    drafts: before.visualAssetWorkspace.drafts.filter(draft => draft.planId !== slotId),
    candidates: before.visualAssetWorkspace.candidates.filter(candidate => candidate.planId !== slotId),
  } : before.visualAssetWorkspace;
  return { ...before, visualAssetPlan: plan, visualAssetWorkspace: workspace, cards };
}
