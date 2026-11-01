import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { StoryboardVisualAssetPlan, StoryboardVisualAssetRef } from "../src/lib/storyboard-workbench";
import { bindVisualAssetPlan, cardCoversVisualAssetPlan, removeVisualAssetBindings, rollbackVisualAssetMode, unresolvedVisualAssetBindingIds, visualAssetUrlMatchesSource } from "../src/lib/storyboard-visual-asset-binding";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { requestedVisualAssetIds } from "../src/lib/storyboard-visual-asset-selection";

const asset = { id: "asset_person", role: "character" as const, name: "人物甲", identityLock: "固定人物脸型与服装色彩不可改变", allowedChanges: [],
  referencePrompts: [{ kind: "identity" as const, purpose: "锁定人物外貌", prompt: "固定人物脸型、发型、服装、材质与识别特征，作为一致性参考。" }],
  source: { kind: "generated-image-history" as const, assetId: "owned-asset-123", storageKey: "users/u/images/person.png" } };
const plan: StoryboardVisualAssetPlan = { mode: "selected", assets: [asset],
  generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: "per-scene-when-required" } };
const signedUrl = "https://media.example/users/u/images/person.png?signature=old";
const manualUrl = "https://media.example/users/u/images/manual.png";
const candidate = { assetId: asset.source.assetId, previewUrl: signedUrl };
const manual: { id: string; referenceImageUrls: string[]; visualAssetRefs: StoryboardVisualAssetRef[] } = { id: "card-1", referenceImageUrls: [manualUrl], visualAssetRefs: [] };

