import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { adoptFirstStoryboardReference, type FirstReferenceAdoptionDocument, type FirstReferenceCard } from '../src/lib/storyboard-first-reference-adoption';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from '../src/lib/storyboard-workbench';
import type { DrawerVisualAsset, DrawerVisualAssetInput } from '../src/components/storyboard-visual-assets-drawer';

type Card = FirstReferenceCard & { prompt: string };
type Document = FirstReferenceAdoptionDocument<Card>;
const source = readFileSync('src/components/storyboard-workbench.tsx', 'utf8');
const tree = ts.createSourceFile('workbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wantedCallbacks = ['withFirstReferenceAdoption', 'ensureInitialReferencesAdopted', 'generateVisualAsset'];
const wantedFunctions = ['storyboardCandidateToAsset', 'visualAssetReferenceKind', 'visualAssetPlanId'];
const definitions = new Map<string, string>();
function walk(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && wantedCallbacks.includes(node.name.getText(tree)) && node.initializer && ts.isCallExpression(node.initializer)) definitions.set(node.name.getText(tree), node.initializer.arguments[0].getText(tree));
  if (ts.isFunctionDeclaration(node) && node.name && wantedFunctions.includes(node.name.text)) definitions.set(node.name.text, node.getText(tree));
  ts.forEachChild(node, walk);
}
walk(tree);
for (const name of [...wantedCallbacks, ...wantedFunctions]) assert.ok(definitions.has(name), 'missing actual WB definition: ' + name);
const helperSource = wantedFunctions.map(name => definitions.get(name)).join('\n');
const executable = ts.transpileModule(helperSource + '\n({' + wantedCallbacks.map(name => name + ':(' + definitions.get(name) + ')').join(',') + '});', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const owner = 'fixture-user\0fixture-token';
const otherOwner = 'other-user\0other-token';
const item: DrawerVisualAsset = { assetId: 'owned_first_person', planId: 'first_person', role: 'character', name: '人物参考', prompt: '保持原始提示词中的人物身份外形与颜色，主体完整入画。',
  projectId: 'project', storageKey: 'objects/first_person.png', previewUrl: 'https://fixture.invalid/first_person.png', saved: false };
const input: DrawerVisualAssetInput = { role: item.role, name: item.name, prompt: item.prompt!, planId: item.planId };
const makeDocument = (): Document => ({ id: 'project', cards: [{ id: 'card', prompt: '原始分镜内容', referenceImageUrls: [], visualAssetSelectionMode: 'project', imageStatus: 'idle', videoStatus: 'idle' }],
  visualAssetPlan: { mode: 'off', assets: [] }, visualAssetWorkspace: { drafts: [{ planId: item.planId, role: item.role, name: item.name, prompt: item.prompt!, tagsText: '旧标签', customCategory: '' }], candidates: [] } });
type Race = 'owner' | 'project' | 'card' | 'draft' | 'plan';
function harness(options: { race?: Race; stage?: 'resolve' | 'save'; saveFailure?: boolean; referenceOnly?: boolean; wrongSlot?: boolean; oldSource?: boolean; oldMedia?: boolean } = {}) {
  const original = makeDocument();
  const counts = { generation: 0, candidateSave: 0, resolve: 0, save: 0, commit: 0, notice: '', error: '' };
  const events: string[] = [];
  const runRef = { current: original };
  const blocked = new Set<string>();
  const context = {
    Error, JSON, referenceOnly: options.referenceOnly === true, referenceDisplayMode: 'reference', referenceLimit: 8, userId: 'fixture-user', token: 'fixture-token',
    runRef, imageDownloadOwnerRef: { current: owner }, scopeMountedRef: { current: true }, contextReadyRef: { current: true }, navigationRef: { current: false },
    visualAssetMutationRef: { current: false }, initialReferenceBlockedRef: { current: blocked },
    visualAssetGenerationRef: { current: false }, visualAssetBatchRef: { current: false }, referenceUploadOperationRef: { current: false }, referenceUploadPendingRef: { current: [] },
    imageSubmissionsRef: { current: new Set<string>() }, videoSubmissionsRef: { current: new Set<string>() }, boardExportLocksRef: { current: new Set<string>() }, batchAuthorizationRef: { current: false },
    submittedRunIdsRef: { current: new Set<string>() }, initialReferenceAdoptionRef: { current: false },
    visibleReferenceChoicesRef: { current: { owner, projectId: original.id, ids: { [item.planId]: item.assetId } } },
    window: { localStorage: {} }, readStoryboardAssetAttempts: () => [], adoptFirstStoryboardReference,
    setVisualAssetSaving: (value: boolean) => { events.push(value ? 'binding-lock' : 'binding-unlock'); },
    setNotice: (message: string) => { counts.notice = message; }, setVisualAssetError: (message: string) => { counts.error = message; },
    setRun: () => { counts.commit++; events.push('binding-committed'); }, createStoryboardPersistenceSnapshot: (value: Document) => value,
    resolveVisualAssetUrls: async (plan: StoryboardVisualAssetPlan) => {
      counts.resolve++; events.push('resolve'); assert.equal(context.visualAssetGenerationRef.current, false, 'generation lock must be released');
      assert.equal(counts.candidateSave, 1, 'candidate must be saved first');
      if (options.stage === 'resolve') race();
      return plan.assets.filter(asset => asset.source).map(asset => ({ assetId: asset.source!.assetId, previewUrl: 'https://fixture.invalid/' + asset.source!.storageKey }));
    },
    saveStoryboardProject: async (next: Document) => {
      counts.save++; events.push('binding-save'); assert.equal(counts.commit, 0, 'save precedes commit'); assert.equal(context.visualAssetMutationRef.current, true);
      StoryboardVisualAssetPlanSchema.parse(next.visualAssetPlan);
      if (options.stage === 'save') race();
      return !options.saveFailure;
    },
  };
  const runtime = vm.runInNewContext(executable, context) as {
    withFirstReferenceAdoption: (value: DrawerVisualAssetInput, operation: () => Promise<DrawerVisualAsset | null>) => Promise<DrawerVisualAsset | null>;
    ensureInitialReferencesAdopted: () => Promise<boolean>; generateVisualAsset: (value: DrawerVisualAssetInput) => Promise<DrawerVisualAsset | null>;
  };
  if (options.oldSource) {
    original.visualAssetPlan = { mode: 'selected', assets: [{ id: item.planId, role: 'character', name: '旧角色', identityLock: '保持旧角色的身份外形、颜色与配饰不变。', allowedChanges: [],
      referencePrompts: [{ kind: 'identity', purpose: '原身份参考', prompt: item.prompt! }], source: { kind: 'uploaded-image', assetId: 'old_owned_person', storageKey: 'objects/old_person.png' } }],
      defaultAssetIds: [item.planId], generationPolicy: { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' } };
  }
  if (options.oldMedia) original.cards[0].imageUrl = 'https://fixture.invalid/old-board.png';
  function race() {
    if (options.race === 'owner') context.imageDownloadOwnerRef.current = otherOwner;
    if (options.race === 'project') runRef.current = { ...runRef.current, id: 'other-project' };
    if (options.race === 'card') runRef.current = { ...runRef.current, cards: runRef.current.cards.map(card => ({ ...card, prompt: '后续用户编辑' })) };
    if (options.race === 'draft') runRef.current = { ...runRef.current, visualAssetWorkspace: { ...runRef.current.visualAssetWorkspace!, drafts: runRef.current.visualAssetWorkspace!.drafts.map(draft => ({ ...draft, prompt: '后续参考提示词' })) } };
    if (options.race === 'plan') runRef.current = { ...runRef.current, visualAssetPlan: { ...runRef.current.visualAssetPlan!, defaultAssetIds: [] } };
  }
  const result = options.wrongSlot ? { ...item, planId: 'other_slot' } : item;
  const operation = async () => {
    counts.generation++; events.push('generate-once'); context.visualAssetGenerationRef.current = true;
    runRef.current = { ...runRef.current, visualAssetWorkspace: { ...runRef.current.visualAssetWorkspace!, candidates: [result] } };
    counts.candidateSave++; events.push('candidate-saved');
    context.visualAssetGenerationRef.current = false; events.push('generation-unlocked');
    return result;
  };
  return { context, runtime, counts, events, blocked, runRef, original, result, run: () => runtime.withFirstReferenceAdoption(input, operation) };
}
let passed = 0;
const cases: string[] = [];
function done(name: string) { passed++; cases.push(name); }
async function main() {
  {
    const h = harness(); assert.equal(await h.run(), h.result);
    assert.deepEqual([h.counts.generation, h.counts.candidateSave, h.counts.resolve, h.counts.save, h.counts.commit], [1, 1, 1, 1, 1]);
    assert.ok(h.events.indexOf('candidate-saved') < h.events.indexOf('generation-unlocked')); assert.ok(h.events.indexOf('generation-unlocked') < h.events.indexOf('resolve'));
    assert.ok(h.events.indexOf('binding-save') < h.events.indexOf('binding-committed'));
    assert.equal(h.runRef.current.visualAssetPlan!.assets[0].source!.assetId, item.assetId);
    assert.equal(h.runRef.current.cards[0].referenceImageUrls.length, 1); assert.equal(h.context.visualAssetMutationRef.current, false);
    done('one generation saves candidate, unlocks, resolves owner and commits only after adoption save');
  }
  for (const stage of ['resolve', 'save'] as const) for (const race of ['owner', 'project', 'card', 'draft', 'plan'] as const) {
    const h = harness({ stage, race }); assert.equal(await h.run(), h.result);
    assert.equal(h.counts.generation, 1); assert.equal(h.counts.commit, 0); assert.equal(h.counts.save, stage === 'save' ? 1 : 0);
    assert.equal(h.runRef.current.visualAssetPlan?.assets.some(asset => asset.source?.assetId === item.assetId), false);
    assert.equal(h.context.visualAssetMutationRef.current, false);
    assert.equal(h.blocked.has(owner + '\0project'), stage === 'save');
    assert.equal(h.blocked.has(otherOwner + '\0project'), false); assert.equal(h.blocked.has(owner + '\0other-project'), false);
    if (race === 'card') assert.equal(h.runRef.current.cards[0].prompt, '后续用户编辑');
    if (race === 'draft') assert.equal(h.runRef.current.visualAssetWorkspace!.drafts[0].prompt, '后续参考提示词');
    done(stage + ' race ' + race + ' retains candidate and newer state without commit');
  }
  for (const variant of ['oldSource', 'oldMedia', 'referenceOnly', 'wrongSlot'] as const) {
    const h = harness({ [variant]: true }); assert.equal(await h.run(), h.result);
    assert.deepEqual([h.counts.generation, h.counts.resolve, h.counts.save, h.counts.commit], [1, 0, 0, 0]);
    if (variant === 'oldSource') assert.equal(h.runRef.current.visualAssetPlan!.assets[0].source!.assetId, 'old_owned_person');
    done(variant + ' never auto-adopts or replaces a source');
  }
  {
    const h = harness({ saveFailure: true }); assert.equal(await h.run(), h.result); assert.equal(h.counts.commit, 0);
    assert.deepEqual([h.counts.generation, h.counts.candidateSave, h.counts.save], [1, 1, 1]);
    assert.ok(h.blocked.has(owner + '\0project')); assert.match(h.counts.error, /图片已保存为候选.*刷新/u);
    assert.equal(await h.runtime.generateVisualAsset(input), null); assert.equal(h.counts.generation, 1, 'actual generator blocked guard prevents retry');
    assert.equal(await h.runtime.ensureInitialReferencesAdopted(), false, 'blocked before off-mode early return');
    done('failed adoption save returns original success candidate and blocks retry before off-mode preflight');
  }
  {
    const h = harness({ oldSource: true }); h.blocked.add(owner + '\0project');
    assert.equal(await h.runtime.ensureInitialReferencesAdopted(), false); assert.match(h.counts.notice, /保存结果尚未确认/u);
    assert.deepEqual([h.counts.generation, h.counts.resolve, h.counts.save], [0, 0, 0]); done('blocked gate runs before a selected plan with no missing required references');
  }
  {
    const h = harness({ saveFailure: true, stage: 'save', race: 'owner' }); assert.equal(await h.run(), h.result);
    assert.ok(h.blocked.has(owner + '\0project')); assert.equal(h.blocked.has(otherOwner + '\0project'), false);
    assert.equal(h.counts.error, '', 'old owner completion must not write new owner warning');
    assert.equal(await h.runtime.ensureInitialReferencesAdopted(), true, 'old owner blocked key does not poison new owner');
    done('save completion after owner switch blocks only original owner/project and leaves new owner usable');
  }
  console.log(JSON.stringify({ passed, failed: 0, actualNetworkRequests: 0, databaseWrites: 0, scope: 'AST current WB wrapper/asset conversion/generator guard/ensure with real first-reference adoption and in-memory IO', cases }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
