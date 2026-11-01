import { normalizeImageGenerationInput, type NormalizedImageGenerationInput } from "./image-generation-request";

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

export type ImageDeliveryRecoveryStatus = {
  state?: string;
  canRecover?: boolean;
  canResubmit?: boolean;
  deliveryReady?: boolean;
  retryAfterMs?: number;
  assetId?: string;
  recordId?: string;
  message?: string;
  resumeInput?: unknown;
};

/** Only the authenticated original status may supply a delivery-only snapshot.
 * Never rebuild its prompt from an editable draft or create a new request key.
 */
export function imageDeliveryRecoveryRequest(
  status: ImageDeliveryRecoveryStatus,
  original: {
    clientIdempotencyKey: string; clientTraceId: string;
    modelId: string; ratio: string; resolution: string;
    historySurface: "storyboard-workbench";
    referenceUsage: "general" | "character-identity";
  },
): NormalizedImageGenerationInput | null {
  if (status.state !== "provider_completed_pending_delivery" || status.canRecover !== true
    || status.canResubmit !== false || status.deliveryReady !== false
    || (status.retryAfterMs !== undefined && status.retryAfterMs !== 0)
    || !/^[A-Za-z0-9_-]{8,128}$/u.test(original.clientIdempotencyKey)
    || !/^[A-Za-z0-9_-]{8,128}$/u.test(original.clientTraceId)) return null;
  const value = status.resumeInput;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const fields = ["prompt", "modelId", "mode", "style", "aspectRatio", "resolution",
    "coverText", "referenceImageUrls", "referenceUsage", "historySurface", "resumeDeliveryOnly", "deliveryRequirement"];
  if (Object.keys(input).some(key => !fields.includes(key))
    || input.resumeDeliveryOnly !== true || input.historySurface !== original.historySurface
    || input.modelId !== original.modelId || input.aspectRatio !== original.ratio || input.resolution !== original.resolution
    || input.mode !== "local" || original.modelId.startsWith("workflow:")
    || input.referenceUsage !== original.referenceUsage
    || typeof input.style !== "string" || typeof input.coverText !== "string"
    || !Array.isArray(input.referenceImageUrls) || input.referenceImageUrls.length !== 0) return null;
  try {
    return normalizeImageGenerationInput({
      ...input,
      clientIdempotencyKey: original.clientIdempotencyKey,
      clientTraceId: original.clientTraceId,
      noRetry: true,
      strictSingleSubmit: true,
      resumeDeliveryOnly: true,
    });
  } catch { return null; }
}
