import assert from "node:assert/strict";
import { refreshStoryboardVisualAssetReferences } from "@/lib/storyboard-visual-asset-submission";
import type { StoryboardVisualAssetPlan } from "@/lib/storyboard-workbench";
async function main() {
const owner = { id: "owner_1", role: "character" as const, name: "女主人", identityLock: "保持同一女主人外貌与服装跨段一致", allowedChanges: [], referencePrompts: [{ kind: "identity" as const, purpose: "保持人物一致", prompt: "使用同一女主人参考，保持脸型服装和鞋子颜色跨段落一致。" }], source: { kind: "generated-image-history" as const, assetId: "generated_record_owner", historyRecordId: "a".repeat(64) } };
const pet = { ...owner, id: "pet_1", role: "pet" as const, name: "柯基", source: { ...owner.source, assetId: "pet-uuid", storageKey: "images/pet.png", historyRecordId: undefined } };
const plan: StoryboardVisualAssetPlan = { mode: "selected", assets: [owner, pet] };
const manual = "https://images.example/manual.png";
const old = "https://images.example/pet.png?signature=old";
const fresh = "https://images.example/pet.png?signature=new";
const card = { referenceImageUrls: [manual, old], visualAssetRefs: [{ assetId: pet.id, role: pet.role, referenceKinds: ["identity" as const], ownedReferenceUrl: old, boundReferenceUrl: old }] };
let resolves = 0;
const changed = await refreshStoryboardVisualAssetReferences({ card, plan, limit: 3, resolve: async required => {
  resolves++; assert.deepEqual(required.assets.map(a => a.id), [owner.id, pet.id]); return [{ assetId: owner.source.assetId, previewUrl: "https://images.example/owner.png" }, { assetId: pet.source.assetId, previewUrl: fresh }];
} });
assert.deepEqual(changed.referenceImageUrls, [manual, "https://images.example/owner.png", fresh]);
assert.deepEqual(card.referenceImageUrls, [manual, old], "existing snapshots must remain immutable");
assert.equal(resolves, 1);
await assert.rejects(refreshStoryboardVisualAssetReferences({ card, plan, limit: 3, resolve: async () => [{ assetId: pet.source.assetId, previewUrl: fresh }] }), /尚未落实或已失效/u, "A partial existing ref cannot silently omit the other project identity");
await assert.rejects(refreshStoryboardVisualAssetReferences({ card, plan, limit: 3, resolve: async () => [] }), /尚未落实或已失效/u);
await assert.rejects(refreshStoryboardVisualAssetReferences({ card: { referenceImageUrls: [], visualAssetRefs: [{ ...card.visualAssetRefs[0], assetId: "missing_role" }] }, plan, limit: 3, resolve: async () => { throw Error("must not resolve unknown identity"); } }), /不一致/u);
await assert.rejects(refreshStoryboardVisualAssetReferences({ card, plan, limit: 1, resolve: async () => [{ assetId: owner.source.assetId, previewUrl: "https://images.example/owner.png" }, { assetId: pet.source.assetId, previewUrl: fresh }] }), /上限/u);
const off = await refreshStoryboardVisualAssetReferences({ card, plan: { ...plan, mode: "off" }, limit: 0, resolve: async () => { throw Error("ordinary mode must not resolve"); } });
assert.equal(off, card);
const defaults = await refreshStoryboardVisualAssetReferences({ card: { referenceImageUrls: [] }, plan, limit: 2, resolve: async required => required.assets.map(asset => ({ assetId: asset.source!.assetId, previewUrl: "https://images.example/" + asset.id + ".png" })) });
assert.equal(defaults.referenceImageUrls.length, 2);
await assert.rejects(refreshStoryboardVisualAssetReferences({ card: { referenceImageUrls: [], visualAssetRefs: [{ ...card.visualAssetRefs[0], assetId: pet.id }] }, plan: { mode: "selected", assets: [] }, limit: 3, resolve: async () => [] }), /不一致/u);
console.log(JSON.stringify({ passed: true, cases: 8, providerCalls: 0, validates: ["full project plan", "resign", "manual protection", "missing blocks", "unknown blocks", "capacity blocks", "ordinary unchanged"] }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
