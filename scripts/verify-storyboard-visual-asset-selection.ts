import assert from 'node:assert/strict';


import { affectedVisualAssetCards, mutateVisualAssetSlot, changeProjectDefaults, chooseCustomAssets, rebindSelectedCard, replaceVisualAssetSource, requestedVisualAssetIds, requestedVisualAssetPlan, rollbackSelectionTransaction, validateSelectionPlan, visualAssetBindingSummary, type SelectionCard, type SelectionPlan } from '../src/lib/storyboard-visual-asset-selection';
import { StoryboardVisualAssetPlanSchema } from '../src/lib/storyboard-workbench';
import { StoryboardProjectDocument } from '../src/lib/storyboard-project-contract';
import { createStoryboardPersistenceSnapshot } from '../src/lib/storyboard-local-persistence';
import { refreshStoryboardVisualAssetReferences } from '../src/lib/storyboard-visual-asset-submission';

const checks: string[] = [];
const test = (name: string, run: () => void) => { run(); checks.push(name); };
const asset = (id: string, role: 'character' | 'pet' | 'environment', sceneId?: string): SelectionPlan['assets'][number] => ({
  id, role, name: id, identityLock: '保持固定身份外观与场景布局一致', allowedChanges: ['姿态'],
  referencePrompts: [{ kind: role === 'environment' ? 'environment-wide' : 'identity', purpose: '保持参考一致', prompt: '以参考图片为依据保持外观、材质、空间布局与固定识别特征一致。' }],
  sceneId, source: { kind: 'uploaded-image', assetId: `owned_${id}`, storageKey: `objects/${id}.png` },
});
const plan: SelectionPlan = { mode: 'selected', assets: [asset('character_main', 'character'), asset('pet_main', 'pet'), asset('env_home', 'environment', 'home_main'), asset('env_clinic', 'environment', 'clinic_main')], defaultAssetIds: ['character_main', 'pet_main', 'env_home'],
  generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'per-scene-when-required' } };
const urls = plan.assets.map(item => ({ assetId: item.source!.assetId, previewUrl: `https://fixture.invalid/${item.source!.storageKey}` }));
const makeCard = (id = 'card_1'): SelectionCard & { imagePrompt: string; videoPrompt: string; imageRequestSnapshot: { prompt: string } } => ({
  id, referenceImageUrls: [], visualAssetRefs: [], visualAssetSelectionMode: 'project',
  imagePrompt: '用户手工图提示词', videoPrompt: '用户手工视频提示词', imageRequestSnapshot: { prompt: '过去已提交的原始提示词' },
});
const bind = <T extends SelectionCard>(card: T, target = plan, resolved = urls, limit = 3) => rebindSelectedCard({ card, previousPlan: plan, plan: target, urls: resolved, limit });
const home = bind(makeCard());
const ids = (card: SelectionCard) => card.visualAssetRefs!.map(ref => ref.assetId);

