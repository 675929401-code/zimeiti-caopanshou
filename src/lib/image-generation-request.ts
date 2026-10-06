const MAX_IMAGE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_REFERENCES = 9;
const MAX_PROMPT_CHARACTERS = 12_000;
const MAX_STYLE_CHARACTERS = 256;
const MAX_HTTP_REFERENCE_CHARACTERS = 4_096;
const MAX_DATA_REFERENCE_CHARACTERS = 28 * 1024 * 1024;

const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const STABLE_KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const ASPECT_RATIOS = new Set(["3:4", "9:16", "4:3", "16:9", "1:1"]);
const RESOLUTIONS = new Set(["0.5K", "1K", "2K", "3K", "4K"]);
const HISTORY_SURFACES = new Set([
  "image-workbench",
  "cover-studio",
  "storyboard-workbench",
  "free-canvas",
  "short-drama-film-studio",
]);

export class ImageGenerationInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "ImageGenerationInputError";
    this.code = code;
    this.status = status;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalString(
  value: unknown,
  field: string,
  maximum: number,
  options: { allowEmpty?: boolean; controls?: boolean } = {},
) {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 格式无效`);
  }
  const normalized = value.trim();
  if (!options.allowEmpty && !normalized) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 不能为空`);
  }
  if (normalized.length > maximum || (options.controls !== false && CONTROL_CHARACTERS.test(normalized))) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 长度或字符格式无效`);
  }
  return normalized;
}

function optionalBoolean(value: unknown, field: string) {
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 必须是布尔值`);
  }
  return value;
}

