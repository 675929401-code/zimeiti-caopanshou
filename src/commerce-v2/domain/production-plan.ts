import { resolveCommerceVideoDurationPlan } from "../../commerce/shared/video-generation-capabilities";
import {
  COMMERCE_V2_PLAN_SCHEMA,
  type ModelCapabilityProfile,
  type ProductionDraft,
  type ProductionPlan,
  type ProductionSegment,
} from "./contracts";

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function countMaterials(draft: ProductionDraft, kind: "image" | "video" | "audio") {
  return draft.materials.filter((material) => material.kind === kind).length;
}

function includesCaseInsensitive(values: string[], target: string) {
  return values.some((value) => value.toLowerCase() === target.toLowerCase());
}

export function compileProductionPlan(input: {
  planId: string;
  draft: ProductionDraft;
  model: ModelCapabilityProfile;
  configurationIssues?: string[];
}): ProductionPlan {
  const { draft, model } = input;
  if (draft.schema !== "commerce-production-draft/v2") throw new Error("生产草稿协议不受支持");
  if (draft.modelId !== model.id) throw new Error("草稿模型与能力快照不一致");
  if (!draft.prompt.trim() && !draft.director?.script?.trim()) throw new Error("请填写创作要求或应用已确认的编导脚本");

  const configurationIssues: string[] = [...(input.configurationIssues || [])];
  const executionIssues: string[] = [];
  const warnings: string[] = [];
  const capabilities = model.capabilities;
  const imageCount = countMaterials(draft, "image");
  const videoCount = countMaterials(draft, "video");
  const audioCount = countMaterials(draft, "audio");

  if (!model.available) configurationIssues.push("模型当前不可用");
  if (!model.executionReady) executionIssues.push(model.readinessMessage || "模型执行链尚未验收");
  if (imageCount > 0 && !capabilities.supportsImageInput) configurationIssues.push("模型不接收参考图片");
  if (imageCount < capabilities.minReferenceImages) configurationIssues.push(`至少需要 ${capabilities.minReferenceImages} 张参考图片`);
  if (videoCount > 0 && !capabilities.supportsSourceVideoInput) configurationIssues.push("模型不接收源视频");
  if (capabilities.requiresSourceVideo && videoCount === 0) configurationIssues.push("当前模型必须提供源视频");
  if (videoCount > capabilities.maxReferenceVideos) configurationIssues.push(`源视频最多 ${capabilities.maxReferenceVideos} 个`);
  if (audioCount > 0 && !capabilities.supportsAudioInput) configurationIssues.push("模型不接收声音参考");
  if (audioCount > capabilities.maxReferenceAudios) configurationIssues.push(`声音参考最多 ${capabilities.maxReferenceAudios} 个`);

  let settings: ProductionPlan["settings"];
  let segments: ProductionSegment[] = [];
  if (draft.kind === "video") {
    if (!draft.videoSettings) throw new Error("视频设置缺失");
    settings = draft.videoSettings;
    const { aspectRatio, resolution, durationSeconds, generateAudio } = draft.videoSettings;
    if (capabilities.aspectRatios.length && !capabilities.aspectRatios.includes(aspectRatio)) configurationIssues.push(`模型不支持画幅 ${aspectRatio}`);
    if (capabilities.resolutionOptions.length && !includesCaseInsensitive(capabilities.resolutionOptions, resolution)) configurationIssues.push(`模型不支持清晰度 ${resolution}`);
    if (!capabilities.supportsGenerateAudioToggle) configurationIssues.push("模型尚未验证声音开关传输");
    let durationPlan: ReturnType<typeof resolveCommerceVideoDurationPlan> | null = null;
    try {
      durationPlan = resolveCommerceVideoDurationPlan(capabilities, durationSeconds, {
        minimum: 4,
        maximum: 80,
        allowRolling: capabilities.supportsRollingContinuation,
      });
    } catch (error) {
      configurationIssues.push(error instanceof Error ? error.message : "视频时长不受支持");
    }
    if (durationPlan) {
      segments = durationPlan.segments.map((duration, index) => ({
        index,
        durationSeconds: duration,
        continuitySource: index === 0 ? "input" : "previous-final-frame",
      }));
      if (!durationPlan.native) {
        warnings.push(`目标时长将拆成 ${durationPlan.segments.length} 段，并用上一段真实尾帧续接`);
      }
      const rollingReserve = durationPlan.native ? 0 : 1;
      if (imageCount + rollingReserve > capabilities.maxReferenceImages) {
        configurationIssues.push(`滚动续接需预留 1 个尾帧位置；当前模型最多接收 ${capabilities.maxReferenceImages} 张图片`);
      }
    }
    if (generateAudio && !capabilities.supportsGenerateAudioToggle) {
      warnings.push("当前声音意图不会静默降级为模型默认值");
    }
  } else {
    if (!draft.imageSettings) throw new Error("图片设置缺失");
    settings = draft.imageSettings;
    if (capabilities.aspectRatios.length && !capabilities.aspectRatios.includes(draft.imageSettings.aspectRatio)) configurationIssues.push(`模型不支持画幅 ${draft.imageSettings.aspectRatio}`);
    if (capabilities.resolutionOptions.length && !includesCaseInsensitive(capabilities.resolutionOptions, draft.imageSettings.resolution)) configurationIssues.push(`模型不支持清晰度 ${draft.imageSettings.resolution}`);
    if (imageCount > capabilities.maxReferenceImages) configurationIssues.push(`参考图片最多 ${capabilities.maxReferenceImages} 张`);
    segments = [{ index: 0, durationSeconds: 0, continuitySource: "input" }];
  }

  const unpersisted = draft.materials.filter((material) => !material.assetId);
  if (unpersisted.length) executionIssues.push(`${unpersisted.length} 个本轮临时素材尚未进入资产库`);
  if (draft.director && !draft.director.script?.trim()) executionIssues.push("编导尚未产出可应用脚本");

  const cleanConfigurationIssues = unique(configurationIssues);
  const cleanExecutionIssues = unique(executionIssues);
  return {
    schema: COMMERCE_V2_PLAN_SCHEMA,
    planId: input.planId,
    draftId: draft.id,
    draftRevision: draft.revision,
    kind: draft.kind,
    skillKey: draft.skillKey,
    model: {
      id: model.id,
      displayName: model.displayName,
      configHash: model.configHash,
      billingUnit: model.billingUnit,
      publicPrice: model.publicPrice,
    },
    settings,
    materials: draft.materials.map((material) => ({ ...material })),
    segments,
    prompt: draft.director?.script?.trim() || draft.prompt.trim(),
    director: draft.director,
    configurationIssues: cleanConfigurationIssues,
    executionIssues: cleanExecutionIssues,
    warnings: unique(warnings),
    confirmable: cleanConfigurationIssues.length === 0 && cleanExecutionIssues.length === 0,
  };
}
