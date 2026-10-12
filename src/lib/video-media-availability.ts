export type VideoMediaSnapshot = {
  status?: unknown; mediaAvailable?: unknown; mediaUnavailableReason?: unknown;
  processingStage?: unknown; errorMessage?: unknown; priceCharged?: unknown;
  billingState?: unknown; videoUrl?: unknown; video_url?: unknown;
  storageUrl?: unknown; storage_url?: unknown; thumbnailUrl?: unknown; needsProxy?: unknown;
};

/** Delivery availability never changes the completed generation/ledger fact. */
export function getVideoMediaUnavailable(data: VideoMediaSnapshot) {
  if (data.status !== "completed" || (data.mediaAvailable !== false
    && data.processingStage !== "media_unavailable" && !data.mediaUnavailableReason)) return null;
  const reason = typeof data.mediaUnavailableReason === "string" ? data.mediaUnavailableReason : "unavailable";
  const message = typeof data.errorMessage === "string" && data.errorMessage.trim()
    ? data.errorMessage : "视频已生成，但当前不可播放；不会自动重新提交";
  return { reason, message };
}

/** Shared by SSE, fallback polling and cancellation's final state check. */
export function videoCompletedDeliveryPatch(data: VideoMediaSnapshot) {
  const unavailable = getVideoMediaUnavailable(data);
  const charged = Number(data.priceCharged);
  return {
    status: "completed" as const,
    mediaAvailable: !unavailable,
    mediaUnavailableReason: unavailable?.reason,
    processingStage: unavailable ? "media_unavailable" : "ready",
    videoUrl: unavailable ? "" : String(data.videoUrl || data.video_url || ""),
    storageUrl: unavailable ? "" : String(data.storageUrl || data.storage_url || ""),
    thumbnailUrl: unavailable ? "" : String(data.thumbnailUrl || ""),
    needsProxy: !unavailable && data.needsProxy === true,
    errorMessage: unavailable?.message || "",
    statusDetail: unavailable?.message || "视频已生成完成",
    progress: 100,
    ...(data.priceCharged !== undefined && Number.isFinite(charged) ? { priceCharged: Math.max(0, charged) } : {}),
    ...(typeof data.billingState === "string" ? { billingState: data.billingState } : {}),
  };
}
