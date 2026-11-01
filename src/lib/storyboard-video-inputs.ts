import { z } from "zod";
import { getAiVideoPageInputCapabilities, type AiVideoPageCapabilitySource, type AiVideoPageInputCapabilities } from "./ai-video-page-capabilities";
import { validateVideoInputContract, type VideoInputRequest } from "./video-input-contract";
import { GeneratedImageReferenceSchema, generatedImageReferenceUri, type GeneratedImageReference } from "./generated-image-reference";
import { isPublicVideoAssetUrl } from "./video-public-url";

const url = z.string().trim().min(1).max(4096).refine(value => {
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  if (/^\/(?!\/)/u.test(value)) return true;
  try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}, "视频素材必须是 http(s) 或站内 URL，不能使用临时 data/blob 地址");
export const StoryboardVideoInputsSchema = z.object({
  useStoryboardImage: z.boolean().optional(), firstFrameUrl: url.optional(), lastFrameUrl: url.optional(),
  referenceImageUrls: z.array(url).max(16).optional(), audioUrl: url.optional(),
  referenceAudioUrls: z.array(url).max(8).optional(), sourceVideoUrl: url.optional(),
  uploadedAssets: z.array(z.object({ url, assetRef: z.string().trim().min(1).max(1200), category: z.enum(["image", "audio"]) }).strict()).max(24).optional(),
}).strict();
export type StoryboardVideoInputs = z.infer<typeof StoryboardVideoInputsSchema>;
export function normalizeStoryboardVideoInputs(value: unknown): StoryboardVideoInputs | undefined {
  return value === undefined ? undefined : StoryboardVideoInputsSchema.parse(value);
}
/** Full generated storyboard asset; legacy preview crops never alter video input identity. */
export function storyboardVideoImageSubmissionReference(reference: GeneratedImageReference): GeneratedImageReference {
  const parsed = GeneratedImageReferenceSchema.parse(reference);
  return { schema: parsed.schema, recordId: parsed.recordId };
}
/** Project already-resolved capabilities onto effective form roles; never reinterpret models here. */
export function getStoryboardVideoInputRoles(capabilities: AiVideoPageInputCapabilities, value: StoryboardVideoInputs = {}) {
  const acceptsImage = capabilities.maxReferenceImages > 0 && capabilities.mode !== "text";
  const firstFrameUrl = acceptsImage ? value.firstFrameUrl : undefined;
  const useStoryboardImage = acceptsImage && value.useStoryboardImage !== false && !firstFrameUrl;
  const lastFrameUrl = acceptsImage && capabilities.showLastFrame ? value.lastFrameUrl : undefined;
  const referenceImageUrls = acceptsImage && capabilities.showReferenceImages ? value.referenceImageUrls : undefined;
  const acceptsAudio = capabilities.showAudioInputs && capabilities.maxReferenceAudios > 0;
  const acceptsReferenceAudio = acceptsAudio && (capabilities.maxReferenceAudios > 1 || capabilities.mode === "multi_image_audio");
  const audioUrl = acceptsAudio ? value.audioUrl : undefined;
  const referenceAudioUrls = acceptsReferenceAudio ? value.referenceAudioUrls : undefined;
  return { acceptsImage, firstFrameUrl, useStoryboardImage, lastFrameUrl, referenceImageUrls,
    remainingImageSlots: Math.max(0, capabilities.maxReferenceImages - Number(useStoryboardImage || Boolean(firstFrameUrl)) - Number(Boolean(lastFrameUrl))),
    acceptsAudio, acceptsReferenceAudio, audioUrl, referenceAudioUrls,
    remainingAudioSlots: acceptsReferenceAudio ? Math.max(0, capabilities.maxReferenceAudios - Number(Boolean(audioUrl))) : 0 };
}
export type StrictVideoInputRequest = { [K in keyof VideoInputRequest]?: K extends "referenceImageUrls" | "referenceAudioUrls" ? string[] : string };
export type StoryboardVideoInputCard = { videoPrompt?: string; videoInputs?: StoryboardVideoInputs; imageRef?: GeneratedImageReference; imageUrl?: string; imageStorageKey?: string };
export type StoryboardVideoRequestFields = {
  image_url?: string; image_ref?: GeneratedImageReference; image_storage_key?: string; last_frame_url?: string; reference_image_url?: string;
  reference_image_urls?: string[]; audio_url?: string; reference_audio_urls?: string[]; source_video_url?: string;
  reference_asset_refs?: Array<{ url: string; asset_ref: string; category: "image" | "audio" }>;
};
export type StoryboardVideoInputIdentity = {
  configured?: StoryboardVideoInputs;
  storyboardImageStorageKey?: string;
  uploadedAssets?: StoryboardVideoRequestFields["reference_asset_refs"];
  effective: Array<{ role: keyof StrictVideoInputRequest; values: string[] }>;
};
export function isStoryboardImageWorkflow(model: AiVideoPageCapabilitySource): boolean {
  const c = getAiVideoPageInputCapabilities(model);
  return c.maxReferenceImages > 0 && c.minReferenceImages <= 1 && !c.requiresLastFrame
    && c.minReferenceAudios === 0 && !c.requiresSourceVideo;
}
export function resolveStoryboardVideoInputs(model: AiVideoPageCapabilitySource, card: StoryboardVideoInputCard): {
  capabilities: AiVideoPageInputCapabilities; input: StrictVideoInputRequest; usesStoryboardImage: boolean;
  requiresStoryboardImage: boolean; isStoryboardImageWorkflow: boolean; requestFields: StoryboardVideoRequestFields;
  identity: StoryboardVideoInputIdentity; issue: string;
} {
  const capabilities = getAiVideoPageInputCapabilities(model), input: StrictVideoInputRequest = { prompt: card.videoPrompt || "" };
  const requestFields: StoryboardVideoRequestFields = {};
  const parsed = StoryboardVideoInputsSchema.safeParse(card.videoInputs === undefined ? {} : card.videoInputs);
  let issue = parsed.success ? "" : "视频素材无效：请检查 URL、素材数量与输入字段";
  const configured = parsed.success ? parsed.data : {};
  let usesStoryboardImage = false;
  const roles = getStoryboardVideoInputRoles(capabilities, configured);
  const { acceptsImage, firstFrameUrl } = roles;
  const requiresStoryboardImage = roles.useStoryboardImage;
  if (acceptsImage && parsed.success) {
    if (firstFrameUrl) input.imageUrl = requestFields.image_url = firstFrameUrl;
    else if (configured.useStoryboardImage !== false) {
      if (card.imageRef !== undefined) {
        const ref = GeneratedImageReferenceSchema.safeParse(card.imageRef);
        if (!ref.success) issue = "本段分镜图引用无效，请重新选择图片";
        else {
          // Preserve the existing storyboard submission contract: old client-only
          // preview crops do not crop the complete generated multi-panel asset.
          const submissionRef = storyboardVideoImageSubmissionReference(ref.data);
          input.imageUrl = generatedImageReferenceUri(submissionRef); requestFields.image_ref = submissionRef; usesStoryboardImage = true;
        }
      } else if (card.imageUrl) {
        const image = url.safeParse(card.imageUrl);
        if (!image.success) issue = "本段分镜图地址无效，请使用已保存图片";
        else {
          input.imageUrl = requestFields.image_url = image.data; usesStoryboardImage = true;
          if (card.imageStorageKey !== undefined) {
            const key = z.string().trim().min(1).max(4096).safeParse(card.imageStorageKey);
            if (!key.success) issue = "本段分镜图存储标识无效";
            else requestFields.image_storage_key = key.data;
          }
        }
      }
    }
    if (roles.lastFrameUrl) input.lastFrameUrl = requestFields.last_frame_url = roles.lastFrameUrl;
    if (roles.referenceImageUrls?.length) input.referenceImageUrls = requestFields.reference_image_urls = [...roles.referenceImageUrls];
  }
  if (parsed.success) {
    if (roles.audioUrl) input.audioUrl = requestFields.audio_url = roles.audioUrl;
    if (roles.referenceAudioUrls?.length) input.referenceAudioUrls = requestFields.reference_audio_urls = [...roles.referenceAudioUrls];
    if (capabilities.supportsSourceVideoInput && configured.sourceVideoUrl) input.sourceVideoUrl = requestFields.source_video_url = configured.sourceVideoUrl;
  }
  if (requiresStoryboardImage && !usesStoryboardImage) issue ||= "请先生成或选择本段分镜图，或关闭使用本段分镜图";
  const mediaUrls = [input.imageUrl && !requestFields.image_ref ? input.imageUrl : undefined, input.lastFrameUrl, input.referenceImageUrl,
    ...(input.referenceImageUrls || []), input.audioUrl, ...(input.referenceAudioUrls || []), input.sourceVideoUrl].filter((value): value is string => value !== undefined);
  if (mediaUrls.some(value => !isPublicVideoAssetUrl(value))) issue ||= "视频素材必须使用可公开访问的 http(s) URL，不能使用站内或私有网络地址";
  issue ||= validateVideoInputContract(capabilities, input)?.message || "";
  const imageUrls = new Set([input.imageUrl, input.lastFrameUrl, input.referenceImageUrl, ...(input.referenceImageUrls || [])].filter(Boolean));
  const audioUrls = new Set([input.audioUrl, ...(input.referenceAudioUrls || [])].filter(Boolean));
  const submittedAssets = configured.uploadedAssets?.filter(asset => (asset.category === "image" ? imageUrls : audioUrls).has(asset.url))
    .map(asset => ({ url: asset.url, asset_ref: asset.assetRef, category: asset.category }));
  if (submittedAssets?.length) requestFields.reference_asset_refs = submittedAssets;
  const effective = (Object.keys(input) as Array<keyof StrictVideoInputRequest>).filter(role => input[role] !== undefined)
    .map(role => ({ role, values: Array.isArray(input[role]) ? [...input[role] as string[]] : [input[role] as string] }));
  return { capabilities, input, requestFields, usesStoryboardImage, requiresStoryboardImage,
    isStoryboardImageWorkflow: isStoryboardImageWorkflow(model), identity: { ...(card.videoInputs === undefined ? {} : { configured }),
      ...(requestFields.image_storage_key ? { storyboardImageStorageKey: requestFields.image_storage_key } : {}),
      ...(submittedAssets?.length ? { uploadedAssets: submittedAssets } : {}), effective }, issue };
}
