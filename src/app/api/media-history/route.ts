import { isCurrentDigitalHumanTask } from '@/lib/digital-human-task';
import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { publicVariantLabel } from "@/lib/public-model-dto";
import { classifyVideoProviderError } from "@/lib/video-error-policy";
import { canRetryVideoHistoryTask } from "@/lib/video-history-presentation";

import {
  loadCommerceMediaHistory,
  type MediaHistoryCommerceRole,
  type MediaHistoryCommercePreview,
} from "@/lib/media-history-commerce";
import { hideMediaHistoryItem, visibleGalleryIndex } from "@/lib/media-history-visibility";
import { loadMediaImageProvenance } from "@/lib/media-image-provenance";
import { parseImageFailureRequestSnapshot } from "@/lib/image-failure-history";
import {
  MEDIA_HISTORY_CATEGORY_KEYS,
  MEDIA_HISTORY_FALLBACK_DAYS,
  mediaHistoryCategoryFromImageSurface,
  mediaHistoryCategoryFromVideoSource,
  mediaHistoryProjectUuid,
  resolveMediaHistoryRetention,
  upstreamMediaExpiry,
  type MediaHistoryCategoryKey,
  type MediaHistoryRetentionSource,
} from "@/lib/media-history-contract";

type MediaKind = "image" | "video";
type CategoryKey = MediaHistoryCategoryKey;
type MediaStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

interface PublicMediaHistoryItem {
  id: string;
  kind: MediaKind;
  title: string;
  project: string;
  segment: string;
  source: string;
  sourcePath: string;
  retryPath: string;
  categoryKey: CategoryKey;
  removable: boolean;
  status: MediaStatus;
  createdAt: string;
  completedAt: string | null;
  publicModelName: string;
  cost: number | null;
  costNote: string;
  previewPath: string;
  thumbnailPath: string;
  downloadPath: string;
  preview: MediaHistoryCommercePreview;
  errorMessage: string;
  aspectRatio: string;
  durationSeconds: number | null;
  expiresAt: string | null;
  retentionSource: MediaHistoryRetentionSource;
}

function safeStatus(value: unknown): MediaStatus {
  const status = String(value || "").toLowerCase();
  if (["queued", "pending"].includes(status)) return "queued";
  if (["processing", "generating", "finalizing", "submitting", "image_downloading", "video_generating"].includes(status)) return "processing";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function relationName(value: unknown): string {
  if (Array.isArray(value)) return String((value[0] as Record<string, unknown> | undefined)?.name || "");
  if (value && typeof value === "object") return String((value as Record<string, unknown>).name || "");
  return "";
}

function publicModelBaseName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/(?:\s*[·|/\-]?\s*)(?:渠道|通道|线路|channel)\s*[A-Za-z0-9一二三四五六七八九十_-]*/gi, "")
    .replace(/\s*·\s*·\s*/g, " · ")
    .replace(/^[\s·|/\-]+|[\s·|/\-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || fallback;
}

function publicSourceName(value: string): string {
  const source = value.trim().toLowerCase();
  if (["llm", "chat", "agent"].includes(source)) return "智能体应用";
  if (source === "image" || source === "drawing") return "图片生成";
  return value.trim() || "智能体应用";
}

function parseImageGallery(content: unknown): {
  images: Array<{
    url: string;
    title?: string;
    label?: string;
    width?: number;
    height?: number;
    assetId?: string;
    storageKey?: string;
  }>;
} | null {
  if (typeof content !== "string" || !content.includes("image_gallery")) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.type !== "image_gallery" || !Array.isArray(parsed.images)) return null;
    const images = parsed.images.filter((image): image is {
      url: string;
      title?: string;
      label?: string;
      width?: number;
      height?: number;
      assetId?: string;
      storageKey?: string;
    } => (
      Boolean(image) && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string"
    ));
    return images.length ? { images } : null;
  } catch {
    return null;
  }
}

type MediaDb = ReturnType<typeof getSupabaseClient>;
type ImageMessageEntry = {
  message: Record<string, unknown>;
  gallery: NonNullable<ReturnType<typeof parseImageGallery>>;
};

