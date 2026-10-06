import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";

const MODEL_LIMITS: Record<string, { maxDuration: number; resolutions: readonly string[] }> = {
  "doubao-seedance-2-0-260128": { maxDuration: 15, resolutions: ["720p"] },
  "doubao-seedance-2-0-fast-260128": { maxDuration: 15, resolutions: ["720p"] },
  "doubao-seedance-2-5-260628": { maxDuration: 30, resolutions: ["720p"] },
};

function uniqueUrls(values: Array<string | undefined>): string[] {
  const urls = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  for (const value of urls) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Seedance 渠道任务参考素材必须是公网 HTTP(S) 地址");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Seedance 渠道任务参考素材必须是公网 HTTP(S) 地址");
    }
  }
  return urls;
}

function mediaItem(type: "image_url" | "video_url" | "audio_url", url: string, role: string) {
  return { type, [type]: { url }, role };
}

/**
 * Secure Skill 分组 37 的 Doubao 原生任务协议。
 * 该协议和分组 42 的 seedance-2.5 /v1/videos 协议相互独立，不能共用密钥或请求体。
 */
export function doubaoSeedanceTaskBody(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Record<string, unknown> {
  const model = String(config.model_name || "").trim();
  const limits = MODEL_LIMITS[model];
  if (!limits) throw new Error(`Seedance 渠道任务协议不支持模型 ${model || "(empty)"}`);

  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("Seedance 渠道任务必须填写提示词");

  const duration = Number(params.duration ?? config.duration_seconds);
  if (!Number.isInteger(duration) || duration < 4 || duration > limits.maxDuration) {
    throw new Error(`模型 ${model} 的时长必须是 4–${limits.maxDuration} 秒整数`);
  }

  const resolution = String(
    params.resolutionTier || config.api_protocol_config?.default_resolution || "720p",
  ).toLowerCase();
  if (!limits.resolutions.includes(resolution)) {
    throw new Error(`模型 ${model} 当前仅开放 ${limits.resolutions.join("/")} 稳定计费档`);
  }

  const ratio = String(params.aspectRatio || "16:9");
  const ratios = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"];
  if (!ratios.includes(ratio)) throw new Error(`Seedance 渠道任务协议不支持画幅 ${ratio}`);

  const imageUrls = uniqueUrls([
    params.imageUrl,
    params.referenceImageUrl,
    ...(params.imageUrls || []),
  ]);
  const videoUrls = uniqueUrls([params.sourceVideoUrl]);
  const audioUrls = uniqueUrls([params.audioUrl, ...(params.audioUrls || [])]);
  const lastFrameUrl = uniqueUrls([params.lastFrameUrl])[0];
  if (lastFrameUrl && videoUrls.length > 0) {
    throw new Error("Seedance 首尾帧模式不能同时传入参考视频");
  }
  if (lastFrameUrl && imageUrls.length !== 1) {
    throw new Error("Seedance 首尾帧模式必须且只能提供一张首帧和一张尾帧");
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (lastFrameUrl) {
    content.push(mediaItem("image_url", imageUrls[0], "first_frame"));
    content.push(mediaItem("image_url", lastFrameUrl, "last_frame"));
  } else {
    for (const url of imageUrls) content.push(mediaItem("image_url", url, "reference_image"));
  }
  for (const url of videoUrls) content.push(mediaItem("video_url", url, "reference_video"));
  for (const url of audioUrls) content.push(mediaItem("audio_url", url, "reference_audio"));

  return {
    model,
    content,
    duration,
    resolution,
    ratio,
    ...(params.generateAudio !== undefined
      ? { generate_audio: params.generateAudio }
      : audioUrls.length > 0 || config.api_protocol_config?.generate_audio === true
      ? { generate_audio: true }
      : {}),
  };
}

export function isDoubaoSeedanceModel(modelName: unknown): boolean {
  return Object.hasOwn(MODEL_LIMITS, String(modelName || "").trim());
}
