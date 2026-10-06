import type { ImageResolution } from "@/lib/image-model-capabilities";

export type SecureSkillAsyncImageRequestInput = {
  modelName: string;
  prompt: string;
  resolution: ImageResolution;
  aspectRatio: string;
  pixelSize: string;
  referenceImageUrls?: string[];
};

export type SecureSkillAsyncImageTask = {
  id: string;
  status: "queued" | "processing" | "succeeded" | "failed" | "unknown";
  imageUrl: string;
  error: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstImageUrl(value: unknown): string {
  if (typeof value === "string") return /^(?:https?:\/\/|data:image\/)/iu.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstImageUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["url", "result_url", "image_url", "output_url", "data"]) {
    if (!Object.hasOwn(item, key)) continue;
    const url = firstImageUrl(item[key]);
    if (url) return url;
  }
  if (string(item.b64_json)) return `data:image/png;base64,${string(item.b64_json)}`;
  return "";
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const item = record(value);
  return string(item.message) || string(item.detail) || string(item.code);
}

function normalizedStatus(value: unknown): SecureSkillAsyncImageTask["status"] {
  const status = string(value).toLowerCase();
  if (["succeeded", "success", "completed", "complete", "done"].includes(status)) return "succeeded";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["queued", "pending", "created", "submitted"].includes(status)) return "queued";
  if (["in_progress", "processing", "running"].includes(status)) return "processing";
  return "unknown";
}

export function buildSecureSkillAsyncImagePayload(input: SecureSkillAsyncImageRequestInput) {
  const references = (input.referenceImageUrls || []).filter(url => /^https?:\/\//iu.test(url));
  return {
    model: input.modelName,
    prompt: input.prompt,
    n: 1,
    image_size: input.resolution,
    size: input.pixelSize,
    aspect_ratio: input.aspectRatio,
    ...(references.length > 0 ? { image_urls: references } : {}),
  };
}

export function parseSecureSkillAsyncImageTask(payload: unknown): SecureSkillAsyncImageTask {
  const root = record(payload);
  const data = record(root.data);
  const id = string(root.id) || string(root.generation_id) || string(root.request_id) || string(root.task_id)
    || string(data.id) || string(data.generation_id) || string(data.request_id) || string(data.task_id);
  const imageUrl = firstImageUrl(root.data) || firstImageUrl(root.url)
    || firstImageUrl(root.result_url) || firstImageUrl(root.output);
  let status = normalizedStatus(root.status || data.status);
  if (imageUrl && status === "unknown") status = "succeeded";
  const error = errorMessage(root.error) || errorMessage(data.error);
  if (error && status === "unknown") status = "failed";
  return { id, status, imageUrl, error };
}
