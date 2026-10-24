import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { activeStoryboardVisualAssetRefs, bindVisualAssetPlan, removeVisualAssetBindings, rollbackVisualAssetMode, suspendVisualAssetBindings } from "../src/lib/storyboard-visual-asset-binding";
import { requestedVisualAssetIds } from "../src/lib/storyboard-visual-asset-selection";
import { refreshStoryboardVisualAssetReferences } from "../src/lib/storyboard-visual-asset-submission";
import { removeStoryboardReference } from "../src/lib/storyboard-reference-removal";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import type { StoryboardVisualAssetPlan, StoryboardVisualAssetRef } from "../src/lib/storyboard-workbench";

const files = ["src/lib/storyboard-visual-asset-binding.ts", "src/lib/storyboard-reference-removal.ts"];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const before = hashes();
let networkRequests = 0;
globalThis.fetch = (async () => { networkRequests++; throw new Error("NETWORK_FORBIDDEN"); }) as typeof fetch;
const checks: string[] = [];
const check = (name: string, action: () => void | Promise<void>) => Promise.resolve().then(action).then(() => { checks.push(name); });
const asset = { id: "character-a", role: "character" as const, name: "人物甲", identityLock: "固定人物脸型与服装色彩不可改变", allowedChanges: [],
  referencePrompts: [{ kind: "identity" as const, purpose: "锁定人物外貌", prompt: "固定人物脸型、发型、服装、材质与识别特征，作为一致性参考。" }],
  source: { kind: "uploaded-image" as const, assetId: "owned-character-a", storageKey: "fixture/a.png" } };
const second = { ...asset, id: "character-b", name: "人物乙", source: { ...asset.source, assetId: "owned-character-b", storageKey: "fixture/b.png" } };
const plan: StoryboardVisualAssetPlan = { mode: "selected", assets: [asset, second], defaultAssetIds: [asset.id],
  generationPolicy: { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: "none" } };
const manual = "https://fixture.invalid/manual.png";
const oldUrl = "https://fixture.invalid/fixture/a.png?signature=old";
const freshUrl = "https://fixture.invalid/fixture/a.png?signature=fresh";
const secondUrl = "https://fixture.invalid/fixture/b.png?signature=fresh";
type Card = { id: string; referenceImageUrls: string[]; visualAssetRefs?: StoryboardVisualAssetRef[];
  visualAssetSelectionMode?: "project" | "custom"; visualAssetRefsMode?: "legacy" | "explicit";
  imagePrompt?: string; imageUrl?: string; videoUrl?: string; videoTaskId?: string };
const seed: Card = { id: "card-a", referenceImageUrls: [manual], visualAssetSelectionMode: "custom", visualAssetRefsMode: "explicit", visualAssetRefs: [] };
const bound = bindVisualAssetPlan(seed, plan, [{ assetId: asset.source.assetId, previewUrl: oldUrl }], 4, [asset.id]).card;
const offPlan: StoryboardVisualAssetPlan = { ...plan, mode: "off" };

