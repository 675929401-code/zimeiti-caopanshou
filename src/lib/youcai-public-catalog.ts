import sourceManifest from "../../public/youcai-media/v1/source-manifest.json";
import {
  OFFICIAL_INSPIRATION_ITEMS,
  PUBLIC_INSPIRATION_AUTHOR_NAME,
  type InspirationMaterialCategory,
  type InspirationMediaType,
} from "@/features/official-inspiration/inspiration-data";
import { CANVAS_SHARE_SHOWCASES } from "@/features/official-inspiration/canvas-showcase-data";
import { HOMEPAGE_HERO_MP4, HOMEPAGE_HERO_POSTER } from "@/lib/youcai-hero-assets";
import { listManjuPublicAssetsSync } from "@/lib/server/manju-public-asset-registry";

type PublicMediaType = "image" | "video" | "audio";
type PublicMaterialCategory =
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "shot"
  | "film"
  | "music"
  | "voice"
  | "audio"
  | "sound-effect"
  | "image"
  | "video"
  | "other";

interface SourceManifestItem {
  id: string;
  type: PublicMediaType;
  category: string;
  title: string;
  prompt: string;
  filename: string;
  mimeType: string;
  size: number;
  toolSlug: string;
  createdAt: string;
  localPath: string;
}

export interface PublicInspirationItem {
  id: string;
  url: string;
  type: PublicMediaType;
  category: PublicMaterialCategory;
  origin: "local" | "admin-upload";
  size: number;
  toolSlug: string;
  prompt: string;
  metadata: {
    title: string;
    summary: string;
    previewUrl: string;
    posterUrl: string | null;
    imageAlt: string;
    imageRatio: "landscape" | "portrait" | "square";
    availability: "ready" | "planned";
    availabilityNote: string | null;
    source: "local-public-catalog" | "manju-admin-upload";
  };
  filename: string;
  mimeType: string;
  likes: number;
  createdAt: string;
  author: {
    nickname: typeof PUBLIC_INSPIRATION_AUTHOR_NAME;
    avatar: null;
  };
  isFavorited: false;
  isDownloaded: false;
  ownerId: "public-catalog" | "manju-admin-upload";
}

type SiteBannerKind = "image" | "video";

export interface PublicSiteBanner {
  url: string;
  type: SiteBannerKind;
  link?: string;
  enabled?: boolean;
  poster?: string;
}

export interface PublicCanvasExample {
  canvasId: string;
  title: string;
  coverImage: string;
  tag?: string;
}

export interface PublicSiteConfig {
  banners: {
    audio: readonly PublicSiteBanner[];
    canvas: readonly PublicSiteBanner[];
    composite: readonly PublicSiteBanner[];
    "film-studio": readonly PublicSiteBanner[];
    image: readonly PublicSiteBanner[];
    text: readonly PublicSiteBanner[];
    tools: readonly PublicSiteBanner[];
    video: readonly PublicSiteBanner[];
  };
  popups: {
    tools: readonly never[];
  };
  heroVideo: PublicSiteBanner;
  backgroundVideos: readonly PublicSiteBanner[];
  canvasExamples: readonly PublicCanvasExample[];
}

export class PublicCatalogContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicCatalogContractError";
  }
}

const LOCAL_MEDIA_ROOT = "/youcai-media/v1";
const CANVAS_BANNER_VIDEO = "/youcai-media/v1/featured/canvas-banner-youcai.mp4";
const FILM_STUDIO_VIDEO = "/short-drama/hero-pipeline-loop-v1.mp4";

const PUBLIC_TYPE_BY_LOCAL: Readonly<Record<InspirationMediaType, PublicMediaType>> = {
  图片: "image",
  视频: "video",
  音频: "audio",
};

const PUBLIC_CATEGORY_BY_LOCAL: Readonly<Record<InspirationMaterialCategory, PublicMaterialCategory>> = {
  角色: "character",
  场景: "scene",
  道具: "prop",
  风格: "style",
  分镜: "shot",
  成片: "film",
  音乐: "music",
  语音: "voice",
  音频: "audio",
  音效: "sound-effect",
  图片: "image",
  视频: "video",
  其他: "other",
};

