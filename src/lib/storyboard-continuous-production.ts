import { normalizeStoryboardVideoInputs, storyboardVideoImageSubmissionReference, type StoryboardVideoInputs } from "./storyboard-video-inputs";
import { storyboardChainContext } from "./storyboard-chain-controller";
import type { GeneratedImageReference } from "./generated-image-reference";
import { resolveStoryboardExecutionMode, storyboardChainFingerprint, type StoryboardChainRequest, type StoryboardChainAnchorConfirmation } from "./storyboard-chain-contract";
import type { StoryboardDirectorIntakeState } from "./storyboard-director-resume";
import type { StoryboardVisualAssetPlan } from "./storyboard-workbench";
import type { StoryboardVisualAssetWorkspace } from "./storyboard-visual-asset-workspace";

export type ProductionImageRequestSnapshot = {
  chainContext?: StoryboardChainRequest;
  runId: string; cardId: string; prompt: string; modelId: string;
  resolution: string; aspectRatio: string; referenceImageUrls: string[];
};
export type ProductionInputMatch = {
  matches: boolean; basis: "current-exact" | "frozen-exact" | "unverified" | "stale";
};

export type ProductionCard = {
  order?: number; chainAnchorConfirmation?: StoryboardChainAnchorConfirmation;
  id: string; imagePrompt: string; videoPrompt: string; narration?: string;
  imageTextLayoutEnabled?: boolean; imageExactText?: string;
  videoInputs?: StoryboardVideoInputs;
  visualAssetRefs?: Array<{ assetId: string; role: string; referenceKinds: string[]; boundReferenceUrl?: string; ownedReferenceUrl?: string }>;
  visualAssetSelectionMode?: "project" | "custom"; referenceImageUrls: string[];
  imageStatus: string; videoStatus: string; imageReferenceState?: "stale";
  imageRetryBlocked?: boolean; imageRecoveryReady?: boolean;
  imageClientRequestId?: string; videoClientRequestId?: string; videoTaskId?: string;
  imageRef?: GeneratedImageReference; imageRecordId?: string; imageAssetId?: string; imageStorageKey?: string;
  imageUrl?: string; videoUrl?: string;
  continuousImageInputFingerprint?: string; continuousVideoInputFingerprint?: string;
  imageRequestSnapshot?: ProductionImageRequestSnapshot;
  directorExecution?: unknown;
};
export type ProductionRun = {
  executionMode?: "ordinary" | "reference" | "chained"; chainRevision?: number;
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
      card.referenceImageUrls.filter(url => !card.visualAssetRefs?.some(ref => ref.boundReferenceUrl === url || ref.ownedReferenceUrl === url)).map(stableReference),
      ...(card.videoInputs === undefined ? [] : [normalizeStoryboardVideoInputs(card.videoInputs)])]),
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

function imageSnapshotMatchesCard(run: ProductionRun, card: ProductionCard, snapshot: ProductionImageRequestSnapshot): boolean {
  return snapshot.runId === run.id && snapshot.cardId === card.id && snapshot.prompt === card.imagePrompt
    && typeof snapshot.modelId === "string" && snapshot.modelId.trim().length > 0
    && typeof snapshot.resolution === "string" && snapshot.resolution.trim().length > 0
    && typeof snapshot.aspectRatio === "string" && /^\d{1,3}:\d{1,3}$/u.test(snapshot.aspectRatio)
    && Array.isArray(snapshot.referenceImageUrls) && snapshot.referenceImageUrls.every(url => typeof url === "string")
    && (snapshot.chainContext ? snapshot.chainContext.projectId === run.id && snapshot.chainContext.cardId === card.id : JSON.stringify(snapshot.referenceImageUrls.map(stableReference)) === JSON.stringify(card.referenceImageUrls.map(stableReference)));
}

/** Two arguments retain the persisted legacy algorithm. New captures freeze only actual image transport settings. */
export function storyboardProductionImageFingerprint(run: ProductionRun, card: ProductionCard, actualSnapshot?: ProductionImageRequestSnapshot): string {
  const chainSnapshot = actualSnapshot?.chainContext ? actualSnapshot : card.imageRequestSnapshot?.chainContext ? card.imageRequestSnapshot : undefined;
  if (resolveStoryboardExecutionMode(run) === "chained" && chainSnapshot?.chainContext) {
    return storyboardProductionFingerprint([chainSnapshot.modelId, chainSnapshot.resolution, chainSnapshot.aspectRatio, card.imagePrompt,
      card.imageTextLayoutEnabled, card.imageExactText, card.narration, chainSnapshot.referenceImageUrls, chainSnapshot.chainContext]);
  }
  if (actualSnapshot) {
    if (!imageSnapshotMatchesCard(run, card, actualSnapshot)) throw new Error("STORYBOARD_IMAGE_CAPTURE_SNAPSHOT_MISMATCH");
    run = { ...run, imageModelId: actualSnapshot.modelId, imageResolution: actualSnapshot.resolution, imageRatio: actualSnapshot.aspectRatio };
  }
  return storyboardProductionFingerprint([run.imageModelId, run.imageResolution, run.imageRatio || run.ratio,
    card.imagePrompt, card.imageTextLayoutEnabled, card.imageExactText, card.narration,
    card.visualAssetSelectionMode, card.visualAssetRefs?.map(ref => [ref.assetId, ref.role, ref.referenceKinds]),
    run.visualAssetPlan?.assets.map(asset => [asset.id, asset.source]), card.referenceImageUrls.map(stableReference)]);
}

