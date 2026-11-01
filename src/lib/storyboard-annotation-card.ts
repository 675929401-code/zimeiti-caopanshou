import { parseStoryboardAnnotationPanels, resolveStoryboardAnnotationLayout } from "./storyboard-annotation-layout";

type AnnotationCard = {
  imagePrompt: string;
  imageExactText?: string;
  imageTextLayoutEnabled?: boolean;
  imageAnnotationIssue?: string;
  directorExecution?: unknown;
  imageClientRequestId?: unknown;
  imageClientTraceId?: unknown;
  imageClientRequestFingerprint?: unknown;
  imageRequestSnapshot?: unknown;
  imageRecordId?: unknown;
  imageUrl?: unknown;
  imageRef?: unknown;
  imageAssetId?: unknown;
  imageStorageKey?: unknown;
  imageSubmittedAt?: unknown;
  imageValidatedAt?: unknown;
  imageAttemptOrdinal?: unknown;
  imageBillingState?: unknown;
  imagePriceCharged?: unknown;
  imageModelIdUsed?: unknown;
  videoTaskId?: unknown;
  videoClientRequestId?: unknown;
  videoUrl?: unknown;
};

export function isStoryboardAnnotationPayload(value: string | undefined): boolean {
  return Boolean(value?.startsWith("STORYBOARD_ANNOTATIONS_"));
}

export function storyboardImageTextLayoutEnabled(card: Pick<AnnotationCard, "imageTextLayoutEnabled" | "imageExactText">): boolean {
  return typeof card.imageTextLayoutEnabled === "boolean" ? card.imageTextLayoutEnabled : Boolean(card.imageExactText?.trim());
}

export function hasStoryboardImageSubmissionIdentity(card: AnnotationCard): boolean {
  return [card.imageClientRequestId, card.imageClientTraceId,
    card.imageClientRequestFingerprint, card.imageRequestSnapshot, card.imageRecordId, card.imageUrl,
    card.imageRef, card.imageAssetId, card.imageStorageKey, card.imageSubmittedAt, card.imageValidatedAt,
    card.imageAttemptOrdinal, card.imageBillingState, card.imagePriceCharged, card.imageModelIdUsed,
    card.videoTaskId, card.videoClientRequestId, card.videoUrl].some(value => value !== undefined && value !== null && value !== "");
}

/** Fresh imports carry an unresolved annotation issue; restored cards are never reclassified. */
export function storyboardAnnotationImportState(imagePrompt: string): { imageExactText?: string; imageTextLayoutEnabled?: boolean; imageAnnotationIssue?: string } {
  const layout = resolveStoryboardAnnotationLayout(imagePrompt);
  if (layout.status === "valid" && layout.exactText) return { imageExactText: layout.exactText, imageTextLayoutEnabled: true };
  if (layout.status === "invalid") return { imageAnnotationIssue: layout.error || "导演注释格式无效，请核对四格的中文说明、SHOT/CAMERA 和 ACTION。", imageTextLayoutEnabled: false };
  return {};
}

/** Explicitly continue without annotations. Accepted requests keep their original fields. */
export function dismissStoryboardAnnotationIssuePatch(card: AnnotationCard): { imageAnnotationIssue: undefined; imageTextLayoutEnabled: false } | null {
  return card.imageAnnotationIssue?.trim() && !hasStoryboardImageSubmissionIdentity(card)
    ? { imageAnnotationIssue: undefined, imageTextLayoutEnabled: false } : null;
}

/** Only an explicit UI action may repair an unsubmitted old import. */
export function directorAnnotationPatch(card: AnnotationCard): { imageExactText: string; imageTextLayoutEnabled: true; imageAnnotationIssue: undefined } | null {
  if ((!card.directorExecution && !card.imageAnnotationIssue && !isStoryboardAnnotationPayload(card.imageExactText)) || hasStoryboardImageSubmissionIdentity(card)) return null;
  // A user-authored ordinary title is never replaced by a director-derived payload.
  if (card.imageExactText?.trim() && !isStoryboardAnnotationPayload(card.imageExactText)) return null;
  const layout = resolveStoryboardAnnotationLayout(card.imagePrompt);
  if (layout.status !== "valid" || !layout.exactText) return null;
  if (card.imageTextLayoutEnabled && card.imageExactText === layout.exactText && !card.imageAnnotationIssue) return null;
  return { imageExactText: layout.exactText, imageTextLayoutEnabled: true, imageAnnotationIssue: undefined };
}

/** Existing accepted requests use their immutable snapshot instead of this new-request check. */
export function storyboardAnnotationSubmissionIssue(card: AnnotationCard): string | null {
  if (card.imageAnnotationIssue?.trim()) return `${card.imageAnnotationIssue}请修复图片提示词后点击“应用导演注释”，或明确选择“不使用注释”再生成。`;
  if (!card.imageTextLayoutEnabled || !isStoryboardAnnotationPayload(card.imageExactText)) return null;
  const layout = resolveStoryboardAnnotationLayout(card.imagePrompt);
  if (layout.status !== "valid" || !layout.exactText) return "导演注释不完整，请检查每格中文说明、镜头和动作，再重新应用导演注释。";
  if (card.imageExactText !== layout.exactText) return "图片提示词已修改，请重新应用导演注释后再生成。";
  return null;
}

export function storyboardAnnotationPreview(value: string | undefined): string | null {
  const panels = parseStoryboardAnnotationPanels(value || "");
  if (!panels) return null;
  return panels.map((panel, index) => [
    `第 ${index + 1} 格${panel.caption ? ` · ${panel.caption}` : ""}`,
    `SHOT ${String(panel.shot).padStart(2, "0")} | CAMERA: ${panel.camera}`,
    `ACTION: ${panel.action}`,
  ].join("\n")).join("\n\n");
}