type DeliveredImageEntry = {
  record_id: unknown;
  delivery_asset_id: unknown;
  request_snapshot: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function pageInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

async function loadVideoRows(db: MediaDb, userId: string) {
  const rows: Record<string, unknown>[] = [];
  let cursor = 0;
  let failed = false;
  const chunkSize = 200;
  while (true) {
    const result = await db
      .from("video_tasks")
      .select("id, client_request_id, model_id, task_label, aspect_ratio, duration_seconds, status, video_url, error_message, submission_error_code, billing_state, provider_result_url, provider_dispatch_receipt, provider_submission_receipt, price_charged, created_at, completed_at, storage_url, batch_id, batch_topic, card_index, video_models(name)")
      .eq("user_id", userId)
      .is("history_hidden_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(cursor, cursor + chunkSize - 1);
    if (result.error) {
      failed = true;
      break;
    }
    const batch = (result.data || []) as Record<string, unknown>[];
    rows.push(...batch.filter((row) => !String(row.task_label || "").startsWith("digital-human:") || isCurrentDigitalHumanTask(row)));
    cursor += batch.length;
    if (batch.length < chunkSize) break;
  }
  return { rows, failed };
}

async function loadImageMessages(db: MediaDb, userId: string) {
  const entries: ImageMessageEntry[] = [];
  let cursor = 0;
  let failed = false;
  const chunkSize = 200;
  while (true) {
    const result = await db
      .from("conversation_messages")
      .select("id, agent_id, conversation_id, content, created_at, media_hidden_indices")
      .eq("user_id", userId)
      .eq("role", "assistant")
      .ilike("content", "%image_gallery%")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(cursor, cursor + chunkSize - 1);
    if (result.error) {
      failed = true;
      break;
    }
    const batch = (result.data || []) as Record<string, unknown>[];
    for (const message of batch) {
      const gallery = parseImageGallery(message.content);
      if (!gallery) continue;
      entries.push({ message, gallery });
    }
    cursor += batch.length;
    if (batch.length < chunkSize) break;
  }
  return { entries, failed };
}

async function loadDeliveredImageRows(db: MediaDb, userId: string) {
  const rows: DeliveredImageEntry[] = [];
  let cursor = 0;
  let failed = false;
  const chunkSize = 200;
  while (true) {
    const result = await db
      .from("image_generation_requests")
      .select("record_id, delivery_asset_id, request_snapshot, created_at, updated_at")
      .eq("user_id", userId)
      .eq("state", "completed")
      .eq("delivery_state", "delivered")
      .order("created_at", { ascending: false })
      .order("record_id", { ascending: false })
      .range(cursor, cursor + chunkSize - 1);
    if (result.error) {
      failed = true;
      break;
    }
    const batch = (result.data || []) as DeliveredImageEntry[];
    rows.push(...batch);
    cursor += batch.length;
    if (batch.length < chunkSize) break;
  }
  return { rows, failed };
}

const CATEGORY_KEYS = new Set<CategoryKey>(MEDIA_HISTORY_CATEGORY_KEYS);
const KIND_KEYS = new Set<MediaKind>(["image", "video"]);

type SourcePages = {
  videoPage: Awaited<ReturnType<typeof loadVideoRows>>;
  imagePage: Awaited<ReturnType<typeof loadImageMessages>>;
  deliveredImagePage: Awaited<ReturnType<typeof loadDeliveredImageRows>>;
  commercePage: ReturnType<typeof loadCommerceMediaHistory>;
};

type IndexedMediaHistoryItem = {
  item: PublicMediaHistoryItem;
  searchText: string;
};

type MediaHistoryAccountSnapshot = {
  rows: readonly IndexedMediaHistoryItem[];
  facets: ReturnType<typeof exactFacets> | ReturnType<typeof unavailableFacets>;
  sourceFailures: readonly string[];
  enumerationFailed: boolean;
  allSourcesFailed: boolean;
  expiredCount: number;
};

type MediaHistorySnapshotCacheEntry = {
  state: "pending" | "settled";
  expiresAt: number;
  lastAccessAt: number;
  promise: Promise<MediaHistoryAccountSnapshot>;
};

class MediaHistoryBusyError extends Error {
  constructor() {
    super("MEDIA_HISTORY_BUSY");
    this.name = "MediaHistoryBusyError";
  }
}

const MEDIA_HISTORY_SNAPSHOT_SUCCESS_TTL_MS = 5_000;
const MEDIA_HISTORY_SNAPSHOT_FAILURE_TTL_MS = 1_000;
const MEDIA_HISTORY_SNAPSHOT_MAX_SETTLED_ACCOUNTS = 32;
const MEDIA_HISTORY_SNAPSHOT_MAX_ACTIVE_BUILDS = 4;
const MEDIA_HISTORY_SNAPSHOT_MAX_WAITING_BUILDS = 32;
const mediaHistorySnapshotCache = new Map<string, MediaHistorySnapshotCacheEntry>();
const mediaHistorySnapshotWaiters: Array<(release: () => void) => void> = [];
let activeMediaHistorySnapshotBuilds = 0;

function mediaHistorySnapshotCacheKey(userId: string, role: MediaHistoryCommerceRole): string {
  return `${role}\0${userId}`;
}

function snapshotPermitRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = mediaHistorySnapshotWaiters.shift();
    if (next) {
      // Transfer the permit directly so a new request cannot race ahead of the queue.
      next(snapshotPermitRelease());
    } else {
      activeMediaHistorySnapshotBuilds = Math.max(0, activeMediaHistorySnapshotBuilds - 1);
    }
  };
}

function acquireMediaHistorySnapshotPermit(): Promise<() => void> {
  if (activeMediaHistorySnapshotBuilds < MEDIA_HISTORY_SNAPSHOT_MAX_ACTIVE_BUILDS) {
    activeMediaHistorySnapshotBuilds += 1;
    return Promise.resolve(snapshotPermitRelease());
  }
  if (mediaHistorySnapshotWaiters.length >= MEDIA_HISTORY_SNAPSHOT_MAX_WAITING_BUILDS) {
    return Promise.reject(new MediaHistoryBusyError());
  }
  return new Promise(resolve => mediaHistorySnapshotWaiters.push(resolve));
}

