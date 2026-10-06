import { NextResponse } from "next/server";
import {
  getPublicInspirationCatalog,
  PublicCatalogContractError,
  type PublicInspirationItem,
} from "@/lib/youcai-public-catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Expires: "0",
  Pragma: "no-cache",
  Vary: "Accept-Encoding",
} as const;

const TYPE_ALIASES: Readonly<Record<string, PublicInspirationItem["type"] | undefined>> = {
  all: undefined,
  "全部": undefined,
  image: "image",
  "图片": "image",
  video: "video",
  "视频": "video",
  audio: "audio",
  "音频": "audio",
};

const CATEGORY_ALIASES: Readonly<Record<string, PublicInspirationItem["category"] | undefined>> = {
  all: undefined,
  "全部": undefined,
  "全部分类": undefined,
  character: "character",
  "角色": "character",
  scene: "scene",
  "场景": "scene",
  prop: "prop",
  "道具": "prop",
  style: "style",
  "风格": "style",
  shot: "shot",
  "分镜": "shot",
  film: "film",
  "成片": "film",
  music: "music",
  "音乐": "music",
  voice: "voice",
  "语音": "voice",
  audio: "audio",
  "音频": "audio",
  "sound-effect": "sound-effect",
  "音效": "sound-effect",
  image: "image",
  "图片": "image",
  video: "video",
  "视频": "video",
  other: "other",
  "其他": "other",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function positiveInteger(
  searchParams: URLSearchParams,
  name: string,
  fallback: number,
  maximum: number,
): number | null {
  const raw = searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return null;
  return value;
}

function publicError(code: string, message: string, status: number) {
  return json({ success: false, error: { code, message } }, status);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = positiveInteger(searchParams, "page", 1, 100_000);
    const limit = positiveInteger(searchParams, "limit", 20, 100);
    if (page === null || limit === null) {
      return publicError("INVALID_PAGINATION", "page 必须为正整数，limit 必须为 1 到 100 的整数", 400);
    }

    const rawType = (searchParams.get("type") ?? searchParams.get("mediaType") ?? "all").trim();
    const rawCategory = (searchParams.get("category") ?? searchParams.get("materialCategory") ?? "all").trim();
    if (!(rawType in TYPE_ALIASES)) {
      return publicError("INVALID_MEDIA_TYPE", "不支持的素材类型", 400);
    }
    if (!(rawCategory in CATEGORY_ALIASES)) {
      return publicError("INVALID_CATEGORY", "不支持的素材分类", 400);
    }

    const query = (searchParams.get("search") ?? searchParams.get("q") ?? "").trim();
    if (query.length > 200) {
      return publicError("INVALID_SEARCH", "搜索文本不能超过 200 个字符", 400);
    }

    const sort = (searchParams.get("sort") ?? searchParams.get("sortBy") ?? "latest").trim().toLowerCase();
    if (!new Set(["latest", "newest", "recent", "popular", "hot", "hottest", "oldest"]).has(sort)) {
      return publicError("INVALID_SORT", "不支持的排序方式", 400);
    }

    const type = TYPE_ALIASES[rawType];
    const category = CATEGORY_ALIASES[rawCategory];
    const queryLower = query.toLocaleLowerCase("zh-CN");
    let items = getPublicInspirationCatalog().filter((item) => {
      if (type && item.type !== type) return false;
      if (category && item.category !== category) return false;
      if (!queryLower) return true;
      return [item.metadata.title, item.metadata.summary, item.prompt, item.filename, item.toolSlug]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(queryLower));
    });

    items = [...items].sort((left, right) => {
      if (["popular", "hot", "hottest"].includes(sort)) {
        return right.likes - left.likes || Date.parse(right.createdAt) - Date.parse(left.createdAt);
      }
      if (sort === "oldest") return Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });

    const total = items.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const data = items.slice(offset, offset + limit);

    return json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    if (error instanceof PublicCatalogContractError) {
      return publicError("PUBLIC_CATALOG_INVALID", "公共素材目录未通过完整性校验", 503);
    }
    return publicError("PUBLIC_CATALOG_UNAVAILABLE", "公共素材目录暂时不可用", 500);
  }
}
