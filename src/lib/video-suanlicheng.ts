import { videoProviderFetch as fetch } from "./video-provider-request-audit";
import { buildOpenAIEndpoint } from "./api-endpoints";
import { readSuanlichengMaterial } from "./video-suanlicheng-material";
import { resolveVideoProviderResultUrl } from "./video-provider-result";
import type {
  VideoGenerateParams,
  VideoModelConfig,
  VideoTaskResult,
} from "./video-adapter";

type H3MaterialReference = {
  material_id: string;
  sha256: string;
  object_revision: number;
};

const H3_MODELS = new Set(["MiniMax-H3 768P", "MiniMax-H3 2K"]);
const H3_FRAME_MAP = new Map<number, number>([
  [5, 124],
  [10, 243],
  [15, 362],
]);
const H3_CANVAS_MAP: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "1:1": { width: 1024, height: 1024 },
};

function getByPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function providerMessage(data: Record<string, unknown>) {
  const error = data.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const detail = error as Record<string, unknown>;
    return String(detail.message || detail.code || "");
  }
  return String(data.message || data.detail || "");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function newMaterialId(kind: "image" | "audio") {
  const uuid = globalThis.crypto.randomUUID().replace(/-/gu, "");
  return `h3-${kind}-${uuid}`;
}

function fileNameFor(contentType: string, kind: "image" | "audio") {
  const extensionByType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
  };
  return `reference.${extensionByType[contentType.toLowerCase()] || (kind === "image" ? "png" : "mp3")}`;
}

