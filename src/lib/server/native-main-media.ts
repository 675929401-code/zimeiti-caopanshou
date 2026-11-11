import "server-only";
import type { getSupabase } from "@/lib/api-middleware";
import { NativeOwnedMediaRefSchema, nativeMainMediaPath, type NativeMediaSource, type NativeOwnedMediaRef } from "@/lib/native-main-media-contract";
import { isPublishingSafeHttps } from "@/lib/publishing-contract";
import { nativeAssetPath } from "@/lib/native-operations-contract";
import { PublishingError } from "./publishing-service";
import { readPublishingProviderConfiguration } from "./publishing-provider-config";

type DB = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const number = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
function unavailable(): never { throw new PublishingError("NATIVE_MAIN_MEDIA_UNAVAILABLE", "主站素材未完成交付、已失效或不属于当前会员", 409); }
async function one(db: DB, table: string, ownerColumn: string, owner: string, idColumn: string, id: string): Promise<Row> {
  const result = await db.from(table).select("*").eq(ownerColumn, owner).eq(idColumn, id).maybeSingle();
  if (result.error) throw new PublishingError("NATIVE_MAIN_MEDIA_LOOKUP_UNAVAILABLE", "主站素材归属暂不可确认", 503);
  const value = row(result.data);
  if (!result.data || value[ownerColumn] !== owner || String(value[idColumn]) !== id) unavailable();
  return value;
}
export { nativeMainMediaPath } from "@/lib/native-main-media-contract";
export function nativeOwnedImageInput(reference: NativeOwnedMediaRef): string {
  const ref = NativeOwnedMediaRefSchema.parse(reference);
  if (ref.kind === "video_task") unavailable();
  return `native-owned-image://${ref.kind}/${ref.id}`;
}
export interface NativeResolvedMedia {
  source: NativeMediaSource;
  contentPath: string;
  fileName: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  connectionCurrent: boolean;
  localMediaId?: string;
  hash?: string;
}
/** Read facts from the existing owner ledger; this never exports or copies an object. */
export async function readNativeMainMedia(db: DB, owner: string, reference: NativeOwnedMediaRef): Promise<NativeResolvedMedia> {
  const ref = NativeOwnedMediaRefSchema.parse(reference);
  const value = ref.kind === "video_task" ? await one(db, "video_tasks", "user_id", owner, "id", ref.id)
    : ref.kind === "image_asset" ? await one(db, "user_files", "user_id", owner, "id", ref.id)
      : await one(db, "image_generation_requests", "user_id", owner, "record_id", ref.id);
  const response = row(value.response), meta = row(value.meta ?? value.metadata);
  if (ref.kind === "video_task" && (value.status !== "completed" || value.source_expired_at != null)) unavailable();
  if (ref.kind === "image_asset" && !text(value.content_type).startsWith("image/")) unavailable();
  if (ref.kind === "image_record" && (value.state !== "completed" || value.delivery_state !== "delivered" || response.deliveryMode !== "provider_url" || response.sourceExpiredAt)) unavailable();
  const mime = ref.kind === "video_task" ? "video/mp4" : text(value.content_type ?? response.contentType) || "image/png";
  const width = number(meta.width ?? response.width), height = number(meta.height ?? response.height), duration = number(value.duration_seconds);
  return {
    source: { kind: "main_asset", reference: ref }, contentPath: nativeMainMediaPath(ref),
    fileName: text(value.file_name) || `${ref.kind}-${ref.id}.${ref.kind === "video_task" ? "mp4" : "png"}`,
    mime, size: number(value.file_size ?? response.size), ...(width ? { width } : {}), ...(height ? { height } : {}), ...(duration ? { duration } : {}),
    connectionCurrent: true,
  };
}
export async function readNativeMediaSource(db: DB, owner: string, source: NativeMediaSource, dependencies: { configuration?: () => { namespace: string } } = {}): Promise<NativeResolvedMedia> {
  if (source.kind === "main_asset") return readNativeMainMedia(db, owner, source.reference);
  const asset = await one(db, "pub3_assets", "owner_id", owner, "id", source.assetId);
  if (asset.state !== "ready") unavailable();
  const cfg = (dependencies.configuration ?? readPublishingProviderConfiguration)(), meta = row(asset.metadata);
  return {
    source, contentPath: nativeAssetPath(source.assetId), fileName: text(asset.file_name), mime: text(asset.mime), size: number(asset.size),
    ...(number(meta.width) ? { width: number(meta.width) } : {}), ...(number(meta.height) ? { height: number(meta.height) } : {}),
    ...(number(meta.duration) ? { duration: number(meta.duration) } : {}), connectionCurrent: asset.connection_id === cfg.namespace, localMediaId: text(asset.local_media_id), hash: text(asset.sha256),
  };
}
/** Native durable requests contain opaque references; temporary access URLs stay in memory. */
export async function resolveNativeAiImageInput(db: DB, userId: string, value: string): Promise<string> {
  const match = /^native-owned-image:\/\/(image_record|image_asset)\/([A-Za-z0-9_.:-]{1,256})$/u.exec(value);
  if (!match) unavailable();
  const ref = NativeOwnedMediaRefSchema.parse({ kind: match[1], id: match[2] });
  await readNativeMainMedia(db, userId, ref);
  let url: string;
  if (ref.kind === "image_record") {
    const receipt = await one(db, "image_generation_requests", "user_id", userId, "record_id", ref.id);
    url = text(row(receipt.response).providerUrl);
  } else {
    const file = await one(db, "user_files", "user_id", userId, "id", ref.id);
    const provider = text(file.storage_provider);
    if (!["coze_s3", "tencent_cos"].includes(provider) || !text(file.storage_key)) throw new PublishingError("NATIVE_REFERENCE_PROVIDER_UNAVAILABLE", "这份参考图当前没有可供生成服务读取的云存储入口，请使用已交付的主站生成图片", 409);
    const { storageManager } = await import("@/storage/object");
    url = await storageManager.getSignedUrl(text(file.storage_key), { expireTime: 600 }, provider as "coze_s3" | "tencent_cos");
  }
  if (!isPublishingSafeHttps(url)) unavailable();
  return url;
}
