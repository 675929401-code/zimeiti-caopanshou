import { StoryboardChainRequestSchema, type StoryboardChainRequest } from "@/lib/storyboard-chain-contract";
const MAX_IMAGE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_REFERENCES = 9;
const MAX_PROMPT_CHARACTERS = 12_000;
const MAX_STYLE_CHARACTERS = 256;
const MAX_HTTP_REFERENCE_CHARACTERS = 4_096;
const MAX_DATA_REFERENCE_CHARACTERS = 28 * 1024 * 1024;
import { isRestorableImageExactText, isValidImageExactText, STORYBOARD_ANNOTATION_TEXT_MAX_LENGTH } from "@/lib/storyboard-annotation-layout";
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const STABLE_KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const ASPECT_RATIOS = new Set(["3:4", "9:16", "4:3", "16:9", "1:1"]);
const RESOLUTIONS = new Set(["0.5K", "1K", "2K", "3K", "4K"]);
const HISTORY_SURFACES = new Set([
  "publish-center-image",
  "image-workbench",
  "cover-studio",
  "storyboard-workbench",
  "free-canvas",
  "short-drama-film-studio",
]);
const IMAGE_PUBLIC_REQUEST_FIELDS = new Set([
  "prompt", "modelId", "style", "mode", "aspectRatio", "resolution", "coverText",
  "referenceImageUrls", "referenceUsage", "imageUrl", "clientTraceId", "clientIdempotencyKey",
  "clientNodeId", "clientNodeTitle", "historySurface", "noRetry", "strictSingleSubmit",
  "resumeDeliveryOnly", "adminValidation", "deliveryRequirement", "presetReferences", "chainContext",
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
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 格式无效`, 422);
  }
  const normalized = value.trim();
  if (!options.allowEmpty && !normalized) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 不能为空`, 422);
  }
  if (normalized.length > maximum || (options.controls !== false && CONTROL_CHARACTERS.test(normalized))) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 长度或字符格式无效`, 422);
  }
  return normalized;
}

function optionalBoolean(value: unknown, field: string) {
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    throw new ImageGenerationInputError("IMAGE_REQUEST_FIELD_INVALID", `${field} 必须是布尔值`, 422);
  }
  return value;
}

function normalizeReference(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 必须是图片 URL 或图片数据`, 422);
  }
  const reference = value.trim();
  if (!reference) {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 不能为空`, 422);
  }
  if (/^data:/iu.test(reference)) {
    if (reference.length > MAX_DATA_REFERENCE_CHARACTERS
      || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/iu.test(reference)) {
      throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 图片数据格式或大小无效`, 422);
    }
    return reference;
  }
  if (reference.length > MAX_HTTP_REFERENCE_CHARACTERS) {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} URL 过长`, 422);
  }
  try {
    const parsed = new URL(reference);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid");
    return parsed.href;
  } catch {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", `${field} 必须是有效的 HTTP(S) 图片 URL`, 422);
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
  chainContext?: StoryboardChainRequest;
  prompt: string;
  modelId?: string;
  style?: string;
  mode?: "local" | "workflow";
  aspectRatio?: string;
  resolution?: string;
  coverText?: string;
  referenceImageUrls: string[];
  presetReferences?: ImagePresetReference[];
  referenceUsage?: "general" | "character-identity";
  imageUrl?: string;
  clientTraceId?: string;
  clientIdempotencyKey?: string;
  clientNodeId?: string;
  clientNodeTitle?: string;
  historySurface?: "publish-center-image" | "image-workbench" | "cover-studio" | "storyboard-workbench" | "free-canvas" | "short-drama-film-studio";
  noRetry?: boolean;
  strictSingleSubmit?: boolean;
  resumeDeliveryOnly?: boolean;
  deliveryRequirement?: "recoverable_reference";
  adminValidation?: Record<string, unknown>;
};

export type ImagePresetReference = { presetId: string; revision: number; referenceIndex: number };

export function normalizeImageGenerationInput(value: unknown): NormalizedImageGenerationInput {
  if (!plainObject(value)) {
    throw new ImageGenerationInputError("IMAGE_REQUEST_BODY_INVALID", "生图请求体必须是 JSON 对象");
  }
  const unsupportedFields = Object.keys(value).filter((field) => !IMAGE_PUBLIC_REQUEST_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new ImageGenerationInputError(
      "IMAGE_REQUEST_FIELD_UNSUPPORTED",
      `当前生图协议不支持参数：${unsupportedFields.sort().join("、")}`,
      422,
    );
  }
  const chain = value.chainContext === undefined ? undefined : StoryboardChainRequestSchema.safeParse(value.chainContext);
  if (chain && (!chain.success || value.historySurface !== "storyboard-workbench")) throw new ImageGenerationInputError("STORYBOARD_CHAIN_CONTEXT_INVALID", "串联请求合同无效", 422);
  const chainContext = chain?.success ? chain.data : undefined;
  const prompt = optionalString(value.prompt, "提示词", MAX_PROMPT_CHARACTERS);
  if (!prompt) throw new ImageGenerationInputError("IMAGE_PROMPT_REQUIRED", "提示词不能为空", 422);
  const modelId = optionalString(value.modelId, "模型标识", 240);
  const style = optionalString(value.style, "风格", MAX_STYLE_CHARACTERS, { allowEmpty: true });
  // Storyboards use the complete authored prompt. Ignore retired layout fields
  // from saved cards/older clients; accepted delivery recovery keeps its snapshot.
  const promptOnlyStoryboard = value.historySurface === "storyboard-workbench" && value.resumeDeliveryOnly !== true;
  const coverText = promptOnlyStoryboard ? undefined
    : optionalString(value.coverText, "精确画面文字", STORYBOARD_ANNOTATION_TEXT_MAX_LENGTH, { allowEmpty: true });
  if (coverText !== undefined && !(value.resumeDeliveryOnly === true ? isRestorableImageExactText(coverText) : isValidImageExactText(coverText))) {
    throw new ImageGenerationInputError("IMAGE_EXACT_TEXT_INVALID", "精确文案最多200字；故事板注释必须是2048字以内的完整四格协议", 422);
  }
  const mode = optionalString(value.mode, "生成模式", 16) as "local" | "workflow" | undefined;
  if (mode && mode !== "local" && mode !== "workflow") {
    throw new ImageGenerationInputError("IMAGE_MODE_UNSUPPORTED", "图片生成模式不受支持", 422);
  }
  const aspectRatio = optionalString(value.aspectRatio, "图片画幅", 8);
  if (aspectRatio && !ASPECT_RATIOS.has(aspectRatio)) {
    throw new ImageGenerationInputError("IMAGE_ASPECT_RATIO_UNSUPPORTED", "图片画幅不受支持", 422);
  }
  const rawResolution = optionalString(value.resolution, "图片分辨率", 8);
  const resolution = rawResolution?.toUpperCase();
  if (resolution && !RESOLUTIONS.has(resolution)) {
    throw new ImageGenerationInputError("IMAGE_RESOLUTION_UNSUPPORTED", "图片分辨率格式不受支持", 422);
  }
  const referenceUsage = optionalString(value.referenceUsage, "参考图用途", 32) as "general" | "character-identity" | undefined;
  if (referenceUsage && referenceUsage !== "general" && referenceUsage !== "character-identity") {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_USAGE_INVALID", "参考图用途不受支持", 422);
  }
  if (value.referenceImageUrls != null && !Array.isArray(value.referenceImageUrls)) {
    throw new ImageGenerationInputError("IMAGE_REFERENCE_INVALID", "参考图列表必须是数组", 422);
  }
  const submittedReferences = Array.isArray(value.referenceImageUrls) ? value.referenceImageUrls : [];
  const hasInputImage = value.imageUrl != null;
  if (submittedReferences.length + (hasInputImage ? 1 : 0) > MAX_IMAGE_REFERENCES) {
    throw new ImageGenerationInputError(
      "IMAGE_REFERENCE_LIMIT_EXCEEDED",
      `单次最多提交 ${MAX_IMAGE_REFERENCES} 张参考图，当前提交了 ${submittedReferences.length + (hasInputImage ? 1 : 0)} 张`,
      422,
    );
  }
  const normalizedReferences = submittedReferences.map((reference, index) =>
    normalizeReference(reference, `第 ${index + 1} 张参考图`));
  const imageUrl = hasInputImage ? normalizeReference(value.imageUrl, "输入图片") : undefined;
  const referenceImageUrls = [...new Set([...normalizedReferences, ...(imageUrl ? [imageUrl] : [])])];
  const presetReferences: ImagePresetReference[] = [];
  if (value.presetReferences !== undefined) {
    if (!Array.isArray(value.presetReferences) || value.presetReferences.length > MAX_IMAGE_REFERENCES) throw new ImageGenerationInputError("IMAGE_PRESET_REFERENCE_INVALID", "预设参考列表无效", 422);
    const indices = new Set<number>();
    for (const ref of value.presetReferences) {
      if (!plainObject(ref) || Object.keys(ref).some(key => !["presetId", "revision", "referenceIndex"].includes(key))
        || typeof ref.presetId !== "string" || !/^preset-[a-z0-9][a-z0-9_-]{2,63}$/u.test(ref.presetId)
        || !Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1 || !Number.isSafeInteger(ref.referenceIndex)
        || Number(ref.referenceIndex) < 0 || Number(ref.referenceIndex) >= referenceImageUrls.length || indices.has(Number(ref.referenceIndex))) {
        throw new ImageGenerationInputError("IMAGE_PRESET_REFERENCE_INVALID", "预设标识、版本或图片位置无效", 422);
      }
      indices.add(Number(ref.referenceIndex)); presetReferences.push({ presetId: ref.presetId, revision: Number(ref.revision), referenceIndex: Number(ref.referenceIndex) });
    }
  }

  const clientTraceId = optionalString(value.clientTraceId, "图片生成追踪键", 128, { allowEmpty: true, controls: false });
  if (clientTraceId && !STABLE_KEY.test(clientTraceId)) {
    throw new ImageGenerationInputError("IMAGE_TRACE_ID_INVALID", "图片生成追踪键格式无效", 422);
  }
  const clientIdempotencyKey = optionalString(value.clientIdempotencyKey, "图片生成幂等键", 128, { allowEmpty: true, controls: false });
  if (clientIdempotencyKey && !STABLE_KEY.test(clientIdempotencyKey)) {
    throw new ImageGenerationInputError("IMAGE_IDEMPOTENCY_KEY_INVALID", "图片生成幂等键格式无效", 422);
  }
  const clientNodeId = optionalString(value.clientNodeId, "节点标识", 128, { allowEmpty: true });
  const clientNodeTitle = optionalString(value.clientNodeTitle, "节点标题", 240, { allowEmpty: true });
  const historySurface = optionalString(value.historySurface, "历史来源", 64) as NormalizedImageGenerationInput["historySurface"];
  if (historySurface && !HISTORY_SURFACES.has(historySurface)) {
    throw new ImageGenerationInputError("IMAGE_HISTORY_SURFACE_INVALID", "图片历史来源不受支持", 422);
  }
  const noRetry = optionalBoolean(value.noRetry, "noRetry");
  const strictSingleSubmit = optionalBoolean(value.strictSingleSubmit, "strictSingleSubmit");
  const resumeDeliveryOnly = optionalBoolean(value.resumeDeliveryOnly, "resumeDeliveryOnly");
  if (value.deliveryRequirement !== undefined && value.deliveryRequirement !== "recoverable_reference") {
    throw new ImageGenerationInputError("IMAGE_DELIVERY_REQUIREMENT_INVALID", "图片交付用途不受支持", 422);
  }
  if (value.adminValidation != null && !plainObject(value.adminValidation)) {
    throw new ImageGenerationInputError("IMAGE_ADMIN_VALIDATION_INVALID", "图片验证参数格式无效", 422);
  }

  return {
    ...(chainContext ? { chainContext } : {}),
    prompt,
    ...(modelId ? { modelId } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(mode ? { mode } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(coverText !== undefined ? { coverText } : {}),
    referenceImageUrls,
    ...(presetReferences.length ? { presetReferences } : {}),
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
    ...(value.deliveryRequirement === "recoverable_reference" ? { deliveryRequirement: "recoverable_reference" as const } : {}),
    ...(value.adminValidation ? { adminValidation: value.adminValidation } : {}),
  };
}

export async function readImageGenerationInput(request: Request, options?: { onWireRequest?: (value: unknown) => void; transformWireRequest?: (value: unknown) => Promise<unknown> }) {
  const bytes = await readRequestBytes(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImageGenerationInputError("IMAGE_REQUEST_BODY_INVALID", "生图请求体不是有效 JSON");
  }
  options?.onWireRequest?.(parsed);
  return normalizeImageGenerationInput(options?.transformWireRequest ? await options.transformWireRequest(parsed) : parsed);
}

export const IMAGE_GENERATION_REQUEST_LIMITS = {
  maxRequestBytes: MAX_IMAGE_REQUEST_BYTES,
  maxReferences: MAX_IMAGE_REFERENCES,
  maxPromptCharacters: MAX_PROMPT_CHARACTERS,
  maxStyleCharacters: MAX_STYLE_CHARACTERS,
} as const;
