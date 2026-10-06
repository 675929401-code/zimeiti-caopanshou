import type { ImageResolution } from "@/lib/image-model-capabilities";

export type SecureSkillImageRequestInput = {
  modelName: string;
  prompt: string;
  resolution: ImageResolution;
  aspectRatio: string;
  referenceImageUrls?: string[];
};

export function buildSecureSkillImagePayload(input: SecureSkillImageRequestInput) {
  const references = (input.referenceImageUrls || []).filter(Boolean);
  return {
    model: input.modelName,
    prompt: input.prompt,
    n: 1,
    image_size: input.resolution,
    aspect_ratio: input.aspectRatio,
    ...(references.length > 0 ? { image: references } : {}),
    response_format: "url",
  };
}