test('single default background yields three actual references; project may contain four assets', () => {
  assert.deepEqual(ids(home), plan.defaultAssetIds); assert.equal(home.referenceImageUrls.length, 3);
  assert.equal(plan.assets.length, 4); assert.equal(visualAssetBindingSummary(home, plan, urls).complete, true);
});
test('new manual card inherits exactly the same defaults', () => assert.deepEqual(ids(bind(makeCard('card_2'))), plan.defaultAssetIds));
const clinic = chooseCustomAssets({ card: home, plan, assetIds: ['character_main', 'pet_main', 'env_clinic'], urls, limit: 3 });
test('multi scene cards each use only their own three images; both manual prompts remain intact', () => {
  assert.deepEqual(ids(clinic), ['character_main', 'pet_main', 'env_clinic']);
  assert.equal(clinic.referenceImageUrls.length, 3); assert.equal(clinic.imagePrompt, home.imagePrompt); assert.equal(clinic.videoPrompt, home.videoPrompt);
});
const empty = chooseCustomAssets({ card: home, plan, assetIds: [], urls, limit: 3 });
test('custom empty selection is valid and not implicitly restored', () => {
  assert.deepEqual(ids(empty), []); assert.deepEqual(empty.referenceImageUrls, []);
  const result = changeProjectDefaults({ cards: [home, clinic, empty], plan, defaultAssetIds: ['character_main', 'pet_main', 'env_clinic'], urls, limit: 3 });
  assert.deepEqual(ids(result.cards[0]), ['character_main', 'pet_main', 'env_clinic']);
  assert.equal(result.cards[1], clinic); assert.equal(result.cards[2], empty);
  assert.equal(visualAssetBindingSummary(empty, plan, urls).intentionallyEmpty, true);
});
test('one character may be excluded while pet and background remain', () => {
  const result = chooseCustomAssets({ card: home, plan, assetIds: ['pet_main', 'env_home'], urls, limit: 3 });
  assert.deepEqual(ids(result), ['pet_main', 'env_home']);
});
test('legacy scene matching and explicit empty import semantics survive', () => {
  const legacy: SelectionCard = { id: 'legacy', referenceImageUrls: [], visualAssetRefsMode: 'legacy', sceneId: 'clinic_main' };
  assert.deepEqual(requestedVisualAssetIds(legacy, plan), ['character_main', 'pet_main', 'env_clinic']);
  const rebound = bind(legacy); assert.equal(rebound.visualAssetRefsMode, 'legacy');
  assert.deepEqual(ids(rebound), ['character_main', 'pet_main', 'env_clinic']);
  assert.deepEqual(requestedVisualAssetIds({ ...legacy, visualAssetRefsMode: 'explicit', visualAssetRefs: [] }, plan), []);
  assert.deepEqual(requestedVisualAssetIds({ ...legacy, sceneId: undefined }, plan), ['character_main', 'pet_main']);
});
test('missing defaults retain identity-only fallback; explicit empty defaults mean none', () => {
  assert.deepEqual(requestedVisualAssetIds(makeCard(), { ...plan, defaultAssetIds: undefined }), ['character_main', 'pet_main']);
  assert.deepEqual(requestedVisualAssetIds(makeCard(), { ...plan, defaultAssetIds: [] }), []);
});
test('default and semantic IDs are validated; second default environment rejected', () => {
  assert.throws(() => validateSelectionPlan({ ...plan, defaultAssetIds: ['unknown'] }), /DEFAULT_NOT_IN_PLAN/);
  assert.throws(() => validateSelectionPlan({ ...plan, defaultAssetIds: ['env_home', 'env_clinic'] }), /MULTIPLE_DEFAULT/);
  assert.throws(() => validateSelectionPlan({ ...plan, defaultAssetIds: ['env_home', 'env_home'] }), /INVALID_DEFAULT/);
  assert.throws(() => validateSelectionPlan({ ...plan, assets: [...plan.assets, plan.assets[0]] }), /DUPLICATE_ID/);
  assert.throws(() => requestedVisualAssetIds({ ...makeCard(), visualAssetSelectionMode: 'custom', visualAssetRefs: undefined }, plan), /CUSTOM_SELECTION_MISSING/);
  assert.throws(() => chooseCustomAssets({ card: home, plan, assetIds: ['unknown'], urls, limit: 3 }), /REFERENCE_NOT_IN_PLAN/);
});
const swappedPlan = replaceVisualAssetSource(plan, 'env_home', { role: 'environment', source: { kind: 'uploaded-image', assetId: 'owned_home_new', storageKey: 'objects/home-new.png' } });
const swappedUrls = [...urls.filter(item => item.assetId !== 'owned_env_home'), { assetId: 'owned_home_new', previewUrl: 'https://fixture.invalid/objects/home-new.png' }];
test('same semantic slot with new source keeps scene/default assignments; refresh replaces old owned URL only', () => {
  assert.equal(swappedPlan.assets[2].id, 'env_home'); assert.equal(swappedPlan.assets[2].sceneId, 'home_main');
  assert.deepEqual(swappedPlan.defaultAssetIds, plan.defaultAssetIds);
  const rebound = bind(home, swappedPlan, swappedUrls); assert.deepEqual(ids(rebound), plan.defaultAssetIds);
  assert.ok(rebound.referenceImageUrls.includes('https://fixture.invalid/objects/home-new.png'));
  assert.ok(!rebound.referenceImageUrls.includes('https://fixture.invalid/objects/env_home.png'));
  assert.equal(rebound.imageRequestSnapshot, home.imageRequestSnapshot);
  assert.deepEqual(ids(bind(clinic, swappedPlan, swappedUrls)), ids(clinic));
  assert.throws(() => replaceVisualAssetSource(plan, 'env_home', { role: 'pet', source: plan.assets[1].source }), /ROLE_MISMATCH/);
});
test('unrelated expired background is not required; requested expired background rejects without mutation', () => {
  const snapshot = JSON.stringify(home);
  assert.equal(bind(home, plan, urls.filter(item => item.assetId !== 'owned_env_clinic')).referenceImageUrls.length, 3);
  assert.throws(() => bind(home, plan, urls.filter(item => item.assetId !== 'owned_env_home')), /SOURCE_UNRESOLVED/);
  assert.equal(JSON.stringify(home), snapshot);
  assert.deepEqual(requestedVisualAssetPlan(home, plan)!.assets.map(item => item.id), plan.defaultAssetIds);
});
test('removed referenced asset rejects; no silent filtering or remapping', () => {
  assert.throws(() => bind(clinic, { ...plan, assets: plan.assets.filter(item => item.id !== 'env_clinic') }), /REFERENCE_NOT_IN_PLAN/);
});
test('count only resolved current sources with actual reference URLs; stale source is not covered', () => {
  assert.deepEqual(visualAssetBindingSummary(home, plan, urls).boundIds, plan.defaultAssetIds);
  assert.deepEqual(visualAssetBindingSummary(home, swappedPlan, swappedUrls).missingIds, ['env_home']);
  assert.deepEqual(visualAssetBindingSummary({ ...home, referenceImageUrls: [] }, plan, urls).boundIds, []);
  assert.deepEqual(visualAssetBindingSummary(home, plan, urls.filter(item => item.assetId !== 'owned_env_home')).missingIds, ['env_home']);
  const actualUse = Object.fromEntries(plan.assets.map(asset => [asset.id, [home, clinic, empty].filter(card => visualAssetBindingSummary(card, plan, urls).boundIds.includes(asset.id)).length]));
  assert.deepEqual(actualUse, { character_main: 2, pet_main: 2, env_home: 1, env_clinic: 1 });
});
test('manual shared reference remains after unbinding; duplicate exact URL counted once', () => {
  const manual = urls[0].previewUrl;
  const shared = bind({ ...makeCard(), referenceImageUrls: [manual, manual] });
  assert.equal(shared.referenceImageUrls.length, 3);
  assert.equal(shared.visualAssetRefs!.find(ref => ref.assetId === 'character_main')!.ownedReferenceUrl, '');
  const off = chooseCustomAssets({ card: shared, plan, assetIds: [], urls, limit: 3 });
  assert.deepEqual(off.referenceImageUrls, [manual]);
});
test('per-card capacity counts manual inputs and fails atomically; invalid limits rejected', () => {
  const original = { ...makeCard(), referenceImageUrls: ['https://fixture.invalid/manual.png'] };
  const snapshot = JSON.stringify(original);
  assert.throws(() => bind(original), /REFERENCE_LIMIT/); assert.equal(JSON.stringify(original), snapshot);
  assert.throws(() => bind(makeCard(), plan, urls, NaN), /INVALID_REFERENCE_LIMIT/);
  assert.throws(() => bind(makeCard(), plan, urls, -1), /INVALID_REFERENCE_LIMIT/);
  assert.throws(() => bind({ ...empty, referenceImageUrls: ['a', 'b', 'c', 'd'] }), /REFERENCE_LIMIT/);
});
test('unknown historical URL ownership refuses destructive rebind', () => {
  const opaque = { ...home, referenceImageUrls: ['https://fixture.invalid/opaque'], visualAssetRefs: [{ assetId: 'character_main', role: 'character' as const, referenceKinds: ['identity' as const] }] };
  assert.throws(() => bind(opaque), /OWNERSHIP_UNKNOWN/);
});
test('rollback restores all binding fields and preserves later prompt edits and frozen snapshots', () => {
  const before = { id: 'project_1', visualAssetPlan: plan, cards: [home] };
  const changed = { ...bind(home, swappedPlan, swappedUrls), visualAssetSelectionMode: 'custom' as const, sceneId: 'home_main', sceneZone: 'living_room' };
  const attempted = { ...before, visualAssetPlan: swappedPlan, cards: [changed] };
  const latest = { ...attempted, cards: [{ ...changed, imagePrompt: '稍后编辑图提示词', videoPrompt: '稍后编辑视频提示词' }] };
  const rolled = rollbackSelectionTransaction(latest, before, attempted);
  assert.equal(rolled.visualAssetPlan, plan); assert.equal(rolled.cards[0].referenceImageUrls, home.referenceImageUrls);
  assert.equal(rolled.cards[0].visualAssetSelectionMode, 'project'); assert.equal(rolled.cards[0].sceneId, undefined);
  assert.equal(rolled.cards[0].sceneZone, undefined); assert.equal(rolled.cards[0].imagePrompt, '稍后编辑图提示词');
  assert.equal(rolled.cards[0].videoPrompt, '稍后编辑视频提示词'); assert.equal(rolled.cards[0].imageRequestSnapshot, home.imageRequestSnapshot);
  const otherProject = { ...latest, id: 'project_2' }; assert.equal(rollbackSelectionTransaction(otherProject, before, attempted), otherProject);
  const laterPlan = { ...latest, visualAssetPlan: { ...swappedPlan } }; assert.equal(rollbackSelectionTransaction(laterPlan, before, attempted), laterPlan);
  const laterBinding = { ...latest, cards: [{ ...latest.cards[0], visualAssetRefs: [] }] }; assert.equal(rollbackSelectionTransaction(laterBinding, before, attempted), laterBinding);
});

