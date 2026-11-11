import "server-only";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { DatabaseImageExactlyOnceStore, type ImageExactlyOnceStore } from "@/lib/image-exactly-once";
import { readGeneratedImageMaterial } from "@/lib/server/generated-image-reference";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import { POST as persistImage } from "@/app/api/image-workbench/persist/route";
import { coverCompositionValidationError, coverTextRendering, type CoverCompositionPlan } from "@/lib/cover-composition";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class CoverGeneratedExportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message); this.name = "CoverGeneratedExportError"; }
}
function refuse(code: string, message: string, status = 503): never { throw new CoverGeneratedExportError(`COVER_GENERATED_EXPORT_${code}`, message, status); }

type ExportBinding = {
  schema: "cover_generated_export/1"; recordId: string; requestBindingSha256: string;
  sha256: string; byteLength: number; contentType: string; width: number; height: number;
  nativePlan?: CoverCompositionPlan;
};
export type CoverGeneratedExportAsset = {
  id: string; user_id: string; storage_key: string; storage_provider: string;
  file_category: string; source: string; content_type: string; file_size: number | string; meta: unknown;
};
export type CoverGeneratedExportInput = {
  request: NextRequest; userId: string; recordId: string; clientIdempotencyKey: string; clientTraceId: string;
  plan?: CoverCompositionPlan;
};
export type CoverGeneratedExportReceipt = {
  success: true; persisted: true; cloudStored: true; userId: string; recordId: string;
  assetId: string; historyRecordId: string; key: string; storageKey: string; provider: "tencent_cos";
  contentType: string; byteLength: number; width: number; height: number; sha256: string; exportTraceId: string; reused: boolean;
};
export type CoverGeneratedExportDependencies = {
  authorize: typeof authorizeCurrentApiUser;
  getRecord: ImageExactlyOnceStore["get"];
  readMaterial: typeof readGeneratedImageMaterial;
  findAsset(userId: string, exportTraceId: string): Promise<CoverGeneratedExportAsset | null>;
  readStored(key: string): Promise<Buffer>;
  bindAsset(asset: CoverGeneratedExportAsset, binding: ExportBinding): Promise<void>;
  persist: typeof persistImage;
};
const ASSET_COLUMNS = "id,user_id,storage_key,storage_provider,file_category,source,content_type,file_size,meta";
const defaults: CoverGeneratedExportDependencies = {
  authorize: authorizeCurrentApiUser,
  getRecord: (keys) => new DatabaseImageExactlyOnceStore().get(keys),
  readMaterial: readGeneratedImageMaterial,
  async findAsset(userId, exportTraceId) {
    const found = await getSupabaseClient().from("user_files").select(ASSET_COLUMNS)
      .eq("user_id", userId).eq("storage_provider", "tencent_cos").eq("file_category", "image")
      .eq("source", "image-workbench").eq("meta->>clientTraceId", exportTraceId).limit(2);
    if (found.error) refuse("PERSIST_PENDING", "原底图导出记录暂时无法确认，请查询原任务；不会重新生图。");
    if ((found.data?.length || 0) > 1) refuse("ASSET_BINDING_MISMATCH", "原底图存在不一致的导出记录，请保留任务并联系管理员。");
    return (found.data?.[0] || null) as CoverGeneratedExportAsset | null;
  },
  readStored: (key) => storageManager.readBounded(key, MAX_BYTES, 20_000, "tencent_cos"),
  async bindAsset(asset, binding) {
    // Compare the whole previous metadata JSON so other writers are never overwritten.
    const prior = object(asset.meta);
    const updated = await getSupabaseClient().from("user_files")
      .update({ meta: { ...prior, coverGeneratedExport: binding } })
      .eq("id", asset.id).eq("user_id", asset.user_id).eq("storage_key", asset.storage_key)
      .eq("storage_provider", "tencent_cos").eq("file_category", "image")
      .eq("meta", JSON.stringify(prior)).is("meta->coverGeneratedExport", null);
    if (updated.error) refuse("PERSIST_PENDING", "原底图已保存，来源绑定尚未确认，请查询原任务；不会重新生图。");
  },
  persist: persistImage,
};

