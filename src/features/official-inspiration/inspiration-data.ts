import { MANJU_WORKBENCH_BRAND } from "@/lib/manju-workbench-brand";
import sourceManifest from "../../../public/youcai-media/v1/source-manifest.json";

export const PUBLIC_INSPIRATION_AUTHOR_NAME = MANJU_WORKBENCH_BRAND;

export type InspirationMediaType = "图片" | "音频" | "视频";
export type InspirationMaterialCategory =
  | "角色"
  | "场景"
  | "道具"
  | "风格"
  | "分镜"
  | "成片"
  | "音乐"
  | "语音"
  | "音频"
  | "音效"
  | "图片"
  | "视频"
  | "其他";

export interface OfficialInspirationItem {
  id: string;
  title: string;
  summary: string;
  mediaType: InspirationMediaType;
  category: InspirationMaterialCategory;
  previewPath: string;
  imagePath: string;
  imageAlt: string;
  imageRatio: "landscape" | "portrait" | "square";
  prompt: string;
  createdAt: string;
  popularity: number;
  availability?: "ready" | "planned";
  mediaPath?: string;
  availabilityNote?: string;
  sourceNote?: string;
  showcaseId?: string;
  authorName: string;
  likes?: number;
}

type ManifestMediaType = "image" | "video" | "audio";
type ManifestCategory =
  | "audio"
  | "character"
  | "film"
  | "image"
  | "music"
  | "prop"
  | "scene"
  | "shot"
  | "video"
  | "voice";

interface SourceManifestItem {
  id: string;
  type: ManifestMediaType;
  category: ManifestCategory;
  title: string;
  prompt: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  toolSlug: string;
  createdAt: string;
  author: string;
  localPath: string;
}

const CATEGORY_MAP: Record<ManifestCategory, InspirationMaterialCategory> = {
  audio: "音频",
  character: "角色",
  film: "成片",
  image: "图片",
  music: "音乐",
  prop: "道具",
  scene: "场景",
  shot: "分镜",
  video: "视频",
  voice: "语音",
};

/**
 * The upstream snapshot has no dedicated `style` category. Keep the original
 * manifest immutable and correct only fixtures whose primary subject is a
 * reusable visual style study. This ready local video demonstrates ten named
 * rendering styles while locking the same subject, pose and camera movement.
 */
export const INSPIRATION_CATEGORY_OVERRIDES: Readonly<Record<string, InspirationMaterialCategory>> = {
  cmp6xtyjr0007vhp4b1ksrui4: "风格",
};

const MEDIA_TYPE_MAP: Record<ManifestMediaType, InspirationMediaType> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

const AUDIO_COVER = "/official-home/hero-eye-original.png";
const LOCAL_MEDIA_ROOT = "/youcai-media/v1";

export const CANVAS_SHOWCASE_ID = "canvas-showcase-78f7a4a9ce11-paper-fox-adventure";

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function normalizeWorkspaceBrand(value: string): string {
  return value
    .replaceAll("有彩视界", "漫剧工作台")
    .replaceAll("有彩世界", "漫剧工作台");
}

function inferRatio(item: SourceManifestItem): OfficialInspirationItem["imageRatio"] {
  if (item.category === "character") return "portrait";
  if (item.category === "scene" || item.category === "shot" || item.category === "film" || item.type === "video") {
    return "landscape";
  }
  return "square";
}

function toOfficialInspirationItem(item: SourceManifestItem, index: number): OfficialInspirationItem {
  const mediaType = MEDIA_TYPE_MAP[item.type];
  const category = INSPIRATION_CATEGORY_OVERRIDES[item.id] ?? CATEGORY_MAP[item.category];
  const mediaPath = `${LOCAL_MEDIA_ROOT}/${item.localPath.replace(/\\/g, "/")}`;
  const title = compactText(
    normalizeWorkspaceBrand(item.title || item.prompt || item.filename),
    56,
  );
  const imagePath = item.type === "video"
    ? `${LOCAL_MEDIA_ROOT}/posters/${item.id}.jpg`
    : item.type === "image"
      ? mediaPath
      : AUDIO_COVER;
  const previewPath = item.type === "image"
    ? `${LOCAL_MEDIA_ROOT}/thumbnails/${item.id}.webp`
    : imagePath;

  return {
    id: item.id,
    title,
    summary: `${category}素材 · ${item.toolSlug || item.mimeType} · 已保存到本站素材库`,
    mediaType,
    category,
    previewPath,
    imagePath,
    imageAlt: title,
    imageRatio: inferRatio(item),
    prompt: normalizeWorkspaceBrand(
      item.prompt?.trim() || item.title?.trim() || "该公开素材未附带提示词。",
    ),
    createdAt: item.createdAt,
    popularity: 10_000 - index,
    availability: "ready",
    mediaPath,
    availabilityNote: "本地可用；浏览和播放不会触发模型调用或积分扣费。",
    sourceNote: "youcai.art 公开灵感素材的本地版本化快照 v1。",
    authorName: PUBLIC_INSPIRATION_AUTHOR_NAME,
    likes: 0,
  };
}

/**
 * 唯一数据源是 public/youcai-media/v1/source-manifest.json。
 * 该清单固定包含 224 条本地素材：162 图片、44 视频、18 音频。
 * 页面不热链外部地址；视频使用同目录下按素材 id 保存的海报。
 */
export const OFFICIAL_INSPIRATION_ITEMS: readonly OfficialInspirationItem[] = (
  sourceManifest as SourceManifestItem[]
).map(toOfficialInspirationItem);

export function getInspirationSourceNote(item: OfficialInspirationItem): string {
  const notes = [item.sourceNote?.trim(), item.availabilityNote?.trim()].filter(
    (note): note is string => Boolean(note),
  );
  if (notes.length > 0) return notes.join(" · ");
  return item.availability === "planned"
    ? "此条展示完整创作思路与提示词，暂无可下载文件。"
    : "本地素材与提示词可作为画布创作参考。";
}

/**
 * “音乐”是音频素材中的真实语义子集。单独提供入口，避免用户只能先选
 * “音频”再猜分类；底层媒体类型仍保持 image / video / audio 三种真实格式。
 */
export const INSPIRATION_MEDIA_FILTERS = ["全部", "图片", "视频", "音频", "音乐"] as const;
export const INSPIRATION_CATEGORY_FILTERS = [
  "全部分类",
  "角色",
  "场景",
  "道具",
  "风格",
  "分镜",
  "成片",
  "音乐",
  "语音",
  "音频",
  "音效",
  "图片",
  "视频",
  "其他",
] as const;

const firstImage = OFFICIAL_INSPIRATION_ITEMS.find((item) => item.mediaType === "图片");

export const CANVAS_SHOWCASE = {
  id: CANVAS_SHOWCASE_ID,
  title: "纸上小狐狸的奇幻冒险",
  subtitle: "本地只读工作流示例",
  prompt: firstImage?.prompt || "从角色、场景、分镜与声音节点组织完整动画工作流。",
} as const;