test('plan schema preserves defaults and validates references, duplicates and one default background', () => {
  assert.deepEqual(StoryboardVisualAssetPlanSchema.parse(plan).defaultAssetIds, plan.defaultAssetIds);
  assert.deepEqual(StoryboardVisualAssetPlanSchema.parse({ ...plan, defaultAssetIds: [] }).defaultAssetIds, []);
  assert.equal(StoryboardVisualAssetPlanSchema.parse({ ...plan, defaultAssetIds: undefined }).defaultAssetIds, undefined);
  for (const defaults of [['unknown'], ['env_home', 'env_home'], ['env_home', 'env_clinic']]) {
    assert.equal(StoryboardVisualAssetPlanSchema.safeParse({ ...plan, defaultAssetIds: defaults }).success, false);
  }
});
const document = {
  id: 'project_fixture', title: '场景绑定验证', createdAt: 1, updatedAt: 2, ratio: '16:9', imageResolution: '2K', videoResolution: '720p',
  videoDuration: 10, imageModelId: 'fixture_image', videoModelId: 'fixture_video', visualAssetPlan: plan,
  cards: [{ ...home, order: 1, imageStatus: 'idle', videoStatus: 'idle' }, { ...empty, id: 'empty_card', order: 2, imageStatus: 'idle', videoStatus: 'idle' }],
};
test('real persistence and project schema round-trip project/custom modes and explicit empty refs', () => {
  const saved = createStoryboardPersistenceSnapshot(document);
  const parsed = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(parsed.visualAssetPlan!.defaultAssetIds, plan.defaultAssetIds);
  assert.equal(parsed.cards[0].visualAssetSelectionMode, 'project'); assert.equal(parsed.cards[1].visualAssetSelectionMode, 'custom');
  assert.deepEqual(parsed.cards[1].visualAssetRefs, []);
  assert.equal(parsed.cards[0].imagePrompt, home.imagePrompt); assert.equal(parsed.cards[0].videoPrompt, home.videoPrompt);
});
test('old documents without new fields remain readable; invalid new defaults cannot silently disappear', () => {
  const old = { ...document, visualAssetPlan: { ...plan, defaultAssetIds: undefined }, cards: document.cards.map(card => ({ ...card, visualAssetSelectionMode: undefined })) };
  const parsed = StoryboardProjectDocument.parse(createStoryboardPersistenceSnapshot(old));
  assert.equal(parsed.visualAssetPlan!.defaultAssetIds, undefined); assert.equal(parsed.cards[0].visualAssetSelectionMode, undefined);
  assert.throws(() => createStoryboardPersistenceSnapshot({ ...document, visualAssetPlan: { ...plan, defaultAssetIds: ['missing'] } }));
  assert.throws(() => createStoryboardPersistenceSnapshot({ ...document, cards: [{ ...home, visualAssetSelectionMode: 'invalid' }] }));
  assert.equal(StoryboardProjectDocument.safeParse({ ...document, cards: [{ ...document.cards[1], visualAssetRefs: undefined }] }).success, false);
  assert.equal(StoryboardProjectDocument.safeParse({ ...document, cards: [{ ...document.cards[1], visualAssetRefs: [{ assetId: 'missing', role: 'pet', referenceKinds: ['identity'] }] }] }).success, false);
});