async function main() {
  await check("custom choices survive off/on; off has no automatic URL, preset, or identity claim", async () => {
    const original = JSON.stringify(bound);
    const off = suspendVisualAssetBindings(bound, plan);
    assert.deepEqual(suspendVisualAssetBindings(off, offPlan), off, "Repeated off is idempotent");
    assert.deepEqual(off.referenceImageUrls, [manual]); assert.deepEqual(off.visualAssetRefs?.map(ref => ref.assetId), [asset.id]);
    assert.equal(off.visualAssetRefs?.[0].ownedReferenceUrl, ""); assert.equal(off.visualAssetRefs?.[0].boundReferenceUrl, "");
    assert.deepEqual(requestedVisualAssetIds(off, offPlan), []); assert.deepEqual(activeStoryboardVisualAssetRefs(off, offPlan), []);
    let resolves = 0;
    const ordinary = await refreshStoryboardVisualAssetReferences({ card: off, plan: offPlan, limit: 4,
      resolve: async () => { resolves++; throw new Error("Off mode must not resolve roles"); } });
    assert.equal(ordinary, off); assert.equal(resolves, 0);
    const persisted = createStoryboardPersistenceSnapshot({ id: "mode-project", visualAssetPlan: offPlan, cards: [off] });
    assert.deepEqual(persisted.cards[0].visualAssetRefs?.map(ref => ref.assetId), [asset.id]);
    const refreshed = await refreshStoryboardVisualAssetReferences({ card: persisted.cards[0], plan, limit: 4,
      resolve: async requested => { resolves++; assert.deepEqual(requested.assets.map(item => item.id), [asset.id]); return [{ assetId: asset.source.assetId, previewUrl: freshUrl }]; } });
    assert.deepEqual(refreshed.referenceImageUrls, [manual, freshUrl]); assert.ok(!refreshed.referenceImageUrls.includes(oldUrl));
    assert.deepEqual(activeStoryboardVisualAssetRefs(refreshed, plan).map(ref => ref.assetId), [asset.id]);
    assert.equal(refreshed.visualAssetSelectionMode, "custom"); assert.equal(resolves, 1); assert.equal(JSON.stringify(bound), original);
  });
  await check("explicit empty custom selection stays empty after round-trip", async () => {
    const empty = suspendVisualAssetBindings(seed, plan);
    assert.deepEqual(requestedVisualAssetIds(empty, plan), []);
    const result = await refreshStoryboardVisualAssetReferences({ card: empty, plan, limit: 4, resolve: async () => { throw new Error("Explicit empty must not resolve project defaults"); } });
    assert.deepEqual(result.referenceImageUrls, [manual]); assert.deepEqual(result.visualAssetRefs, []); assert.equal(result.visualAssetSelectionMode, "custom");
  });
  await check("project-following and legacy explicit choices keep distinct semantics", () => {
    const project = suspendVisualAssetBindings({ ...bound, visualAssetSelectionMode: "project" as const }, plan);
    const changedDefaults = { ...plan, defaultAssetIds: [second.id] };
    assert.deepEqual(requestedVisualAssetIds(project, changedDefaults), [second.id]);
    assert.deepEqual(requestedVisualAssetIds(suspendVisualAssetBindings(bound, plan), changedDefaults), [asset.id]);
    const legacy = suspendVisualAssetBindings({ ...bound, visualAssetSelectionMode: undefined, visualAssetRefsMode: "explicit" as const }, plan);
    assert.deepEqual(requestedVisualAssetIds(legacy, changedDefaults), [asset.id]);
    assert.equal(legacy.visualAssetSelectionMode, undefined);
    const legacyEmpty = suspendVisualAssetBindings({ ...seed, visualAssetSelectionMode: undefined }, plan);
    assert.deepEqual(requestedVisualAssetIds(legacyEmpty, changedDefaults), []);
    assert.throws(() => requestedVisualAssetIds(suspendVisualAssetBindings({ ...seed, visualAssetRefs: undefined }, plan), plan), /CUSTOM_SELECTION_MISSING/u);
  });
  await check("explicit unowned manual images remain manual even when their URL equals a role image", () => {
    const shared = bindVisualAssetPlan({ ...seed, referenceImageUrls: [oldUrl] }, plan, [{ assetId: asset.source.assetId, previewUrl: oldUrl }], 1, [asset.id]).card;
    assert.equal(shared.visualAssetRefs?.[0].ownedReferenceUrl, "");
    const off = suspendVisualAssetBindings(shared, plan);
    assert.deepEqual(off.referenceImageUrls, [oldUrl]); assert.deepEqual(activeStoryboardVisualAssetRefs(off, offPlan), []);
  });
  await check("expired or unrelated sources fail closed without reusing the old URL", async () => {
    const off = suspendVisualAssetBindings(bound, plan); const original = JSON.stringify(off);
    await assert.rejects(refreshStoryboardVisualAssetReferences({ card: off, plan, limit: 4, resolve: async () => [] }), /尚未落实或已失效/u);
    await assert.rejects(refreshStoryboardVisualAssetReferences({ card: off, plan, limit: 4, resolve: async () => [{ assetId: "foreign-project-source", previewUrl: oldUrl }] }), /尚未落实或已失效/u);
    const anotherPlan = { ...plan, assets: [{ ...second, id: "other-project-slot" }], defaultAssetIds: ["other-project-slot"] };
    await assert.rejects(refreshStoryboardVisualAssetReferences({ card: off, plan: anotherPlan, limit: 4, resolve: async () => [] }), /当前项目不一致/u);
    assert.equal(JSON.stringify(off), original);
  });
  await check("remove one role while off preserves the other dormant custom choice and paid media", async () => {
    const both = bindVisualAssetPlan({ ...seed, imageUrl: "old-board", videoUrl: "old-video", videoTaskId: "old-task" }, plan,
      [{ assetId: asset.source.assetId, previewUrl: oldUrl }, { assetId: second.source.assetId, previewUrl: secondUrl }], 4, [asset.id, second.id]).card;
    const run = { id: "project-remove", visualAssetPlan: offPlan, cards: [suspendVisualAssetBindings(both, plan)] };
    const removed = removeStoryboardReference(run, asset.id, false);
    assert.equal(removed.visualAssetPlan?.mode, "off"); assert.deepEqual(removed.cards[0].visualAssetRefs?.map(ref => ref.assetId), [second.id]);
    assert.deepEqual(removed.cards[0].referenceImageUrls, [manual]); assert.equal(removed.cards[0].videoTaskId, "old-task");
    assert.equal(removed.cards[0].imageUrl, "old-board"); assert.equal(removed.cards[0].videoUrl, "old-video");
    const selected: StoryboardVisualAssetPlan = { ...removed.visualAssetPlan!, mode: "selected" };
    const refreshed = await refreshStoryboardVisualAssetReferences({ card: removed.cards[0], plan: selected, limit: 4,
      resolve: async () => [{ assetId: second.source.assetId, previewUrl: secondUrl }] });
    assert.deepEqual(refreshed.referenceImageUrls, [manual, secondUrl]);
    const allRemoved = removeStoryboardReference(removed, second.id, false);
    assert.deepEqual(allRemoved.cards[0].visualAssetRefs, []); assert.equal(allRemoved.cards[0].visualAssetSelectionMode, "custom");
  });
  await check("explicit removal still clears semantic IDs and selected-mode removal keeps remaining bindings", () => {
    assert.deepEqual(removeVisualAssetBindings(bound, plan).visualAssetRefs, []);
    const both = bindVisualAssetPlan(seed, plan, [{ assetId: asset.source.assetId, previewUrl: oldUrl }, { assetId: second.source.assetId, previewUrl: secondUrl }], 4).card;
    const removed = removeStoryboardReference({ id: "selected-remove", visualAssetPlan: plan, cards: [both] }, asset.id, false);
    assert.deepEqual(removed.cards[0].visualAssetRefs?.map(ref => ref.assetId), [second.id]);
    assert.deepEqual(removed.cards[0].referenceImageUrls, [manual, secondUrl]);
  });
  await check("failed mode persistence restores bindings and preserves concurrent edits", () => {
    const beforeRun = { id: "rollback-project", visualAssetPlan: plan, cards: [{ ...bound, imagePrompt: "before" }] };
    const attempted = { ...beforeRun, visualAssetPlan: offPlan, cards: [suspendVisualAssetBindings(beforeRun.cards[0], plan)] };
    const edited = { ...attempted, cards: [{ ...attempted.cards[0], imagePrompt: "edited while saving" }] };
    const restored = rollbackVisualAssetMode(edited, beforeRun, attempted);
    assert.equal(restored.visualAssetPlan, plan); assert.deepEqual(restored.cards[0].visualAssetRefs, bound.visualAssetRefs);
    assert.deepEqual(restored.cards[0].referenceImageUrls, [manual, oldUrl]); assert.equal(restored.cards[0].imagePrompt, "edited while saving");
  });
  await check("unknown legacy ownership blocks off instead of stripping or sending ambiguous images", () => {
    const opaquePlan = { ...plan, assets: [{ ...asset, source: { ...asset.source, storageKey: undefined } }] };
    const ambiguous = { ...bound, referenceImageUrls: [manual, "https://fixture.invalid/opaque"], visualAssetRefs: [{ assetId: asset.id, role: asset.role, referenceKinds: ["identity" as const] }] };
    const original = JSON.stringify(ambiguous);
    assert.throws(() => suspendVisualAssetBindings(ambiguous, opaquePlan), /OWNERSHIP_UNKNOWN/u);
    assert.equal(JSON.stringify(ambiguous), original);
  });
  await check("dormant platform preset selection cannot emit a preset-reference claim", () => {
    const presetPlan: StoryboardVisualAssetPlan = { ...plan, assets: [{ ...asset, source: { kind: "platform-preset", assetId: "preset-asset", presetId: "preset-character", presetRevision: 1 } }] };
    const preset = bindVisualAssetPlan(seed, presetPlan, [{ assetId: "preset-asset", previewUrl: oldUrl }], 4).card;
    const off = suspendVisualAssetBindings(preset, presetPlan);
    assert.deepEqual(activeStoryboardVisualAssetRefs(off, { ...presetPlan, mode: "off" }), []);
    assert.deepEqual(off.referenceImageUrls, [manual]); assert.deepEqual(off.visualAssetRefs?.map(ref => ref.assetId), [asset.id]);
  });
  const after = hashes(); assert.deepEqual(after, before, "Reference source changed while testing"); assert.equal(networkRequests, 0);
  console.log(JSON.stringify({ passed: true, checks, sourceHashes: { before, after }, networkRequests, databaseWrites: 0, providerSubmissions: 0 }, null, 2));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