async function inspectBytes(bytes: Buffer, declaredType: string): Promise<Omit<ExportBinding, "schema" | "recordId" | "requestBindingSha256" | "nativePlan">> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) refuse("IMAGE_INVALID", "原底图为空或超过 25MB 导出上限。", 422);
  const contentType = declaredType.split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) refuse("IMAGE_INVALID", "原底图格式不支持导出，请保留原任务记录。", 422);
  try {
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS });
    const metadata = await decoder.metadata();
    const formatTypes: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
    const formatType = formatTypes[String(metadata.format)];
    const width = Number(metadata.width), height = Number(metadata.height);
    if (formatType !== contentType || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width * height > MAX_PIXELS || (metadata.pages || 1) !== 1) throw new Error("invalid dimensions or format");
    await decoder.raw().toBuffer(); // Fully decode for validation; only the untouched original bytes are persisted.
    return { sha256: digest(bytes), byteLength: bytes.length, contentType, width, height };
  } catch { return refuse("IMAGE_INVALID", "原底图无法完整解码或超过 4000 万像素上限，未导出其他图片。", 422); }
}

function checkedAsset(asset: CoverGeneratedExportAsset, input: CoverGeneratedExportInput, exportTraceId: string) {
  const expectedName = `${digest(`${input.userId}\0${exportTraceId}`).slice(0, 48)}-1`;
  // COS buildKey wraps this logical name in images/YYYY/MM/DD/. Keep old logical
  // keys valid too, and never bind recovery to today's upload directory.
  const validKey = new RegExp(`^(?:images/[0-9]{4}/(?:0[1-9]|1[0-2])/(?:0[1-9]|[12][0-9]|3[01])/)?image-workbench/by-trace/${expectedName}\\.(?:png|jpg|jpeg|webp)$`, "u")
    .test(asset.storage_key);
  if (!UUID.test(asset.id) || asset.user_id !== input.userId || asset.storage_provider !== "tencent_cos" || asset.file_category !== "image"
    || asset.source !== "image-workbench" || !validKey
    || object(asset.meta).clientTraceId !== exportTraceId || !Number.isSafeInteger(Number(asset.file_size))
    || Number(asset.file_size) <= 0 || Number(asset.file_size) > MAX_BYTES) {
    refuse("ASSET_BINDING_MISMATCH", "原底图导出归属或追踪标识不一致，未复用其他资产。", 409);
  }
  return asset;
}
function boundTo(value: unknown, expected: ExportBinding) {
  const binding = object(value);
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return Object.entries(expected).every(([key, entry]) => JSON.stringify(canonical(binding[key])) === JSON.stringify(canonical(entry)))
    && (binding.nativePlan === undefined) === (expected.nativePlan === undefined);
}