test('explicit slot mutation preserves all stored slots even when the candidate display contains only the replacement', () => {
  const replacement = { ...asset('env_home', 'environment', 'untrusted_candidate_scene'), source: swappedPlan.assets[2].source };
  const next = mutateVisualAssetSlot(plan, { type: 'upsert', asset: replacement });
  assert.equal(next.assets.length, 4); assert.equal(next.assets[3], plan.assets[3]);
  assert.equal(next.assets[2].sceneId, 'home_main'); assert.equal(next.assets[2].source!.assetId, 'owned_home_new');
  assert.deepEqual(next.defaultAssetIds, plan.defaultAssetIds);
  assert.deepEqual(affectedVisualAssetCards([home, clinic, empty], plan, next), [home]);
  assert.throws(() => mutateVisualAssetSlot(plan, { type: 'upsert', asset: asset('env_home', 'pet') }), /ROLE_MISMATCH/);
});
test('sequential character and pet become defaults; all new backgrounds stay segment-specific', () => {
  let next: SelectionPlan | undefined;
  for (const item of plan.assets) next = mutateVisualAssetSlot(next, { type: 'upsert', asset: item });
  assert.deepEqual(next!.defaultAssetIds, ['character_main', 'pet_main']);
  assert.equal(next!.assets.length, 4);
  const removed = mutateVisualAssetSlot(next, { type: 'remove', slotId: 'env_clinic' });
  assert.deepEqual(removed.defaultAssetIds, next!.defaultAssetIds);
  assert.throws(() => affectedVisualAssetCards([clinic], next, removed), /REFERENCE_NOT_IN_PLAN/);
  assert.throws(() => mutateVisualAssetSlot(next, { type: 'remove', slotId: 'unknown' }), /REFERENCE_NOT_IN_PLAN/);
});
test('unrelated unresolved background does not enter affected set or resolution subset when another slot changes', () => {
  const unresolvedPlan = { ...plan, assets: plan.assets.map(item => item.id === 'env_clinic' ? { ...item, source: undefined } : item) };
  const next = mutateVisualAssetSlot(unresolvedPlan, { type: 'upsert', asset: swappedPlan.assets[2] });
  const affected = affectedVisualAssetCards([home, clinic, empty], unresolvedPlan, next);
  assert.deepEqual(affected, [home]);
  const rebuilt = [home, clinic, empty].map(card => affected.includes(card)
    ? rebindSelectedCard({ card, previousPlan: unresolvedPlan, plan: next, urls: swappedUrls.filter(item => item.assetId !== 'owned_env_clinic'), limit: 3 }) : card);
  assert.equal(rebuilt[1], clinic); assert.equal(rebuilt[2], empty);
  assert.deepEqual(requestedVisualAssetPlan(home, next)!.assets.map(item => item.id), plan.defaultAssetIds);
  assert.deepEqual(ids(rebuilt[0]), plan.defaultAssetIds);
  const changedDefaults = { ...plan, defaultAssetIds: ['character_main', 'pet_main', 'env_clinic'] };
  assert.deepEqual(affectedVisualAssetCards([home, clinic, empty], plan, changedDefaults), [home]);
});