async function withMediaHistorySnapshotPermit<T>(build: () => Promise<T>): Promise<T> {
  const release = await acquireMediaHistorySnapshotPermit();
  try {
    return await build();
  } finally {
    release();
  }
}

function evictSettledMediaHistorySnapshots(): void {
  const settled = [...mediaHistorySnapshotCache.entries()]
    .filter((entry): entry is [string, MediaHistorySnapshotCacheEntry] => entry[1].state === "settled")
    .sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt);
  while (settled.length > MEDIA_HISTORY_SNAPSHOT_MAX_SETTLED_ACCOUNTS) {
    const [cacheKey, entry] = settled.shift()!;
    if (mediaHistorySnapshotCache.get(cacheKey) === entry) mediaHistorySnapshotCache.delete(cacheKey);
  }
}

function loadCachedMediaHistorySnapshot(
  cacheKey: string,
  build: () => Promise<MediaHistoryAccountSnapshot>,
): Promise<MediaHistoryAccountSnapshot> {
  const now = Date.now();
  const cached = mediaHistorySnapshotCache.get(cacheKey);
  if (cached?.state === "pending") return cached.promise;
  if (cached?.state === "settled" && cached.expiresAt > now) {
    cached.lastAccessAt = now;
    return cached.promise;
  }
  if (cached && mediaHistorySnapshotCache.get(cacheKey) === cached) {
    mediaHistorySnapshotCache.delete(cacheKey);
  }

  const entry: MediaHistorySnapshotCacheEntry = {
    state: "pending",
    expiresAt: Number.POSITIVE_INFINITY,
    lastAccessAt: now,
    promise: undefined as unknown as Promise<MediaHistoryAccountSnapshot>,
  };
  entry.promise = withMediaHistorySnapshotPermit(build).then(
    snapshot => {
      if (mediaHistorySnapshotCache.get(cacheKey) === entry) {
        const settledAt = Date.now();
        entry.state = "settled";
        entry.expiresAt = settledAt + (snapshot.enumerationFailed
          ? MEDIA_HISTORY_SNAPSHOT_FAILURE_TTL_MS
          : MEDIA_HISTORY_SNAPSHOT_SUCCESS_TTL_MS);
        entry.lastAccessAt = settledAt;
        evictSettledMediaHistorySnapshots();
      }
      return snapshot;
    },
    error => {
      if (mediaHistorySnapshotCache.get(cacheKey) === entry) {
        mediaHistorySnapshotCache.delete(cacheKey);
      }
      throw error;
    },
  );
  mediaHistorySnapshotCache.set(cacheKey, entry);
  evictSettledMediaHistorySnapshots();
  return entry.promise;
}

function invalidateMediaHistorySnapshot(userId: string, role: MediaHistoryCommerceRole): void {
  mediaHistorySnapshotCache.delete(mediaHistorySnapshotCacheKey(userId, role));
}

function mediaHistoryBusyResponse(): NextResponse {
  return NextResponse.json({ error: "作品历史请求较多，请稍后重试" }, {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      "Retry-After": "1",
    },
  });
}

function previewContract(
  kind: MediaKind,
  path: string,
  thumbnailPath: string,
): MediaHistoryCommercePreview {
  const available = Boolean(path);
  return {
    available,
    kind,
    path,
    thumbnailPath,
    delivery: available ? (kind === "video" ? "ticket" : "bearer") : "none",
  };
}

function retainedMediaHistoryItem(
  item: Omit<PublicMediaHistoryItem, "expiresAt" | "retentionSource">,
  explicitUpstreamExpiry?: string | null,
): { item: PublicMediaHistoryItem; expired: boolean } {
  const retention = resolveMediaHistoryRetention({
    kind: item.kind,
    status: item.status,
    createdAt: item.createdAt,
    completedAt: item.completedAt,
    upstreamExpiresAt: explicitUpstreamExpiry,
  });
  return {
    item: {
      ...item,
      expiresAt: retention.expiresAt,
      retentionSource: retention.retentionSource,
    },
    expired: retention.expired,
  };
}

function imageHistoryPresentation(
  categoryKey: CategoryKey,
  conversation: { title: string; source: string } | undefined,
): { project: string; source: string; sourcePath: string } {
  if (categoryKey === "cover-studio") return { project: "封面制作", source: "封面制作", sourcePath: "/cover" };
  if (categoryKey === "storyboard-workbench") return { project: "分镜工作台", source: "分镜工作台", sourcePath: "/storyboard-workbench" };
  if (categoryKey === "short-drama") return { project: "影视工坊", source: "影视工坊", sourcePath: "/short-drama" };
  if (categoryKey === "free-canvas") return { project: "自由画布", source: "自由画布", sourcePath: "/free-canvas" };
  if (categoryKey === "image-workbench") {
    return { project: conversation?.title || "AI 生图", source: "AI 生图工作台", sourcePath: "/image-workbench" };
  }
  return {
    project: conversation?.title || "智能体图片",
    source: publicSourceName(conversation?.source || "智能体应用"),
    sourcePath: "/",
  };
}

function stableTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function stableDedupe(items: PublicMediaHistoryItem[]): PublicMediaHistoryItem[] {
  const byId = new Map<string, PublicMediaHistoryItem>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => (
    stableTimestamp(right.createdAt) - stableTimestamp(left.createdAt)
    || right.id.localeCompare(left.id)
  ));
}

function searchableText(item: PublicMediaHistoryItem): string {
  return [
    item.id,
    item.title,
    item.project,
    item.segment,
    item.source,
    item.publicModelName,
    item.status,
    item.categoryKey,
  ].join("\n").toLocaleLowerCase("zh-CN");
}

function exactFacets(items: PublicMediaHistoryItem[]) {
  const categories = Object.fromEntries([
    ["all", items.length],
    ...MEDIA_HISTORY_CATEGORY_KEYS.map(key => [key, 0] as const),
  ]) as Record<"all" | CategoryKey, number>;
  const kinds: Record<"all" | MediaKind, number> = { all: items.length, image: 0, video: 0 };
  for (const item of items) {
    categories[item.categoryKey] += 1;
    kinds[item.kind] += 1;
  }
  return {
    all: items.length,
    image: kinds.image,
    video: kinds.video,
    kinds,
    categories,
  };
}

function unavailableFacets() {
  return {
    all: null,
    image: null,
    video: null,
    kinds: { all: null, image: null, video: null },
    categories: Object.fromEntries([
      ["all", null],
      ...MEDIA_HISTORY_CATEGORY_KEYS.map(key => [key, null] as const),
    ]) as Record<"all" | CategoryKey, null>,
  };
}

