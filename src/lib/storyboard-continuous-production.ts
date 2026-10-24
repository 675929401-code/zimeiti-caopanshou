import type { StoryboardDirectorIntakeState } from "./storyboard-director-resume";
import type { StoryboardVisualAssetPlan } from "./storyboard-workbench";
import type { StoryboardVisualAssetWorkspace } from "./storyboard-visual-asset-workspace";

export type ProductionCard = {
  id: string; imagePrompt: string; videoPrompt: string; narration?: string;
  imageTextLayoutEnabled?: boolean; imageExactText?: string;
  visualAssetRefs?: Array<{ assetId: string; role: string; referenceKinds: string[]; boundReferenceUrl?: string; ownedReferenceUrl?: string }>;
  visualAssetSelectionMode?: "project" | "custom"; referenceImageUrls: string[];
  imageStatus: string; videoStatus: string; imageReferenceState?: "stale";
  imageRetryBlocked?: boolean; imageRecoveryReady?: boolean;
  imageClientRequestId?: string; videoClientRequestId?: string; videoTaskId?: string;
  imageRecordId?: string; imageAssetId?: string; imageStorageKey?: string;
  imageUrl?: string; videoUrl?: string;
  continuousImageInputFingerprint?: string; continuousVideoInputFingerprint?: string;
  directorExecution?: unknown;
};
export type ProductionRun = {
  id: string; ratio: string; imageRatio?: string; imageResolution: string;
  videoResolution: string; videoDuration: number; imageModelId: string; videoModelId: string;
  videoContract?: unknown; directorIntake?: StoryboardDirectorIntakeState;
  visualAssetPlan?: StoryboardVisualAssetPlan; visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
  cards: ProductionCard[];
};

/** A deterministic change detector, not a signature or an authorization credential. */
export function storyboardProductionFingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  const state = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < text.length; i++) for (let n = 0; n < state.length; n++) {
    state[n] = Math.imul(state[n] ^ (text.charCodeAt(i) + n), 16777619 + n * 2) >>> 0;
  }
  return state.map(item => item.toString(16).padStart(8, "0")).join("");
}

/** Generated candidates and explicit adoption are expected progress, not edits to the plan. */
export function storyboardProductionPlanFingerprint(run: ProductionRun): string {
  return storyboardProductionFingerprint([
    run.id, run.ratio, run.imageRatio, run.imageResolution, run.videoResolution, run.videoDuration,
    run.imageModelId, run.videoModelId, run.videoContract, run.directorIntake?.input,
    run.visualAssetWorkspace?.generationSettings, run.visualAssetWorkspace?.drafts,
    run.visualAssetPlan?.mode, run.visualAssetPlan?.defaultAssetIds ?? run.visualAssetPlan?.assets.filter(asset => asset.role === "character" || asset.role === "pet").map(asset => asset.id),
    run.visualAssetPlan?.assets.map(({ source: _source, ...asset }) => asset),
    run.cards.map(card => [card.id, card.imagePrompt, card.videoPrompt, card.narration,
      card.imageTextLayoutEnabled, card.imageExactText, card.visualAssetSelectionMode,
      card.visualAssetRefs?.map(ref => [ref.assetId, ref.role]),
      card.referenceImageUrls.filter(url => !card.visualAssetRefs?.some(ref => ref.boundReferenceUrl === url || ref.ownedReferenceUrl === url)).map(stableReference)]),
  ]);
}

export function storyboardProductionAssetFingerprint(run: ProductionRun): string {
  return storyboardProductionFingerprint([
    run.visualAssetPlan?.mode,
    run.visualAssetPlan?.assets.map(asset => [asset.id, asset.source]),
    run.directorIntake?.confirmedAssets,
  ]);
}

function stableReference(url: string): string {
  try {
    const parsed = new URL(url, "https://storyboard.invalid");
    const assetId = parsed.searchParams.get("assetId");
    const recordId = parsed.searchParams.get("recordId");
    return assetId || recordId ? `${parsed.pathname}?${assetId ? "assetId=" + assetId : "recordId=" + recordId}` : url;
  } catch { return url; }
}

