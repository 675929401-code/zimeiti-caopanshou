import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from './storyboard-workbench';
import { StoryboardVisualAssetCandidateSchema, type StoryboardVisualAssetCandidate, type StoryboardVisualAssetWorkspace } from './storyboard-visual-asset-workspace';
import { hasInitialReferenceDownstream } from './storyboard-initial-reference-adoption';
import { affectedVisualAssetCards, mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, requestedVisualAssetIds } from './storyboard-visual-asset-selection';
import type { VisualAssetUrl } from './storyboard-visual-asset-binding';

export type FirstReferenceCard = Parameters<typeof hasInitialReferenceDownstream>[0] & { id: string };
export type FirstReferenceAdoptionDocument<T extends FirstReferenceCard> = {
  id: string; cards: T[]; visualAssetPlan?: StoryboardVisualAssetPlan;
  visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
};
type Asset = StoryboardVisualAssetPlan['assets'][number];
export type FirstReferenceCandidateOnly = {
  status: 'candidate-only'; reason: 'busy' | 'slot-already-adopted' | 'downstream-history' | 'inactive-plan'; affectedCount: number;
};
type PreparationInput<T extends FirstReferenceCard, D extends FirstReferenceAdoptionDocument<T>> = {
  document: D; candidate: StoryboardVisualAssetCandidate; asset: Asset; busy: boolean;
};
type Ready<T extends FirstReferenceCard> = { status: 'ready'; plan: StoryboardVisualAssetPlan; affected: T[]; resolveIds: string[] };

/** First-source adoption only. Existing relationships and media require a separate explicit edit. */
export function prepareFirstStoryboardReferenceAdoption<T extends FirstReferenceCard, D extends FirstReferenceAdoptionDocument<T>>(
  input: PreparationInput<T, D>,
): Ready<T> | FirstReferenceCandidateOnly {
  const before = input.document.visualAssetPlan;
  if (before?.assets.find(asset => asset.id === input.asset.id)?.source) return { status: 'candidate-only', reason: 'slot-already-adopted', affectedCount: 0 };
  if (before?.mode === 'off' && before.assets.length) return { status: 'candidate-only', reason: 'inactive-plan', affectedCount: 0 };
  if (input.busy) return { status: 'candidate-only', reason: 'busy', affectedCount: 0 };
  const candidate = input.candidate;
  StoryboardVisualAssetCandidateSchema.parse(candidate);
  if (candidate.projectId !== input.document.id || candidate.planId !== input.asset.id || candidate.role !== input.asset.role) throw new Error('FIRST_REFERENCE_CANDIDATE_SCOPE_MISMATCH');
  const matches = (input.document.visualAssetWorkspace?.candidates || []).filter(item => item.assetId === candidate.assetId
    && item.projectId === input.document.id && item.planId === candidate.planId && item.role === candidate.role);
  if (matches.length !== 1) throw new Error('FIRST_REFERENCE_CANDIDATE_NOT_UNIQUE');
  const registered = matches[0];
  if (registered.storageKey !== candidate.storageKey || registered.historyRecordId !== candidate.historyRecordId
    || registered.source === 'platform-preset' || candidate.source === 'platform-preset'
    || (!candidate.storageKey && !/^[a-f0-9]{64}$/u.test(candidate.historyRecordId || ''))) throw new Error('FIRST_REFERENCE_CANDIDATE_PROOF_INVALID');
  const source = input.asset.source;
  if (!source || source.kind === 'platform-preset' || source.assetId !== candidate.assetId
    || source.storageKey !== candidate.storageKey || source.historyRecordId !== candidate.historyRecordId) throw new Error('FIRST_REFERENCE_SOURCE_MISMATCH');
  const plan = mutateVisualAssetSlot(before, { type: 'upsert', asset: input.asset });
  StoryboardVisualAssetPlanSchema.parse(plan);
  const affected = affectedVisualAssetCards(input.document.cards, before, plan);
  if (affected.some(hasInitialReferenceDownstream)) return { status: 'candidate-only', reason: 'downstream-history', affectedCount: affected.length };
  const resolveIds = [...new Set([input.asset.id, ...affected.flatMap(card => requestedVisualAssetIds(card, plan))])]
    .filter(id => Boolean(plan.assets.find(asset => asset.id === id)?.source));
  return { status: 'ready', plan, affected, resolveIds };
}

/** Parent save owns server revision/CAS. In-memory assertions guard scope across every await. */
export async function adoptFirstStoryboardReference<T extends FirstReferenceCard, D extends FirstReferenceAdoptionDocument<T>>(
  input: PreparationInput<T, D> & {
    limit: number; assertCurrent: () => void; resolve: (plan: StoryboardVisualAssetPlan) => Promise<VisualAssetUrl[]>;
    save: (next: D) => Promise<boolean>; commit: (next: D) => void;
  },
): Promise<FirstReferenceCandidateOnly | { status: 'adopted'; document: D; affectedCount: number }> {
  input.assertCurrent();
  const prepared = prepareFirstStoryboardReferenceAdoption<T, D>(input);
  if (prepared.status === 'candidate-only') return prepared;
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) throw new Error('VISUAL_ASSET_INVALID_REFERENCE_LIMIT');
  const { plan } = prepared;
  const ids = new Set(prepared.resolveIds);
  const subset = { ...plan, assets: plan.assets.filter(asset => ids.has(asset.id)), defaultAssetIds: undefined };
  input.assertCurrent();
  const urls = await input.resolve(subset);
  input.assertCurrent();
  if (subset.assets.some(asset => !urls.some(url => url.assetId === asset.source!.assetId && url.previewUrl.trim()))) throw new Error('FIRST_REFERENCE_SOURCE_UNRESOLVED');
  const affectedIds = new Set(prepared.affected.map(card => card.id));
  const cards = input.document.cards.map(card => {
    if (!affectedIds.has(card.id)) return card;
    const updated = prepareSelectedCardSourceUpdate({ card, previousPlan: input.document.visualAssetPlan, plan, urls, limit: input.limit });
    if (updated.missingIds.some(id => id === input.asset.id || Boolean(plan.assets.find(asset => asset.id === id)?.source)
      || !plan.generationPolicy?.initialRequiredAssetIds.includes(id))) throw new Error('FIRST_REFERENCE_REQUIRED_SOURCE_UNRESOLVED');
    return updated.card;
  });
  const next = { ...input.document, visualAssetPlan: plan, cards };
  input.assertCurrent();
  const saved = await input.save(next);
  input.assertCurrent();
  if (!saved) throw new Error('FIRST_REFERENCE_SAVE_UNCONFIRMED');
  input.commit(next);
  return { status: 'adopted', document: next, affectedCount: prepared.affected.length };
}
