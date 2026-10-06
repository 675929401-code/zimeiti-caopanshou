import type { CanvasShareShowcaseData, CanvasShowcaseNode } from "./canvas-showcase-data";
import type { OfficialInspirationItem } from "./inspiration-data";

function mediaNode(item: OfficialInspirationItem): CanvasShowcaseNode {
  const common = {
    id: "reference-media",
    order: "02",
    title: "原始灵感素材",
    status: "已导入",
    body: [
      item.summary,
      item.sourceNote ? `来源：${item.sourceNote}` : "来源：项目内版本化素材",
      item.availabilityNote || "素材只作为当前画布的只读参考。",
    ].join("\n\n"),
    position: { x: 610, y: 100 },
    height: 450,
    toolLabel: "只读参考 · 不自动生成",
  } as const;

  if (item.mediaType === "视频" && item.mediaPath && item.availability !== "planned") {
    return {
      ...common,
      kind: "video",
      mediaPath: item.mediaPath,
      mediaType: "video/mp4",
      posterPath: item.imagePath,
      durationLabel: "本地视频参考",
    };
  }
  if (item.mediaType === "音频" && item.mediaPath && item.availability !== "planned") {
    return {
      ...common,
      kind: item.category === "音乐" ? "music" : "audio",
      mediaPath: item.mediaPath,
      mediaType: "audio/mpeg",
      durationLabel: "本地音频参考",
    };
  }
  return {
    ...common,
    kind: "image",
    imagePath: item.imagePath,
    imageAlt: item.imageAlt,
  };
}

export function toInspirationCanvasWorkspace(item: OfficialInspirationItem): CanvasShareShowcaseData {
  return {
    id: `inspiration-workspace-${item.id}`,
    title: item.title,
    tag: item.category,
    description: item.summary,
    prompt: item.prompt,
    coverMediaType: "image",
    coverImage: item.imagePath,
    coverAlt: item.imageAlt,
    nodes: [
      {
        id: "prompt",
        order: "01",
        title: "灵感提示词",
        kind: "text",
        status: "已导入",
        body: item.prompt,
        position: { x: 90, y: 100 },
        height: 360,
        toolLabel: "可编辑提示词",
      },
      mediaNode(item),
      {
        id: "creation-plan",
        order: "03",
        title: "二次创作计划",
        kind: item.mediaType === "视频" ? "video-plan" : "text",
        status: "待配置",
        body: "基于左侧提示词与参考素材，补充目标受众、画面风格、镜头节奏和交付规格。这里的修改只保存为草稿，不会自动调用模型。",
        position: { x: 1130, y: 100 },
        height: 330,
        toolLabel: "等待用户确认模型与参数",
      },
    ],
    edges: [
      { id: "prompt-to-media", source: "prompt", target: "reference-media" },
      { id: "media-to-plan", source: "reference-media", target: "creation-plan" },
    ],
  };
}