assert.equal(visualAssetUrlMatchesSource(signedUrl, asset.source), true);
assert.equal(visualAssetUrlMatchesSource("https://media.example/unrelated/person.png", asset.source), false);
const bound = bindVisualAssetPlan(manual, plan, [candidate], 3);
assert.equal(bound.bound, 1);
assert.equal(cardCoversVisualAssetPlan(bound.card, plan), true);
assert.deepEqual(removeVisualAssetBindings(bound.card, plan).referenceImageUrls, [manualUrl]);
const legacy = { ...bound.card, visualAssetRefs: [{ assetId: asset.id, role: asset.role, referenceKinds: ["identity" as const] }] };
assert.deepEqual(removeVisualAssetBindings(legacy, plan).referenceImageUrls, [manualUrl], "old signed URLs clean without candidates");
const opaque = bindVisualAssetPlan(manual, { ...plan, assets: [{ ...asset, source: { ...asset.source, storageKey: undefined } }] }, [{ ...candidate, previewUrl: "https://media.example/opaque" }], 3);
assert.deepEqual(removeVisualAssetBindings(opaque.card, plan).referenceImageUrls, [manualUrl], "new ownership works even without storageKey");
const shared = bindVisualAssetPlan({ ...manual, referenceImageUrls: [signedUrl] }, plan, [candidate], 1);
assert.equal(shared.card.referenceImageUrls.length, 1, "binding a manual URL does not duplicate it");
assert.equal(cardCoversVisualAssetPlan(shared.card, plan), true);
assert.deepEqual(removeVisualAssetBindings(shared.card, plan).referenceImageUrls, [signedUrl], "pre-existing manual image is preserved");
const freshUrl = "https://media.example/users/u/images/person.png?signature=fresh";
const refreshed = bindVisualAssetPlan(bound.card, plan, [{ ...candidate, previewUrl: freshUrl }], 2);
assert.equal(refreshed.bound, 1);
assert.deepEqual(refreshed.card.referenceImageUrls, [manualUrl, freshUrl], "fresh signature replaces the old owned URL even at full capacity");
assert.equal(refreshed.card.visualAssetRefs[0].ownedReferenceUrl, freshUrl);
assert.equal(refreshed.card.visualAssetRefs[0].boundReferenceUrl, freshUrl);
assert.deepEqual(removeVisualAssetBindings(refreshed.card, plan).referenceImageUrls, [manualUrl]);
const opaquePlan = { ...plan, assets: [{ ...asset, source: { ...asset.source, storageKey: undefined } }] };
const opaqueUrl = "https://media.example/opaque-image";
const opaqueManual = bindVisualAssetPlan({ ...manual, referenceImageUrls: [opaqueUrl] }, opaquePlan, [{ ...candidate, previewUrl: opaqueUrl }], 1);
assert.equal(cardCoversVisualAssetPlan(opaqueManual.card, opaquePlan), true, "opaque manual binding has identity without deletion ownership");
assert.equal(opaqueManual.card.visualAssetRefs[0].ownedReferenceUrl, "");
assert.deepEqual(removeVisualAssetBindings(opaqueManual.card, opaquePlan).referenceImageUrls, [opaqueUrl]);
const persistedOpaqueManual = createStoryboardPersistenceSnapshot({ id: "opaque-run-123", visualAssetPlan: opaquePlan, cards: [opaqueManual.card] });
assert.equal(cardCoversVisualAssetPlan(persistedOpaqueManual.cards[0], opaquePlan), true, "opaque manual identity survives persistence");
assert.deepEqual(removeVisualAssetBindings(persistedOpaqueManual.cards[0], opaquePlan).referenceImageUrls, [opaqueUrl]);
const ambiguousLegacy = { ...legacy, referenceImageUrls: [manualUrl, opaqueUrl] };
assert.deepEqual(unresolvedVisualAssetBindingIds(ambiguousLegacy, opaquePlan), [asset.id]);
assert.throws(() => removeVisualAssetBindings(ambiguousLegacy, opaquePlan), /OWNERSHIP_UNKNOWN/u);
const limited = bindVisualAssetPlan(manual, plan, [candidate], 1);
assert.deepEqual(limited.overLimit, [asset.id]);
assert.equal(cardCoversVisualAssetPlan(limited.card, plan), false);
assert.deepEqual(bindVisualAssetPlan(manual, plan, [], 3).missing, [asset.id]);
assert.deepEqual(bindVisualAssetPlan(manual, { mode: "off", assets: plan.assets }, [candidate], 3).card.referenceImageUrls, [manualUrl], "ordinary mode keeps manual images and adds no automatic references");
const twoAssets = { ...plan, assets: [asset, { ...asset, id: "asset_prop", role: "prop" as const, source: { ...asset.source, assetId: "second-asset-123" } }] };
assert.equal(cardCoversVisualAssetPlan(bound.card, twoAssets), false, "one of two assets is not complete coverage");
const snapshot = createStoryboardPersistenceSnapshot({ id: "run-12345", visualAssetPlan: plan, cards: [bound.card] });
assert.equal(snapshot.cards[0].visualAssetRefs[0].ownedReferenceUrl, signedUrl, "ownership survives persistence projection");
assert.equal(snapshot.cards[0].visualAssetRefs[0].boundReferenceUrl, signedUrl, "binding identity survives persistence projection");
assert.deepEqual(removeVisualAssetBindings(snapshot.cards[0], plan).referenceImageUrls, [manualUrl]);

