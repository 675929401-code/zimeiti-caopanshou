import type { ImageProviderContract } from "@/lib/image-provider-contract";

export const IMAGE_FIXED_OUTPUT_COUNT = 1 as const;

export type ImagePublishedProtocol = ImageProviderContract["requestProtocol"] | "cover_workflow";
export type ImageParameterDisposition = "consumed" | "fixed" | "rejected" | "platform_postprocess";

export type ImageParameterContractRow = {
  userPrompt: ImageParameterDisposition;
  effectivePrompt: ImageParameterDisposition;
  negativePrompt: ImageParameterDisposition;
  widthHeight: ImageParameterDisposition;
  aspectRatio: ImageParameterDisposition;
  resolutionTier: ImageParameterDisposition;
  count: ImageParameterDisposition;
  seed: ImageParameterDisposition;
  references: ImageParameterDisposition;
  mask: ImageParameterDisposition;
  quality: ImageParameterDisposition;
  style: ImageParameterDisposition;
  exactCoverText: ImageParameterDisposition;
  providerSpecificFields: ImageParameterDisposition;
  providerMapping: Readonly<Record<string, string>>;
};

const COMMON_REJECTIONS = {
  negativePrompt: "rejected",
  seed: "rejected",
  mask: "rejected",
  quality: "rejected",
  providerSpecificFields: "rejected",
} as const;

/**
 * Public request controls are deliberately smaller than any one upstream API.
 * A browser cannot smuggle provider-specific fields into a paid request. Each
 * accepted field is either mapped below, fixed by the platform, or rejected
 * before the durable intent/wallet/provider boundary.
 */
export const IMAGE_PROTOCOL_PARAMETER_MATRIX: Readonly<Record<ImagePublishedProtocol, ImageParameterContractRow>> = {
  google_generate_content: {
    userPrompt: "consumed", effectivePrompt: "consumed", ...COMMON_REJECTIONS,
    widthHeight: "consumed", aspectRatio: "consumed", resolutionTier: "consumed",
    count: "fixed", references: "consumed", style: "consumed", exactCoverText: "platform_postprocess",
    providerMapping: {
      effectivePrompt: "contents[].parts[].text",
      references: "contents[].parts[].inlineData",
      aspectRatio: "generationConfig.imageConfig.aspectRatio",
      resolutionTier: "generationConfig.imageConfig.imageSize",
      widthHeight: "validated output contract",
      count: "one platform result",
    },
  },
  chat_completions: {
    userPrompt: "consumed", effectivePrompt: "consumed", ...COMMON_REJECTIONS,
    widthHeight: "consumed", aspectRatio: "consumed", resolutionTier: "consumed",
    count: "fixed", references: "consumed", style: "consumed", exactCoverText: "platform_postprocess",
    providerMapping: {
      effectivePrompt: "messages[0].content",
      references: "messages[0].content[].image_url",
      aspectRatio: "aspect_ratio and image_config",
      resolutionTier: "image_size and image_config",
      widthHeight: "size",
      count: "one platform result",
    },
  },
  images_generations: {
    userPrompt: "consumed", effectivePrompt: "consumed", ...COMMON_REJECTIONS,
    widthHeight: "consumed", aspectRatio: "consumed", resolutionTier: "consumed",
    count: "fixed", references: "consumed", style: "consumed", exactCoverText: "platform_postprocess",
    providerMapping: {
      effectivePrompt: "prompt",
      references: "image when configured",
      aspectRatio: "aspect_ratio or encoded size",
      resolutionTier: "image_size or encoded size",
      widthHeight: "size when required by protocol binding",
      count: "n=1",
    },
  },
  images_generations_async: {
    userPrompt: "consumed", effectivePrompt: "consumed", ...COMMON_REJECTIONS,
    widthHeight: "consumed", aspectRatio: "consumed", resolutionTier: "consumed",
    count: "fixed", references: "consumed", style: "consumed", exactCoverText: "platform_postprocess",
    providerMapping: {
      effectivePrompt: "prompt",
      references: "image_urls",
      aspectRatio: "aspect_ratio",
      resolutionTier: "image_size",
      widthHeight: "size",
      count: "n=1",
    },
  },
  images_edits: {
    userPrompt: "consumed", effectivePrompt: "consumed", ...COMMON_REJECTIONS,
    widthHeight: "consumed", aspectRatio: "consumed", resolutionTier: "consumed",
    count: "fixed", references: "consumed", style: "consumed", exactCoverText: "platform_postprocess",
    providerMapping: {
      effectivePrompt: "multipart prompt",
      references: "multipart image or image[]",
      aspectRatio: "encoded size",
      resolutionTier: "encoded size",
      widthHeight: "multipart size",
      count: "multipart n=1",
    },
  },
  cover_workflow: {
    userPrompt: "consumed", effectivePrompt: "consumed", ...COMMON_REJECTIONS,
    widthHeight: "consumed", aspectRatio: "consumed", resolutionTier: "consumed",
    count: "fixed", references: "rejected", style: "consumed", exactCoverText: "platform_postprocess",
    providerMapping: {
      effectivePrompt: "content.query.prompt[0].content.text",
      aspectRatio: "effective prompt plus output validation",
      resolutionTier: "effective prompt plus output validation",
      widthHeight: "effective prompt plus output validation",
      count: "one platform result",
    },
  },
};
