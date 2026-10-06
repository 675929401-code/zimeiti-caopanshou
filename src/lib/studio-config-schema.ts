import { z } from "zod";

export const StudioPromptTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(20),
  updatedAt: z.string().datetime(),
});

export const StudioRuntimeConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    chatModelId: z.string().default(""),
    imageModelId: z.string().default(""),
    videoModelId: z.string().default(""),
  }),
  health: z.object({
    disabledImageModelIds: z.array(z.string()).default([]),
  }),
  brainTemplateId: z.string().min(1),
  promptTemplates: z.array(StudioPromptTemplateSchema).min(1),
  updatedAt: z.string().datetime(),
});

export type StudioRuntimeConfig = z.infer<typeof StudioRuntimeConfigSchema>;

export const DEFAULT_BRAIN_PROMPT = `你是客服口播短视频的资深分镜导演，也是左侧“创作大脑”。
用户会给你一段口播文案，以及系统已经按每秒 {{charsPerSecond}} 个汉字、每镜约 {{shotSeconds}} 秒预切好的镜头文本。
你只增强每个镜头的视觉执行信息，不得合并、拆分、增删或改写原口播文本。
返回严格 JSON：{"title":"项目名","route":"text-to-image或keyframe-img2img","charsPerSecond":6,"scenes":[{"narration":"原文","imagePrompt":"完整生图提示词","keyframePrompt":"关键帧提示词","refinementPrompt":"图生图补充提示词","videoPrompt":"图生视频提示词"}]}。
图片提示词必须包含主体、场景、动作、构图、光线、色彩和统一风格；视频提示词必须包含镜头运动、秒级主体动作、节奏、声音建议和防跳变约束。
text-to-image 路线的 keyframePrompt 与 refinementPrompt 返回空字符串；keyframe-img2img 路线必须同时给出关键帧和二次精修提示词。只输出 JSON，不要添加解释或代码围栏。`;

export function createDefaultStudioConfig(): StudioRuntimeConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    defaults: {
      chatModelId: "673aef26-e373-4876-ad0c-41041a5d35ae",
      imageModelId: "gemini-3-1-flash-image-chA",
      videoModelId: "veo-3-1-fast-chC",
    },
    health: {
      disabledImageModelIds: [
        "cover-model-seedream-5",
        "cover-model-seedream-5-pro",
      ],
    },
    brainTemplateId: "customer-service-storyboard",
    promptTemplates: [{
      id: "customer-service-storyboard",
      name: "客服口播拆镜",
      content: DEFAULT_BRAIN_PROMPT,
      updatedAt: now,
    }],
    updatedAt: now,
  };
}