async function main() {
  const seen: string[][] = [];
  const refreshed = await refreshStoryboardVisualAssetReferences({ card: home, plan, limit: 3, resolve: async requested => {
    seen.push(requested.assets.map(asset => asset.id));
    assert.equal(requested.defaultAssetIds, undefined);
    return urls.filter(item => item.assetId !== 'owned_env_clinic');
  } });
  assert.deepEqual(seen, [plan.defaultAssetIds]); assert.deepEqual(ids(refreshed), plan.defaultAssetIds);
  checks.push('actual submission refresh resolves only the requested scene subset');
  const changedDefault = { ...plan, defaultAssetIds: ['character_main', 'pet_main', 'env_clinic'] };
  const switched = await refreshStoryboardVisualAssetReferences({ card: home, plan: changedDefault, limit: 3, resolve: async requested => {
    assert.deepEqual(requested.assets.map(asset => asset.id), changedDefault.defaultAssetIds); return urls;
  } });
  assert.deepEqual(ids(switched), changedDefault.defaultAssetIds); assert.ok(!switched.referenceImageUrls.includes(urls[2].previewUrl));
  assert.equal(switched.imageRequestSnapshot, home.imageRequestSnapshot);
  checks.push('actual submission refresh follows new defaults and preserves frozen historical request');
  const noReferences = await refreshStoryboardVisualAssetReferences({ card: empty, plan: changedDefault, limit: 3, resolve: async () => { throw new Error('must not resolve explicit empty'); } });
  assert.deepEqual(ids(noReferences), []);
  await assert.rejects(refreshStoryboardVisualAssetReferences({ card: clinic, plan: { ...plan, assets: plan.assets.filter(asset => asset.id !== 'env_clinic') }, limit: 3, resolve: async () => { throw new Error('must reject before resolution'); } }), /不一致/u);
  await assert.rejects(refreshStoryboardVisualAssetReferences({ card: home, plan, limit: 3, resolve: async () => urls.filter(item => item.assetId !== 'owned_env_home') }), /尚未落实或已失效/u);
  checks.push('actual submission explicit empty skips resolution; removed custom asset and missing source fail before generation');
  console.log(JSON.stringify({ candidateOnly: false, integratedLibrary: true, runtimeVerified: false, providerCalls: 0, persistenceWrites: 0, passed: true, checks, checkCount: checks.length, generatedAt: new Date().toISOString() }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
