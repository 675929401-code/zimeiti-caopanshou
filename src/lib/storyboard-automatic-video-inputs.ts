import type { AiVideoPageCapabilitySource } from "./ai-video-page-capabilities";
import { resolveStoryboardVideoInputs, type StoryboardVideoInputCard } from "./storyboard-video-inputs";
import { storyboardProductionBlocker, storyboardProductionVideoFingerprint, type ProductionCard, type ProductionImageRequestSnapshot, type ProductionRun } from "./storyboard-continuous-production";

/** The workbench submits only its current storyboard image and video prompt.
 * Retained custom inputs belong to saved project history, never this surface's
 * effective request. Keep the generic resolver and persistence contract intact.
 */
export function resolveStoryboardAutomaticVideoInputs(model: AiVideoPageCapabilitySource, card: StoryboardVideoInputCard) {
  const resolved = resolveStoryboardVideoInputs(model, {
    videoPrompt: card.videoPrompt,
    imageRef: card.imageRef,
    imageUrl: card.imageUrl,
    imageStorageKey: card.imageStorageKey,
  });
  const capabilities = resolved.capabilities;
  const unsupportedRequirement = capabilities.requiresLastFrame
    ? "当前模型需要尾帧；此工作台仅使用当前分镜图，请选择支持单张分镜图的视频模型。"
    : capabilities.minReferenceImages > 1
      ? `当前模型至少需要${capabilities.minReferenceImages}张图片；此工作台仅使用当前分镜图，请选择支持单张分镜图的视频模型。`
      : capabilities.minReferenceAudios > 0
        ? "当前模型需要音频；此工作台仅使用当前分镜图和视频提示词，请选择无需音频的视频模型。"
        : capabilities.requiresSourceVideo
          ? "当前模型需要源视频；此工作台仅使用当前分镜图和视频提示词，请选择无需源视频的视频模型。"
          : "";
  return { ...resolved, issue: unsupportedRequirement || resolved.issue.replace("，或关闭使用本段分镜图", "") };
}

function automaticProductionCard(card: ProductionCard): ProductionCard {
  const { videoInputs: _retainedInputs, ...automatic } = card;
  // The explicit marker keeps the generic full typed-image reference binding
  // for configured legacy cards without retaining any custom media. Missing
  // legacy inputs retain their exact original fingerprint branch.
  return card.videoInputs === undefined ? automatic : { ...automatic, videoInputs: { useStoryboardImage: true } };
}

function automaticProductionRun(run: ProductionRun): ProductionRun {
  return { ...run, cards: run.cards.map(automaticProductionCard) };
}

/** Captures and completed-output admission must describe the same effective
 * current-image request. Old custom-input receipts remain stored, but cannot
 * count as evidence that the automatic request has already been completed.
 */
export function storyboardAutomaticVideoProductionFingerprint(run: ProductionRun, card: ProductionCard, actualImageSnapshot?: ProductionImageRequestSnapshot) {
  return storyboardProductionVideoFingerprint(automaticProductionRun(run), automaticProductionCard(card), actualImageSnapshot);
}

export function storyboardAutomaticVideoProductionBlocker(run: ProductionRun) {
  return storyboardProductionBlocker(automaticProductionRun(run));
}
