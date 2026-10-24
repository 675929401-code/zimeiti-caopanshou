import assert from "node:assert/strict";
import { bindVisualAssetPlan, defaultVisualAssetIdsForCard } from "@/lib/storyboard-visual-asset-binding";
import type { StoryboardVisualAssetPlan, StoryboardVisualAssetRef } from "@/lib/storyboard-workbench";

const asset = (id: string, role: "character" | "pet" | "environment", sceneId?: string) => ({
  id, role, name: id, identityLock: `固定${id}身份与关键外观关系`, allowedChanges: ["姿态"],
  referencePrompts: [{ kind: role === "environment" ? "environment-wide" as const : "identity" as const, purpose: "锁定参考", prompt: `保持${id}的固定外观、布局、材质和关键锚点一致。` }],
  ...(sceneId ? { sceneId } : {}),
  ...(role === "environment" ? { cameraCoverage: "wide" as const } : {}),
  source: { kind: "uploaded-image" as const, assetId: `owned-${id}`, storageKey: `images/${id}.png` },
});
const plan: StoryboardVisualAssetPlan = {
  mode: "selected",
  assets: [asset("character_main", "character"), asset("pet_main", "pet"), asset("env_home", "environment", "home_main"), asset("env_clinic", "environment", "clinic_check")],
};
const homeCard = { sceneId: "home_main", sceneZone: "living_room", visualAssetRefsMode: "legacy" as const };
assert.deepEqual(defaultVisualAssetIdsForCard(homeCard, plan), ["character_main", "pet_main", "env_home"]);
assert.deepEqual(defaultVisualAssetIdsForCard({ ...homeCard, visualAssetRefsMode: "explicit", visualAssetRefs: [] }, plan), []);
const card: { id: string; referenceImageUrls: string[]; visualAssetRefs: StoryboardVisualAssetRef[]; sceneId: string; sceneZone: string; visualAssetRefsMode: "legacy" } = { id: "card-home", referenceImageUrls: [], visualAssetRefs: [], ...homeCard };
const urls = ["character_main", "pet_main", "env_home"].map((id) => ({ assetId: `owned-${id}`, previewUrl: `https://fixture.invalid/${id}.png` }));
const bound = bindVisualAssetPlan(card, plan, urls, 4, defaultVisualAssetIdsForCard(homeCard, plan));
assert.equal(bound.missing.length, 0);
assert.deepEqual(bound.card.visualAssetRefs.map((ref) => ref.assetId), ["character_main", "pet_main", "env_home"]);
assert.equal(bound.card.visualAssetRefs.some((ref) => ref.assetId === "env_clinic"), false);
console.log(JSON.stringify({ passed: true, checks: ["scene scoped defaults", "explicit empty refs", "unrelated environment excluded"], providerCalls: 0 }));
