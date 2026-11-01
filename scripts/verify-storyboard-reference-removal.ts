import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { removeStoryboardReference } from '../src/lib/storyboard-reference-removal';
import { rebindSelectedCard, requestedVisualAssetIds, rollbackSelectionTransaction, type SelectionCard } from '../src/lib/storyboard-visual-asset-selection';
import { removeVisualAssetBindings } from '../src/lib/storyboard-visual-asset-binding';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from '../src/lib/storyboard-workbench';

const makeAsset = (id: string, role: 'character' | 'pet') => ({ id, role, name: id, identityLock: '保持原始描述中的主体身份及外观一致', allowedChanges: [],
  referencePrompts: [{ kind: 'identity' as const, purpose: '主体参考', prompt: '保持原始提示词描述的身份外观和状态，不增加新身份。' }],
  source: { kind: 'uploaded-image' as const, assetId: `owned_${id}`, storageKey: `objects/${id}.png` },
});
const plan: StoryboardVisualAssetPlan = { mode: 'selected', assets: [makeAsset('person_main', 'character'), makeAsset('pet_main', 'pet')], defaultAssetIds: ['person_main', 'pet_main'],
  generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: ['person_main', 'pet_main'], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' },
};
const urls = plan.assets.map(asset => ({ assetId: asset.source!.assetId, previewUrl: `https://fixture.invalid/${asset.source!.storageKey}` }));
const card: SelectionCard & { id: string; imageUrl: string; videoUrl: string; imageRequestSnapshot: { prompt: string } } = rebindSelectedCard({ card: { id: 'card', referenceImageUrls: ['https://fixture.invalid/manual.png'], visualAssetSelectionMode: 'project' as const,
  imageUrl: 'https://fixture.invalid/old-board.png', videoUrl: 'https://fixture.invalid/old-video.mp4', imageRequestSnapshot: { prompt: 'frozen original paid prompt' } }, plan, urls, limit: 8 });
const before = { id: 'project', cards: [card], visualAssetPlan: plan, visualAssetWorkspace: { drafts: plan.assets.map(asset => ({ planId: asset.id, role: asset.role, name: asset.name, prompt: '原提示词', tagsText: '', customCategory: '' })), candidates: [] } };
let passed = 0;
for (const mode of ['project', 'custom'] as const) {
  const input = { ...before, cards: [{ ...card, visualAssetSelectionMode: mode }] };
  const next = removeStoryboardReference(input, 'person_main', true);
  assert.deepEqual(next.visualAssetPlan!.assets.map(asset => asset.id), ['pet_main']);
  assert.deepEqual(next.visualAssetWorkspace!.drafts.map(draft => draft.planId), ['pet_main']);
  assert.deepEqual(next.cards[0].visualAssetRefs!.map(ref => ref.assetId), ['pet_main']);
  assert.deepEqual(next.cards[0].referenceImageUrls, ['https://fixture.invalid/manual.png', urls[1].previewUrl]);
  assert.equal(next.cards[0].imageReferenceState, 'stale');
  assert.equal(next.cards[0].imageUrl, card.imageUrl); assert.equal(next.cards[0].videoUrl, card.videoUrl);
  assert.equal(next.cards[0].imageRequestSnapshot, card.imageRequestSnapshot);
  assert.deepEqual(next.visualAssetPlan!.generationPolicy!.initialRequiredAssetIds, ['pet_main']);
  StoryboardVisualAssetPlanSchema.parse(next.visualAssetPlan); passed++;
}
const shared = rebindSelectedCard({ card: { ...card, referenceImageUrls: [], visualAssetRefs: [] }, plan, urls: urls.map(url => ({ ...url, previewUrl: 'https://fixture.invalid/shared.png' })), limit: 8 });
const sharedNext = removeStoryboardReference({ ...before, cards: [shared] }, 'person_main', true);
assert.deepEqual(sharedNext.cards[0].referenceImageUrls, ['https://fixture.invalid/shared.png']);
assert.doesNotThrow(() => removeVisualAssetBindings(sharedNext.cards[0], sharedNext.visualAssetPlan)); passed++;
const invalid = { ...before, cards: [{ ...card, visualAssetRefs: [{ ...card.visualAssetRefs![0], ownedReferenceUrl: 'https://fixture.invalid/unknown.png' }] }] };
assert.throws(() => removeStoryboardReference(invalid, 'person_main', true), /OWNERSHIP_UNKNOWN/u); passed++;
const unbound = removeStoryboardReference(before, 'unbound_extra', true);
assert.equal(unbound.visualAssetPlan, plan); assert.equal(unbound.cards[0], card); passed++;
const disabled = removeStoryboardReference({ ...before, cards: [], visualAssetPlan: { ...plan, mode: 'off' as const } }, 'person_main', true);
assert.equal(disabled.visualAssetPlan!.mode, 'off'); passed++;