const sourcePath = "src/components/storyboard-workbench.tsx";
const source = readFileSync(sourcePath, "utf8");
const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, context: Record<string, unknown>) {
  let code = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isCallExpression(node.initializer)) code = node.initializer.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(code, `${name} callback exists`);
  const compiled = ts.transpileModule(`const callback = ${code}; callback;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(compiled, { userId: "fixture-owner", token: "fixture-token", imageDownloadOwnerRef: { current: "fixture-owner\0fixture-token" }, scopeMountedRef: { current: true }, visualAssetGenerationRef: { current: false }, referenceUploadOperationRef: { current: null }, videoSubmissionsRef: { current: new Set<string>() }, boardExportLocksRef: { current: new Set<string>() }, contextReadyRef: { current: true }, navigationRef: { current: false }, imageSubmissionsRef: { current: new Set<string>() }, ...context, URL, Date });
}

async function main() {
  const readCalls: string[] = [];
  const resolver = callback("resolveVisualAssetUrls", { visualAssetCandidates: [],
    readOwnedStoryboardImage: async (reference: { assetId: string }) => { readCalls.push(reference.assetId); return { assetId: reference.assetId, storageKey: asset.source.storageKey, url: signedUrl }; } });
  const hydrated = await resolver(plan);
  assert.deepEqual(readCalls, [asset.source.assetId], "a confirmed source is read even when candidate list is empty");
  assert.equal(bindVisualAssetPlan(manual, plan, hydrated, 3).bound, 1);
  const cachedReadCalls: string[] = [];
  const cachedResolver = callback("resolveVisualAssetUrls", { visualAssetCandidates: [candidate],
    readOwnedStoryboardImage: async (reference: { assetId: string }) => { cachedReadCalls.push(reference.assetId); return { assetId: reference.assetId, storageKey: asset.source.storageKey, url: freshUrl }; } });
  const cachedHydrated = await cachedResolver(plan);
  assert.deepEqual(cachedReadCalls, [asset.source.assetId], "cached candidates do not suppress source refresh");
  assert.equal(cachedHydrated[0].previewUrl, freshUrl);
  const missingResolver = callback("resolveVisualAssetUrls", { visualAssetCandidates: [], readOwnedStoryboardImage: async () => { throw new Error("not owned or unavailable"); } });
  assert.equal((await missingResolver(plan)).length, 0);

  const before = { id: "run-12345", visualAssetPlan: plan, cards: [{ ...bound.card, narration: "original" }] };
  const runRef = { current: before };
  const notices: string[] = [];
  let finishSave: (value: boolean) => void = () => {};
  const save = new Promise<boolean>((resolve) => { finishSave = resolve; });
  const mutation = { current: false };
  const select = callback("selectVisualAssetMode", { runRef, visualAssetMutationRef: mutation, setRun: () => {}, setVisualAssetSaving: () => {},
    removeVisualAssetBindings, rollbackVisualAssetMode, unresolvedVisualAssetBindingIds, createStoryboardPersistenceSnapshot,
    saveStoryboardProject: () => save, setVisualAssetPickerOpen: () => {}, setVisualAssetStudioOpen: () => {}, setNotice: (notice: string) => notices.push(notice) });
  const saving = select("off");
  assert.equal(mutation.current, true, "parallel asset mutations are blocked while saving");
  assert.equal(notices.length, 0, "success is not reported before persistence confirmation");
  runRef.current = { ...runRef.current, cards: runRef.current.cards.map((card) => ({ ...card, narration: "edited during save" })) };
  finishSave(false);
  await saving;
  assert.equal(runRef.current.visualAssetPlan, plan, "failed save restores original mode");
  assert.deepEqual(runRef.current.cards[0].referenceImageUrls, [manualUrl, signedUrl]);
  assert.equal(runRef.current.cards[0].narration, "edited during save", "rollback preserves unrelated newer edits");
  assert.ok(notices[0].includes("未保存确认"));
  assert.equal(mutation.current, false);
  const throwSelect = callback("selectVisualAssetMode", { runRef, visualAssetMutationRef: mutation, setRun: () => {}, setVisualAssetSaving: () => {},
    removeVisualAssetBindings, rollbackVisualAssetMode, unresolvedVisualAssetBindingIds, createStoryboardPersistenceSnapshot,
    saveStoryboardProject: async () => { throw new Error("save rejected"); }, setVisualAssetPickerOpen: () => {}, setVisualAssetStudioOpen: () => {}, setNotice: (notice: string) => notices.push(notice) });
  await throwSelect("off");
  assert.equal(runRef.current.visualAssetPlan, plan, "a rejected save also rolls back");
  assert.deepEqual(runRef.current.cards[0].referenceImageUrls, [manualUrl, signedUrl]);
  const ambiguousBefore = { ...before, visualAssetPlan: opaquePlan, cards: [{ ...ambiguousLegacy, order: 1 }] };
  const ambiguousRef = { current: ambiguousBefore };
  let ambiguousSaveCalls = 0;
  const ambiguousNotices: string[] = [];
  const ambiguousOff = callback("selectVisualAssetMode", { runRef: ambiguousRef, visualAssetMutationRef: { current: false },
    unresolvedVisualAssetBindingIds, setNotice: (notice: string) => ambiguousNotices.push(notice),
    saveStoryboardProject: async () => { ambiguousSaveCalls++; return true; } });
  await ambiguousOff("off");
  assert.equal(ambiguousRef.current, ambiguousBefore, "opaque legacy off is fail-closed with all state preserved");
  assert.equal(ambiguousSaveCalls, 0);
  assert.ok(ambiguousNotices[0].includes("无法安全区分"));

  const pendingPlan: StoryboardVisualAssetPlan = { mode: "selected", assets: [{ ...asset, id: "asset_new_pending", name: "新人物待确认", source: undefined }] };
  const importRef = { current: before };
  const importResolvedPlans: Array<StoryboardVisualAssetPlan | undefined> = [];
  const importNotices: string[] = [];
  const importer = callback("applyImportedSegments", { runRef: importRef, visualAssetMutationRef: { current: false }, MAX_CARDS: 100,
    imageAttemptNeedsResolution: () => false, isActiveVideoStatus: () => false, setVisualAssetSaving: () => {},
    resolveVisualAssetUrls: async (inputPlan?: StoryboardVisualAssetPlan) => { importResolvedPlans.push(inputPlan); return inputPlan === plan ? [candidate] : []; },
    bindVisualAssetPlan, requestedVisualAssetIds, referenceLimit: 2, archiveRunSnapshot: () => {}, createId: () => "new-import-run", isWorkbenchRatio: () => true,
    createCard: (order: number) => ({ ...manual, id: `new-card-${order}`, order, referenceImageUrls: [], visualAssetRefs: [] }),
    visualAssetReferenceKind: () => "identity", visualAssetBindingNotice: () => "missing new asset",
    setRun: () => {}, setExpandedVideoCards: () => {}, setNotice: (notice: string) => importNotices.push(notice) });
  const importInput = { segments: [{ imagePrompt: "new image prompt", videoPrompt: "new video prompt" }], title: "new project", successNotice: "imported" };
  await importer({ ...importInput, visualAssetPlan: pendingPlan });
  assert.equal(importRef.current.visualAssetPlan, pendingPlan, "an unresolved new plan is retained");
  assert.deepEqual(Array.from(importRef.current.cards[0].referenceImageUrls), [], "an unresolved new plan never receives old project images");
  assert.equal(importRef.current.cards[0].visualAssetRefs[0].assetId, "asset_new_pending", "new pending semantic refs are preserved");
  assert.equal(importResolvedPlans.includes(plan), false, "old plan is never resolved for a different pending plan");
  assert.ok(importNotices[0].includes("尚未"));
  importRef.current = before;
  await importer(importInput);
  assert.equal(importRef.current.visualAssetPlan, plan, "only absence of a new plan inherits the confirmed current plan");
  assert.deepEqual(Array.from(importRef.current.cards[0].referenceImageUrls), [signedUrl]);
  importRef.current = before;
  await importer({ ...importInput, visualAssetPlan: { mode: "off", assets: [] } });
  assert.equal(importRef.current.visualAssetPlan.mode, "off", "an explicit new off plan does not inherit an old selected plan");
  assert.equal(importRef.current.cards[0].referenceImageUrls.length, 0);
  console.log("PASS storyboard visual asset binding: ownership, legacy cleanup, manual preservation, full coverage, limits, persistence, source refresh, failed-save rollback, pending-plan isolation, fresh-signed-URL replacement, opaque-legacy off blocking, opaque-manual coverage");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
