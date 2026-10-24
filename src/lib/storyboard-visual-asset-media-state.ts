import { requestedVisualAssetIds, type SelectionCard, type SelectionPlan } from './storyboard-visual-asset-selection';

type MediaCard = SelectionCard & {
  imageUrl?: string; imageRef?: unknown; imageRecordId?: string;
  videoUrl?: string; videoTaskId?: string;
  imageReferenceState?: 'stale';
};
function sourceIdentity(plan: SelectionPlan | undefined, id: string) {
  const source = plan?.assets.find(asset => asset.id === id)?.source;
  if (!source) return '';
  if (source.kind === 'platform-preset') return JSON.stringify(['preset', source.presetId, source.presetRevision]);
  // Saving an owned copy of the same original is not a visual identity change.
  if (/^[a-f0-9]{64}$/u.test(source.historyRecordId || '')) return `history:${source.historyRecordId}`;
  return JSON.stringify([source.kind, source.assetId, source.storageKey]);
}
export function visualAssetReferenceContentChanged(before: SelectionCard, after: SelectionCard,
  previousPlan: SelectionPlan | undefined, plan: SelectionPlan) {
  const previous = requestedVisualAssetIds(before, previousPlan), next = requestedVisualAssetIds(after, plan);
  return previous.length !== next.length || previous.some(id => !next.includes(id))
    || next.some(id => sourceIdentity(previousPlan, id) !== sourceIdentity(plan, id));
}
export function markVisualAssetMediaStale<T extends MediaCard>(before: T, after: T,
  previousPlan: SelectionPlan | undefined, plan: SelectionPlan): T {
  return Boolean(before.imageUrl || before.imageRef || before.imageRecordId || before.videoUrl || before.videoTaskId)
    && visualAssetReferenceContentChanged(before, after, previousPlan, plan)
    ? { ...after, imageReferenceState: 'stale' } : after;
}
