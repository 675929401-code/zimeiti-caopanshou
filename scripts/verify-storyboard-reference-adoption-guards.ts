import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { affectedVisualAssetCards, changeProjectDefaults, chooseCustomAssets, rebindSelectedCard, requestedVisualAssetPlan, mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, requestedVisualAssetIds, rollbackSelectionTransaction, type SelectionCard } from '../src/lib/storyboard-visual-asset-selection';
import { markVisualAssetMediaStale, visualAssetReferenceContentChanged } from '../src/lib/storyboard-visual-asset-media-state';
import { adoptInitialStoryboardReferences } from '../src/lib/storyboard-initial-reference-adoption';
import { VIDEO_HISTORY_SETTLED_BILLING_STATES } from '../src/lib/video-history-policy';
import { isUnavailableCompletedStoryboardImage } from '../src/lib/storyboard-image-result-state';
import { confirmStoryboardDirectorAsset } from '../src/lib/storyboard-director-asset-confirmation';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from '../src/lib/storyboard-workbench';
import type { StoryboardVisualAssetCandidate } from '../src/lib/storyboard-visual-asset-workspace';

type TestCard = SelectionCard & { id: string; imageStatus: string; videoStatus: string; [key: string]: unknown };
type TestDocument = { id: string; cards: TestCard[]; visualAssetPlan: StoryboardVisualAssetPlan; visualAssetWorkspace: { drafts: []; candidates: StoryboardVisualAssetCandidate[] } };
const source = readFileSync('src/components/storyboard-workbench.tsx', 'utf8');
const tree = ts.createSourceFile('workbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extracted = new Map<string, string>();
function walk(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
    && ['applyVisualAssets', 'ensureInitialReferencesAdopted', 'updateVisualAssetSelection'].includes(node.name.getText(tree))) {
    extracted.set(node.name.getText(tree), node.initializer.arguments[0].getText(tree));
  }
  if (ts.isFunctionDeclaration(node) && node.name && ['isCompletedInlineImageReceipt', 'imageAttemptNeedsResolution', 'isActiveVideoStatus', 'videoNeedsRequestReconciliation', 'visualAssetPlanId', 'visualAssetReferenceKind', 'storyboardCandidateToAsset'].includes(node.name.text)) {
    extracted.set(node.name.text, node.getText(tree));
  }
  ts.forEachChild(node, walk);
}
walk(tree);
const helpers = ['isCompletedInlineImageReceipt', 'imageAttemptNeedsResolution', 'isActiveVideoStatus', 'videoNeedsRequestReconciliation', 'visualAssetPlanId', 'visualAssetReferenceKind', 'storyboardCandidateToAsset'].map(name => {
  assert.ok(extracted.has(name), 'missing actual helper ' + name); return extracted.get(name)!;
}).join('\n');
function actualCallback(name: string, context: Record<string, unknown>) {
  assert.ok(extracted.has(name), 'missing actual callback ' + name);
  return vm.runInNewContext(ts.transpileModule(helpers + '\n(' + extracted.get(name) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
const policy = { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' as const };
const offPlan = (): StoryboardVisualAssetPlan => ({ mode: 'off', assets: [] });
const candidate = (role: 'character' | 'pet' | 'prop' = 'character', slot = 'new_identity'): StoryboardVisualAssetCandidate => ({
  assetId: 'owned_' + slot, planId: slot, projectId: 'project', role, name: role === 'pet' ? '宠物参考' : role === 'prop' ? '道具参考' : '人物参考',
  prompt: '保持用户提示词中的主体身份、颜色和已有配饰，展示同一主体的三视图。', storageKey: 'objects/' + slot + '.png', saved: false,
});
const asset = (slot = 'existing_identity'): StoryboardVisualAssetPlan['assets'][number] => ({
  id: slot, role: 'character', name: '已有角色', identityLock: '保持原始描述中的主体身份及外形一致', allowedChanges: [],
  referencePrompts: [{ kind: 'identity', purpose: '主体身份参考', prompt: '保持原始描述中的主体身份及外形一致，不添加其他主体和配饰。' }],
  source: { kind: 'uploaded-image', assetId: 'original_' + slot, storageKey: 'objects/original_' + slot + '.png' },
});
const document = (cardPatch: Record<string, unknown> = {}, plan = offPlan()): TestDocument => ({ id: 'project', cards: [{
  id: 'card', referenceImageUrls: [], visualAssetSelectionMode: 'project', imageStatus: 'idle', videoStatus: 'idle', ...cardPatch,
}], visualAssetPlan: plan, visualAssetWorkspace: { drafts: [], candidates: [] } });
const owner = 'user\0token';
const noop = () => {};
function harness(before: TestDocument, options: { confirm?: boolean; videoLock?: boolean; boardLock?: boolean; duringResolve?: (run: TestDocument) => void } = {}) {
  const runRef = { current: before };
  const counts = { save: 0, library: 0, resolve: 0, confirm: 0, notice: '', error: '' };
  const context = {
    Error, Date, JSON, referenceOnly: false, referenceDisplayMode: 'normal', referenceLimit: 8, token: 'token', userId: 'user',
    contextReadyRef: { current: true }, navigationRef: { current: false }, scopeMountedRef: { current: true },
    visualAssetMutationRef: { current: false }, imageSubmissionsRef: { current: new Set<string>() },
    videoSubmissionsRef: { current: new Set(options.videoLock ? ['card'] : []) }, boardExportLocksRef: { current: new Set(options.boardLock ? ['card'] : []) },
    visualAssetGenerationRef: { current: false }, pendingAssetAttempts: [], referenceUploadPending: [],
    imageDownloadOwnerRef: { current: owner }, runRef, requestedVisualAssetIds, affectedVisualAssetCards, mutateVisualAssetSlot, storyboardCandidateToAsset: actualCallback('storyboardCandidateToAsset', {}), confirmStoryboardDirectorAsset,
    prepareSelectedCardSourceUpdate, markVisualAssetMediaStale, visualAssetReferenceContentChanged, changeProjectDefaults, chooseCustomAssets, rebindSelectedCard, requestedVisualAssetPlan, rollbackSelectionTransaction, VIDEO_HISTORY_SETTLED_BILLING_STATES, isUnavailableCompletedStoryboardImage,
    submittedRunIdsRef: { current: new Set<string>() }, explicitlyExportedAssetsRef: { current: new Set<string>() },
    window: { confirm: () => { counts.confirm++; return options.confirm !== false; }, localStorage: {} },
    setVisualAssetSaving: noop, setVisualAssetError: (message: string) => { counts.error = message; }, setRun: noop, setVisualAssetCandidates: noop,
    setNotice: (message: string) => { counts.notice = message; }, rememberVisualAssetCandidate: noop,
    createStoryboardPersistenceSnapshot: (value: unknown) => value,
    saveVisualAssetContext: async () => { counts.save++; return true; },
    saveStoryboardProject: async (value: TestDocument) => { counts.save++; StoryboardVisualAssetPlanSchema.parse(value.visualAssetPlan); return true; },
    saveStoryboardVisualAssetCandidates: async () => { counts.library++; throw new Error('Unexpected library export in guard test'); },
    visualAssetSelectionError: (error: unknown, fallback: string) => {
      // The callback runs inside a VM context, so its Error prototype is not
      // the host realm's Error. Read the stable message contract first and
      // only use instanceof for same-realm errors.
      if (error instanceof Error) return error.message;
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
      return fallback;
    },
    resolveVisualAssetUrls: async (plan: StoryboardVisualAssetPlan) => {
      counts.resolve++; options.duringResolve?.(runRef.current);
      return plan.assets.filter(item => item.source).map(item => ({ assetId: item.source!.assetId, previewUrl: 'https://fixture.invalid/' + item.source!.storageKey }));
    },
    visibleReferenceChoicesRef: { current: { owner, projectId: before.id, ids: {} as Record<string, string> } },
    initialReferenceBlockedRef: { current: new Set<string>() }, initialReferenceAdoptionRef: { current: false },
    visualAssetBatchRef: { current: false }, referenceUploadOperationRef: { current: false }, referenceUploadPendingRef: { current: [] },
    batchAuthorizationRef: { current: false }, readStoryboardAssetAttempts: () => [], adoptInitialStoryboardReferences,
  };
  return { runRef, counts, context,
    apply: actualCallback('applyVisualAssets', context) as (mutation: unknown, saveToLibrary: boolean) => Promise<boolean>,
    ensure: actualCallback('ensureInitialReferencesAdopted', context) as () => Promise<boolean>,
    select: actualCallback('updateVisualAssetSelection', context) as (ids: string[], cardId?: string, mode?: 'project' | 'custom') => Promise<void>,
  };
}
let passed = 0;
const cases: string[] = [];
function done(name: string) { passed++; cases.push(name); }
async function main() {
  const blocked: Array<[string, Record<string, unknown>, { videoLock?: boolean; boardLock?: boolean }]> = [
    ['active image', { imageStatus: 'running' }, {}],
    ['pending image billing', { imageBillingState: 'pending' }, {}],
    ['active video', { videoStatus: 'running', videoTaskId: 'active-task' }, {}],
    ['failed video without retry clearance', { videoStatus: 'failed', videoRetryable: false }, {}],
    ['unknown video billing', { videoBillingState: 'unknown' }, {}],
    ['video submission lock', {}, { videoLock: true }],
    ['board export lock', {}, { boardLock: true }],
  ];
  for (const [name, patch, options] of blocked) {
    const before = document(patch); const snapshot = structuredClone(before); const h = harness(before, options);
    assert.equal(await h.apply({ type: 'upsert', slotId: 'new_identity', asset: candidate() }, true), false, name);
    assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [0, 0, 0], name + ' must block before any IO');
    assert.deepEqual(h.runRef.current, snapshot, name + ' must retain the original plan and card');
    assert.match(h.counts.error, /原请求或费用待确认/u); done(name + ' blocks newly affected slot before IO');
  }
  {
    const h = harness(document());
    assert.equal(await h.apply({ type: 'upsert', slotId: 'new_identity', asset: candidate() }, false), true);
    assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [1, 0, 1]);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source!.assetId, 'owned_new_identity');
    assert.equal(h.runRef.current.cards[0].visualAssetRefs![0].assetId, 'new_identity');
    assert.equal(h.runRef.current.cards[0].referenceImageUrls.length, 1); done('idle manual identity adopts source and binds project card');
  }
  {
    const before = document({ imageUrl: 'https://fixture.invalid/existing.png' }); const h = harness(before, { confirm: false });
    assert.equal(await h.apply({ type: 'upsert', slotId: 'new_identity', asset: candidate() }, true), false);
    assert.equal(h.counts.confirm, 1); assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [0, 0, 0]);
    assert.equal(h.runRef.current, before); done('existing media confirmation rejection writes nothing');
  }
  const old = asset(); const existingPlan: StoryboardVisualAssetPlan = { mode: 'selected', assets: [old], defaultAssetIds: [old.id], generationPolicy: policy };
  {
    const before = document({ imageBillingState: 'pending' }, existingPlan); const h = harness(before);
    assert.equal(await h.apply({ type: 'upsert', slotId: old.id, asset: candidate('character', old.id) }, false), false);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source!.assetId, old.source!.assetId);
    assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [0, 0, 0]); done('pending replacement retains original source');
  }
  {
    const before = document({}, existingPlan); const h = harness(before, { duringResolve: run => { run.cards[0].imageBillingState = 'pending'; } });
    assert.equal(await h.apply({ type: 'upsert', slotId: old.id, asset: candidate('character', old.id) }, false), false);
    assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [0, 0, 1]);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source!.assetId, old.source!.assetId);
    assert.match(h.counts.error, /原请求或费用待确认/u); done('billing entering pending during resolution blocks commit');
  }
  for (const role of ['character', 'pet'] as const) {
    const before = document({}, { mode: 'selected', assets: [], generationPolicy: policy }); const item = candidate(role); before.visualAssetWorkspace.candidates = [item];
    const h = harness(before); h.context.visibleReferenceChoicesRef.current.ids = { [item.planId]: item.assetId };
    assert.equal(await h.ensure(), false); assert.match(h.counts.notice, /未采用候选.*使用这张/u);
    assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [0, 0, 0]); done('visible new ' + role + ' requires explicit adoption');
  }
  for (const variant of ['existing-replacement', 'prop', 'off', 'different-owner', 'different-choice-project', 'different-candidate-project'] as const) {
    const item = variant === 'existing-replacement' ? candidate('character', old.id) : candidate(variant === 'prop' ? 'prop' : 'character');
    const before = document({}, variant === 'off' ? offPlan() : variant === 'existing-replacement' ? existingPlan : { mode: 'selected', assets: [], generationPolicy: policy });
    before.visualAssetWorkspace.candidates = [variant === 'different-candidate-project' ? { ...item, projectId: 'other-project' } : item];
    const h = harness(before); h.context.visibleReferenceChoicesRef.current.ids = { [item.planId]: item.assetId };
    if (variant === 'different-owner') h.context.visibleReferenceChoicesRef.current.owner = 'other-owner';
    if (variant === 'different-choice-project') h.context.visibleReferenceChoicesRef.current.projectId = 'other-project';
    assert.equal(await h.ensure(), true, variant); assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [0, 0, 0]); done(variant + ' does not block generation preflight');
  }
  {
    const required = { ...asset('required_identity'), source: undefined };
    const before = document({}, { mode: 'selected', assets: [required], generationPolicy: { maxInitialImages: 1, initialRequiredAssetIds: [required.id], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' } });
    const item = candidate('character', required.id); before.visualAssetWorkspace.candidates = [item];
    const h = harness(before); h.context.visibleReferenceChoicesRef.current.ids = { [item.planId]: item.assetId };
    assert.equal(await h.ensure(), true); assert.deepEqual([h.counts.save, h.counts.library, h.counts.resolve], [1, 0, 1]);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source!.assetId, item.assetId);
    assert.equal(h.runRef.current.cards[0].referenceImageUrls.length, 1); done('required imported identity keeps the existing automatic adoption path');
  }
  for (const patch of [{ videoBillingState: 'unknown' }, { videoStatus: 'failed', videoRetryable: false }]) {
    const before = document(patch, existingPlan); const snapshot = structuredClone(before); const h = harness(before);
    await h.select([], 'card', 'custom');
    assert.equal(h.counts.save, 0); assert.equal(h.counts.library, 0);
    assert.deepEqual(h.runRef.current, snapshot);
    assert.match(h.counts.error, /原媒体任务或费用尚未确认/u);
    done('custom selection rejects ' + ('videoBillingState' in patch ? 'unknown billing' : 'uncleared failed video') + ' without existing media');
  }
  {
    const before = document({ imageUrl: 'https://fixture.invalid/existing-board.png', videoUrl: 'https://fixture.invalid/existing-video.mp4', videoStatus: 'done', videoBillingState: 'settled' }, existingPlan);
    const h = harness(before); await h.select([], 'card', 'custom');
    assert.equal(h.counts.save, 1); assert.equal(h.counts.library, 0); assert.equal(h.counts.confirm, 1);
    assert.equal(h.runRef.current.cards[0].visualAssetSelectionMode, 'custom');
    assert.equal(h.runRef.current.cards[0].visualAssetRefs!.length, 0);
    assert.equal(h.runRef.current.cards[0].imageReferenceState, 'stale');
    assert.equal(h.runRef.current.cards[0].imageUrl, before.cards[0].imageUrl);
    assert.equal(h.runRef.current.cards[0].videoUrl, before.cards[0].videoUrl);
    done('settled custom selection saves, marks stale, and preserves both old media');
  }
  console.log(JSON.stringify({ passed, failed: 0, actualNetworkRequests: 0, databaseWrites: 0, providerCalls: 0, scope: 'AST extracted current workbench callbacks with real selection/adoption helpers and counted IO fixtures', cases }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
