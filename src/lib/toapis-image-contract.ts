export const TOAPIS_STANDARD_IMAGE_CONTRACT = "toapis_gpt_image_2_6_standard.v1";

// The standard adapter submits an aspect and a K tier. Keep observed native
// sizes specific to the SKU and setting for which the relay delivered them.
export function toApisStandardNativeSize(contract: unknown, resolution: unknown, aspectRatio: unknown) {
  if (contract === TOAPIS_STANDARD_IMAGE_CONTRACT && resolution === "1K" && aspectRatio === "5:4") {
    return { width: 1120, height: 896 };
  }
  return null;
}