let inspirationCache: readonly PublicInspirationItem[] | undefined;
let siteConfigCache: PublicSiteConfig | undefined;

function localAssetPath(localPath: string): string {
  const normalized = localPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || /^[a-z][a-z\d+.-]*:/i.test(normalized)) {
    throw new PublicCatalogContractError("素材清单包含不安全的本地路径");
  }
  return `${LOCAL_MEDIA_ROOT}/${normalized}`;
}

function assertPublicPath(value: string, label: string): void {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("..") || /^https?:/i.test(value)) {
    throw new PublicCatalogContractError(`${label} 必须是本站绝对路径`);
  }
}

function buildPublicInspirationCatalog(): readonly PublicInspirationItem[] {
  const manifest = sourceManifest as readonly SourceManifestItem[];
  if (manifest.length !== OFFICIAL_INSPIRATION_ITEMS.length) {
    throw new PublicCatalogContractError("素材清单与灵感卡片数量不一致");
  }

  const manifestById = new Map<string, SourceManifestItem>();
  for (const item of manifest) {
    if (!item.id || manifestById.has(item.id)) {
      throw new PublicCatalogContractError("素材清单包含空 ID 或重复 ID");
    }
    manifestById.set(item.id, item);
  }

  const catalog = OFFICIAL_INSPIRATION_ITEMS.map((item) => {
    const source = manifestById.get(item.id);
    if (!source) throw new PublicCatalogContractError("灵感卡片缺少对应的本地素材记录");

    const type = PUBLIC_TYPE_BY_LOCAL[item.mediaType];
    if (source.type !== type) {
      throw new PublicCatalogContractError("素材清单与灵感卡片的媒体类型不一致");
    }

    const url = localAssetPath(source.localPath);
    const previewUrl = item.previewPath;
    const posterUrl = type === "video" ? item.imagePath : null;
    assertPublicPath(url, "素材 URL");
    assertPublicPath(previewUrl, "素材预览 URL");
    if (posterUrl) assertPublicPath(posterUrl, "视频海报 URL");

    return Object.freeze({
      id: item.id,
      url,
      type,
      category: PUBLIC_CATEGORY_BY_LOCAL[item.category],
      origin: "local" as const,
      size: Number.isFinite(source.size) && source.size >= 0 ? source.size : 0,
      toolSlug: source.toolSlug || "local-public-catalog",
      prompt: item.prompt,
      metadata: Object.freeze({
        title: item.title,
        summary: item.summary,
        previewUrl,
        posterUrl,
        imageAlt: item.imageAlt,
        imageRatio: item.imageRatio,
        availability: item.availability ?? "ready",
        availabilityNote: item.availabilityNote ?? null,
        source: "local-public-catalog" as const,
      }),
      filename: source.filename,
      mimeType: source.mimeType,
      likes: item.likes ?? 0,
      createdAt: item.createdAt,
      author: Object.freeze({ nickname: PUBLIC_INSPIRATION_AUTHOR_NAME, avatar: null }),
      isFavorited: false as const,
      isDownloaded: false as const,
      ownerId: "public-catalog" as const,
    });
  });

  const uploadedAssets = listManjuPublicAssetsSync().map((asset) => Object.freeze({
    id: asset.id,
    url: asset.path,
    type: asset.mediaType,
    category: asset.category,
    origin: "admin-upload" as const,
    size: asset.size,
    toolSlug: "manju-admin-upload",
    prompt: asset.prompt,
    metadata: Object.freeze({
      title: asset.title,
      summary: asset.summary,
      previewUrl: asset.path,
      posterUrl: null,
      imageAlt: asset.title,
      imageRatio: "landscape" as const,
      availability: "ready" as const,
      availabilityNote: "后台已上传并登记，可作为漫剧工作台展示、参考图或画布示例素材。",
      source: "manju-admin-upload" as const,
    }),
    filename: asset.filename,
    mimeType: asset.contentType,
    likes: 0,
    createdAt: asset.createdAt,
    author: Object.freeze({ nickname: PUBLIC_INSPIRATION_AUTHOR_NAME, avatar: null }),
    isFavorited: false as const,
    isDownloaded: false as const,
    ownerId: "manju-admin-upload" as const,
  }));

  return Object.freeze([...uploadedAssets, ...catalog]);
}

