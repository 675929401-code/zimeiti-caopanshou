import { GeneratedImageReferenceError, resolveGeneratedImageReference, validateOwnedGeneratedImageReference } from "@/lib/server/generated-image-reference";
import { isPublicVideoAssetUrl } from "@/lib/video-public-url";
import { SafeFetchError } from "@/lib/safe-fetch";
import type { SupabaseClient } from "@supabase/supabase-js";

export const VISUAL_ASSET_ROLES = ["character", "pet", "environment", "prop"] as const;
export type VisualAssetLibraryQuery = { role: string; q: string; offset: number; limit: number; includeUnclassified: boolean };

export function parseVisualAssetQuery(params: URLSearchParams): { recordId: string } | VisualAssetLibraryQuery {
  if (params.has("recordId")) {
    const recordId = params.get("recordId") || "";
    if (!/^[a-f0-9]{64}$/u.test(recordId)) throw new GeneratedImageReferenceError("GENERATED_IMAGE_REFERENCE_INVALID", "生成图片记录标识无效", 400);
    if (["role", "q", "offset", "limit", "includeUnclassified"].some((key) => params.has(key))) {
      throw new GeneratedImageReferenceError("VISUAL_ASSET_QUERY_CONFLICT", "生成图片解析不能同时查询资产库", 400);
    }
    return { recordId };
  }
  const role = (params.get("role") || "").trim();
  const q = (params.get("q") || "").trim();
  const offset = Number(params.get("offset") ?? "0");
  const limit = Number(params.get("limit") ?? "60");
  if (role && !(VISUAL_ASSET_ROLES as readonly string[]).includes(role)) throw new GeneratedImageReferenceError("VISUAL_ASSET_ROLE_INVALID", "视觉资产类别无效", 400);
  if (q.length > 120 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new GeneratedImageReferenceError("VISUAL_ASSET_QUERY_INVALID", "搜索或分页参数无效", 400);
  }
  return { role, q, offset, limit, includeUnclassified: params.get("includeUnclassified") === "1" };
}

type VisualAssetReferenceDependencies = {
  validateOwned: typeof validateOwnedGeneratedImageReference;
  read: typeof import("@/lib/image-provider-delivery").readProviderImage;
};
const visualAssetReferenceDefaults: VisualAssetReferenceDependencies = {
  validateOwned: validateOwnedGeneratedImageReference,
  read: async (...args) => {
    const { readProviderImage } = await import("@/lib/image-provider-delivery");
    return readProviderImage(...args);
  },
};

/** Resolve an owned public image through the same bounded safe read as image preview. */
export async function resolveStoryboardVisualAssetReference(
  userId: string,
  recordId: string,
  resolve: typeof resolveGeneratedImageReference | VisualAssetReferenceDependencies = visualAssetReferenceDefaults,
) {
  if (!/^[a-f0-9]{64}$/u.test(recordId)) throw new GeneratedImageReferenceError("GENERATED_IMAGE_REFERENCE_INVALID", "生成图片记录标识无效", 400);
  const input = { userId, reference: { schema: "generated_image_ref.v1" as const, recordId } };
  // Preserve the existing resolver injection used by contract callers.
  if (typeof resolve === "function") {
    const previewUrl = await resolve(input);
    return { reference: { recordId, previewUrl } };
  }
  const delivery = await resolve.validateOwned(input);
  const previewUrl = typeof delivery.providerUrl === "string" ? delivery.providerUrl : "";
  if (!isPublicVideoAssetUrl(previewUrl)) {
    throw new GeneratedImageReferenceError("GENERATED_IMAGE_PRIVATE_INPUT_UNSUPPORTED", "当前视觉资产仅支持公开上游图片；不会重新生成或扣费");
  }
  try {
    await resolve.read(delivery, false, { recordId, userId });
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    const transient = error.code === "DNS_LOOKUP_FAILED" || error.status >= 500;
    throw new GeneratedImageReferenceError(
      transient ? "GENERATED_IMAGE_URL_CHECK_UNAVAILABLE" : "GENERATED_IMAGE_URL_UNSAFE",
      transient ? "生成图片地址暂时无法安全核对，本次未提交或扣费" : "生成图片地址未通过安全校验，本次未提交或扣费",
      transient ? 503 : 422,
    );
  }
  return { reference: { recordId, previewUrl } };
}

/** Escape LIKE wildcards: a user's search text is literal rather than a PostgREST filter. */
export function visualAssetNamePattern(q: string) {
  return `%${q.replace(/[\\%_]/gu, (value) => `\\${value}`)}%`;
}

/** Apply ownership and metadata predicates before range, so old assets remain discoverable. */
export function queryVisualAssetLibrary(db: SupabaseClient, userId: string, input: VisualAssetLibraryQuery) {
  const { role, q, offset, limit, includeUnclassified } = input;
  let query = db.from("user_files")
    .select("id,storage_key,storage_provider,file_size,content_type,source,meta,created_at", { count: "exact" })
    .eq("user_id", userId).eq("file_category", "image");
  if (!includeUnclassified) {
    query = query.in("meta->storyboardVisualAsset->>role", [...VISUAL_ASSET_ROLES]);
  }
  if (!includeUnclassified || (role && role !== "prop")) {
    query = query.or("meta->storyboardVisualAsset->>enabled.is.null,meta->storyboardVisualAsset->>enabled.neq.false");
  }
  if (role) {
    query = includeUnclassified && role === "prop"
      ? query.or("meta->storyboardVisualAsset->>role.eq.prop,meta->storyboardVisualAsset.is.null,meta->storyboardVisualAsset->>enabled.eq.false")
      : query.eq("meta->storyboardVisualAsset->>role", role);
  }
  if (q) query = query.ilike("meta->storyboardVisualAsset->>name", visualAssetNamePattern(q));
  return query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1);
}

export function parseVisualAssetLabels(body: Record<string, unknown>): { tags: string[]; customCategory: string } {
  const tags = body.tags ?? [];
  const customCategory = body.customCategory ?? "";
  if (!Array.isArray(tags) || tags.length > 12 || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 32) || typeof customCategory !== "string" || customCategory.trim().length > 40) {
    throw new GeneratedImageReferenceError("VISUAL_ASSET_LABELS_INVALID", "标签最多12个且每个不超过32字，自定义分类不超过40字", 400);
  }
  return { tags: [...new Set(tags.map((tag: string) => tag.trim()))], customCategory: customCategory.trim() };
}