async function buildMediaHistoryAccountSnapshot(
  db: MediaDb,
  userId: string,
  role: MediaHistoryCommerceRole,
): Promise<MediaHistoryAccountSnapshot> {
  const [videoPage, imagePage, deliveredImagePage, commercePage]: [
    SourcePages["videoPage"],
    SourcePages["imagePage"],
    SourcePages["deliveredImagePage"],
    SourcePages["commercePage"],
  ] = await Promise.all([
    loadVideoRows(db, userId),
    loadImageMessages(db, userId),
    loadDeliveredImageRows(db, userId),
    Promise.resolve().then(() => loadCommerceMediaHistory(userId, role)),
  ]);
  const sourceEnumerationFailed = videoPage.failed || imagePage.failed || deliveredImagePage.failed || commercePage.failed;
  const allSourcesFailed = videoPage.failed && imagePage.failed && deliveredImagePage.failed && commercePage.failed;
  if (allSourcesFailed) {
    return {
      rows: [],
      facets: unavailableFacets(),
      sourceFailures: ["视频任务", "聊天图片记录", "生图交付记录", "带货 Agent 媒体记录"],
      enumerationFailed: true,
      allSourcesFailed: true,
      expiredCount: 0,
    };
  }

  const imageMessages = imagePage.entries;
  const conversationIds = Array.from(new Set(imageMessages.map((entry) => String(entry.message.conversation_id || "")).filter(Boolean)));
  const conversationMap = new Map<string, { title: string; source: string }>();
  if (conversationIds.length) {
    const conversations = await db
      .from("conversations")
      .select("id, title, source")
      .eq("user_id", userId)
      .in("id", conversationIds);
    for (const row of conversations.data || []) {
      conversationMap.set(String(row.id), { title: String(row.title || "图片生成"), source: String(row.source || "智能体对话") });
    }
  }

  const galleryAssetIds = new Set(imageMessages.flatMap(({ gallery }) => (
    gallery.images.map((image) => String(image.assetId || "").trim()).filter(Boolean)
  )));
  const deliveredImageAssetIds = deliveredImagePage.rows
    .map(row => String(row.delivery_asset_id || "").trim())
    .filter(Boolean);
  const referencedAssetIds = Array.from(new Set([...galleryAssetIds, ...deliveredImageAssetIds]));
  const ownedImageAssetMap = new Map<string, { storageKey: string; contentType: string; meta: unknown }>();
  let imageAssetLookupFailed = false;
  for (let offset = 0; offset < referencedAssetIds.length; offset += 100) {
    const ownedAssets = await db
      .from("user_files")
      .select("id, storage_key, content_type, meta")
      .eq("user_id", userId)
      .in("id", referencedAssetIds.slice(offset, offset + 100));
    if (ownedAssets.error) {
      imageAssetLookupFailed = true;
      break;
    } else {
      for (const asset of ownedAssets.data || []) {
        ownedImageAssetMap.set(String(asset.id), {
          storageKey: String(asset.storage_key || ""),
          contentType: String(asset.content_type || ""),
          meta: asset.meta,
        });
      }
    }
  }

  const imageProvenance = await loadMediaImageProvenance(userId, [...ownedImageAssetMap.keys()]);

  const ownedImageStorageKeys = Array.from(new Set([...ownedImageAssetMap.values()]
    .map(asset => asset.storageKey)
    .filter(Boolean)));
  const shortDramaImageStorageKeys = new Set<string>();
  let shortDramaImageLookupFailed = false;
  for (let offset = 0; offset < ownedImageStorageKeys.length; offset += 100) {
    const result = await db
      .from("short_drama_assets")
      .select("object_key")
      .eq("user_id", userId)
      .in("object_key", ownedImageStorageKeys.slice(offset, offset + 100))
      .is("deleted_at", null);
    if (result.error) {
      shortDramaImageLookupFailed = true;
      break;
    }
    for (const row of result.data || []) shortDramaImageStorageKeys.add(String(row.object_key || ""));
  }

  const shortDramaBatchIds = Array.from(new Set(videoPage.rows
    .map(row => mediaHistoryProjectUuid(row.batch_id))
    .filter((batchId): batchId is string => Boolean(batchId))));
  const shortDramaProjects = new Map<string, string>();
  let shortDramaLookupFailed = false;
  for (let offset = 0; offset < shortDramaBatchIds.length; offset += 100) {
    const result = await db
      .from("short_drama_projects")
      .select("id,title")
      .eq("user_id", userId)
      .in("id", shortDramaBatchIds.slice(offset, offset + 100));
    if (result.error) {
      shortDramaLookupFailed = true;
      break;
    }
    for (const row of result.data || []) {
      shortDramaProjects.set(String(row.id), String(row.title || "影视工坊"));
    }
  }

  // 已下线功能的历史任务不再暴露到媒体库，避免出现失效入口。
  const videoRows = videoPage.rows;
  const retainedVideos = videoRows.map((row) => {
    const recordId = String(row.id || "");
    const human = isCurrentDigitalHumanTask(row);
    const storyboard = String(row.task_label || "").startsWith("分镜工作台");
    const shortDramaTitle = shortDramaProjects.get(String(row.batch_id || ""));
    const shortDrama = Boolean(shortDramaTitle);
    const freeCanvas = String(row.batch_id || "").trim() === "manual-workflow";
    const categoryKey = mediaHistoryCategoryFromVideoSource({
      digitalHuman: human,
      storyboard,
      shortDrama,
      batchId: String(row.batch_id || ""),
    });
    const humanTitle = row.task_label === "digital-human:video" ? "视频改口型" : "照片说话";
    const cardIndex = Number(row.card_index || 0);
    const configuredModelName = relationName(row.video_models);
    const modelName = publicModelBaseName(configuredModelName, "视频模型");
    const variant = publicVariantLabel({ name: configuredModelName }, 0);
    const rawError = String(row.error_message || "");
    const chargedRaw = row.price_charged;
    const charged = chargedRaw === null || chargedRaw === undefined || chargedRaw === "" ? null : Number(chargedRaw);
    const rawStatus = safeStatus(row.status);
    const hasAuthenticatedDeliverySource = Boolean(
      String(row.storage_url || "").trim()
      || String(row.provider_result_url || "").trim()
      || String(row.video_url || "").trim(),
    );
    const deliveryReady = rawStatus === "completed" && hasAuthenticatedDeliverySource;
    const previewPath = deliveryReady ? `/api/video/storage/${encodeURIComponent(recordId)}` : "";
    const thumbnailPath = deliveryReady ? `/api/video/thumbnail/${encodeURIComponent(recordId)}` : "";
    const status = rawStatus === "completed" && !deliveryReady ? "failed" : rawStatus;
    return retainedMediaHistoryItem({
      id: `video:${recordId}`,
      kind: "video",
      title: human ? humanTitle : String(row.task_label || (cardIndex ? `分镜 ${String(cardIndex).padStart(2, "0")}` : "视频任务")),
      project: human ? "AI 数字人" : shortDrama ? shortDramaTitle! : freeCanvas ? "自由画布" : String(row.batch_topic || (storyboard ? "分镜工作台" : "视频制作")),
      segment: human ? humanTitle : cardIndex ? `分镜 ${String(cardIndex).padStart(2, "0")}` : String(row.task_label || "未标注分镜"),
      source: human ? "AI 数字人" : shortDrama ? "影视工坊" : storyboard ? "分镜工作台" : freeCanvas ? "自由画布" : "视频制作",
      sourcePath: human ? "/digital-human" : shortDrama ? "/short-drama" : storyboard ? "/storyboard-workbench" : freeCanvas ? "/free-canvas" : "/video",
      retryPath: categoryKey === "video-production" && canRetryVideoHistoryTask(row)
        ? `/video?retryTask=${encodeURIComponent(recordId)}`
        : "",
      categoryKey,
      removable: true,
      status,
      createdAt: String(row.created_at || ""),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      publicModelName: `${modelName} · ${variant}`,
      cost: charged !== null && Number.isFinite(charged) ? charged : null,
      costNote: charged !== null && Number.isFinite(charged) ? "任务实际费用" : "账单未关联",
      previewPath,
      thumbnailPath,
      downloadPath: previewPath,
      preview: previewContract("video", previewPath, thumbnailPath),
      errorMessage: rawStatus === "completed" && !hasAuthenticatedDeliverySource
        ? "任务已标记完成，但没有可验证的交付地址，暂不可预览或下载。"
        : rawError ? classifyVideoProviderError(rawError, modelName).publicMessage : "",
      aspectRatio: String(row.aspect_ratio || ""),
      durationSeconds: Number.isFinite(Number(row.duration_seconds)) ? Number(row.duration_seconds) : null,
    }, upstreamMediaExpiry(row.provider_submission_receipt) || upstreamMediaExpiry(row.provider_dispatch_receipt));
  });
  const videos = retainedVideos.filter(entry => !entry.expired).map(entry => entry.item);

  const retainedImages = imageMessages.flatMap(({ message, gallery }) => {
    const conversationId = String(message.conversation_id || "");
    const conversation = conversationMap.get(conversationId);
    return gallery.images.flatMap((image, index) => {
      if (!visibleGalleryIndex(message, index)) return [];
      const recordId = String(message.id || "");
      const query = new URLSearchParams({ id: recordId, index: String(index) });
      const assetId = String(image.assetId || "").trim();
      const storageKey = String(image.storageKey || "").trim();
      const ownedAsset = assetId ? ownedImageAssetMap.get(assetId) : undefined;
      const cover = imageProvenance.covers.get(assetId);
      const receipt = imageProvenance.receipts.get(cover?.backgroundAssetId || assetId);
      const fromImageWorkbench = String(message.agent_id || "") === "image-workbench";
      const imageSurface = imageProvenance.origins.get(cover?.backgroundAssetId || assetId)?.surface;
      const categoryKey = shortDramaImageStorageKeys.has(ownedAsset?.storageKey || "")
        ? "short-drama" as const
        : mediaHistoryCategoryFromImageSurface({
          surface: imageSurface,
          cover: Boolean(cover),
          agentId: fromImageWorkbench ? "image-workbench" : String(message.agent_id || ""),
        });
      const presentation = imageHistoryPresentation(categoryKey, conversation);
      const deliveryReady = Boolean(
        assetId
        && storageKey
        && ownedAsset
        && ownedAsset.storageKey === storageKey
        && ownedAsset.contentType.startsWith("image/"),
      );
      const previewPath = deliveryReady ? `/api/media-history/content?${query.toString()}` : "";
      return [retainedMediaHistoryItem({
        id: `image:${recordId}:${index}`,
        kind: "image" as const,
        title: cover?.title || String(image.title || image.label || `图片 ${String(index + 1).padStart(2, "0")}`),
        project: presentation.project,
        segment: `图片 ${String(index + 1).padStart(2, "0")}`,
        source: presentation.source,
        sourcePath: presentation.sourcePath,
        retryPath: "",
        categoryKey,
        removable: true,
        status: deliveryReady ? "completed" as const : "failed" as const,
        createdAt: String(message.created_at || ""),
        completedAt: deliveryReady ? String(message.created_at || "") : null,
        publicModelName: receipt ? publicModelBaseName(receipt.modelName, "图片生成模型") : cover ? "封面文字排版" : "图片生成模型",
        cost: cover ? 0 : receipt?.cost ?? null,
        costNote: cover ? `文字排版不额外收费${receipt ? `；底图生成费 ¥${receipt.cost.toFixed(2)} 已计入原任务` : "；底图费用以原生成任务账单为准"}`
          : receipt ? "原生成任务实际扣费" : "原记录未建立图片与账单的一对一关联",
        previewPath,
        thumbnailPath: previewPath,
        downloadPath: deliveryReady ? `/api/media-history/content?${query.toString()}&download=1` : "",
        preview: previewContract("image", previewPath, previewPath),
        errorMessage: deliveryReady
          ? ""
          : "图片历史缺少与当前用户匹配的永久资产记录，暂不可交付。",
        aspectRatio: cover?.ratio || (image.width && image.height ? `${image.width}:${image.height}` : ""),
        durationSeconds: null,
      }, upstreamMediaExpiry(ownedAsset?.meta))];
    });
  });

  const retainedDeliveredImages = deliveredImagePage.rows.flatMap((row) => {
    const recordId = String(row.record_id || "").trim();
    const assetId = String(row.delivery_asset_id || "").trim();
    if (!recordId || !assetId || galleryAssetIds.has(assetId)) return [];

    const ownedAsset = ownedImageAssetMap.get(assetId);
    const snapshot = parseImageFailureRequestSnapshot(row.request_snapshot);
    const receipt = imageProvenance.receipts.get(assetId);
    const surface = snapshot?.surface || imageProvenance.origins.get(assetId)?.surface || "other";
    const categoryKey = shortDramaImageStorageKeys.has(ownedAsset?.storageKey || "")
      ? "short-drama" as const
      : mediaHistoryCategoryFromImageSurface({ surface });
    const presentation = imageHistoryPresentation(categoryKey, undefined);
    const deliveryReady = Boolean(
      ownedAsset
      && ownedAsset.storageKey
      && ownedAsset.contentType.startsWith("image/"),
    );
    const query = new URLSearchParams({ assetId });
    const previewPath = deliveryReady ? `/api/media-history/content?${query.toString()}` : "";
    const title = categoryKey === "storyboard-workbench"
      ? "分镜故事板"
      : categoryKey === "cover-studio"
        ? "封面底图"
        : categoryKey === "image-workbench"
          ? "AI 生图"
          : "生成图片";
    const createdAt = String(row.created_at || row.updated_at || "");
    const completedAt = String(row.updated_at || row.created_at || "") || null;

    return [retainedMediaHistoryItem({
      id: `image-attempt:${recordId}`,
      kind: "image" as const,
      title,
      project: presentation.project,
      segment: snapshot ? `${snapshot.aspectRatio} · ${snapshot.resolution}` : "生成图片",
      source: presentation.source,
      sourcePath: presentation.sourcePath,
      retryPath: "",
      categoryKey,
      removable: false,
      status: deliveryReady ? "completed" as const : "failed" as const,
      createdAt,
      completedAt: deliveryReady ? completedAt : null,
      publicModelName: publicModelBaseName(receipt?.modelName || snapshot?.modelName || "图片生成模型", "图片生成模型"),
      cost: receipt?.cost ?? null,
      costNote: receipt ? "原生成任务实际扣费" : "原记录未建立图片与账单的一对一关联",
      previewPath,
      thumbnailPath: previewPath,
      downloadPath: deliveryReady ? `/api/media-history/content?${query.toString()}&download=1` : "",
      preview: previewContract("image", previewPath, previewPath),
      errorMessage: deliveryReady ? "" : "生图记录已完成，但永久资产不存在或不属于当前账号。",
      aspectRatio: snapshot?.aspectRatio || "",
      durationSeconds: null,
    }, upstreamMediaExpiry(ownedAsset?.meta))];
  });

  const images = [...retainedImages, ...retainedDeliveredImages]
    .filter(entry => !entry.expired)
    .map(entry => entry.item);

  const retainedCommerce = commercePage.items.map(item => retainedMediaHistoryItem(item));
  const commerceItems = retainedCommerce.filter(entry => !entry.expired).map(entry => entry.item);
  const expiredCount = [...retainedVideos, ...retainedImages, ...retainedDeliveredImages, ...retainedCommerce]
    .filter(entry => entry.expired).length;
  const merged = stableDedupe([...videos, ...images, ...commerceItems]);
  const sourceFailures = [
    ...(videoPage.failed ? ["视频任务"] : []),
    ...(imagePage.failed ? ["聊天图片记录"] : []),
    ...(deliveredImagePage.failed ? ["生图交付记录"] : []),
    ...(commercePage.failed ? ["带货 Agent 媒体记录"] : []),
    ...(imageAssetLookupFailed ? ["图片资产归属"] : []),
    ...(imageProvenance.failed ? ["图片来源与费用"] : []),
    ...(shortDramaLookupFailed ? ["影视工坊视频来源"] : []),
    ...(shortDramaImageLookupFailed ? ["影视工坊图片来源"] : []),
  ];
  const facets = sourceEnumerationFailed ? unavailableFacets() : exactFacets(merged);
  return {
    rows: merged.map(item => ({ item, searchText: searchableText(item) })),
    facets,
    sourceFailures,
    enumerationFailed: sourceEnumerationFailed,
    allSourcesFailed: false,
    expiredCount,
  };
}

