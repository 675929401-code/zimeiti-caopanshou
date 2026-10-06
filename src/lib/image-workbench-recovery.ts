export type ImageWorkbenchRecoveryPayload = {
  prompt: string;
  modelId: string;
  aspectRatio: "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
  resolution: "1K" | "2K" | "4K";
  referenceImageUrls: string[];
  resumeDeliveryOnly?: boolean;
};

/** This UI stores JSON request fields here, not the server's SHA-256 digest. */
export function parseImageWorkbenchRecoveryPayload(job: {
  generationFingerprint?: string;
  generationModelId?: string;
  generationKey?: string;
  generationTraceId?: string;
}): ImageWorkbenchRecoveryPayload | null {
  if (!job.generationKey || !job.generationTraceId || !job.generationFingerprint) return null;
  try {
    const value = JSON.parse(job.generationFingerprint) as ImageWorkbenchRecoveryPayload;
    if (!value || typeof value !== "object" || typeof value.prompt !== "string" || !value.prompt.trim()
      || typeof value.modelId !== "string" || !value.modelId || value.modelId !== job.generationModelId
      || !["1:1", "3:4", "4:3", "16:9", "9:16"].includes(value.aspectRatio)
      || !["1K", "2K", "4K"].includes(value.resolution)
      || !Array.isArray(value.referenceImageUrls) || !value.referenceImageUrls.every((url) => typeof url === "string" && url.length > 0)
      || (value.resumeDeliveryOnly !== undefined && value.resumeDeliveryOnly !== true)) return null;
    return { prompt: value.prompt, modelId: value.modelId, aspectRatio: value.aspectRatio,
      resolution: value.resolution, referenceImageUrls: [...value.referenceImageUrls],
      ...(value.resumeDeliveryOnly ? { resumeDeliveryOnly: true } : {}) };
  } catch { return null; }
}