const source = readFileSync('src/components/storyboard-workbench.tsx', 'utf8');
const tree = ts.createSourceFile('workbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
function walk(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'applyVisualAssets' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(tree); ts.forEachChild(node, walk); }
walk(tree); assert.ok(callback);
async function main() {
  for (const outcome of ['success', 'save-failure', 'unknown-request', 'pending-asset', 'pending-upload'] as const) {
    const runRef = { current: structuredClone(before) };
    const original = runRef.current; let saves = 0;
    const apply = vm.runInNewContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      referenceOnly: false, contextReadyRef: { current: true }, navigationRef: { current: false }, visualAssetMutationRef: { current: false }, imageSubmissionsRef: { current: new Set() },
      visualAssetGenerationRef: { current: false }, pendingAssetAttempts: outcome === 'pending-asset' ? [{ planId: 'person_main' }] : [],
      videoSubmissionsRef: { current: new Set() }, boardExportLocksRef: { current: new Set() }, VIDEO_HISTORY_SETTLED_BILLING_STATES: ['settled', 'not_required'],
      referenceUploadPending: outcome === 'pending-upload' ? [{ contextId: 'project', draft: { planId: 'person_main' } }] : [],
      imageDownloadOwnerRef: { current: 'owner' }, scopeMountedRef: { current: true }, runRef, requestedVisualAssetIds,
      imageAttemptNeedsResolution: () => outcome === 'unknown-request', videoNeedsRequestReconciliation: () => false, isActiveVideoStatus: () => false,
      window: { confirm: () => true }, Date, removeStoryboardReference, rollbackSelectionTransaction,
      setVisualAssetSaving: () => {}, setVisualAssetError: () => {}, setRun: () => {}, setVisualAssetCandidates: () => {}, setNotice: () => {},
      createStoryboardPersistenceSnapshot: (value: unknown) => value,
      saveVisualAssetContext: async () => { saves++; return outcome !== 'save-failure'; }, visualAssetSelectionError: (_error: unknown, fallback: string) => fallback,
    });
    const result = await apply({ type: 'remove', slotId: 'person_main' }, false, true);
    assert.equal(result, outcome === 'success');
    assert.equal(saves, outcome === 'success' || outcome === 'save-failure' ? 1 : 0);
    assert.deepEqual(runRef.current.visualAssetWorkspace!.drafts.map(draft => draft.planId), outcome === 'success' ? ['pet_main'] : original.visualAssetWorkspace!.drafts.map(draft => draft.planId));
    assert.deepEqual(runRef.current.visualAssetPlan!.assets.map(asset => asset.id), outcome === 'success' ? ['pet_main'] : ['person_main', 'pet_main']);
    assert.equal(runRef.current.cards[0].videoUrl, original.cards[0].videoUrl); passed++;
  }
  console.log(JSON.stringify({ passed, failed: 0, actualNetworkRequests: 0, databaseWrites: 0, scope: 'reference removal pure contract and actual transaction callback; no media deletion' }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
