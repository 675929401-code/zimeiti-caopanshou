export const LOCAL_IMAGE_LIMITS = {
  maxInputBytes: 10 * 1024 * 1024,
  maxRequestBytes: 10 * 1024 * 1024 + 256 * 1024,
  maxInputPixels: 40_000_000,
  maxInputDimension: 16_384,
  maxOutputPixels: 60_000_000,
  maxOutputBytes: 48 * 1024 * 1024,
  maxConcurrentJobs: 1,
} as const;

export const LOCAL_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/avif";

export const UPSCALE_TARGETS = {
  "4k": 3_840,
  "8k": 7_680,
} as const;

export type LocalImageOperation = "beauty" | "upscale";
export type UpscaleTarget = keyof typeof UPSCALE_TARGETS;

export interface LocalImageDimensions {
  width: number;
  height: number;
  pixels: number;
}

export interface LocalImageProcessResult {
  buffer: Buffer;
  input: LocalImageDimensions & {
    bytes: number;
    mimeType: string;
  };
  output: LocalImageDimensions & {
    bytes: number;
    mimeType: "image/webp";
  };
  method: "basic-global-filter" | "lanczos3-resample-sharpen";
}