function buildPublicSiteConfig(): PublicSiteConfig {
  if (CANVAS_SHARE_SHOWCASES.length !== 4) {
    throw new PublicCatalogContractError("公开画布示例必须恰好包含 4 项");
  }

  const seenCanvasIds = new Set<string>();
  const canvasExamples = CANVAS_SHARE_SHOWCASES.map((showcase) => {
    if (!showcase.id || seenCanvasIds.has(showcase.id)) {
      throw new PublicCatalogContractError("公开画布示例包含空 ID 或重复 ID");
    }
    seenCanvasIds.add(showcase.id);
    assertPublicPath(showcase.coverImage, "画布示例封面");

    return Object.freeze({
      canvasId: showcase.id,
      title: showcase.title,
      coverImage: showcase.coverImage,
      ...(showcase.tag ? { tag: showcase.tag } : {}),
    });
  });

  const config: PublicSiteConfig = {
    banners: {
      audio: Object.freeze([]),
      canvas: Object.freeze([{ url: CANVAS_BANNER_VIDEO, type: "video", enabled: true, poster: "/short-drama/previews/hero-pipeline-v1.webp" }]),
      composite: Object.freeze([]),
      "film-studio": Object.freeze([{ url: "/short-drama/previews/film-studio-promo-bg-v2.webp", type: "image", link: "/youcai/tools/film-studio", enabled: true }]),
      image: Object.freeze([{ url: "/short-drama/previews/inspiration-moon-observatory-v1.webp", type: "image", link: "/youcai/tools/image", enabled: true }]),
      text: Object.freeze([{ url: "/short-drama/previews/film-studio-promo-bg-v2.webp", type: "image", link: "/youcai/tools/text", enabled: true }]),
      tools: Object.freeze([{ url: CANVAS_BANNER_VIDEO, type: "video", link: "/youcai/tools/canvas", enabled: true, poster: "/short-drama/previews/hero-pipeline-v1.webp" }]),
      video: Object.freeze([{ url: FILM_STUDIO_VIDEO, type: "video", link: "/youcai/tools/video", enabled: true, poster: "/short-drama/previews/hero-pipeline-v1.webp" }]),
    },
    popups: { tools: Object.freeze([]) },
    heroVideo: { url: HOMEPAGE_HERO_MP4, type: "video", poster: HOMEPAGE_HERO_POSTER },
    backgroundVideos: Object.freeze([
      { url: HOMEPAGE_HERO_MP4, type: "video", poster: HOMEPAGE_HERO_POSTER },
      { url: CANVAS_BANNER_VIDEO, type: "video", poster: "/short-drama/previews/hero-pipeline-v1.webp" },
    ]),
    canvasExamples: Object.freeze(canvasExamples),
  };

  const publicPaths = [
    ...Object.values(config.banners).flatMap((items) => items.flatMap((item) => [item.url, item.link, item.poster])),
    config.heroVideo.url,
    config.heroVideo.poster,
    ...config.backgroundVideos.flatMap((item) => [item.url, item.poster]),
    ...config.canvasExamples.map((item) => item.coverImage),
  ].filter((value): value is string => Boolean(value));
  for (const value of publicPaths) assertPublicPath(value, "站点配置路径");

  return Object.freeze(config);
}

export function getPublicInspirationCatalog(): readonly PublicInspirationItem[] {
  inspirationCache ??= buildPublicInspirationCatalog();
  return inspirationCache;
}

export function getPublicSiteConfig(): PublicSiteConfig {
  siteConfigCache ??= buildPublicSiteConfig();
  return siteConfigCache;
}

export function resetPublicCatalogCache(): void {
  inspirationCache = undefined;
  siteConfigCache = undefined;
}
