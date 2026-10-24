import type { StoryboardVisualAssetPlan } from "./storyboard-workbench";
import type { VisualAssetUrl } from "./storyboard-visual-asset-binding";
import { rebindSelectedCard, requestedVisualAssetPlan, type SelectionCard } from "./storyboard-visual-asset-selection";

/** Refresh only a new submission's automatic inputs; callers keep recovery snapshots immutable. */
export async function refreshStoryboardVisualAssetReferences<T extends SelectionCard>(input: {
  card: T; plan?: StoryboardVisualAssetPlan; limit: number;
  resolve: (plan: StoryboardVisualAssetPlan) => Promise<VisualAssetUrl[]>;
}): Promise<T> {
  if (input.plan?.mode !== "selected") return input.card;
  try {
    const requestedPlan = requestedVisualAssetPlan(input.card, input.plan)!;
    const urls = requestedPlan.assets.length ? await input.resolve(requestedPlan) : [];
    return rebindSelectedCard({ card: input.card, previousPlan: input.plan, plan: input.plan, urls, limit: input.limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/VISUAL_ASSET_(?:REFERENCE_NOT_IN_PLAN|DEFAULT_NOT_IN_PLAN|CUSTOM_SELECTION_MISSING|DUPLICATE_ID|INVALID_DEFAULT_IDS|MULTIPLE_DEFAULT_ENVIRONMENTS|PLAN_LIMIT)/u.test(message)) {
      throw new Error("本段参考选择与当前项目不一致，请在视觉资产中重新确认；本次未提交生图");
    }
    if (message.startsWith("VISUAL_ASSET_SOURCE_UNRESOLVED:")) {
      const names = message.split(":")[1].split(",").map(id => input.plan!.assets.find(asset => asset.id === id)?.name || id).join("、");
      throw new Error(`参考尚未落实或已失效：${names}。请在视觉资产中确认图片；本次未提交生图`);
    }
    if (/VISUAL_ASSET_(?:REFERENCE_LIMIT|INVALID_REFERENCE_LIMIT)/u.test(message)) throw new Error(`本段参考图超过当前模型 ${input.limit} 张上限，请减少参考或更换模型；本次未提交生图`);
    if (message === "VISUAL_ASSET_REFERENCE_OWNERSHIP_UNKNOWN") throw new Error("本段旧参考图归属尚未确认，请重新确认参考选择；原引用保留，本次未提交生图");
    throw error;
  }
}