async function uploadMaterial(
  config: VideoModelConfig,
  sourceUrl: string,
  kind: "image" | "audio",
  inputOwnerId?: string,
): Promise<H3MaterialReference> {
  const { buffer, contentType } = await readSuanlichengMaterial(sourceUrl, kind, inputOwnerId);
  const bytes = new Uint8Array(buffer);

  const form = new FormData();
  form.set("material_id", newMaterialId(kind));
  form.set("kind", kind);
  form.set("file", new Blob([bytes], { type: contentType }), fileNameFor(contentType, kind));

  const uploadResponse = await fetch(buildOpenAIEndpoint(config.api_endpoint, "h3/materials"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      Accept: "application/json",
    },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const data = await readJson(uploadResponse);
  if (!uploadResponse.ok) {
    throw new Error(`算力橙素材上传失败（HTTP ${uploadResponse.status}）：${providerMessage(data) || "未知错误"}`);
  }

  const material = (data.material || getByPath(data, "data.material") || data) as Record<string, unknown>;
  const reference = {
    material_id: String(material.material_id || ""),
    sha256: String(material.sha256 || ""),
    object_revision: Number(material.object_revision),
  };
  if (!reference.material_id || !reference.sha256 || !Number.isInteger(reference.object_revision)) {
    throw new Error("算力橙素材上传响应缺少 material_id、sha256 或 object_revision");
  }
  return reference;
}

function bindPictureReferences(prompt: string, pictureCount: number, hasAudio: boolean) {
  let output = prompt.replace(/@图片\s*(\d+)/gu, "<Picture $1>");
  const pictureRefs = [...output.matchAll(/<Picture\s+(\d+)>/giu)].map((match) => Number(match[1]));
  if (pictureRefs.some((index) => index < 1 || index > pictureCount)) {
    throw new Error(`提示词中的图片编号超出范围，本次共有 ${pictureCount} 张参考图`);
  }
  const missingPictures = Array.from({ length: pictureCount }, (_, index) => index + 1)
    .filter((index) => !pictureRefs.includes(index));
  if (missingPictures.length > 0) {
    const binding = missingPictures.map((index) => `<Picture ${index}>`).join("、");
    output = `${binding} 作为本次视频的角色、产品或场景参考，保持主体身份和关键外观一致。\n${output}`;
  }
  if (hasAudio && !/<Audio\s+1>/iu.test(output)) {
    output = `<Audio 1> 作为环境音效或音乐节奏参考，不生成语音或口播。\n${output}`;
  }
  return output;
}

function normalizeStatus(value: unknown): VideoTaskResult["status"] {
  const status = String(value || "").toLowerCase();
  if (["completed", "success", "succeeded", "done"].includes(status)) return "success";
  if (["failed", "error", "cancelled", "canceled", "terminated"].includes(status)) return "failed";
  if (["queued", "pending"].includes(status)) return "queued";
  return "processing";
}

function returnedVideoUrl(data: Record<string, unknown>) {
  const paths = ["video_url", "data.video_url", "video.url", "data.video.url", "output.url"];
  for (const path of paths) {
    const value = getByPath(data, path);
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function wasDowngradedFrom2K(data: Record<string, unknown>) {
  const booleanSignals = [
    getByPath(data, "degraded"),
    getByPath(data, "downgraded"),
    getByPath(data, "data.degraded"),
    getByPath(data, "data.downgraded"),
  ];
  if (booleanSignals.some((value) => value === true)) return true;

  const textSignals = [
    getByPath(data, "resolution"),
    getByPath(data, "actual_resolution"),
    getByPath(data, "fallback_resolution"),
    getByPath(data, "degraded_to"),
    getByPath(data, "model"),
    getByPath(data, "data.resolution"),
    getByPath(data, "data.actual_resolution"),
  ].map((value) => String(value || "").toLowerCase());
  if (textSignals.some((value) => value.includes("768"))) return true;

  const width = Number(getByPath(data, "width") || getByPath(data, "data.width") || getByPath(data, "video.width"));
  const height = Number(getByPath(data, "height") || getByPath(data, "data.height") || getByPath(data, "video.height"));
  return width > 0 && height > 0 && Math.max(width, height) <= 1344;
}

export async function generateSuanlichengVideo(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Promise<VideoTaskResult> {
  const modelName = String(config.model_name || "");
  if (!H3_MODELS.has(modelName)) {
    return { taskId: "", status: "failed", error: `算力橙协议不支持模型：${modelName || "未配置"}` };
  }

  const imageUrls = [params.imageUrl, params.referenceImageUrl, params.lastFrameUrl, ...(params.imageUrls || [])]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  if (imageUrls.length === 0) {
    return { taskId: "", status: "failed", error: "MiniMax-H3 必须提供至少一张参考图" };
  }
  const audioUrl = params.audioUrl || params.audioUrls?.find(Boolean);
  if (modelName.endsWith("2K") && audioUrl) {
    return { taskId: "", status: "failed", error: "算力橙 MiniMax-H3 2K 不支持音频参考，请移除音频或改用 768P" };
  }

  const duration = Number(params.duration || config.duration_seconds || 5);
  const frames = H3_FRAME_MAP.get(duration);
  if (!frames) {
    return { taskId: "", status: "failed", error: "算力橙 MiniMax-H3 仅支持 5 秒、10 秒或 15 秒" };
  }
  const canvas = H3_CANVAS_MAP[params.aspectRatio || "16:9"];
  if (!canvas) {
    return { taskId: "", status: "failed", error: "算力橙 MiniMax-H3 仅支持 16:9、9:16 或 1:1" };
  }

  let generationDispatched = false;
  try {
    const materials = await Promise.all(imageUrls.map((url) => uploadMaterial(config, url, "image", params.inputOwnerId)));
    const audioReferences = audioUrl
      ? [await uploadMaterial(config, audioUrl, "audio", params.inputOwnerId)]
      : [];
    const prompt = bindPictureReferences(params.prompt.trim(), materials.length, audioReferences.length > 0);
    const idempotencyKey = params.idempotencyKey || globalThis.crypto.randomUUID();
    const seedArray = new Uint32Array(1);
    globalThis.crypto.getRandomValues(seedArray);

    const body: Record<string, unknown> = {
      task: "multi_reference_to_video",
      model: modelName,
      prompt,
      materials,
      idempotency_key: idempotencyKey,
      frames,
      seed: seedArray[0],
      width: canvas.width,
      height: canvas.height,
    };
    if (audioReferences.length > 0) body.audio_references = audioReferences;

    generationDispatched = true;
    const response = await fetch(buildOpenAIEndpoint(config.api_endpoint, "h3/videos/generations"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const data = await readJson(response);
    if (!response.ok) {
      return {
        taskId: "",
        status: response.status >= 500 || response.status === 408 ? "processing" : "failed",
        ...(response.status >= 500 || response.status === 408 ? { submissionOutcome: "unknown" as const } : {}),
        error: `算力橙视频提交失败（HTTP ${response.status}）：${providerMessage(data) || "未知错误"}`,
      };
    }

    const taskId = String(data.task_id || data.id || getByPath(data, "data.task_id") || getByPath(data, "data.id") || "");
    if (!taskId) {
      if (normalizeStatus(data.status || getByPath(data, "data.status")) === "failed") {
        return { taskId: "", status: "failed", error: providerMessage(data) || "算力橙已明确拒绝生成任务" };
      }
      return { taskId: "", status: "processing", submissionOutcome: "unknown", error: "算力橙提交结果未包含任务编号，正在确认原任务" };
    }
    return {
      taskId,
      status: normalizeStatus(data.status || getByPath(data, "data.status") || "queued"),
      progress: typeof data.progress === "number" ? data.progress : null,
    };
  } catch (error) {
    return {
      taskId: "",
      status: generationDispatched ? "processing" : "failed",
      ...(generationDispatched ? { submissionOutcome: "unknown" as const } : {}),
      error: error instanceof Error ? error.message : "算力橙视频提交失败",
    };
  }
}

export async function pollSuanlichengVideo(
  config: VideoModelConfig,
  taskId: string,
): Promise<VideoTaskResult> {
  const pollUrl = buildOpenAIEndpoint(config.api_endpoint, `h3/videos/generations/${encodeURIComponent(taskId)}`);
  let response: Response;
  try {
    response = await fetch(pollUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { taskId, status: "processing", progress: null, error: "算力橙状态查询暂时不可达，正在重试" };
  }

  const data = await readJson(response);
  if (!response.ok) {
    // A failed query does not establish a failed paid generation. Keep the same task.
    return { taskId, status: "processing", progress: null, error: "算力橙状态查询暂不可用，正在确认原任务" };
  }

  const status = normalizeStatus(data.status || getByPath(data, "data.status"));
  if (status === "failed") {
    return { taskId, status, error: providerMessage(data) || "算力橙视频生成失败" };
  }
  if (status !== "success") {
    const progress = Number(data.progress ?? getByPath(data, "data.progress"));
    return { taskId, status, progress: Number.isFinite(progress) ? progress : null };
  }

  if (String(config.model_name || "").endsWith("2K") && wasDowngradedFrom2K(data)) {
    return {
      taskId,
      status: "failed",
      error: "供应商将 2K 任务降为 768P，系统已按无降级策略拒绝交付和扣费",
    };
  }

  const contentUrl = buildOpenAIEndpoint(config.api_endpoint, `h3/videos/generations/${encodeURIComponent(taskId)}/content`);
  return {
    taskId,
    status: "success",
    videoUrl: resolveVideoProviderResultUrl(returnedVideoUrl(data) || contentUrl, config.api_endpoint),
    progress: 1,
    needsProxy: true,
  };
}
