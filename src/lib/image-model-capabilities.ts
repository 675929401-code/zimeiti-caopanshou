export const IMAGE_RESOLUTION_ORDER = ["0.5K", "1K", "2K", "3K", "4K"] as const;

export type ImageResolution = (typeof IMAGE_RESOLUTION_ORDER)[number];
export type ImageReferenceInputMode = "none" | "single" | "multi";
export type ImageIdentityReferenceLevel = "none" | "single-subject" | "multi-subject";

export type ImageModelIdentity = {
  id?: string | null;
  name?: string | null;
  model_name?: string | null;
  provider?: string | null;
  supports_image_input?: boolean | null;
  supports_reference_input?: boolean | null;
  reference_input_mode?: ImageReferenceInputMode | null;
  identity_reference_level?: ImageIdentityReferenceLevel | null;
  max_reference_images?: number | null;
  max_character_references?: number | null;
  reference_capability_label?: string | null;
  resolution_options?: string[] | null;
  default_resolution?: string | null;
  api_protocol_config?: Record<string, unknown> | null;
};

export type ImageModelCapabilities = {
  resolutionOptions: ImageResolution[];
  defaultResolution: ImageResolution;
  supportsReferenceInput: boolean;
  referenceInputMode: ImageReferenceInputMode;
  identityReferenceLevel: ImageIdentityReferenceLevel;
  maxReferenceImages: number;
  maxCharacterReferences: number;
  referenceCapabilityLabel: string;
};

