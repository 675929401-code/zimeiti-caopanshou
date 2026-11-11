import { getImageModelCapabilities } from "@/lib/image-model-capabilities";
import {
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
} from "@/lib/video-model-capabilities";
import { getVideoInputContract } from "@/lib/video-input-contract";
import { isDigitalHumanWorkspaceModel } from "@/lib/video-model-surface";

export type WorkspaceModelKind = "image" | "video";
export type WorkspaceModelSurface =
  | "publish-center-image"
  | "publish-center-video"
  | "image-workbench"
  | "cover-studio"
  | "storyboard-image"
  | "storyboard-video"
  | "free-canvas-image"
  | "free-canvas-video"
  | "film-studio-image"
  | "film-studio-video"
  | "commerce-video"
  | "video-page";

export type WorkspaceModelIssue = {
  code: string;
  message: string;
};

export type WorkspaceModelCompatibility = {
  compatible: boolean;
  issues: WorkspaceModelIssue[];
  warnings: WorkspaceModelIssue[];
  capabilityLabels: string[];
};

export const WORKSPACE_MODEL_SURFACES: ReadonlyArray<{
  id: WorkspaceModelSurface;
  kind: WorkspaceModelKind;
  label: string;
  description: string;
  storageValue: string;
}> = [
  {
    id: "image-workbench",
    kind: "image",
    label: "图片创作 · 生图",
    description: "按图片模型的参考图、分辨率和画幅能力组织生成。",
    storageValue: "image-workbench",
  },
  {
    id: "cover-studio",
    kind: "image",
    label: "封面制作 · 生图",
    description: "用于动画、商品和参考封面的图片制作；原图排版保留上传图片。",
    storageValue: "cover-studio",
  },
  {
    id: "storyboard-image",
    kind: "image",
    label: "分镜工作台 · 生图",
    description: "生成故事板图片，并把实际画幅与像素交给后续视频链路。",
    storageValue: "storyboard-workbench",
  },
  {
    id: "free-canvas-image",
    kind: "image",
    label: "无限画布 · 生图",
    description: "画布图片节点使用的模型目录和独立排序。",
    storageValue: "free-canvas",
  },
  {
    id: "free-canvas-video",
    kind: "video",
    label: "无限画布 · 生视频",
    description: "支持画布提供的提示词、图片、首尾帧和音频输入；强制源视频模型不进入此槽位。",
    storageValue: "free-canvas",
  },
  {
    id: "film-studio-image",
    kind: "image",
    label: "影视工坊 · 生图",
    description: "实体图和镜头关键帧使用的生图模型。",
    storageValue: "film-studio",
  },
  {
    id: "film-studio-video",
    kind: "video",
    label: "影视工坊 · 生视频",
    description: "必须接收当前镜头的一张关键帧，不能强制尾帧、源视频或音频。",
    storageValue: "film-studio",
  },
  {
    id: "storyboard-video",
    kind: "video",
    label: "分镜工作台 · 生视频",
    description: "按模型能力提供提示词、分镜图、首尾帧、参考图片、音频和源视频；逐段校验素材后提交。",
    storageValue: "storyboard",
  },
  {
    id: "commerce-video",
    kind: "video",
    label: "带货 Agent · 爆款视频复刻",
    description: "只接收至少 5 张参考图的多参考视频模型；普通单图和纯文生视频模型留在资源池，但不会进入本槽位。",
    storageValue: "commerce-agent",
  },
  {
    id: "video-page",
    kind: "video",
    label: "主站视频制作",
    description: "按模型能力动态展示首尾帧、参考图、音频、源视频、时长和清晰度。",
    storageValue: "ai-video",
  },
  {
    id: "publish-center-image", kind: "image", label: "发布中心 · 生图",
    description: "主站发布中心的明确用户动作；模型目录展示与场景执行准入分别管理。",
    storageValue: "publish-center-image",
  },
  {
    id: "publish-center-video", kind: "video", label: "发布中心 · 生视频",
    description: "主站发布中心的明确用户动作；每次执行须绑定原生动作及冻结预算。",
    storageValue: "publish-center-video",
  },
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function declaredInputLimitsConflict(minimum: unknown, maximum: unknown) {
  if (minimum === undefined || minimum === null || maximum === undefined || maximum === null) return false;
  const min = Number(minimum);
  const max = Number(maximum);
  return Number.isFinite(min) && Number.isFinite(max) && min > max;
}

function surfaceDefinition(surface: WorkspaceModelSurface) {
  return WORKSPACE_MODEL_SURFACES.find((entry) => entry.id === surface) || null;
}

export function normalizeWorkspaceModelAssignments(kind: WorkspaceModelKind, value: unknown): string[] {
  const source = Array.isArray(value) ? value.map(String) : [];
  return unique(source.map((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (kind === "video") {
      if (normalized === "video-page") return "ai-video";
      if (normalized === "storyboard-workbench") return "storyboard";
    } else if (normalized === "storyboard") {
      return "storyboard-workbench";
    }
    return normalized;
  }));
}

export function workspaceModelAssignments(kind: WorkspaceModelKind, model: Record<string, unknown>): string[] {
  const config = record(model.api_protocol_config);
  return normalizeWorkspaceModelAssignments(kind, config.workspace_surfaces);
}

export function isModelAssignedToWorkspace(
  kind: WorkspaceModelKind,
  model: Record<string, unknown>,
  surface: WorkspaceModelSurface,
) {
  const definition = surfaceDefinition(surface);
  return Boolean(definition && definition.kind === kind
    && workspaceModelAssignments(kind, model).includes(definition.storageValue));
}

export function withWorkspaceModelAssignment(
  kind: WorkspaceModelKind,
  model: Record<string, unknown>,
  surface: WorkspaceModelSurface,
  enabled: boolean,
) {
  const definition = surfaceDefinition(surface);
  if (!definition || definition.kind !== kind) throw new Error("工作台与模型类型不匹配");
  const config = record(model.api_protocol_config);
  const current = workspaceModelAssignments(kind, model);
  const workspaceSurfaces = enabled
    ? unique([...current, definition.storageValue])
    : current.filter((value) => value !== definition.storageValue);
  return { ...config, workspace_surfaces: workspaceSurfaces };
}

export function imageWorkspaceSurfaceFromRequest(value: unknown): WorkspaceModelSurface | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "publish-center-image") return "publish-center-image";
  if (normalized === "image-workbench") return "image-workbench";
  if (normalized === "cover-studio" || normalized === "cover") return "cover-studio";
  if (normalized === "storyboard-workbench" || normalized === "storyboard") return "storyboard-image";
  if (normalized === "free-canvas" || normalized === "canvas") return "free-canvas-image";
  if (["film-studio", "short-drama-film-studio", "film_entity", "film-entity"].includes(normalized)) return "film-studio-image";
  return null;
}