/** The optional image snapshot affects new captures only; two-argument video hashes remain byte-compatible. */
export function storyboardProductionVideoFingerprint(run: ProductionRun, card: ProductionCard, actualImageSnapshot?: ProductionImageRequestSnapshot): string {
  return storyboardProductionFingerprint([storyboardProductionImageFingerprint(run, card, actualImageSnapshot),
    card.imageRecordId, card.imageAssetId, card.imageStorageKey, card.imageRecordId ? undefined : card.imageUrl,
    card.videoPrompt, card.directorExecution, run.videoModelId, run.videoResolution, run.videoDuration, run.ratio, run.videoContract,
    ...(card.videoInputs === undefined ? [] : [normalizeStoryboardVideoInputs(card.videoInputs), card.imageRef ? storyboardVideoImageSubmissionReference(card.imageRef) : undefined])]);
}

/** Existing media is compared against exact evidence, never rewritten to fit the next-generation controls. */
export function storyboardProductionImageInputMatch(run: ProductionRun, card: ProductionCard): ProductionInputMatch {
  if (card.imageReferenceState === "stale") return { matches: false, basis: "stale" };
  if (resolveStoryboardExecutionMode(run) === "chained") {
    const snapshot = card.imageRequestSnapshot;
    if (!snapshot?.chainContext || snapshot.modelId !== run.imageModelId || snapshot.resolution !== run.imageResolution || snapshot.aspectRatio !== (run.imageRatio || run.ratio)) return { matches:false, basis:"stale" };
    try {
      const chainRun = { ...run, cards: run.cards.map((item,index) => ({ ...item, order:item.order || index+1 })) };
      const expected = storyboardChainContext(chainRun, card.id, snapshot.chainContext.previous ? 2 : 1);
      if (storyboardChainFingerprint(expected) !== storyboardChainFingerprint(snapshot.chainContext)) return { matches:false, basis:"stale" };
    } catch { return { matches:false, basis:"stale" }; }
  }
  const stored = card.continuousImageInputFingerprint;
  if (!stored || !/^[a-f0-9]{32}$/u.test(stored)) return { matches: false, basis: "unverified" };
  const snapshot = card.imageRequestSnapshot;
  if (snapshot && !imageSnapshotMatchesCard(run, card, snapshot)) return { matches: false, basis: "unverified" };
  if (stored === storyboardProductionImageFingerprint(run, card)) return { matches: true, basis: "current-exact" };
  if (snapshot && stored === storyboardProductionImageFingerprint(run, card, snapshot)) return { matches: true, basis: "frozen-exact" };
  return { matches: false, basis: "unverified" };
}

/** Legacy completed-video hashes embed the image hash; test both exact forms without changing video settings or receipts. */
export function storyboardProductionVideoInputMatch(run: ProductionRun, card: ProductionCard): ProductionInputMatch {
  const imageMatch = storyboardProductionImageInputMatch(run, card);
  if (!imageMatch.matches) return imageMatch;
  const stored = card.continuousVideoInputFingerprint;
  if (!stored || !/^[a-f0-9]{32}$/u.test(stored)) return { matches: false, basis: "unverified" };
  if (stored === storyboardProductionVideoFingerprint(run, card)) return { matches: true, basis: "current-exact" };
  if (card.imageRequestSnapshot && stored === storyboardProductionVideoFingerprint(run, card, card.imageRequestSnapshot)) return { matches: true, basis: "frozen-exact" };
  return { matches: false, basis: "unverified" };
}

/** Failure, unknown receipts and stale outputs always need an explicit separate resolution. */
export function storyboardProductionBlocker(run: ProductionRun): string {
  if (!run.cards.length || run.cards.some(card => !card.imagePrompt.trim() || !card.videoPrompt.trim())) return "请补齐每段的生图和视频提示词后开始连续制作。";
  for (const card of run.cards) {
    if (card.imageRecoveryReady || card.imageRetryBlocked || ["queued", "running"].includes(card.imageStatus)
      || ["queued", "running"].includes(card.videoStatus)) return "原生成请求仍在运行或结果待核验，请先查询原任务；连续制作不会重复提交。";
    if (["failed", "cancelled"].includes(card.imageStatus) || ["failed", "cancelled"].includes(card.videoStatus)) return "某段生成失败或已取消，请在该段处理原任务并明确重试；完成后可继续剩余制作。";
    if (card.imageReferenceState === "stale") return "参考已改变，请在对应段落重新生成分镜图后继续；旧图和旧视频保留。";
    if (card.imageStatus === "done" && !storyboardProductionImageInputMatch(run, card).matches) return "已有分镜图与本次制作输入未确认一致，请在对应段落重新生成后继续。";
    if (card.videoStatus === "done" && !storyboardProductionVideoInputMatch(run, card).matches) return "已有视频与当前提示词或模型未确认一致，请在对应段落重新生成后继续。";
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