function normalizedIdentity(model?: ImageModelIdentity | null) {
  return [model?.id, model?.name, model?.model_name, model?.provider]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function normalizeConfiguredResolutions(values?: string[] | null): ImageResolution[] {
  if (!Array.isArray(values)) return [];
  const allowed = new Set<string>(IMAGE_RESOLUTION_ORDER);
  return IMAGE_RESOLUTION_ORDER.filter((resolution) =>
    values.some((value) => allowed.has(value.toUpperCase()) && value.toUpperCase() === resolution.toUpperCase()),
  );
}

export function getImageModelCapabilities(model?: ImageModelIdentity | null): ImageModelCapabilities {
  const protocolConfig = model?.api_protocol_config && typeof model.api_protocol_config === "object"
    && !Array.isArray(model.api_protocol_config) ? model.api_protocol_config : {};
  const configuredModel = { ...protocolConfig, ...model } as ImageModelIdentity;
  const identity = normalizedIdentity(configuredModel);
  const supportsReferenceInput = configuredModel.supports_reference_input ?? configuredModel.supports_image_input === true;
  const configuredMaxReferenceImages = Number(configuredModel.max_reference_images);
  const configuredMaxCharacterReferences = Number(configuredModel.max_character_references);
  const hasConfiguredReferenceCapabilities = supportsReferenceInput
    && (
      Number.isFinite(configuredMaxReferenceImages)
      || Number.isFinite(configuredMaxCharacterReferences)
      || Boolean(configuredModel.reference_input_mode)
      || Boolean(configuredModel.identity_reference_level)
    );
  const referenceCapabilities = !supportsReferenceInput
    ? {
        supportsReferenceInput: false,
        referenceInputMode: "none" as const,
        identityReferenceLevel: "none" as const,
        maxReferenceImages: 0,
        maxCharacterReferences: 0,
        referenceCapabilityLabel: "仅文本生图",
      }
    : hasConfiguredReferenceCapabilities
      ? {
          supportsReferenceInput: true,
          referenceInputMode: configuredModel.reference_input_mode
            || (configuredMaxReferenceImages > 1 ? "multi" as const : "single" as const),
          identityReferenceLevel: configuredModel.identity_reference_level
            || (configuredMaxCharacterReferences > 1 ? "multi-subject" as const : "single-subject" as const),
          maxReferenceImages: Number.isFinite(configuredMaxReferenceImages)
            ? Math.max(1, Math.floor(configuredMaxReferenceImages))
            : 1,
          maxCharacterReferences: Number.isFinite(configuredMaxCharacterReferences)
            ? Math.max(1, Math.floor(configuredMaxCharacterReferences))
            : 1,
          referenceCapabilityLabel: configuredModel.reference_capability_label?.trim()
            || (configuredMaxCharacterReferences > 1
              ? `多角色参考（最多${Math.floor(configuredMaxCharacterReferences)}个角色）`
              : "单主体参考"),
        }
      : identity.includes("gpt-image-2") || identity.includes("gpt image 2") || identity.includes("gpt-image-1") || identity.includes("gpt image 1")
      ? {
          supportsReferenceInput: true,
          referenceInputMode: "multi" as const,
          identityReferenceLevel: "multi-subject" as const,
          maxReferenceImages: 8,
          maxCharacterReferences: 4,
          referenceCapabilityLabel: "多图参考 / 多角色一致性",
        }
      : identity.includes("gemini-3.1-flash-image") || identity.includes("nano banana 2")
      ? {
          supportsReferenceInput: true,
          referenceInputMode: "multi" as const,
          identityReferenceLevel: "multi-subject" as const,
          // Gemini 3.1 Flash Image accepts more references upstream, while the
          // main-site image gateway deliberately caps one request at 9. Keep
          // the published capability equal to the end-to-end platform limit.
          maxReferenceImages: 9,
          maxCharacterReferences: 4,
          referenceCapabilityLabel: "多角色参考（最多4个角色）",
        }
      : identity.includes("gemini-3.0-pro-image") || identity.includes("gemini 3.0 pro image")
        ? {
            supportsReferenceInput: true,
            referenceInputMode: "multi" as const,
            identityReferenceLevel: "multi-subject" as const,
            maxReferenceImages: 8,
            maxCharacterReferences: 5,
            referenceCapabilityLabel: "多角色参考（最多5个角色）",
          }
        : identity.includes("secure_skill_chat")
          ? {
              supportsReferenceInput: true,
              referenceInputMode: "multi" as const,
              identityReferenceLevel: "single-subject" as const,
              maxReferenceImages: 8,
              maxCharacterReferences: 1,
              referenceCapabilityLabel: "多图传输 / 单主体保真",
            }
          : {
              supportsReferenceInput: true,
              referenceInputMode: "single" as const,
              identityReferenceLevel: "single-subject" as const,
              maxReferenceImages: 1,
              maxCharacterReferences: 1,
              referenceCapabilityLabel: "单张主体参考",
            };
  const configured = normalizeConfiguredResolutions(configuredModel.resolution_options);
  if (configured.length > 0) {
    const configuredDefault = configuredModel.default_resolution?.toUpperCase() as ImageResolution | undefined;
    return {
      resolutionOptions: configured,
      defaultResolution: configuredDefault && configured.includes(configuredDefault)
        ? configuredDefault
        : configured[Math.min(1, configured.length - 1)],
      ...referenceCapabilities,
    };
  }

  if (identity.includes("dall-e-3") || identity.includes("dall·e 3") || identity.includes("dall-e 3")) {
    return { resolutionOptions: ["1K"], defaultResolution: "1K", ...referenceCapabilities };
  }
  if (identity.includes("gpt-image-2") || identity.includes("gpt image 2")) {
    return { resolutionOptions: ["1K", "2K", "4K"], defaultResolution: "2K", ...referenceCapabilities };
  }
  if (identity.includes("gpt-image")) {
    return { resolutionOptions: ["1K"], defaultResolution: "1K", ...referenceCapabilities };
  }
  if (identity.includes("gemini-3.1-flash-image") || identity.includes("nano banana 2")) {
    return { resolutionOptions: ["1K", "2K", "4K"], defaultResolution: "2K", ...referenceCapabilities };
  }
  if (identity.includes("gemini-3.0-pro-image") || identity.includes("gemini 3.0 pro image")) {
    return { resolutionOptions: ["1K", "2K", "4K"], defaultResolution: "2K", ...referenceCapabilities };
  }
  if (model?.provider === "volcengine" && identity.includes("seedream")) {
    return { resolutionOptions: ["2K"], defaultResolution: "2K", ...referenceCapabilities };
  }
  if (identity.includes("qwen-image") || identity.includes("qwen image") || identity.includes("千问")) {
    return { resolutionOptions: ["1K", "2K"], defaultResolution: "2K", ...referenceCapabilities };
  }
  return { resolutionOptions: ["1K"], defaultResolution: "1K", ...referenceCapabilities };
}

export function coerceImageResolution(
  model: ImageModelIdentity | null | undefined,
  requested?: string | null,
  preferredFallback?: ImageResolution,
): ImageResolution {
  const capabilities = getImageModelCapabilities(model);
  const normalizedRequested = requested?.toUpperCase() as ImageResolution | undefined;
  if (normalizedRequested && capabilities.resolutionOptions.includes(normalizedRequested)) {
    return normalizedRequested;
  }

  if (preferredFallback) {
    const preferredIndex = IMAGE_RESOLUTION_ORDER.indexOf(preferredFallback);
    const available = [...capabilities.resolutionOptions].reverse();
    const nearest = available.find((resolution) => IMAGE_RESOLUTION_ORDER.indexOf(resolution) <= preferredIndex);
    if (nearest) return nearest;
  }

  return capabilities.defaultResolution;
}

export function withImageModelCapabilities<T extends ImageModelIdentity>(model: T) {
  const capabilities = getImageModelCapabilities(model);
  return {
    ...model,
    ...capabilities,
  };
}
