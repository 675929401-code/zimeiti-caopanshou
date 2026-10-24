import assert from 'node:assert/strict';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from '../src/lib/storyboard-workbench';
import { mutateVisualAssetSlot } from '../src/lib/storyboard-visual-asset-selection';

type Asset = StoryboardVisualAssetPlan['assets'][number];
const manualPolicy = { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' as const };
const asset = (id: string, role: Asset['role']): Asset => ({
  id, role, name: role === 'character' ? '人物参考' : role === 'pet' ? '宠物参考' : '道具参考',
  identityLock: '保持原始提示词描述的身份外形以及已有颜色与配饰。', allowedChanges: [],
  referencePrompts: [{ kind: role === 'prop' ? 'prop' : 'identity', purpose: '保持分镜中的主体一致', prompt: '依照用户原始参考描述保持主体身份、外形、颜色与原有配饰，不增加其他主体。' }],
  source: { kind: 'uploaded-image', assetId: 'owned_' + id, storageKey: 'uploads/' + id + '.png' },
});
const roundTrip = (plan: StoryboardVisualAssetPlan) => StoryboardVisualAssetPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
const off = StoryboardVisualAssetPlanSchema.parse({ mode: 'off', assets: [] });
const offSnapshot = structuredClone(off);

// The strict schema still refuses the state that previously broke first manual adoption.
assert.equal(StoryboardVisualAssetPlanSchema.safeParse({ mode: 'selected', assets: [asset('manual_person', 'character')] }).success, false);
for (const [id, role] of [['manual_person', 'character'], ['manual_pet', 'pet'], ['manual_prop', 'prop']] as const) {
  const selected = mutateVisualAssetSlot(off, { type: 'upsert', asset: asset(id, role) });
  const restored = roundTrip(selected);
  assert.equal(restored.mode, 'selected');
  assert.deepEqual(restored.assets, [asset(id, role)]);
  assert.deepEqual(restored.generationPolicy, manualPolicy);
  assert.deepEqual(restored.defaultAssetIds, role === 'prop' ? [] : [id]);
}
assert.deepEqual(off, offSnapshot, 'adoption must not mutate the original off plan');
assert.deepEqual(roundTrip(mutateVisualAssetSlot(undefined, { type: 'upsert', asset: asset('manual_new', 'pet') })).generationPolicy, manualPolicy);

let manual = off;
for (const [id, role] of [['manual_person', 'character'], ['manual_pet', 'pet'], ['manual_prop', 'prop']] as const) {
  manual = roundTrip(mutateVisualAssetSlot(manual, { type: 'upsert', asset: asset(id, role) }));
}
assert.deepEqual(manual.defaultAssetIds, ['manual_person', 'manual_pet']);
assert.deepEqual(manual.generationPolicy, manualPolicy);
const replacement = { ...manual.assets[0], source: { kind: 'uploaded-image' as const, assetId: 'replacement_person', storageKey: 'uploads/replacement_person.png' } };
assert.deepEqual(roundTrip(mutateVisualAssetSlot(manual, { type: 'upsert', asset: replacement })).assets[0].source, replacement.source);

// Existing imported instructions remain authoritative when adopting or adding a source.
const required = { ...asset('import_person', 'character'), source: undefined };
const deferred = { ...asset('import_prop', 'prop'), source: undefined };
const imported = roundTrip({ mode: 'selected', assets: [required, deferred], generationPolicy: {
  maxInitialImages: 2, initialRequiredAssetIds: ['import_person'], initialDeferredAssetIds: ['import_prop'], environmentAnchorPolicy: 'per-scene-when-required',
} });
const importedSnapshot = structuredClone(imported);
const adopted = mutateVisualAssetSlot(imported, { type: 'upsert', asset: asset('import_person', 'character') });
assert.equal(adopted.generationPolicy, imported.generationPolicy, 'preserve the existing policy object');
assert.deepEqual(roundTrip(adopted).generationPolicy, importedSnapshot.generationPolicy);
const extended = mutateVisualAssetSlot(adopted, { type: 'upsert', asset: asset('extra_pet', 'pet') });
assert.deepEqual(roundTrip(extended).generationPolicy, importedSnapshot.generationPolicy);
assert.deepEqual(imported, importedSnapshot, 'preserve the existing imported plan');
console.log('PASS: first manual person/pet/prop adoption and source replacement survive strict plan-schema JSON roundtrip; existing policy preserved. Zero network/database/media calls.');