export function videoWorkspaceSurfaceFromRequest(value: unknown): WorkspaceModelSurface | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "publish-center-video") return "publish-center-video";
  if (normalized === "storyboard-workbench" || normalized === "storyboard") return "storyboard-video";
  if (normalized === "video-page" || normalized === "ai-video") return "video-page";
  if (normalized === "commerce-agent" || normalized === "commerce" || normalized === "commerce-video") return "commerce-video";
  if (normalized === "free-canvas" || normalized === "canvas") return "free-canvas-video";
  if (["film-studio", "short-drama-film-studio", "film_video", "film-video"].includes(normalized)) return "film-studio-video";
  return null;
}

export function configuredAspectRatios(config: Record<string, unknown>) {
  const value = Array.isArray(config.aspect_ratios)
    ? config.aspect_ratios
    : Array.isArray(config.supported_aspect_ratios)
      ? config.supported_aspect_ratios
      : [];
  return unique(value.map(String));
}

function videoDurationLabel(model: Record<string, unknown>) {
  const duration = getVideoDurationCapabilities(model);
  if (duration.mode === "fixed") return `${duration.defaultDuration}秒`;
  if (duration.mode === "discrete") return duration.nativeDurations.map((value) => `${value}秒`).join("/");
  return `${duration.minDuration}-${duration.maxDuration}秒`;
}

