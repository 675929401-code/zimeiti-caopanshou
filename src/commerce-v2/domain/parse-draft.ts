import {
  COMMERCE_V2_DRAFT_SCHEMA,
  type DirectorBinding,
  type ProductionDraft,
  type ProductionMaterial,
} from "./contracts";

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false) {
  if (typeof value !== "string") throw new Error(`${label}格式无效`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maximum) throw new Error(`${label}长度无效`);
  return result;
}

function materials(value: unknown): ProductionMaterial[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error("参考素材数量无效");
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = record(entry, "参考素材");
    const instanceId = text(item.instanceId, "素材实例标识", 100);
    if (seen.has(instanceId)) throw new Error("参考素材实例标识重复");
    seen.add(instanceId);
    const kind = text(item.kind, "素材类型", 10);
    if (!["image", "video", "audio"].includes(kind)) throw new Error("素材类型不支持");
    const source = text(item.source, "素材来源", 20);
    if (!["local-session", "asset-library"].includes(source)) throw new Error("素材来源不支持");
    return {
      instanceId,
      ...(typeof item.assetId === "string" && item.assetId.trim() ? { assetId: text(item.assetId, "资产标识", 120) } : {}),
      name: text(item.name, "素材名称", 240),
      kind: kind as ProductionMaterial["kind"],
      role: text(item.role, "素材职责", 80),
      source: source as ProductionMaterial["source"],
      ...(typeof item.mimeType === "string" && item.mimeType.trim() ? { mimeType: text(item.mimeType, "素材媒体类型", 120) } : {}),
      ...(Number.isInteger(item.size) && Number(item.size) > 0 ? { size: Number(item.size) } : {}),
      ...(typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256) ? { sha256: item.sha256 } : {}),
    };
  });
}

function director(value: unknown): DirectorBinding | undefined {
  if (value === undefined || value === null) return undefined;
  const item = record(value, "编导绑定");
  if (item.outputProtocol !== "director-script/v2") throw new Error("编导输出协议无效");
  return {
    skillKey: text(item.skillKey, "编导标识", 80),
    registryVersion: text(item.registryVersion, "编导目录版本", 128),
    promptVersion: text(item.promptVersion, "编导提示词版本", 128),
    outputProtocol: "director-script/v2",
    ...(typeof item.conversationId === "string" && item.conversationId.trim() ? { conversationId: text(item.conversationId, "编导会话标识", 120) } : {}),
    ...(typeof item.messageId === "string" && item.messageId.trim() ? { messageId: text(item.messageId, "编导消息标识", 120) } : {}),
    ...(typeof item.applicationId === "string" && item.applicationId.trim() ? { applicationId: text(item.applicationId, "编导应用标识", 120) } : {}),
    ...(typeof item.script === "string" ? { script: text(item.script, "编导脚本", 20_000, true) } : {}),
  };
}

export function parseProductionDraft(value: unknown): ProductionDraft {
  const input = record(value, "生产草稿");
  if (input.schema !== COMMERCE_V2_DRAFT_SCHEMA) throw new Error("生产草稿协议无效");
  const kind = text(input.kind, "生产类型", 10);
  if (!["image", "video"].includes(kind)) throw new Error("生产类型不支持");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("草稿修订号无效");
  const modelId = input.modelId === null ? null : text(input.modelId, "模型标识", 160);
  const base = {
    schema: COMMERCE_V2_DRAFT_SCHEMA,
    id: text(input.id, "草稿标识", 120),
    revision,
    kind: kind as ProductionDraft["kind"],
    prompt: text(input.prompt, "创作要求", 20_000, true),
    skillKey: text(input.skillKey, "技能标识", 80),
    modelId,
    materials: materials(input.materials),
    director: director(input.director),
  };
  if (kind === "video") {
    const settings = record(input.videoSettings, "视频设置");
    const durationSeconds = Number(settings.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 80) throw new Error("视频时长需在 4–80 秒内");
    if (typeof settings.generateAudio !== "boolean") throw new Error("视频声音设置无效");
    return {
      ...base,
      kind: "video",
      videoSettings: {
        aspectRatio: text(settings.aspectRatio, "视频画幅", 20),
        resolution: text(settings.resolution, "视频清晰度", 20),
        durationSeconds,
        generateAudio: settings.generateAudio,
      },
    };
  }
  const settings = record(input.imageSettings, "图片设置");
  const format = text(settings.format, "图片格式", 10).toUpperCase();
  if (!["PNG", "JPEG", "WEBP"].includes(format)) throw new Error("图片格式不支持");
  return {
    ...base,
    kind: "image",
    imageSettings: {
      aspectRatio: text(settings.aspectRatio, "图片画幅", 20),
      resolution: text(settings.resolution, "图片清晰度", 20),
      format: format as "PNG" | "JPEG" | "WEBP",
    },
  };
}
