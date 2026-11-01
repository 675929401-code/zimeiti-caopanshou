import { ImageGenerationInputError, type ImagePresetReference } from "../image-generation-request";
import { isStoryboardPresetUrl } from "../storyboard-preset-assets";

/** Revalidate published identity immediately before a new generation. URLs alone never prove availability. */
export async function resolveStoryboardPresetImageReferences(input: { referenceImageUrls: string[]; presetReferences?: ImagePresetReference[] },
  resolve: (input: { presetId: string; revision: number }) => Promise<{ previewUrl: string }>) {
  const refs = input.presetReferences || [];
  const indexed = new Map(refs.map(ref => [ref.referenceIndex, ref]));
  if (indexed.size !== refs.length || refs.some(ref => ref.referenceIndex < 0 || ref.referenceIndex >= input.referenceImageUrls.length)) {
    throw new ImageGenerationInputError("IMAGE_PRESET_REFERENCE_INVALID", "预设参考图片位置无效", 422);
  }
  for (let index = 0; index < input.referenceImageUrls.length; index++) {
    if (isStoryboardPresetUrl(input.referenceImageUrls[index]) && !indexed.has(index)) {
      throw new ImageGenerationInputError("IMAGE_PRESET_REFERENCE_REQUIRED", "平台预设缺少身份或版本，请重新从预设库选择", 422);
    }
  }
  const urls = [...input.referenceImageUrls];
  for (const ref of refs) urls[ref.referenceIndex] = (await resolve({ presetId: ref.presetId, revision: ref.revision })).previewUrl;
  return urls;
}
