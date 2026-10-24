import assert from 'node:assert/strict';
import { mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, rebindSelectedCard, requestedVisualAssetIds, visualAssetBindingSummary, type SelectionCard, type SelectionPlan } from '../src/lib/storyboard-visual-asset-selection';
import { refreshStoryboardVisualAssetReferences } from '../src/lib/storyboard-visual-asset-submission';
import { StoryboardVisualAssetRefSchema } from '../src/lib/storyboard-workbench';

const checks: string[] = [];
const test = (name: string, run: () => void) => { run(); checks.push(name); };
const planned: SelectionPlan = { mode: 'selected', assets: ['character', 'pet'].map(role => ({
  id: `${role}_main`, role: role as 'character' | 'pet', name: `${role}参考`, identityLock: '保持同一身份和所有固定外观特征',
  allowedChanges: ['姿态'], referencePrompts: [{ kind: 'identity', purpose: '固定身份参考', prompt: '保持参考图中同一身份和所有固定外观特征，允许姿态变化。' }],
})), defaultAssetIds: ['character_main', 'pet_main'] };
const cards: (SelectionCard & { imageStatus: string; imageRequestSnapshot: { prompt: string } })[] = Array.from({ length: 3 }, (_, index) => ({
  id: `card_${index}`, referenceImageUrls: [], visualAssetSelectionMode: 'custom', visualAssetRefsMode: 'explicit',
  visualAssetRefs: planned.assets.map(asset => ({ assetId: asset.id, role: asset.role, referenceKinds: ['identity'] })),
  imageStatus: 'idle', imageRequestSnapshot: { prompt: '不可改动的历史请求' },
}));
const source = (id: string) => ({ kind: 'uploaded-image' as const, assetId: `owned_${id}`, storageKey: `fixtures/${id}.png` });
const characterPlan = mutateVisualAssetSlot(planned, { type: 'upsert', asset: { ...planned.assets[0], source: source('character') } });
const characterUrls = [{ assetId: 'owned_character', previewUrl: 'https://fixture.invalid/fixtures/character.png' }];
const first = cards.map(card => prepareSelectedCardSourceUpdate({ card, previousPlan: planned, plan: characterPlan, urls: characterUrls, limit: 2 }));

test('three cards with two planned slots accept the first source and preserve the missing pet semantic ref', () => {
  first.forEach((result, index) => {
    assert.deepEqual(result.missingIds, ['pet_main']);
    assert.deepEqual(requestedVisualAssetIds(result.card, characterPlan), planned.defaultAssetIds);
    assert.deepEqual(result.card.referenceImageUrls, [characterUrls[0].previewUrl]);
    assert.deepEqual(result.card.visualAssetRefs![1], { ...cards[index].visualAssetRefs![1], ownedReferenceUrl: '', boundReferenceUrl: '' });
    assert.equal(visualAssetBindingSummary(result.card, characterPlan, characterUrls).complete, false);
    assert.equal(result.card.imageStatus, 'idle');
    assert.equal(result.card.imageRequestSnapshot, cards[index].imageRequestSnapshot);
    result.card.visualAssetRefs!.forEach(ref => StoryboardVisualAssetRefSchema.parse(ref));
  });
  assert.deepEqual(cards[0].referenceImageUrls, []);
  assert.equal(cards[0].visualAssetRefs![0].ownedReferenceUrl, undefined);
});
const completePlan = mutateVisualAssetSlot(characterPlan, { type: 'upsert', asset: { ...planned.assets[1], source: source('pet') } });
const urls = [...characterUrls, { assetId: 'owned_pet', previewUrl: 'https://fixture.invalid/fixtures/pet.png' }];
const completed = first.map(({ card }) => prepareSelectedCardSourceUpdate({ card, previousPlan: characterPlan, plan: completePlan, urls, limit: 2 }));
test('applying the pet source next completes both references in each card without swapping slots', () => {
  completed.forEach(result => {
    assert.deepEqual(result.missingIds, []);
    assert.equal(visualAssetBindingSummary(result.card, completePlan, urls).complete, true);
    assert.equal(result.card.visualAssetRefs![0].boundReferenceUrl, characterUrls[0].previewUrl);
    assert.equal(result.card.visualAssetRefs![1].boundReferenceUrl, urls[1].previewUrl);
    assert.equal(result.card.imageStatus, 'idle');
    assert.deepEqual(rebindSelectedCard({ card: result.card, previousPlan: completePlan, plan: completePlan, urls, limit: 2 }).referenceImageUrls, urls.map(item => item.previewUrl));
  });
});
test('an expired existing source is missing and its formerly owned URL is removed', () => {
  const result = prepareSelectedCardSourceUpdate({ card: completed[0].card, previousPlan: completePlan, plan: completePlan, urls: characterUrls, limit: 2 });
  assert.deepEqual(result.missingIds, ['pet_main']);
  assert.deepEqual(result.card.referenceImageUrls, [characterUrls[0].previewUrl]);
  assert.equal(result.card.visualAssetRefs![1].boundReferenceUrl, '');
  assert.equal(result.card.visualAssetRefs![1].ownedReferenceUrl, '');
  assert.equal(visualAssetBindingSummary(result.card, completePlan, characterUrls).complete, false);
});
test('source replacement drops the old URL and unrelated resolver entries cannot supply a missing slot', () => {
  const next = mutateVisualAssetSlot(completePlan, { type: 'upsert', asset: { ...planned.assets[1], source: source('new_pet') } });
  const missing = prepareSelectedCardSourceUpdate({ card: completed[0].card, previousPlan: completePlan, plan: next, urls, limit: 2 });
  assert.deepEqual(missing.missingIds, ['pet_main']);
  assert.deepEqual(missing.card.referenceImageUrls, [characterUrls[0].previewUrl]);
});
test('role/kind mismatch, reference overflow and strict incomplete rebinding remain rejected', () => {
  const original = first[0].card;
  for (const mismatch of [{ ...original.visualAssetRefs![0], role: 'pet' as const }, { ...original.visualAssetRefs![0], referenceKinds: ['environment-wide' as const] }]) {
    assert.throws(() => prepareSelectedCardSourceUpdate({ card: { ...original, visualAssetRefs: [mismatch, original.visualAssetRefs![1]] }, previousPlan: characterPlan, plan: characterPlan, urls: characterUrls, limit: 2 }), /ROLE_MISMATCH/);
  }
  assert.throws(() => prepareSelectedCardSourceUpdate({ card: { ...first[0].card, referenceImageUrls: ['manual'] }, previousPlan: characterPlan, plan: completePlan, urls, limit: 2 }), /REFERENCE_LIMIT/);
  assert.throws(() => rebindSelectedCard({ card: original, previousPlan: characterPlan, plan: characterPlan, urls: characterUrls, limit: 2 }), /SOURCE_UNRESOLVED:pet_main/);
});

async function main() {
  await assert.rejects(refreshStoryboardVisualAssetReferences({ card: first[0].card, plan: characterPlan, limit: 2, resolve: async () => characterUrls }), /尚未落实或已失效/u);
  checks.push('actual submission refresh still rejects the incomplete source before generation');
  console.log(JSON.stringify({ passed: true, checks, checkCount: checks.length, providerCalls: 0, persistenceWrites: 0, runtimeVerified: false }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
