import type { ImageResolution } from "./image-model-capabilities";

const IMAGE_PIXEL_SIZES: Record<ImageResolution, Record<string, string>> = {
  "0.5K": {
    "3:4": "384x512",
    "9:16": "288x512",
    "4:3": "512x384",
    "16:9": "512x288",
    "1:1": "512x512",
  },
  "1K": {
    "3:4": "768x1024",
    "9:16": "576x1024",
    "4:3": "1024x768",
    "16:9": "1024x576",
    "1:1": "1024x1024",
  },
  "2K": {
    "3:4": "1536x2048",
    "9:16": "1152x2048",
    "4:3": "2048x1536",
    "16:9": "2048x1152",
    "1:1": "2048x2048",
  },
  "3K": {
    "3:4": "2304x3072",
    "9:16": "1728x3072",
    "4:3": "3072x2304",
    "16:9": "3072x1728",
    "1:1": "3072x3072",
  },
  "4K": {
    "3:4": "3072x4096",
    "9:16": "2304x4096",
    "4:3": "4096x3072",
    "16:9": "4096x2304",
    "1:1": "4096x4096",
  },
};

export type ImageOutputContractIssue = {
  code: "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH" | "IMAGE_OUTPUT_RESOLUTION_MISMATCH";
  message: string;
  actualDimensions: string;
  expectedAspectRatio: string;
  expectedResolution: ImageResolution;
  expectedDimensions: string;
};

export function imagePixelSizeFor(resolution: ImageResolution, aspectRatio: string): string {
  return IMAGE_PIXEL_SIZES[resolution]?.[aspectRatio] || IMAGE_PIXEL_SIZES[resolution]["1:1"];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredResolutionMap(
  config: Record<string, unknown>,
  field: string,
  resolution: ImageResolution,
) {
  const byResolution = objectValue(config[field]);
  const exact = objectValue(byResolution[resolution]);
  if (Object.keys(exact).length > 0) return exact;
  const normalizedResolution = resolution.toLowerCase();
  const matchedKey = Object.keys(byResolution)
    .find((key) => key.trim().toLowerCase() === normalizedResolution);
  return matchedKey ? objectValue(byResolution[matchedKey]) : {};
}

/**
 * Provider-specific image APIs can impose pixel floors/ceilings that do not
 * match the platform's generic K-tier map. Keep those differences in model
 * configuration so fixing one relay never changes every other image model.
 */
export function configuredImagePixelSizeFor(
  protocolConfig: unknown,
  resolution: ImageResolution,
  aspectRatio: string,
): string {
  const config = objectValue(protocolConfig);
  const fields = [
    "request_pixel_size_by_resolution",
    "input_pixel_size_by_resolution",
    "pixel_size_by_resolution",
  ];
  for (const field of fields) {
    const map = configuredResolutionMap(config, field, resolution);
    const candidate = String(map[aspectRatio] || "").trim().toLowerCase();
    const parsed = parsePixelSize(candidate);
    if (parsed && imageDimensionsMatchAspectRatio(parsed.width, parsed.height, aspectRatio, 0.001)) {
      return candidate;
    }
  }
  return imagePixelSizeFor(resolution, aspectRatio);
}

export function parsePixelSize(value: string): { width: number; height: number } | null {
  const match = String(value || "").trim().match(/^(\d{2,5})x(\d{2,5})$/iu);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function aspectRatioValue(value: string): number | null {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

export function imageDimensionsMatchAspectRatio(
  width: number,
  height: number,
  aspectRatio: string,
  tolerance = 0.025,
): boolean {
  const expected = aspectRatioValue(aspectRatio);
  if (!expected || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return Math.abs(width / height - expected) / expected <= tolerance;
}

export function validateImageOutputContract(input: {
  width: number;
  height: number;
  aspectRatio: string;
  resolution: ImageResolution;
  expectedPixelSize?: string;
  minimumDimensionScale?: number;
}): ImageOutputContractIssue | null {
  const actualDimensions = `${input.width}x${input.height}`;
  const expectedDimensions = input.expectedPixelSize || imagePixelSizeFor(input.resolution, input.aspectRatio);
  if (!imageDimensionsMatchAspectRatio(input.width, input.height, input.aspectRatio)) {
    return {
      code: "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH",
      message: `上游返回 ${actualDimensions}，与所选 ${input.aspectRatio} 画幅不一致，结果未发放且未扣费`,
      actualDimensions,
      expectedAspectRatio: input.aspectRatio,
      expectedResolution: input.resolution,
      expectedDimensions,
    };
  }

  const expected = parsePixelSize(expectedDimensions);
  const minimumScale = Math.max(0.5, Math.min(1, input.minimumDimensionScale ?? 0.8));
  if (expected && (input.width < expected.width * minimumScale || input.height < expected.height * minimumScale)) {
    return {
      code: "IMAGE_OUTPUT_RESOLUTION_MISMATCH",
      message: `上游返回 ${actualDimensions}，未达到所选 ${input.resolution}（目标 ${expectedDimensions}）的最低交付尺寸，结果未发放且未扣费`,
      actualDimensions,
      expectedAspectRatio: input.aspectRatio,
      expectedResolution: input.resolution,
      expectedDimensions,
    };
  }
  return null;
}

export function cropDimensionsForAspectRatio(width: number, height: number, aspectRatio: string) {
  const ratio = aspectRatioValue(aspectRatio);
  if (!ratio || width <= 0 || height <= 0) return null;
  if (width / height > ratio) return { width: Math.max(1, Math.floor(height * ratio)), height };
  return { width, height: Math.max(1, Math.floor(width / ratio)) };
}
