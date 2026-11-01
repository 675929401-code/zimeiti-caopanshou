import assert from "node:assert/strict";
import { assertVisualAssetContract } from "../src/lib/storyboard-compile-contract";

const baseAsset = {
  id: "character_main",
  role: "character" as const,
  name: "主人",
  identityLock: "固定人物身份、外观、比例和识别特征",
  allowedChanges: ["姿态"],
  referencePrompts: [{ kind: "identity" as const, purpose: "保持身份一致", prompt: "保持同一人物身份和外观特征，允许姿态变化。" }],
};
const baseProject = {
  visualAssetPlan: { mode: "selected" as const, assets: [baseAsset] },
  segments: [{ visualAssetRefs: [] }],
};
const selectedInput = { visualAssetMode: "selected" as const, selectedVisualAssets: [{ id: baseAsset.id, role: baseAsset.role }] };

assert.throws(() => assertVisualAssetContract(baseProject, selectedInput), /生成策略/u);

const noTurnaround = {
  ...baseProject,
  visualAssetPlan: {
    ...baseProject.visualAssetPlan,
    generationPolicy: { maxInitialImages: 1, initialRequiredAssetIds: [baseAsset.id], initialDeferredAssetIds: [], environmentAnchorPolicy: "none" as const },
  },
};
assert.throws(() => assertVisualAssetContract(noTurnaround, selectedInput), /三视图/u);

const turnaround = {
  ...noTurnaround,
  visualAssetPlan: {
    ...noTurnaround.visualAssetPlan,
    assets: [{ ...baseAsset, referencePrompts: [{ ...baseAsset.referencePrompts[0], kind: "turnaround" as const, purpose: "三视图身份参考" }] }],
  },
};
assert.doesNotThrow(() => assertVisualAssetContract(turnaround, selectedInput));

const propOnly = {
  ...turnaround,
  visualAssetPlan: {
    ...turnaround.visualAssetPlan,
    assets: [{ ...turnaround.visualAssetPlan.assets[0], role: "prop" as const }],
  },
};
assert.throws(() => assertVisualAssetContract(propOnly, selectedInput), /人物或宠物/u);

const missingRequired = {
  ...turnaround,
  visualAssetPlan: { ...turnaround.visualAssetPlan, generationPolicy: { ...turnaround.visualAssetPlan.generationPolicy, initialRequiredAssetIds: [] } },
};
assert.throws(() => assertVisualAssetContract(missingRequired, selectedInput), /首轮三视图/u);

const ordinary = { visualAssetPlan: { mode: "off" as const, assets: [] }, segments: [{ visualAssetRefs: [] }] };
assert.doesNotThrow(() => assertVisualAssetContract(ordinary, { visualAssetMode: "off", selectedVisualAssets: [] }));

console.log(JSON.stringify({ passed: true, checks: 6, networkCalls: 0, providerCalls: 0, databaseWrites: 0 }));