async function exportGeneratedCoverBackgroundOnce(input: CoverGeneratedExportInput,
  deps: CoverGeneratedExportDependencies = defaults): Promise<CoverGeneratedExportReceipt> {
  if (!input.userId?.trim() || !KEY.test(input.clientIdempotencyKey) || !KEY.test(input.clientTraceId)
    || !SHA256.test(input.recordId) || input.recordId !== digest(`${input.userId}\0${input.clientIdempotencyKey}`)) {
    refuse("BINDING_INVALID", "原图片请求标识不一致，未读取或导出图片。", 422);
  }
  const authorization = await deps.authorize(input.request);
  if (!authorization.ok) refuse("AUTH_REQUIRED", "请登录原任务所属账号后继续导出。", authorization.response.status === 503 ? 503 : 401);
  if (authorization.user.userId !== input.userId) refuse("OWNER_MISMATCH", "原图片不属于当前登录账号。", 403);
  if (input.plan && coverCompositionValidationError(input.plan)) refuse("BINDING_INVALID", "原生封面计划无效，未导出图片。", 422);
  const nativePlan = input.plan && coverTextRendering(input.plan).mode === "native" ? input.plan : undefined;
  const requestBindingSha256 = digest(JSON.stringify([input.userId, input.recordId, input.clientIdempotencyKey, input.clientTraceId]));
  const exportTraceId = `coverwb_bg_${requestBindingSha256}`;
  const record = await deps.getRecord({ userId: input.userId, clientIdempotencyKey: input.clientIdempotencyKey, clientTraceId: input.clientTraceId })
    .catch(() => refuse("SOURCE_UNAVAILABLE", "原图片记录暂时无法确认，请查询原任务；不会重新生图。"));
  if (!record) refuse("RECORD_NOT_FOUND", "原图片记录不存在或不属于当前账号。", 404);
  if (record.recordId !== input.recordId || record.clientIdempotencyKey !== input.clientIdempotencyKey
    || record.clientTraceId !== input.clientTraceId || record.userHash !== digest(input.userId)) {
    refuse("RECORD_BINDING_MISMATCH", "原图片记录与原请求不一致，未导出其他图片。", 409);
  }
  if (record.state !== "completed" || record.deliveryState !== "delivered") refuse("RESULT_NOT_READY", "原图片结果尚未确认，请查询原任务；不会重新生图。", 409);
  if (record.response?.deliveryMode === "inline_ephemeral") refuse("INLINE_UNAVAILABLE", "原图片仅在生成页面临时存在，原字节已不可恢复；费用记录保留，不会重新生成。", 422);
  if (record.response?.deliveryMode !== "provider_url") refuse("RESULT_NOT_READY", "当前原图片不适用此导出路径，未改变原交付策略。", 422);

  const asset = await deps.findAsset(input.userId, exportTraceId);
  if (asset) checkedAsset(asset, input, exportTraceId);
  let expected: ExportBinding;
  let sourceBytes: Buffer | undefined;
  const previousBinding = object(object(asset?.meta).coverGeneratedExport);
  if (asset && Object.keys(previousBinding).length) {
    let bytes: Buffer;
    try { bytes = await deps.readStored(asset.storage_key); }
    catch { return refuse("STORAGE_UNAVAILABLE", "原底图导出文件暂时无法读取，未重新取图或生图。"); }
    const inspected = await inspectBytes(bytes, asset.content_type);
    expected = { schema: "cover_generated_export/1", recordId: input.recordId, requestBindingSha256, ...inspected, ...(nativePlan ? { nativePlan } : {}) };
    if (Number(asset.file_size) !== inspected.byteLength || !boundTo(previousBinding, expected)) refuse("ASSET_BINDING_MISMATCH", "已保存底图与原任务绑定不一致，未导出其他图片。", 409);
  } else {
    try {
      const material = await deps.readMaterial({ userId: input.userId, reference: { schema: "generated_image_ref.v1", recordId: input.recordId }, maxBytes: MAX_BYTES });
      sourceBytes = material.buffer;
      expected = { schema: "cover_generated_export/1", recordId: input.recordId, requestBindingSha256,
        ...await inspectBytes(material.buffer, material.contentType), ...(nativePlan ? { nativePlan } : {}) };
    } catch (error) {
      if (error instanceof CoverGeneratedExportError) throw error;
      return refuse("SOURCE_UNAVAILABLE", "原底图暂时无法读取或已失效，费用记录保留；不会重新生成。");
    }
    if (asset) {
      let stored: Buffer;
      try { stored = await deps.readStored(asset.storage_key); }
      catch { return refuse("STORAGE_UNAVAILABLE", "已有导出文件暂时无法读取，未创建其他图片。"); }
      if (digest(stored) !== expected.sha256 || stored.length !== expected.byteLength) refuse("ASSET_BINDING_MISMATCH", "已有同标识图片并非原底图，未覆盖或复用。", 409);
    }
  }

  const body = JSON.stringify({ intent: "user_asset_export", index: 1, clientTraceId: exportTraceId,
    ...(asset ? { assetId: asset.id, storageKey: asset.storage_key } : { url: `data:${expected.contentType};base64,${sourceBytes!.toString("base64")}` }) });
  const headers = new Headers({ "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
  for (const name of ["authorization", "cookie"]) { const value = input.request.headers.get(name); if (value) headers.set(name, value); }
  let response: Response | undefined;
  let receipt: Record<string, unknown> = {};
  try {
    response = await deps.persist(new NextRequest(new URL("/api/image-workbench/persist", input.request.url), { method: "POST", headers, body }));
    receipt = object(await response.json().catch(() => null));
  } catch { /* The same stable trace can recover an already-saved object below. */ }
  const verified = await deps.findAsset(input.userId, exportTraceId);
  if (!verified) refuse("PERSIST_PENDING", "原底图导出尚未确认，请查询原任务；不会重新生成。");
  checkedAsset(verified, input, exportTraceId);
  let exported: Buffer;
  try { exported = await deps.readStored(verified.storage_key); }
  catch { return refuse("STORAGE_UNAVAILABLE", "原底图导出文件尚未确认可读取，请查询原任务。"); }
  if (exported.length !== expected.byteLength || Number(verified.file_size) !== expected.byteLength || digest(exported) !== expected.sha256
    || verified.content_type !== expected.contentType) refuse("ASSET_BINDING_MISMATCH", "导出文件与原底图字节不一致，未提交后续排版。", 409);
  const installed = object(verified.meta).coverGeneratedExport;
  if (installed && !boundTo(installed, expected)) refuse("ASSET_BINDING_MISMATCH", "导出文件已有其他来源绑定，未覆盖该记录。", 409);
  if (!installed) await deps.bindAsset(verified, expected);
  const readBack = await deps.findAsset(input.userId, exportTraceId);
  if (!readBack || readBack.id !== verified.id || readBack.storage_key !== verified.storage_key
    || !boundTo(object(readBack.meta).coverGeneratedExport, expected)) refuse("PERSIST_PENDING", "原底图已导出，来源绑定回读尚未确认，请查询原任务。");
  if (!response?.ok || receipt.success !== true || receipt.persisted !== true || receipt.cloudStored === false
    || receipt.historyRecorded !== true || receipt.assetId !== verified.id || receipt.key !== verified.storage_key
    || typeof receipt.historyRecordId !== "string" || !UUID.test(receipt.historyRecordId)) {
    refuse("PERSIST_PENDING", "原底图已安全导出，账号历史尚未确认，请查询原任务；不会重新生图。");
  }
  return { success: true, persisted: true, cloudStored: true, userId: input.userId, recordId: input.recordId,
    assetId: verified.id, historyRecordId: receipt.historyRecordId, key: verified.storage_key, storageKey: verified.storage_key,
    provider: "tencent_cos", contentType: expected.contentType, byteLength: expected.byteLength, width: expected.width,
    height: expected.height, sha256: expected.sha256, exportTraceId, reused: Boolean(asset) };
}

const activeExports = new WeakMap<CoverGeneratedExportDependencies, Map<string, Promise<CoverGeneratedExportReceipt>>>();

/** Only call after the V2 parent, explicit export consent and original task binding were validated. */
export async function exportGeneratedCoverBackground(input: CoverGeneratedExportInput,
  deps: CoverGeneratedExportDependencies = defaults): Promise<CoverGeneratedExportReceipt> {
  try {
    // Authenticate every caller before joining another request's in-process work.
    const authorization = await deps.authorize(input.request);
    if (!authorization.ok) refuse("AUTH_REQUIRED", "请登录原任务所属账号后继续导出。", authorization.response.status === 503 ? 503 : 401);
    if (authorization.user.userId !== input.userId) refuse("OWNER_MISMATCH", "原图片不属于当前登录账号。", 403);
    let requests = activeExports.get(deps);
    if (!requests) { requests = new Map(); activeExports.set(deps, requests); }
    const key = digest(JSON.stringify([input.userId, input.recordId, input.clientIdempotencyKey, input.clientTraceId,
      input.plan && coverTextRendering(input.plan).mode === "native" ? input.plan : null]));
    const previous = requests.get(key);
    if (previous) return await previous;
    const pending = exportGeneratedCoverBackgroundOnce(input, deps);
    requests.set(key, pending);
    try { return await pending; }
    finally { if (requests.get(key) === pending) requests.delete(key); }
  } catch (error) {
    if (error instanceof CoverGeneratedExportError) throw error;
    return refuse("PERSIST_PENDING", "原底图导出状态暂时无法确认，请查询原任务；不会重新生图。");
  }
}
