import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { affectedVisualAssetCards, mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, requestedVisualAssetIds, rollbackSelectionTransaction, type SelectionCard } from '../src/lib/storyboard-visual-asset-selection';
import { markVisualAssetMediaStale } from '../src/lib/storyboard-visual-asset-media-state';
import { adoptFirstStoryboardReference } from '../src/lib/storyboard-first-reference-adoption';
import { confirmStoryboardDirectorAsset, hasStoryboardDirectorAssetConfirmation, pruneStoryboardDirectorAssetConfirmations } from '../src/lib/storyboard-director-asset-confirmation';
import type { StoryboardDirectorIntakeState } from '../src/lib/storyboard-director-resume';
import { removeStoryboardReference } from '../src/lib/storyboard-reference-removal';
import { VIDEO_HISTORY_SETTLED_BILLING_STATES } from '../src/lib/video-history-policy';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from '../src/lib/storyboard-workbench';
import { normalizeStoryboardVisualAssetWorkspace, type StoryboardVisualAssetCandidate, type StoryboardVisualAssetWorkspace } from '../src/lib/storyboard-visual-asset-workspace';
import { migrateSavedVisualAssetSource, rollbackVisualAssetMode } from '../src/lib/storyboard-visual-asset-binding';
import { saveStoryboardVisualAssetCandidates } from '../src/lib/storyboard-visual-asset-library';
import { visibleStoryboardReference } from '../src/lib/storyboard-initial-reference-adoption';
import { isReferenceSessionId } from '../src/lib/storyboard-reference-workspace';
import type { DrawerVisualAsset } from '../src/components/storyboard-visual-assets-drawer';