export function evaluateWorkspaceModelCompatibility(
  kind: WorkspaceModelKind,
  model: Record<string, unknown>,
  surface: WorkspaceModelSurface,
): WorkspaceModelCompatibility {
  const definition = surfaceDefinition(surface);
  const issues: WorkspaceModelIssue[] = [];
  const warnings: WorkspaceModelIssue[] = [];
  const capabilityLabels: string[] = [];
  if (!definition || definition.kind !== kind) {
    return {
      compatible: false,
      issues: [{ code: "WORKSPACE_MODEL_KIND_MISMATCH", message: "工作台与模型类型不匹配" }],
      warnings,
      capabilityLabels,
    };
  }

  const config = record(model.api_protocol_config);
  if (kind === "image") {
    const capabilities = getImageModelCapabilities(model);
    const ratios = configuredAspectRatios(config);
    if (config.supports_prompt === false) {
      issues.push({ code: "IMAGE_PROMPT_UNSUPPORTED", message: "该模型未声明支持提示词生图" });
    }
    if (capabilities.resolutionOptions.length === 0) {
      issues.push({ code: "IMAGE_RESOLUTION_UNDECLARED", message: "未配置可用图片分辨率" });
    }
    if (surface === "storyboard-image" && ratios.length > 0
      && !ratios.some((ratio) => ["16:9", "9:16", "1:1"].includes(ratio))) {
      issues.push({ code: "IMAGE_STORYBOARD_RATIO_UNSUPPORTED", message: "模型不支持分镜工作台的 16:9、9:16 或 1:1 画幅" });
    }
    capabilityLabels.push(capabilities.resolutionOptions.join("/"));
    capabilityLabels.push(capabilities.supportsReferenceInput
      ? `参考图≤${capabilities.maxReferenceImages}`
      : "仅文本生图");
    capabilityLabels.push(ratios.length > 0 ? ratios.join("/") : "常用画幅");
    return { compatible: issues.length === 0, issues, warnings, capabilityLabels: unique(capabilityLabels) };
  }

  const input = getVideoInputContract(model);
  const duration = getVideoDurationCapabilities(model);
  const resolution = getVideoResolutionCapabilities(model);
  const ratios = configuredAspectRatios(config);
  const digitalHuman = isDigitalHumanWorkspaceModel(model);
  if (digitalHuman) {
    issues.push({ code: "DEDICATED_DIGITAL_HUMAN_MODEL", message: "数字人、换脸或口型模型只能进入数字人专用工作台" });
  }
  if (duration.maxDuration <= 0) {
    issues.push({ code: "VIDEO_DURATION_INVALID", message: "视频时长能力配置无效" });
  }
  if (input.minReferenceImages > input.maxReferenceImages
    || declaredInputLimitsConflict(config.min_reference_images ?? config.required_reference_images, config.max_reference_images)) {
    issues.push({ code: "VIDEO_IMAGE_LIMIT_CONFLICT", message: "参考图最小数量大于最大数量" });
  }
  if (input.minReferenceAudios > input.maxReferenceAudios
    || declaredInputLimitsConflict(config.min_reference_audios ?? config.required_reference_audios, config.max_reference_audios)) {
    issues.push({ code: "VIDEO_AUDIO_LIMIT_CONFLICT", message: "参考音频最小数量大于最大数量" });
  }
  if (input.requiresSourceVideo && !input.supportsSourceVideoInput) {
    issues.push({ code: "VIDEO_SOURCE_CONTRACT_CONFLICT", message: "模型要求源视频但未声明源视频输入能力" });
  }
  // Storyboard cards now collect the model's declared media inputs. Keep the
  // existing single-keyframe restriction limited to the film workspace.
  if (surface === "film-studio-video") {
    const singleImageLabel = "影视工坊镜头";
    if (input.maxReferenceImages < 1) {
      issues.push({ code: "STORYBOARD_IMAGE_INPUT_REQUIRED", message: `${singleImageLabel}生视频必须支持至少一张图片` });
    }
    if (input.minReferenceImages > 1) {
      issues.push({ code: "STORYBOARD_TOO_MANY_REQUIRED_IMAGES", message: `该模型强制多张参考图，当前${singleImageLabel}只保证一张图片` });
    }
    if (input.requiresLastFrame) {
      issues.push({ code: "STORYBOARD_LAST_FRAME_REQUIRED", message: `该模型强制尾帧，当前${singleImageLabel}未提供尾帧入口` });
    }
    if (input.requiresSourceVideo) {
      issues.push({ code: "STORYBOARD_SOURCE_VIDEO_REQUIRED", message: `该模型强制源视频，不能用于${singleImageLabel}图生视频` });
    }
    if (input.minReferenceAudios > 0) {
      issues.push({ code: "STORYBOARD_AUDIO_REQUIRED", message: `该模型强制参考音频，当前${singleImageLabel}未提供音频入口` });
    }
  }
  if (surface === "free-canvas-video" && input.requiresSourceVideo) {
    issues.push({ code: "CANVAS_SOURCE_VIDEO_REQUIRED", message: "该模型强制源视频，当前无限画布视频节点未提供源视频入口" });
  }
  if (surface === "commerce-video") {
    if (input.maxReferenceImages < 5) {
      issues.push({ code: "COMMERCE_MULTI_REFERENCE_REQUIRED", message: "爆款视频复刻至少需要支持 5 张参考图，单图和首尾帧模型不能加入" });
    }
    if (input.requiresLastFrame) {
      issues.push({ code: "COMMERCE_LAST_FRAME_ONLY", message: "该模型强制尾帧，不能作为多参考复刻模型" });
    }
    if (!input.supportsSourceVideoInput) {
      warnings.push({ code: "COMMERCE_FRAME_REFERENCE_ROUTE", message: "该模型使用源视频拆帧后的多参考图路线，不直接接收源视频文件" });
    }
  }
  capabilityLabels.push(videoDurationLabel(model));
  capabilityLabels.push(resolution.options.length > 0 ? resolution.options.join("/") : "服务商自动清晰度");
  capabilityLabels.push(ratios.length > 0 ? ratios.join("/") : "默认画幅");
  if (input.maxReferenceImages > 0) capabilityLabels.push(`参考图≤${input.maxReferenceImages}`);
  if (input.showLastFrame) capabilityLabels.push("尾帧");
  if (input.showAudioInputs) capabilityLabels.push(`音频≤${input.maxReferenceAudios}`);
  if (input.supportsSourceVideoInput) capabilityLabels.push("源视频");
  if (input.supportsPrompt) capabilityLabels.push("提示词");
  return { compatible: issues.length === 0, issues, warnings, capabilityLabels: unique(capabilityLabels) };
}
