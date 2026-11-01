/** Generation success and the availability of its original media are separate. */
export type StoryboardImageMediaState = "expired" | "unavailable";
type ImageResultCard = {
  imageStatus?: unknown;
  imageMediaState?: unknown;
  imageDeliveryMode?: unknown;
  imageRecordId?: unknown;
  imageRef?: { recordId?: unknown } | null;
};
export function isCompletedProviderImageReceipt(card: ImageResultCard | null | undefined): boolean {
  return Boolean(card && card.imageStatus === "done" && card.imageDeliveryMode === "provider_url"
    && typeof card.imageRecordId === "string" && /^[a-f0-9]{64}$/u.test(card.imageRecordId)
    && (!card.imageRef || card.imageRef.recordId === card.imageRecordId));
}
export function isUnavailableCompletedStoryboardImage(card: ImageResultCard | null | undefined): boolean {
  return isCompletedProviderImageReceipt(card) && (card?.imageMediaState === "expired" || card?.imageMediaState === "unavailable");
}
function presentation(state: StoryboardImageMediaState) {
  return state === "expired"
    ? { label: "已完成·原图已失效", message: "图片已成功生成，上游原图已确认失效；原任务与费用收据保留，不会重新生成或扣费。", actionLabel: "原图已失效" }
    : { label: "已完成·原图暂不可用", message: "图片已成功生成，原图暂时无法读取；原任务与费用收据保留，重试读取不会重新生成或扣费。", actionLabel: "重试读取原图" };
}
export function storyboardImageUnavailablePresentation(card: ImageResultCard | null | undefined) {
  return isUnavailableCompletedStoryboardImage(card) ? presentation(card!.imageMediaState as StoryboardImageMediaState) : null;
}
/** Caller must first prove an owned completed delivery; this patch grants no access. */
export function storyboardImageUnavailablePatch(state: StoryboardImageMediaState) {
  return {
    imageStatus: "done" as const,
    imageMediaState: state,
    imageUrl: undefined,
    videoSourceImageUrl: undefined,
    imageValidatedAt: undefined,
    imageRecoveryReady: false,
    imageRetryBlocked: true,
    imageError: presentation(state).message,
  };
}