function normalizeReference(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 必须是图片 URL 或图片数据`);
  }
  const reference = value.trim();
  if (!reference) {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 不能为空`);
  }
  if (/^data:/iu.test(reference)) {
    if (reference.length > MAX_DATA_REFERENCE_CHARACTERS
      || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/iu.test(reference)) {
      throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 图片数据格式或大小无效`);
    }
    return reference;
  }
  if (reference.length > MAX_HTTP_REFERENCE_CHARACTERS) {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} URL 过长`);
  }
  try {
    const parsed = new URL(reference);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid");
    return parsed.href;
  } catch {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 必须是有效的 HTTP(S) 图片 URL`);
  }
}

async function readRequestBytes(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_REQUEST_BYTES) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_TOO_LARGE", "生图请求体超过 32MB", 413);
  }
  if (!request.body) throw new ImageGenerationInputError("IMAGE_REQUEST_BODY_INVALID", "生图请求体不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > MAX_IMAGE_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ImageGenerationInputError("IMAGE_REQUEST_TOO_LARGE", "生图请求体超过 32MB", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type NormalizedImageGenerationInput = {
  prompt: string;
  modelId?: string;
  style?: string;
  mode?: "local" | "workflow";
  aspectRatio?: string;
  resolution?: string;
  coverText?: string;
  referenceImageUrls: string[];
  referenceUsage?: "general" | "character-identity";
  imageUrl?: string;
  clientTraceId?: string;
  clientIdempotencyKey?: string;
  clientNodeId?: string;
  clientNodeTitle?: string;
  historySurface?: "image-workbench" | "cover-studio" | "storyboard-workbench" | "free-canvas" | "short-drama-film-studio";
  noRetry?: boolean;
  strictSingleSubmit?: boolean;
  resumeDeliveryOnly?: boolean;
  adminValidation?: Record<string, unknown>;
};

export function normalizeImageGenerationInput(value: unknown): NormalizedImageGenerationInput {
  if (!plainObject(value)) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_BODY_INVALID", "生图请求体必须是 JSON 对象");
  }
  const prompt = optionalString(value.prompt, "提示词", MAX_PROMPT_CHARACTERS);
  if (!prompt) throw new ImageGenerationInputError("IMAGE_PROMPT_REQUIRED", "提示词不能为空");
  const modelId = optionalString(value.modelId, "模型标识", 240);
  const style = optionalString(value.style, "风格", MAX_STYLE_CHARACTERS, { allowEmpty: true });
  const coverText = optionalString(value.coverText, "精确画面文字", 200, { allowEmpty: true });
  const mode = optionalString(value.mode, "生成模式", 16) as "local" | "workflow" | undefined;
  if (mode && mode !== "local" && mode !== "workflow") {
    throw new ImageGenerationInputError("IMAGE_MODE_UNSUPPORTED", "图片生成模式不受支持");
  }
  const aspectRatio = optionalString(value.aspectRatio, "图片画幅", 8);
  if (aspectRatio && !ASPECT_RATIOS.has(aspectRatio)) {
    throw new ImageGenerationInputError("IMAGE_ASPECT_RATIO_UNSUPPORTED", "图片画幅不受支持");
  }
  const rawResolution = optionalString(value.resolution, "图片分辨率", 8);
  const resolution = rawResolution?.toUpperCase();
  if (resolution && !RESOLUTIONS.has(resolution)) {
    throw new ImageGenerationInputError("IMAGE_RESOLUTION_UNSUPPORTED", "图片分辨率格式不受支持");
  }
  const referenceUsage = optionalString(value.referenceUsage, "参考图用途", 32) as "general" | "character-identity" | undefined;
  if (referenceUsage && referenceUsage !== "general" && referenceUsage !== "character-identity") {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_USAGE_INVALID", "参考图用途不受支持");
  }
  if (value.referenceImageUrls != null && !Array.isArray(value.referenceImageUrls)) {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", "参考图列表必须是数组");
  }
  const submittedReferences = Array.isArray(value.referenceImageUrls) ? value.referenceImageUrls : [];
  const hasInputImage = value.imageUrl != null;
  if (submittedReferences.length + (hasInputImage ? 1 : 0) > MAX_IMAGE_REFERENCES) {
    throw new ImageGenerationInputError(
      "IMAGE_REFERENCE_LIMIT_EXCEEDED",
      `单次最多提交 ${MAX_IMAGE_REFERENCES} 张参考图，当前提交了 ${submittedReferences.length + (hasInputImage ? 1 : 0)} 张`,
    );
  }
  const normalizedReferences = submittedReferences.map((reference, index) =>
    normalizeReference(reference, `第 ${index + 1} 张参考图`));
  const imageUrl = hasInputImage ? normalizeReference(value.imageUrl, "输入图片") : undefined;
  const referenceImageUrls = [...new Set([...normalizedReferences, ...(imageUrl ? [imageUrl] : [])])];

  const clientTraceId = optionalString(value.clientTraceId, "图片生成追踪键", 128, { allowEmpty: true, controls: false });
  if (clientTraceId && !STABLE_KEY.test(clientTraceId)) {
    throw new ImageGenerationInputError("IMAGE_TRACE_ID_INVALID", "图片生成追踪键格式无效");
  }
  const clientIdempotencyKey = optionalString(value.clientIdempotencyKey, "图片生成幂等键", 128, { allowEmpty: true, controls: false });
  if (clientIdempotencyKey && !STABLE_KEY.test(clientIdempotencyKey)) {
    throw new ImageGenerationInputError("IMAGE_IDEMPOTENCY_KEY_INVALID", "图片生成幂等键格式无效");
  }
  const clientNodeId = optionalString(value.clientNodeId, "节点标识", 128, { allowEmpty: true });
  const clientNodeTitle = optionalString(value.clientNodeTitle, "节点标题", 240, { allowEmpty: true });
  const historySurface = optionalString(value.historySurface, "历史来源", 64) as NormalizedImageGenerationInput["historySurface"];
  if (historySurface && !HISTORY_SURFACES.has(historySurface)) {
    throw new ImageGenerationInputError("IMAGE_HISTORY_SURFACE_INVALID", "图片历史来源不受支持");
  }
  const noRetry = optionalBoolean(value.noRetry, "noRetry");
  const strictSingleSubmit = optionalBoolean(value.strictSingleSubmit, "strictSingleSubmit");
  const resumeDeliveryOnly = optionalBoolean(value.resumeDeliveryOnly, "resumeDeliveryOnly");
  if (value.adminValidation != null && !plainObject(value.adminValidation)) {
    throw new ImageGenerationInputError("IMAGE_ADMIN_VALIDATION_INVALID", "图片验证参数格式无效");
  }

  return {
    prompt,
    ...(modelId ? { modelId } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(mode ? { mode } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(coverText !== undefined ? { coverText } : {}),
    referenceImageUrls,
    ...(referenceUsage ? { referenceUsage } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(clientTraceId ? { clientTraceId } : {}),
    ...(clientIdempotencyKey ? { clientIdempotencyKey } : {}),
    ...(clientNodeId !== undefined ? { clientNodeId } : {}),
    ...(clientNodeTitle !== undefined ? { clientNodeTitle } : {}),
    ...(historySurface ? { historySurface } : {}),
    ...(noRetry !== undefined ? { noRetry } : {}),
    ...(strictSingleSubmit !== undefined ? { strictSingleSubmit } : {}),
    ...(resumeDeliveryOnly !== undefined ? { resumeDeliveryOnly } : {}),
    ...(value.adminValidation ? { adminValidation: value.adminValidation } : {}),
  };
}

export async function readImageGenerationInput(request: Request) {
  const bytes = await readRequestBytes(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImageGenerationInputError("IMAGE_REQUEST_BODY_INVALID", "生图请求体不是有效 JSON");
  }
  return normalizeImageGenerationInput(parsed);
}

export const IMAGE_GENERATION_REQUEST_LIMITS = {
  maxRequestBytes: MAX_IMAGE_REQUEST_BYTES,
  maxReferences: MAX_IMAGE_REFERENCES,
  maxPromptCharacters: MAX_PROMPT_CHARACTERS,
  maxStyleCharacters: MAX_STYLE_CHARACTERS,
} as const;