const source = readFileSync('src/components/storyboard-workbench.tsx', 'utf8');
const tree = ts.createSourceFile('workbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extracted = new Map<string, string>();
const helperNames = ['isCompletedInlineImageReceipt', 'imageAttemptNeedsResolution', 'isActiveVideoStatus', 'videoNeedsRequestReconciliation', 'visualAssetPlanId', 'visualAssetReferenceKind', 'storyboardCandidateToAsset',
  'withVisualAssetCandidate', 'directorAssetExportCandidate', 'withDirectorAssetLibrarySave', 'directorLegacyAssetSlotIds'];
const callbackNames = ['applyVisualAssets', 'withFirstReferenceAdoption', 'saveVisualAssetSelection', 'rememberVisualAssetCandidate', 'rememberDirectorAssetExport', 'restoreDirectorOriginalAssets'];
function walk(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const name = node.name.getText(tree);
    if (callbackNames.includes(name) && ts.isCallExpression(node.initializer)) extracted.set(name, node.initializer.arguments[0].getText(tree));
    if (name === 'directorConfirmedSlots') extracted.set(name, node.initializer.getText(tree));
  }
  if (ts.isFunctionDeclaration(node) && node.name && helperNames.includes(node.name.text)) extracted.set(node.name.text, node.getText(tree));
  if (ts.isJsxAttribute(node) && ['selectedAssets', 'selectedSlotIds'].includes(node.name.getText(tree))
    && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) extracted.set('drawer_' + node.name.getText(tree), node.initializer.expression.getText(tree));
  if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'key' && node.initializer && ts.isJsxExpression(node.initializer)
    && node.initializer.expression?.getText(tree) === 'visualAssetRecoveryRevision') extracted.set('drawer_recoveryKey', node.initializer.expression.getText(tree));
  ts.forEachChild(node, walk);
}
walk(tree);
const drawerTree = ts.createSourceFile('drawer.tsx', readFileSync('src/components/storyboard-visual-assets-drawer.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function walkDrawer(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ['save', 'remember', 'perform'].includes(node.name.getText(drawerTree))) {
    extracted.set('drawer_' + node.name.getText(drawerTree), node.initializer.getText(drawerTree));
  }
  ts.forEachChild(node, walkDrawer);
}
walkDrawer(drawerTree);
const helpers = helperNames.map(name => { assert.ok(extracted.has(name), 'missing actual helper ' + name); return extracted.get(name)!; }).join('\n');
function actual(name: string, context: Record<string, unknown>, includeHelpers = true): unknown {
  assert.ok(extracted.has(name), 'missing actual callback/expression ' + name);
  return vm.runInNewContext(ts.transpileModule((includeHelpers ? helpers : '') + '\n(' + extracted.get(name) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
}
type Card = SelectionCard & { id: string; imageStatus: string; videoStatus: string };
type Document = { id: string; cards: Card[]; directorIntake?: StoryboardDirectorIntakeState; visualAssetPlan: StoryboardVisualAssetPlan; visualAssetWorkspace: StoryboardVisualAssetWorkspace };
const historyRecordId = 'a'.repeat(64);
const item: StoryboardVisualAssetCandidate = { assetId: `generated_${historyRecordId}`, planId: 'owner_main', projectId: 'project', role: 'character', name: '人物',
  prompt: '人物同一身份正面、侧面、背面三视图，全身完整，保持固定服装。', historyRecordId, saved: false };
function fixture(director = true, existingSource = false): Document {
  return { id: 'project', cards: [{ id: 'card', referenceImageUrls: [], visualAssetSelectionMode: 'project', imageStatus: 'idle', videoStatus: 'idle' }],
    directorIntake: director ? { phase: 'assets', sourceMessageId: 'original-message', input: { schema_version: 'storyboard_director_input.v1', segmented_script: '原始分段', director_mode: 'high_energy', animation_style: '原始黏土', aspect_ratio: '9:16', target_duration_seconds: 10, special_notes: '', visual_asset_mode: '参考图模式' } } : undefined,
    visualAssetPlan: { mode: 'selected', assets: [{ id: item.planId, role: item.role, name: item.name, identityLock: '原始人物身份、服装、体型、发色与五官全片固定', allowedChanges: ['表情'],
      referencePrompts: [{ kind: 'turnaround', purpose: '人物三视图', prompt: item.prompt! }],
      ...(existingSource ? { source: { kind: 'generated-image-history' as const, assetId: item.assetId, historyRecordId } } : {}),
    }], generationPolicy: { maxInitialImages: 1, initialRequiredAssetIds: [item.planId], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' } },
    visualAssetWorkspace: { drafts: [{ planId: item.planId, role: item.role, name: item.name, prompt: item.prompt!, tagsText: '', customCategory: '' }], candidates: [] },
  };
}
type FixtureOptions = { libraryFailure?: 'read' | 'persist' | 'library'; recovery?: { candidate?: DrawerVisualAsset; error?: string }; recoveryOk?: boolean };
function drawerAsset(candidate: StoryboardVisualAssetCandidate = item): DrawerVisualAsset {
  return { ...candidate, previewUrl: '/owned/' + candidate.assetId };
}
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function harness(before: Document, saveResult = true, options: FixtureOptions = {}) {
  const runRef = { current: before };
  const saved: Document[] = [];
  const counts = { resolve: 0, save: 0, operation: 0, libraryRead: 0, libraryPersist: 0, libraryWrite: 0, recoveryRead: 0, recoveryRevision: 0, error: '', notice: '' };
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let visibleCandidates = before.visualAssetWorkspace.candidates.map(drawerAsset);
  const noop = () => {};
  const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
  const fixtureRequest: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method, ...(body ? { body } : {}) });
    if (url.startsWith('/api/storyboard/director-assets/original?') && method === 'GET') {
      counts.recoveryRead++;
      const parsed = new URL(url, 'http://fixture.invalid');
      assert.equal(parsed.searchParams.get('projectId'), before.id);
      assert.equal(parsed.searchParams.get('assetId'), item.planId);
      assert.equal(init?.cache, 'no-store');
      return reply(options.recovery || { candidate: drawerAsset() }, options.recoveryOk !== false);
    }
    if (url === '/api/storyboard/visual-assets?recordId=' + historyRecordId && method === 'GET') {
      counts.libraryRead++;
      return reply(options.libraryFailure === 'read' ? { error: 'fixture original unavailable' } : { reference: { previewUrl: '/fixture/original-image' } }, options.libraryFailure !== 'read');
    }
    if (url === '/api/image-workbench/persist' && method === 'POST') {
      counts.libraryPersist++;
      assert.equal(body?.intent, 'user_asset_export');
      return reply(options.libraryFailure === 'persist' ? { error: 'fixture persist failed' } : { assetId: 'library_copy', key: 'fixture/library-copy.png', url: '/fixture/library-copy.png' }, options.libraryFailure !== 'persist');
    }
    if (url === '/api/storyboard/visual-assets' && method === 'POST') {
      counts.libraryWrite++;
      return reply(options.libraryFailure === 'library' ? { error: 'fixture library failed' } : { asset: { ...body, previewUrl: '/fixture/library-copy.png' } }, options.libraryFailure !== 'library');
    }
    throw new Error('Unexpected fixture IO: ' + method + ' ' + url);
  };
  const context: Record<string, unknown> = {
    Error, Date, JSON, structuredClone, URL, encodeURIComponent, referenceOnly: false, referenceLimit: 8, token: 'token', userId: 'user', runRef,
    contextReadyRef: { current: true }, navigationRef: { current: false }, scopeMountedRef: { current: true },
    visualAssetMutationRef: { current: false }, imageSubmissionsRef: { current: new Set<string>() }, videoSubmissionsRef: { current: new Set<string>() },
    boardExportLocksRef: { current: new Set<string>() }, visualAssetGenerationRef: { current: false }, pendingAssetAttempts: [], referenceUploadPending: [],
    imageDownloadOwnerRef: { current: 'user\0token' }, initialReferenceBlockedRef: { current: new Set<string>() }, initialReferenceAdoptionRef: { current: false },
    visualAssetBatchRef: { current: false }, referenceUploadOperationRef: { current: false }, referenceUploadPendingRef: { current: [] }, batchAuthorizationRef: { current: false },
    submittedRunIdsRef: { current: new Set<string>() }, explicitlyExportedAssetsRef: { current: new Map<string, DrawerVisualAsset>() },
    requestedVisualAssetIds, affectedVisualAssetCards, mutateVisualAssetSlot, prepareSelectedCardSourceUpdate, markVisualAssetMediaStale, rollbackSelectionTransaction,
    confirmStoryboardDirectorAsset, pruneStoryboardDirectorAssetConfirmations, adoptFirstStoryboardReference, removeStoryboardReference, VIDEO_HISTORY_SETTLED_BILLING_STATES,
    migrateSavedVisualAssetSource, rollbackVisualAssetMode, normalizeStoryboardVisualAssetWorkspace, isReferenceSessionId,
    window: { confirm: () => true, localStorage: {} }, readStoryboardAssetAttempts: () => [],
    setVisualAssetSaving: noop, setVisualAssetError: (message: string) => { counts.error = message; }, setRun: noop,
    setVisualAssetCandidates: (update: (items: DrawerVisualAsset[]) => DrawerVisualAsset[]) => { visibleCandidates = update(visibleCandidates); },
    setVisualAssetRecoveryRevision: (update: (revision: number) => number) => { counts.recoveryRevision = update(counts.recoveryRevision); },
    setNotice: (message: string) => { counts.notice = message; }, rememberVisualAssetCandidate: noop,
    createStoryboardPersistenceSnapshot: (value: unknown) => value,
    saveStoryboardProject: async (value: Document) => { counts.save++; StoryboardVisualAssetPlanSchema.parse(value.visualAssetPlan); saved.push(structuredClone(value)); return saveResult; },
    saveVisualAssetContext: async (value: Document) => { counts.save++; saved.push(structuredClone(value)); return saveResult; },
    saveStoryboardVisualAssetCandidates: (input: Parameters<typeof saveStoryboardVisualAssetCandidates>[0]) => saveStoryboardVisualAssetCandidates({ ...input, request: fixtureRequest }),
    fetch: fixtureRequest,
    visualAssetSelectionError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
    resolveVisualAssetUrls: async (plan: StoryboardVisualAssetPlan) => { counts.resolve++; return plan.assets.filter(asset => asset.source).map(asset => ({ assetId: asset.source!.assetId, previewUrl: '/owned/' + asset.source!.assetId })); },
  };
  context.rememberVisualAssetCandidate = actual('rememberVisualAssetCandidate', context);
  context.rememberDirectorAssetExport = actual('rememberDirectorAssetExport', context);
  const apply = actual('applyVisualAssets', context) as (mutation: unknown, saveToLibrary: boolean) => Promise<boolean>;
  const save = actual('saveVisualAssetSelection', context) as (selected: DrawerVisualAsset[]) => Promise<DrawerVisualAsset[]>;
  const restore = actual('restoreDirectorOriginalAssets', context) as () => Promise<boolean>;
  const first = actual('withFirstReferenceAdoption', context) as (input: unknown, operation: () => Promise<StoryboardVisualAssetCandidate>) => Promise<StoryboardVisualAssetCandidate>;
  const generate = () => first(item, async () => { counts.operation++; runRef.current = { ...runRef.current, visualAssetWorkspace: { ...runRef.current.visualAssetWorkspace, candidates: [item] } }; return item; });
  return { runRef, saved, counts, requests, apply, generate, save, restore, visibleCandidates: () => visibleCandidates };
}
function drawerHarness(initialGenerated: DrawerVisualAsset[], onSaveSelected: (selected: DrawerVisualAsset[]) => Promise<DrawerVisualAsset[]>) {
  const state = { generated: initialGenerated, error: '', notice: '' };
  let pendingOperation = Promise.resolve();
  const noop = () => {};
  const context: Record<string, unknown> = { Error, props: { onSaveSelected }, pending: false, scope: 'fixture', sameScope: () => true,
    lock: { current: false }, busy: false, setActionBusy: noop, setBusyPlan: noop,
    setLocalError: (value: string) => { state.error = value; }, setNotice: (value: string) => { state.notice = value; },
    setGenerated: (update: (items: DrawerVisualAsset[]) => DrawerVisualAsset[]) => { state.generated = update(state.generated); },
  };
  context.remember = actual('drawer_remember', context, false);
  const perform = actual('drawer_perform', context, false) as (operation: () => Promise<void>) => Promise<void>;
  context.perform = (operation: () => Promise<void>) => { pendingOperation = perform(operation); return pendingOperation; };
  const save = actual('drawer_save', context, false) as (asset: DrawerVisualAsset) => void;
  return { state, save: async (asset: DrawerVisualAsset) => { save(asset); await pendingOperation; } };
}
function assertCanonical(run: Document, expectedSaved?: boolean) {
  const candidate = run.visualAssetWorkspace.candidates.find(candidate => candidate.planId === item.planId)!;
  assert.equal(candidate.assetId, item.assetId);
  assert.equal(candidate.historyRecordId, item.historyRecordId);
  assert.equal(candidate.storageKey, undefined);
  assert.equal(candidate.prompt, item.prompt);
  if (expectedSaved !== undefined) assert.equal(candidate.saved, expectedSaved);
}
function assertDrawerSelection(run: Document, expectedCount: number) {
  const slots = actual('directorConfirmedSlots', { run, hasStoryboardDirectorAssetConfirmation }, false);
  const context = { run, directorConfirmedSlots: slots, selectedAssets: [{ planId: item.planId, assetId: run.visualAssetPlan.assets[0].source?.assetId }] };
  assert.equal((actual('drawer_selectedAssets', context, false) as unknown[]).length, expectedCount);
  assert.equal((actual('drawer_selectedSlotIds', context, false) as unknown[]).length, expectedCount);
}
function legacyFixture() {
  const before = fixture(true, true);
  const legacy = { ...item, assetId: 'library_copy', storageKey: 'fixture/library-copy.png', saved: true, prompt: '旧图库元数据提示词，不是原始派发提示词。' };
  before.visualAssetWorkspace.candidates = [legacy];
  before.visualAssetPlan.assets[0].source = { kind: 'generated-image-history', assetId: legacy.assetId, storageKey: legacy.storageKey, historyRecordId };
  before.directorIntake!.confirmedAssets = [{ planId: item.planId, sourceAssetId: legacy.assetId, historyRecordId, role: 'character', confirmedAt: '2026-10-23T00:00:00.000Z' }];
  before.cards[0].referenceImageUrls = ['/fixture/old-selected-image'];
  return before;
}
const checks: string[] = [];
async function main() {
  {
    const h = harness(fixture());
    assert.equal(await h.generate(), item);
    assert.equal(h.counts.operation, 1);
    assert.equal(h.counts.save, 0); assert.equal(h.counts.resolve, 0);
    assert.equal(h.runRef.current.visualAssetWorkspace.candidates.length, 1);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source, undefined);
    assert.equal(h.runRef.current.directorIntake?.confirmedAssets, undefined);
    assert.equal(h.runRef.current.cards[0].referenceImageUrls.length, 0);
    checks.push('assets first generated candidate remains unadopted without save or confirmation');
  }
  {
    const h = harness(fixture(false));
    await h.generate();
    assert.equal(h.counts.save, 1, h.counts.error); assert.equal(h.counts.resolve, 1);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source?.assetId, item.assetId);
    assert.equal(h.runRef.current.cards[0].referenceImageUrls.length, 1);
    checks.push('ordinary first generation retains actual automatic adoption and binding');
  }
  for (const saveResult of [false, true]) {
    const before = fixture(true, true); before.visualAssetWorkspace.candidates = [item];
    const snapshot = structuredClone(before);
    const h = harness(before, saveResult);
    const slots = actual('directorConfirmedSlots', { run: before, hasStoryboardDirectorAssetConfirmation }, false);
    const drawerContext = { run: before, directorConfirmedSlots: slots, selectedAssets: [{ planId: item.planId, assetId: item.assetId }] };
    assert.equal((actual('drawer_selectedAssets', drawerContext, false) as unknown[]).length, 0);
    assert.equal((actual('drawer_selectedSlotIds', drawerContext, false) as unknown[]).length, 0);
    assert.equal(await h.apply({ type: 'upsert', slotId: item.planId, asset: item }, false), saveResult);
    assert.equal(h.counts.save, 1);
    assert.equal(h.saved[0].directorIntake?.confirmedAssets?.length, 1, 'confirmation and selected source saved in one snapshot');
    if (!saveResult) {
      assert.deepEqual(h.runRef.current.directorIntake, snapshot.directorIntake);
      assert.deepEqual(h.runRef.current.visualAssetPlan, snapshot.visualAssetPlan);
      assert.deepEqual(JSON.parse(JSON.stringify(h.runRef.current.cards)), JSON.parse(JSON.stringify(snapshot.cards)));
      assert.match(h.counts.error, /保存未确认/u);
      checks.push('explicit apply save failure rolls back confirmation and bindings');
    } else {
      assert.equal(h.runRef.current.directorIntake?.confirmedAssets?.[0].sourceAssetId, item.assetId);
      assert.deepEqual(h.runRef.current.directorIntake?.input, snapshot.directorIntake?.input);
      assert.equal(h.runRef.current.directorIntake?.sourceMessageId, snapshot.directorIntake?.sourceMessageId);
      checks.push('old auto-selected source without confirmation is visibly unselected and can be explicitly applied');
    }
  }
  {
    const before = fixture(); before.visualAssetWorkspace.candidates = [item];
    const h = harness(before);
    const rawDrawerAsset = { ...drawerAsset(), prompt: '抽屉内尚未派发的编辑草稿，不得覆盖原始派发提示词。', name: '图库展示名称', tags: ['图库标签'] };
    const drawer = drawerHarness([rawDrawerAsset], h.save);
    await drawer.save(rawDrawerAsset);
    assert.equal(drawer.state.error, '', drawer.state.error);
    assert.equal(drawer.state.generated[0].assetId, item.assetId);
    assert.equal(drawer.state.generated[0].storageKey, undefined);
    assert.equal(drawer.state.generated[0].prompt, item.prompt);
    assert.equal(drawer.state.generated[0].saved, true);
    const visible = visibleStoryboardReference(item.planId, before.id, drawer.state.generated, h.visibleCandidates(), []);
    assert.equal(visible, drawer.state.generated[0]);
    assertCanonical(h.runRef.current, true);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source, undefined);
    assert.equal(h.runRef.current.directorIntake?.confirmedAssets, undefined);
    assert.equal(h.requests.find(request => request.method === 'POST' && request.url === '/api/storyboard/visual-assets')?.body?.prompt, item.prompt);
    assert.equal(h.requests.find(request => request.method === 'POST' && request.url === '/api/storyboard/visual-assets')?.body?.name, rawDrawerAsset.name);
    assert.equal(await h.apply({ type: 'upsert', slotId: item.planId, asset: visible }, false), true, h.counts.error);
    // VM callbacks mutate the ref; TS cannot invalidate its pre-await property narrowing.
    const afterApply = h.runRef.current as Document;
    assert.equal(afterApply.visualAssetPlan.assets[0].source?.assetId, item.assetId);
    assert.equal(afterApply.visualAssetPlan.assets[0].source?.storageKey, undefined);
    assert.equal(afterApply.directorIntake?.confirmedAssets?.[0].sourceAssetId, item.assetId);
    assertDrawerSelection(h.runRef.current, 1);
    checks.push('actual drawer export then Apply preserves canonical generated ID and dispatched prompt while allowing library metadata');
  }
  {
    const before = fixture(); before.visualAssetWorkspace.candidates = [item];
    const h = harness(before);
    assert.equal(await h.apply({ type: 'upsert', slotId: item.planId, asset: drawerAsset() }, false), true, h.counts.error);
    const selection = plain({ plan: h.runRef.current.visualAssetPlan, cards: h.runRef.current.cards, intake: h.runRef.current.directorIntake });
    const exported = await h.save([{ ...drawerAsset(), prompt: '未派发的编辑草稿。' }]);
    assert.equal(exported.length, 1, h.counts.error);
    assert.equal(exported[0].assetId, item.assetId); assert.equal(exported[0].storageKey, undefined); assert.equal(exported[0].saved, true);
    assert.equal(exported[0].prompt, item.prompt);
    assert.deepEqual(plain({ plan: h.runRef.current.visualAssetPlan, cards: h.runRef.current.cards, intake: h.runRef.current.directorIntake }), selection);
    assertCanonical(h.runRef.current, true); assertDrawerSelection(h.runRef.current, 1);
    checks.push('Apply then export leaves selected source, card bindings and exact confirmation unchanged');
  }
  {
    const before = fixture(true, true); before.visualAssetWorkspace.candidates = [item];
    before.directorIntake = confirmStoryboardDirectorAsset(before, item.planId, '2026-10-23T00:00:00.000Z');
    const snapshot = plain(before);
    const h = harness(before, false);
    const exported = await h.save([{ ...drawerAsset(), prompt: '未派发的编辑草稿。' }]);
    assert.equal(h.counts.libraryWrite, 1); assert.equal(h.counts.save, 1);
    assert.match(h.counts.error, /项目来源更新未保存/u);
    assert.equal(exported.length, 1); assert.equal(exported[0].assetId, item.assetId); assert.equal(exported[0].saved, true);
    assert.equal(exported[0].storageKey, undefined); assert.equal(exported[0].prompt, item.prompt);
    assert.deepEqual(plain(h.runRef.current.visualAssetPlan), snapshot.visualAssetPlan);
    assert.deepEqual(plain(h.runRef.current.directorIntake), snapshot.directorIntake);
    assertCanonical(h.runRef.current, true); assertDrawerSelection(h.runRef.current, 1);
    checks.push('successful library export with failed project save returns canonical saved receipt and preserves original source, prompt and confirmation');
  }
  for (const libraryFailure of ['read', 'persist', 'library'] as const) {
    const before = fixture(true, true); before.visualAssetWorkspace.candidates = [item];
    const snapshot = plain(before);
    const h = harness(before, true, { libraryFailure });
    const original = drawerAsset();
    const drawer = drawerHarness([original], h.save);
    await drawer.save(original);
    assert.match(drawer.state.error, /图库保存未确认/u);
    assert.equal(drawer.state.generated[0], original);
    assert.deepEqual(plain(h.runRef.current), snapshot);
    assert.equal(h.counts.save, 0); assert.equal(h.counts.resolve, 0);
    checks.push('actual drawer failed export at ' + libraryFailure + ' retains its original visible candidate and project state');
  }
  {
    const before = fixture(); before.visualAssetWorkspace.candidates = [item];
    const h = harness(before);
    assert.equal(await h.apply({ type: 'upsert', slotId: item.planId, asset: { ...drawerAsset(), prompt: '未派发的草稿文本，不能取代实际派发提示词。' } }, true), true, h.counts.error);
    assert.equal(h.counts.libraryWrite, 1); assert.equal(h.counts.save, 2);
    assertCanonical(h.runRef.current, true);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source?.assetId, item.assetId);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source?.storageKey, undefined);
    assert.equal(h.runRef.current.directorIntake?.confirmedAssets?.[0].sourceAssetId, item.assetId);
    assert.equal(h.requests.find(request => request.method === 'POST' && request.url === '/api/storyboard/visual-assets')?.body?.prompt, item.prompt);
    assertDrawerSelection(h.runRef.current, 1);
    checks.push('Apply with saveToLibrary=true saves an independent library copy and confirms the canonical original');
  }
  for (const combinedApply of [false, true]) {
    const before = fixture(false, !combinedApply); before.visualAssetWorkspace.candidates = [item];
    const h = harness(before);
    if (combinedApply) assert.equal(await h.apply({ type: 'upsert', slotId: item.planId, asset: drawerAsset() }, true), true, h.counts.error);
    else assert.equal((await h.save([drawerAsset()]))[0].assetId, 'library_copy', h.counts.error);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source?.assetId, 'library_copy');
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source?.storageKey, 'fixture/library-copy.png');
    assert.equal(h.runRef.current.visualAssetWorkspace.candidates[0].assetId, 'library_copy');
    assert.equal(h.runRef.current.directorIntake, undefined);
    checks.push('ordinary mode ' + (combinedApply ? 'Apply with library save' : 'export') + ' retains existing saved-source migration compatibility');
  }
  {
    const before = legacyFixture(); const snapshot = plain(before);
    assertDrawerSelection(before, 0);
    const h = harness(before);
    const staleGenerated = drawerAsset(before.visualAssetWorkspace.candidates[0]);
    assert.equal(await h.restore(), true, h.counts.error);
    assert.equal(h.counts.recoveryRead, 1); assert.equal(h.counts.save, 1);
    assert.equal(h.counts.libraryWrite, 0); assert.equal(h.counts.libraryPersist, 0); assert.equal(h.counts.resolve, 0);
    assertCanonical(h.runRef.current, false);
    assert.deepEqual(plain(h.runRef.current.visualAssetPlan), snapshot.visualAssetPlan);
    assert.deepEqual(plain(h.runRef.current.cards), snapshot.cards);
    assert.equal(h.runRef.current.directorIntake?.confirmedAssets?.length, 0);
    assert.deepEqual(plain(h.runRef.current.directorIntake?.input), snapshot.directorIntake?.input);
    assertDrawerSelection(h.runRef.current, 0);
    assert.equal(h.counts.recoveryRevision, 1);
    assert.equal(actual('drawer_recoveryKey', { visualAssetRecoveryRevision: h.counts.recoveryRevision }, false), 1);
    assert.equal(visibleStoryboardReference(item.planId, before.id, [staleGenerated], h.visibleCandidates(), [])?.assetId, staleGenerated.assetId);
    const remounted = drawerHarness([], h.save);
    const recovered = visibleStoryboardReference(item.planId, before.id, remounted.state.generated, h.visibleCandidates(), []);
    assert.equal(recovered?.assetId, item.assetId);
    assert.equal(await h.apply({ type: 'upsert', slotId: item.planId, asset: recovered }, false), true, h.counts.error);
    assert.equal(h.runRef.current.visualAssetPlan.assets[0].source?.assetId, item.assetId);
    assert.equal(h.runRef.current.directorIntake?.confirmedAssets?.[0].sourceAssetId, item.assetId);
    assertDrawerSelection(h.runRef.current, 1);
    checks.push('legacy recovery persists only canonical workspace, clears confirmation, preserves old plan and bindings, and remounts drawer before explicit Apply');
  }
  for (const failure of ['save', 'request', 'identity'] as const) {
    const before = legacyFixture(); const snapshot = plain(before);
    const h = harness(before, failure !== 'save', failure === 'request'
      ? { recoveryOk: false, recovery: { error: 'fixture original unavailable' } }
      : failure === 'identity' ? { recovery: { candidate: { ...drawerAsset(), storageKey: 'fixture/not-original.png' } } } : {});
    const visibleBefore = plain(h.visibleCandidates());
    assert.equal(await h.restore(), false);
    assert.equal(h.runRef.current, before);
    assert.deepEqual(plain(h.runRef.current), snapshot);
    assert.deepEqual(plain(h.visibleCandidates()), visibleBefore);
    assert.equal(h.counts.recoveryRevision, 0); assert.equal(h.counts.libraryWrite, 0);
    assert.equal(h.counts.save, failure === 'save' ? 1 : 0);
    assert.ok(h.counts.error);
    checks.push('legacy recovery ' + failure + ' failure preserves old project, visible candidate and drawer identity');
  }
  const result = { passed: true, checks, actualNetworkRequests: 0, databaseWrites: 0, providerCalls: 0,
    scope: 'AST extracted current workbench and drawer callbacks, actual library-save implementation and real domain helpers with allowlisted fixture IO' };
  mkdirSync('.codex-evidence/director-refinement-20261023/mode-followup', { recursive: true });
  writeFileSync('.codex-evidence/director-refinement-20261023/mode-followup/confirmation-ui-result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