export function storyboardProductionImageFingerprint(run: ProductionRun, card: ProductionCard): string {
  return storyboardProductionFingerprint([run.imageModelId, run.imageResolution, run.imageRatio || run.ratio,
    card.imagePrompt, card.imageTextLayoutEnabled, card.imageExactText, card.narration,
    card.visualAssetSelectionMode, card.visualAssetRefs?.map(ref => [ref.assetId, ref.role, ref.referenceKinds]),
    run.visualAssetPlan?.assets.map(asset => [asset.id, asset.source]), card.referenceImageUrls.map(stableReference)]);
}

export function storyboardProductionVideoFingerprint(run: ProductionRun, card: ProductionCard): string {
  return storyboardProductionFingerprint([storyboardProductionImageFingerprint(run, card),
    card.imageRecordId, card.imageAssetId, card.imageStorageKey, card.imageRecordId ? undefined : card.imageUrl,
    card.videoPrompt, card.directorExecution, run.videoModelId, run.videoResolution, run.videoDuration, run.ratio, run.videoContract]);
}

/** Failure, unknown receipts and stale outputs always need an explicit separate resolution. */
export function storyboardProductionBlocker(run: ProductionRun): string {
  if (!run.cards.length || run.cards.some(card => !card.imagePrompt.trim() || !card.videoPrompt.trim())) return "请补齐每段的生图和视频提示词后开始连续制作。";
  for (const card of run.cards) {
    if (card.imageRecoveryReady || card.imageRetryBlocked || ["queued", "running"].includes(card.imageStatus)
      || ["queued", "running"].includes(card.videoStatus)) return "原生成请求仍在运行或结果待核验，请先查询原任务；连续制作不会重复提交。";
    if (["failed", "cancelled"].includes(card.imageStatus) || ["failed", "cancelled"].includes(card.videoStatus)) return "某段生成失败或已取消，请在该段处理原任务并明确重试；完成后可继续剩余制作。";
    if (card.imageReferenceState === "stale") return "参考已改变，请在对应段落重新生成分镜图后继续；旧图和旧视频保留。";
    if (card.imageStatus === "done" && card.continuousImageInputFingerprint !== storyboardProductionImageFingerprint(run, card)) return "已有分镜图与本次制作输入未确认一致，请在对应段落重新生成后继续。";
    if (card.videoStatus === "done" && card.continuousVideoInputFingerprint !== storyboardProductionVideoFingerprint(run, card)) return "已有视频与当前提示词或模型未确认一致，请在对应段落重新生成后继续。";
    if (card.imageStatus === "idle" && card.imageClientRequestId || card.videoStatus === "idle" && (card.videoTaskId || card.videoClientRequestId)) return "存在尚未核实的原请求，请先查询原任务后继续。";
  }
  return "";
}

export function storyboardProductionQuote(input: { references: number; images: number; videos: number; referencePrice: number; imagePrice: number; videoPrice: number }): number {
  const groups = [[input.references, input.referencePrice], [input.images, input.imagePrice], [input.videos, input.videoPrice]];
  if (groups.some(([count, price]) => !Number.isSafeInteger(count) || count < 0 || !Number.isFinite(price) || price < 0)) throw new Error("连续制作报价尚未确认，本次未提交。");
  return Math.round(groups.reduce((sum, [count, price]) => sum + count * price, 0) * 100) / 100;
}

/** All dispatches are awaited. A failed or unknown item ends the queue before its successor. */
export async function runStoryboardProductionQueue(input: {
  current: () => boolean;
  references: () => Promise<boolean>;
  cards: () => ProductionCard[];
  onStage: (stage: "references" | "images" | "videos") => void;
  image: (cardId: string) => Promise<boolean>;
  video: (cardId: string) => Promise<boolean>;
}): Promise<"waiting" | "completed" | "stopped"> {
  if (!input.current()) return "stopped";
  input.onStage("references");
  if (!await input.references()) return input.current() ? "waiting" : "stopped";
  for (const kind of ["images", "videos"] as const) {
    if (!input.current()) return "stopped";
    input.onStage(kind);
    for (const snapshot of input.cards()) {
      if (!input.current()) return "stopped";
      const card = input.cards().find(item => item.id === snapshot.id);
      if (!card) return "stopped";
      if ((kind === "images" ? card.imageStatus : card.videoStatus) === "done") continue;
      const success = await (kind === "images" ? input.image(card.id) : input.video(card.id));
      if (!success) return "stopped";
    }
  }
  return input.current() ? "completed" : "stopped";
}