function loadMediaHistoryAccountSnapshot(
  db: MediaDb,
  userId: string,
  role: MediaHistoryCommerceRole,
): Promise<MediaHistoryAccountSnapshot> {
  return loadCachedMediaHistorySnapshot(
    mediaHistorySnapshotCacheKey(userId, role),
    () => buildMediaHistoryAccountSnapshot(db, userId, role),
  );
}

type MediaHistoryCacheTestHook = {
  load: (cacheKey: string, build: () => Promise<unknown>) => Promise<unknown>;
  invalidate: (cacheKey: string) => void;
  expireSettled: (cacheKey: string) => void;
  clear: () => void;
  stats: () => {
    active: number;
    waiting: number;
    pending: number;
    settled: number;
    keys: string[];
  };
  busyResponse: () => NextResponse;
  limits: { active: number; waiting: number; settled: number };
};

if (process.env.MEDIA_HISTORY_CACHE_TEST_HOOK === "1") {
  const testGlobal = globalThis as typeof globalThis & {
    __MEDIA_HISTORY_CACHE_TEST_HOOK__?: MediaHistoryCacheTestHook;
  };
  testGlobal.__MEDIA_HISTORY_CACHE_TEST_HOOK__ = {
    load: (cacheKey, build) => loadCachedMediaHistorySnapshot(
      cacheKey,
      build as () => Promise<MediaHistoryAccountSnapshot>,
    ),
    invalidate: cacheKey => mediaHistorySnapshotCache.delete(cacheKey),
    expireSettled: cacheKey => {
      const entry = mediaHistorySnapshotCache.get(cacheKey);
      if (entry?.state === "settled") entry.expiresAt = 0;
    },
    clear: () => {
      if (activeMediaHistorySnapshotBuilds || mediaHistorySnapshotWaiters.length) {
        throw new Error("MEDIA_HISTORY_CACHE_TEST_RESET_WHILE_BUSY");
      }
      mediaHistorySnapshotCache.clear();
    },
    stats: () => {
      const entries = [...mediaHistorySnapshotCache.entries()];
      return {
        active: activeMediaHistorySnapshotBuilds,
        waiting: mediaHistorySnapshotWaiters.length,
        pending: entries.filter(([, entry]) => entry.state === "pending").length,
        settled: entries.filter(([, entry]) => entry.state === "settled").length,
        keys: entries.map(([cacheKey]) => cacheKey),
      };
    },
    busyResponse: mediaHistoryBusyResponse,
    limits: {
      active: MEDIA_HISTORY_SNAPSHOT_MAX_ACTIVE_BUILDS,
      waiting: MEDIA_HISTORY_SNAPSHOT_MAX_WAITING_BUILDS,
      settled: MEDIA_HISTORY_SNAPSHOT_MAX_SETTLED_ACCOUNTS,
    },
  };
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;

  const limit = pageInteger(request.nextUrl.searchParams.get("limit"), 100, 1, 100);
  const offset = pageInteger(
    request.nextUrl.searchParams.get("offset"),
    0,
    0,
    Number.MAX_SAFE_INTEGER - 100,
  );
  const rawCategory = String(request.nextUrl.searchParams.get("category") || "all").trim();
  const rawKind = String(request.nextUrl.searchParams.get("kind") || "all").trim();
  const queryText = String(request.nextUrl.searchParams.get("q") || "").trim();
  if (rawCategory !== "all" && !CATEGORY_KEYS.has(rawCategory as CategoryKey)) {
    return NextResponse.json({ error: "媒体分类无效" }, { status: 400 });
  }
  if (rawKind !== "all" && !KIND_KEYS.has(rawKind as MediaKind)) {
    return NextResponse.json({ error: "媒体类型无效" }, { status: 400 });
  }
  if (queryText.length > 160) {
    return NextResponse.json({ error: "搜索关键词不能超过 160 个字符" }, { status: 400 });
  }
  const userId = user.userId;
  const db = getSupabaseClient();
  let snapshot: MediaHistoryAccountSnapshot;
  try {
    snapshot = await loadMediaHistoryAccountSnapshot(db, userId, user.role);
  } catch (error) {
    if (error instanceof MediaHistoryBusyError) return mediaHistoryBusyResponse();
    throw error;
  }

  if (snapshot.allSourcesFailed) {
    return NextResponse.json({ error: "媒体历史暂时不可用" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  const normalizedQuery = queryText.toLocaleLowerCase("zh-CN");
  const filtered = snapshot.rows.filter(row => (
    (rawCategory === "all" || row.item.categoryKey === rawCategory)
    && (rawKind === "all" || row.item.kind === rawKind)
    && (!normalizedQuery || row.searchText.includes(normalizedQuery))
  ));
  const items = filtered.slice(offset, offset + limit).map(row => row.item);
  const hasMore = snapshot.enumerationFailed ? null : filtered.length > offset + limit;
  const totalCount = snapshot.enumerationFailed ? null : filtered.length;
  const facets = snapshot.facets;

  return NextResponse.json({
    items,
    facets: {
      categories: facets.categories,
      kinds: facets.kinds,
      all: facets.all,
      image: facets.image,
      video: facets.video,
    },
    total: totalCount,
    totalCount,
    totalCountSource: totalCount === null ? "unavailable" : "exact-aggregate",
    pagination: {
      offset,
      limit,
      total: totalCount,
      returned: items.length,
      currentCount: items.length,
      hasMore,
      nextOffset: hasMore === true ? offset + items.length : null,
      totalKnown: totalCount !== null,
    },
    sourceFailures: snapshot.sourceFailures,
    countFailures: snapshot.enumerationFailed ? snapshot.sourceFailures : [],
    expiredCount: snapshot.expiredCount,
    retention: {
      imageFallbackDays: MEDIA_HISTORY_FALLBACK_DAYS.image,
      videoFallbackDays: MEDIA_HISTORY_FALLBACK_DAYS.video,
      strategy: "upstream-expiry-then-fallback",
    },
  }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;
  const body = await request.json().catch(() => null) as { id?: string; confirmation?: string } | null;
  if (!body?.id || !["REMOVE_HISTORY", "DELETE_SERVER_RECORD"].includes(body.confirmation || "")) {
    return NextResponse.json({ error: "请确认移除这条历史记录" }, { status: 400 });
  }

  const [kind, rawId, rawIndex, extra] = body.id.split(":");
  if (extra !== undefined) return NextResponse.json({ error: "历史记录无效" }, { status: 400 });
  let response: Response;
  if (kind === "video" && rawId && rawIndex === undefined) {
    response = await hideMediaHistoryItem(user.userId, "video", rawId);
  } else if (kind === "image" && rawId && rawIndex !== undefined && /^\d+$/.test(rawIndex)) {
    response = await hideMediaHistoryItem(user.userId, "image", rawId, Number(rawIndex));
  } else {
    return NextResponse.json({ error: "历史记录无效" }, { status: 400 });
  }
  if (response.ok) invalidateMediaHistorySnapshot(user.userId, user.role);
  return response;
}
