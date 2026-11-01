import assert from 'node:assert/strict';
import { adoptFirstStoryboardReference, prepareFirstStoryboardReferenceAdoption, type FirstReferenceAdoptionDocument, type FirstReferenceCard } from '../src/lib/storyboard-first-reference-adoption';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from '../src/lib/storyboard-workbench';
import type { StoryboardVisualAssetCandidate } from '../src/lib/storyboard-visual-asset-workspace';

type Card = FirstReferenceCard & { prompt: string };
type Document = FirstReferenceAdoptionDocument<Card>;
type Asset = StoryboardVisualAssetPlan['assets'][number];
const policy = { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' as const };
const card = (id = 'card'): Card => ({ id, prompt: '原始分镜提示词', referenceImageUrls: [], visualAssetSelectionMode: 'project', imageStatus: 'idle', videoStatus: 'idle' });
const candidate = (id = 'first_person', role: Asset['role'] = 'character'): StoryboardVisualAssetCandidate => ({ assetId: 'owned_' + id, planId: id, projectId: 'project', role, name: '主体参考',
  prompt: '完整保留提示词描述的主体身份与外形，展示同一主体。', storageKey: 'objects/' + id + '.png', saved: false });
const asset = (item: StoryboardVisualAssetCandidate): Asset => ({ id: item.planId, role: item.role, name: item.name, identityLock: '保持原提示词描述中的主体身份与外观一致。', allowedChanges: [],
  referencePrompts: [{ kind: item.role === 'prop' ? 'prop' : item.role === 'environment' ? 'environment-wide' : 'identity', purpose: '主体参考保持', prompt: item.prompt! }],
  source: { kind: 'generated-image-history', assetId: item.assetId, storageKey: item.storageKey, historyRecordId: item.historyRecordId, librarySaved: item.saved } });
function document(items = [candidate()], cards = [card()], plan: StoryboardVisualAssetPlan = { mode: 'off', assets: [] }): Document {
  return { id: 'project', cards, visualAssetPlan: plan, visualAssetWorkspace: { drafts: items.map(item => ({ planId: item.planId, role: item.role, name: item.name, prompt: item.prompt!, tagsText: '保留旧标签', customCategory: '' })), candidates: items } };
}
function harness(before: Document, item = before.visualAssetWorkspace!.candidates[0], options: { ownerFailure?: boolean; missingSource?: boolean; saveFailure?: boolean; changeAt?: 'before-resolve' | 'after-resolve' | 'after-save' } = {}) {
  const counts = { resolve: 0, save: 0, commit: 0, assertions: 0 };
  let current = before; let changed = false; let resolvedIds: string[] = [];
  const input = { document: before, candidate: item, asset: asset(item), busy: false, limit: 8,
    assertCurrent: () => { counts.assertions++; if (options.changeAt === 'before-resolve' && counts.assertions === 2) changed = true; if (changed) throw new Error('PROJECT_CHANGED'); },
    resolve: async (plan: StoryboardVisualAssetPlan) => {
      counts.resolve++; resolvedIds = plan.assets.map(value => value.id);
      if (options.ownerFailure) throw new Error('OWNER_READ_FAILED');
      if (options.changeAt === 'after-resolve') changed = true;
      return options.missingSource ? [] : plan.assets.filter(value => value.source).map(value => ({ assetId: value.source!.assetId, previewUrl: 'https://fixture.invalid/' + value.source!.storageKey }));
    },
    save: async (next: Document) => { counts.save++; StoryboardVisualAssetPlanSchema.parse(next.visualAssetPlan); if (options.changeAt === 'after-save') changed = true; return !options.saveFailure; },
    commit: (next: Document) => { counts.commit++; current = next; },
  };
  return { input, counts, current: () => current, resolvedIds: () => resolvedIds };
}
let passed = 0;
const cases: string[] = [];
function done(name: string) { passed++; cases.push(name); }
async function main() {
  for (const role of ['character', 'pet', 'prop', 'environment'] as const) {
    const item = candidate('first_' + role, role); const before = document([item]); const snapshot = structuredClone(before); const h = harness(before);
    const result = await adoptFirstStoryboardReference(h.input);
    assert.equal(result.status, 'adopted'); assert.deepEqual([h.counts.resolve, h.counts.save, h.counts.commit], [1, 1, 1]);
    assert.deepEqual(before, snapshot); assert.equal(h.current().visualAssetPlan!.assets[0].source!.assetId, item.assetId);
    assert.deepEqual(h.current().visualAssetWorkspace, before.visualAssetWorkspace);
    assert.equal(h.current().cards[0].prompt, before.cards[0].prompt);
    assert.equal(h.current().cards[0].referenceImageUrls.length, role === 'character' || role === 'pet' ? 1 : 0);
    assert.deepEqual(h.current().visualAssetPlan!.defaultAssetIds, role === 'character' || role === 'pet' ? [item.planId] : []);
    done(role + ' registers exact source; only identities join defaults');
  }
  {
    const item = candidate(); const h = harness(document([item], [])); const result = await adoptFirstStoryboardReference(h.input);
    assert.equal(result.status, 'adopted'); assert.deepEqual(h.resolvedIds(), [item.planId]); assert.equal(h.counts.resolve, 1); done('zero-card project still performs owner resolution');
  }
  for (const variant of ['ownerFailure', 'missingSource', 'saveFailure'] as const) {
    const h = harness(document(), undefined, { [variant]: true });
    await assert.rejects(() => adoptFirstStoryboardReference(h.input), variant === 'ownerFailure' ? /OWNER_READ_FAILED/u : variant === 'missingSource' ? /SOURCE_UNRESOLVED/u : /SAVE_UNCONFIRMED/u);
    assert.equal(h.counts.commit, 0); assert.equal(h.counts.save, variant === 'saveFailure' ? 1 : 0); done(variant + ' preserves candidate and commits nothing');
  }
  for (const changeAt of ['before-resolve', 'after-resolve', 'after-save'] as const) {
    const h = harness(document(), undefined, { changeAt }); await assert.rejects(() => adoptFirstStoryboardReference(h.input), /PROJECT_CHANGED/u);
    assert.equal(h.counts.commit, 0); assert.equal(h.counts.save, changeAt === 'after-save' ? 1 : 0); done(changeAt + ' scope race blocks commit');
  }
  {
    const h = harness(document()); const result = await adoptFirstStoryboardReference({ ...h.input, busy: true });
    assert.equal(result.status, 'candidate-only'); if (result.status === 'candidate-only') assert.equal(result.reason, 'busy');
    assert.deepEqual([h.counts.resolve, h.counts.save, h.counts.commit], [0, 0, 0]); done('busy returns successful candidate-only without binding IO');
  }
  const old = asset(candidate('existing_person'));
  const existing: StoryboardVisualAssetPlan = { mode: 'selected', assets: [old], defaultAssetIds: [old.id], generationPolicy: policy };
  {
    const replacement = { ...candidate(old.id), assetId: 'replacement_identity', storageKey: 'objects/replacement.png' };
    const h = harness(document([replacement], [card()], existing)); const result = await adoptFirstStoryboardReference(h.input);
    assert.equal(result.status, 'candidate-only'); if (result.status === 'candidate-only') assert.equal(result.reason, 'slot-already-adopted');
    assert.deepEqual([h.counts.resolve, h.counts.save, h.counts.commit], [0, 0, 0]); assert.equal(h.current().visualAssetPlan!.assets[0].source, old.source); done('existing source is never auto-replaced');
  }
  {
    const h = harness(document([candidate()], [card()], { ...existing, mode: 'off' })); const result = await adoptFirstStoryboardReference(h.input);
    assert.equal(result.status, 'candidate-only'); if (result.status === 'candidate-only') assert.equal(result.reason, 'inactive-plan');
    assert.equal(h.counts.resolve, 0); done('off plan with retained assets is not re-enabled');
  }
  for (const patch of [
    { imageUrl: 'https://fixture.invalid/old.png' }, { videoUrl: 'https://fixture.invalid/old.mp4' }, { imageStatus: 'unknown' }, { videoStatus: 'unknown' },
    { imageBillingState: 'pending' }, { imageBillingState: 'unknown' }, { videoBillingState: 'unknown' }, { imageStatus: 'running' },
    { videoStatus: 'running' }, { videoStatus: 'failed', videoRetryable: false }, { imagePriceCharged: 0 }, { imageRequestSnapshot: { prompt: 'frozen' } },
  ]) {
    const before = document([candidate()], [{ ...card(), ...patch }]); const snapshot = structuredClone(before); const h = harness(before);
    const result = await adoptFirstStoryboardReference(h.input); assert.equal(result.status, 'candidate-only');
    if (result.status === 'candidate-only') assert.equal(result.reason, 'downstream-history');
    assert.deepEqual([h.counts.resolve, h.counts.save, h.counts.commit], [0, 0, 0]); assert.deepEqual(before, snapshot); done('downstream ' + Object.keys(patch).join('/') + ' remains candidate-only');
  }
  {
    const empty: Card = { ...card('custom_empty'), visualAssetSelectionMode: 'custom', visualAssetRefs: [], imageUrl: 'https://fixture.invalid/old.png' };
    const custom: Card = { ...card('custom_selected'), visualAssetSelectionMode: 'custom', visualAssetRefs: [{ assetId: old.id, role: old.role, referenceKinds: ['identity'], ownedReferenceUrl: '' }] };
    const before = document([candidate()], [card(), empty, custom], existing); const h = harness(before); const result = await adoptFirstStoryboardReference(h.input);
    assert.equal(result.status, 'adopted'); assert.equal(h.current().cards[1], empty); assert.equal(h.current().cards[2], custom);
    assert.equal(h.current().cards[0].referenceImageUrls.length, 2); done('custom empty and selected identities remain unchanged outside the affected set');
  }
  {
    const person = candidate('required_person'); const pet = candidate('required_pet', 'pet');
    const plan: StoryboardVisualAssetPlan = { mode: 'selected', assets: [person, pet].map(item => ({ ...asset(item), source: undefined })), generationPolicy: {
      maxInitialImages: 2, initialRequiredAssetIds: [person.planId, pet.planId], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none',
    } };
    const first = harness(document([person, pet], [card()], plan), person); assert.equal((await adoptFirstStoryboardReference(first.input)).status, 'adopted');
    assert.deepEqual(first.resolvedIds(), [person.planId]); assert.equal(first.current().cards[0].visualAssetRefs!.length, 2); assert.equal(first.current().cards[0].referenceImageUrls.length, 1);
    const second = harness(first.current(), pet); assert.equal((await adoptFirstStoryboardReference(second.input)).status, 'adopted');
    assert.equal(second.current().cards[0].referenceImageUrls.length, 2); assert.deepEqual(second.current().visualAssetPlan!.generationPolicy, plan.generationPolicy);
    done('required person and pet adopt incrementally without fabricating the missing source');
  }
  for (const variant of ['project', 'plan', 'role', 'duplicate', 'preset', 'proof', 'source'] as const) {
    const before = document(); const h = harness(before);
    if (variant === 'project') h.input.candidate = { ...h.input.candidate, projectId: 'other' };
    if (variant === 'plan') h.input.candidate = { ...h.input.candidate, planId: 'other_slot' };
    if (variant === 'role') h.input.candidate = { ...h.input.candidate, role: 'pet' };
    if (variant === 'duplicate') before.visualAssetWorkspace!.candidates.push({ ...h.input.candidate });
    if (variant === 'preset') h.input.candidate = { ...h.input.candidate, source: 'platform-preset', presetId: 'preset-test', presetRevision: 1 };
    if (variant === 'proof') { h.input.candidate = { ...h.input.candidate, storageKey: undefined }; before.visualAssetWorkspace!.candidates[0] = h.input.candidate; }
    if (variant === 'source') h.input.asset = { ...h.input.asset, source: { ...h.input.asset.source!, assetId: 'wrong_asset' } };
    await assert.rejects(() => adoptFirstStoryboardReference(h.input)); assert.deepEqual([h.counts.resolve, h.counts.save, h.counts.commit], [0, 0, 0]); done(variant + ' mismatch rejects without IO');
  }
  {
    const h = harness(document()); await assert.rejects(() => adoptFirstStoryboardReference({ ...h.input, limit: 0 }), /VISUAL_ASSET_REFERENCE_LIMIT/u);
    assert.equal(h.counts.save, 0); assert.equal(h.counts.commit, 0); done('real binding capacity limit blocks before save');
  }
  {
    const h = harness(document([candidate()], [card()], existing));
    h.input.resolve = async plan => { h.counts.resolve++; return plan.assets.filter(item => item.id === h.input.asset.id).map(item => ({ assetId: item.source!.assetId, previewUrl: 'https://fixture.invalid/new-source.png' })); };
    await assert.rejects(() => adoptFirstStoryboardReference(h.input), /FIRST_REFERENCE_SOURCE_UNRESOLVED/u);
    assert.deepEqual([h.counts.save, h.counts.commit], [0, 0]); done('unresolved existing source cannot be erased during incremental adoption');
  }
  {
    const item = { ...candidate(), storageKey: undefined, historyRecordId: 'a'.repeat(64) };
    const h = harness(document([item])); const result = await adoptFirstStoryboardReference(h.input);
    assert.equal(result.status, 'adopted'); assert.equal(h.current().visualAssetPlan!.assets[0].source!.historyRecordId, item.historyRecordId);
    done('owned stable history proof can be adopted without an object key');
  }
  assert.equal(prepareFirstStoryboardReferenceAdoption(harness(document()).input).status, 'ready');
  console.log(JSON.stringify({ passed, failed: 0, networkRequests: 0, databaseWrites: 0, generatedImages: 0, generatedVideos: 0, cases }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
