import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { storageManager, type StorageProviderType } from "@/storage/object";
import { InvalidImageFileError, validateImageFile } from "@/lib/image-file-validation";
import { parseImageDataUrl } from "@/lib/image-data-url";
import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  AUTODL_H3_SELFHOST_PROVIDER,
  autodlH3SelfhostGatewayOrigin,
  readAutodlH3SelfhostResult,
} from "@/lib/autodl-h3-selfhost";
import { parseAutodlH3AssetRef, stabilizeAutodlH3InputAssets } from "@/lib/autodl-h3-assets";
import { cropDimensionsForAspectRatio, imageDimensionsMatchAspectRatio } from "@/lib/image-output-contract";

export const runtime = "nodejs";

const VIDEO_READY_IMAGE_PROVIDER = "tencent_cos" as const;
const VIDEO_READY_IMAGE_URL_TTL = 30 * 24 * 60 * 60;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16 * 1024;
const ALLOWED_REMOTE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const TRUSTED_GENERATED_IMAGE_HOSTS = [
  "source.openclaw-token.shop",
  "flow.secure-skill.com",
];

type PersistStage = "authorize" | "read_request" | "reuse_image" | "import_image" | "transform_image" | "validate_image" | "upload_image" | "sign_image";

class ImageHistoryProjectionPendingError extends Error {
  constructor(readonly assetId: string) {
    super("IMAGE_HISTORY_INDEX_PENDING");
    this.name = "ImageHistoryProjectionPendingError";
  }
}

function deterministicUuid(seed: string) {
  const bytes = Buffer.from(createHash("sha256").update(seed, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function persistErrorMessage(stage: PersistStage, error: unknown) {
  const detail = error instanceof Error ? error.message : "";
  if (/Provider tencent_cos 未初始化|缺少必要配置|缺少存储桶/u.test(detail)) {
    return "视频对象存储尚未正确配置或加载";
  }
  if (/上传失败|未能保存到视频可访问的对象存储/u.test(detail)) {
    return "图片上传到视频对象存储失败";
  }
  if (/签名URL失败/u.test(detail)) {
    return "视频对象存储未能生成可访问地址";
  }
  const labels: Record<PersistStage, string> = {
    authorize: "身份校验",
    read_request: "读取图片请求",
    reuse_image: "复用已入库图片",
    import_image: "读取图片文件",
    transform_image: "裁取故事板首格",
    validate_image: "校验图片文件",
    upload_image: "上传图片",
    sign_image: "生成图片访问地址",
  };
  return `图片入库失败（${labels[stage]}阶段）`;
}

function extensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}

async function ensureImageWorkbenchHistory(input: {
  userId: string;
  storageKey: string;
  assetId?: string;
  signedUrl: string;
  index: number;
}) {
  const db = getSupabaseClient();
  const assetQuery = db
    .from("user_files")
    .select("id, created_at, storage_key, storage_provider, content_type, file_size")
    .eq("user_id", input.userId)
    .eq("storage_key", input.storageKey)
    .eq("storage_provider", VIDEO_READY_IMAGE_PROVIDER)
    .eq("file_category", "image");
  const asset = await (input.assetId ? assetQuery.eq("id", input.assetId) : assetQuery).maybeSingle();
  if (asset.error) throw asset.error;
  if (!asset.data?.id || !asset.data.storage_key) throw new Error("IMAGE_WORKBENCH_ASSET_RECORD_MISSING");

  // conversations.id and conversation_messages.id are UUID columns. The old
  // image_workbench_<sha256> values failed every insert with PostgreSQL 22P02.
  const conversationId = deterministicUuid(`image-workbench-conversation\0${input.userId}`);
  const historyRecordId = deterministicUuid(`image-workbench-history\0${input.userId}\0${input.storageKey}`);
  const createdAt = String(asset.data.created_at || new Date().toISOString());
  const title = `AI 生图工作台 ${Math.max(1, input.index)}.png`;
  const content = JSON.stringify({
    type: "image_gallery",
    source: "image-workbench",
    images: [{
      url: input.signedUrl,
      title,
      label: title,
      assetId: String(asset.data.id),
      storageKey: String(asset.data.storage_key),
    }],
  });

  try {
    const conversation = await db.from("conversations").upsert({
      id: conversationId,
      user_id: input.userId,
      agent_id: "image-workbench",
      title: "AI 生图工作台",
      source: "图片生成",
      updated_at: createdAt,
    }, { onConflict: "id" });
    if (conversation.error) throw conversation.error;

    const history = await db.from("conversation_messages").upsert({
      id: historyRecordId,
      conversation_id: conversationId,
      user_id: input.userId,
      agent_id: "image-workbench",
      role: "assistant",
      content,
      created_at: createdAt,
    }, { onConflict: "id" });
    if (history.error) throw history.error;
    return { assetId: String(asset.data.id), historyRecordId, historyRecorded: true as const };
  } catch (error) {
    // The owned asset is safe, but the workbench must not clear its exact
    // request until the account history projection is also durable. The same
    // asset/key can be retried without downloading, regenerating or charging.
    console.warn("[ImageWorkbench/Persist] history projection deferred", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    throw new ImageHistoryProjectionPendingError(String(asset.data.id));
  }
}

export async function POST(request: NextRequest) {
  let stage: PersistStage = "authorize";
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const payload = authorization.user;

    stage = "read_request";
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return NextResponse.json({ error: "Invalid request size" }, { status: 411 });
    }
    if (contentLength > MAX_JSON_BYTES) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }

    const body = await request.json().catch(() => null) as {
      url?: string;
      index?: number;
      assetId?: string;
      storageKey?: string;
      clientTraceId?: string;
      transform?: "first_storyboard_panel";
      targetAspectRatio?: string;
    } | null;
    const clientTraceId = body?.clientTraceId?.trim() || "";
    if (clientTraceId && !/^[A-Za-z0-9_-]{8,128}$/u.test(clientTraceId)) {
      return NextResponse.json({ error: "图片追踪键格式无效", code: "IMAGE_TRACE_ID_INVALID" }, { status: 400 });
    }
    const reusableAssetId = body?.assetId?.trim() || "";
    if (reusableAssetId.length > 512) {
      return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
    }
    const reusableStorageKey = body?.storageKey?.trim() || "";
    if (reusableStorageKey.length > 512) {
      return NextResponse.json({ error: "Invalid storage key" }, { status: 400 });
    }
    const sourceUrl = body?.url?.trim();
    if (!reusableStorageKey && sourceUrl?.startsWith("data:") && sourceUrl.length > MAX_JSON_BYTES) {
      return NextResponse.json({ error: "Image data too large" }, { status: 413 });
    }
    if (!reusableStorageKey && sourceUrl && !sourceUrl.startsWith("data:") && sourceUrl.length > 2048) {
      return NextResponse.json({ error: "Invalid image URL" }, { status: 400 });
    }
    if (!sourceUrl && !reusableStorageKey) {
      return NextResponse.json({ error: "图片地址不能为空" }, { status: 400 });
    }

    // 生图接口已经完成对象落盘并建立 user_files 归属记录。复用时按当前用户、
    // 资产 ID（调用方已取得时）、对象键、供应商和分类做精确校验；source 只描述
    // 资产来源，不能作为跨工作台复用门槛。对象已存在时只重新签名并登记历史，
    // 禁止再次下载或上传。
    if (reusableStorageKey && body?.transform !== "first_storyboard_panel") {
      stage = "reuse_image";
      const db = getSupabaseClient();
      const ownedAssetQuery = db
        .from("user_files")
        .select("id, storage_key")
        .eq("user_id", payload.userId)
        .eq("storage_key", reusableStorageKey)
        .eq("storage_provider", VIDEO_READY_IMAGE_PROVIDER)
        .eq("file_category", "image");
      const { data: ownedAsset, error: ownedAssetError } = await (
        reusableAssetId ? ownedAssetQuery.eq("id", reusableAssetId) : ownedAssetQuery
      ).maybeSingle();
      if (ownedAssetError || !ownedAsset?.id || ownedAsset.storage_key !== reusableStorageKey) {
        return NextResponse.json({ error: "图片存储引用无效", code: "IMAGE_STORAGE_KEY_INVALID" }, { status: 400 });
      }
      const exists = await storageManager.exists(reusableStorageKey, VIDEO_READY_IMAGE_PROVIDER);
      if (!exists) {
        return NextResponse.json({ error: "已入库图片不存在", code: "IMAGE_STORAGE_KEY_NOT_FOUND" }, { status: 404 });
      }
      stage = "sign_image";
      const signedUrl = await storageManager.getSignedUrl(
        reusableStorageKey,
        { expireTime: VIDEO_READY_IMAGE_URL_TTL },
        VIDEO_READY_IMAGE_PROVIDER,
      );
      const history = await ensureImageWorkbenchHistory({
        userId: payload.userId,
        storageKey: reusableStorageKey,
        assetId: String(ownedAsset.id),
        signedUrl,
        index: Math.max(1, Number(body?.index || 1)),
      });
      return NextResponse.json({
        success: true,
        status: "completed",
        persisted: true,
        key: reusableStorageKey,
        url: signedUrl,
        reused: true,
        assetId: history.assetId,
        historyRecorded: history.historyRecorded,
        ...(history.historyRecordId ? { historyRecordId: history.historyRecordId } : {}),
      });
    }

    stage = "import_image";
    let bytes: Buffer;
    let mimeType = "image/png";
    let extension = "png";
    const dataUrl = sourceUrl ? parseImageDataUrl(sourceUrl) : null;
    if (reusableStorageKey && body?.transform === "first_storyboard_panel") {
      // Older storyboard sessions may only retain the stable storage key after
      // their signed URL expires. Resolve that key server-side, and require an
      // exact current-user image record before reading any bytes. The original
      // source may be image-generation/image-workflow-generation/image-workbench.
      const db = getSupabaseClient();
      const ownedFileQuery = db
        .from("user_files")
        .select("id, storage_key, storage_provider, content_type, file_size")
        .eq("user_id", payload.userId)
        .eq("storage_key", reusableStorageKey)
        .eq("storage_provider", VIDEO_READY_IMAGE_PROVIDER)
        .eq("file_category", "image");
      const { data: ownedFile, error: ownedFileError } = await (
        reusableAssetId ? ownedFileQuery.eq("id", reusableAssetId) : ownedFileQuery
      ).maybeSingle();
      if (ownedFileError || !ownedFile) {
        return NextResponse.json(
          { error: "故事板图片不属于当前账号", code: "IMAGE_STORAGE_OWNERSHIP_INVALID" },
          { status: 403 },
        );
      }
      const declaredSize = Number(ownedFile.file_size || 0);
      if (declaredSize > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: "故事板图片超过 25MB，无法裁切", code: "IMAGE_STORAGE_TOO_LARGE" },
          { status: 400 },
        );
      }
      const head = await storageManager.head(reusableStorageKey, VIDEO_READY_IMAGE_PROVIDER);
      if (!head) {
        return NextResponse.json(
          { error: "已入库的故事板图片不存在", code: "IMAGE_STORAGE_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (head.size > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: "故事板图片超过 25MB，无法裁切", code: "IMAGE_STORAGE_TOO_LARGE" },
          { status: 400 },
        );
      }
      bytes = await storageManager.read(reusableStorageKey, VIDEO_READY_IMAGE_PROVIDER);
      mimeType = head.contentType || String(ownedFile.content_type || "image/png");
      extension = extensionFromMimeType(mimeType);
    } else if (dataUrl) {
      bytes = dataUrl.bytes;
      mimeType = dataUrl.mimeType;
      extension = dataUrl.extension;
    } else if (body?.transform === "first_storyboard_panel") {
      // 故事板图片已经由本系统持久化到当前用户的 COS 空间。服务端按
      // URL 路径恢复对象键、校验归属后直接通过 COS SDK 读取，避免浏览器
      // 对签名 URL 做跨域 fetch 导致 CORS 拦截，也不允许任意远程 URL 取件。
      const stable = await stabilizeAutodlH3InputAssets({
        userId: payload.userId,
        candidates: { imageUrl: sourceUrl },
      });
      const owned = parseAutodlH3AssetRef(stable.imageAssetRef);
      if (!owned) {
        return NextResponse.json({ error: "故事板图片不是当前账号已入库的稳定资产", code: "IMAGE_STORAGE_REF_INVALID" }, { status: 400 });
      }
      const head = await storageManager.head(owned.key, owned.provider);
      if (!head) {
        return NextResponse.json({ error: "已入库的故事板图片不存在", code: "IMAGE_STORAGE_NOT_FOUND" }, { status: 404 });
      }
      if (head.size > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "故事板图片超过 25MB，无法裁切", code: "IMAGE_STORAGE_TOO_LARGE" }, { status: 400 });
      }
      bytes = await storageManager.read(owned.key, owned.provider);
      mimeType = head.contentType || "image/png";
      extension = extensionFromMimeType(mimeType);
    } else {
      let h3Endpoint = "";
      try {
        const sourceOrigin = new URL(sourceUrl!).origin;
        const db = getSupabaseClient();
        const { data: h3Models } = await db
          .from("cover_models")
          .select("api_endpoint")
          .eq("provider", AUTODL_H3_SELFHOST_PROVIDER)
          .eq("is_active", true)
          .limit(5);
        h3Endpoint = (h3Models || [])
          .map((model: { api_endpoint?: string }) => String(model.api_endpoint || ""))
          .find((candidate: string) => {
            try { return autodlH3SelfhostGatewayOrigin(candidate) === sourceOrigin; } catch { return false; }
          }) || "";
      } catch {
        h3Endpoint = "";
      }

      if (h3Endpoint) {
        const response = await readAutodlH3SelfhostResult(sourceUrl!, h3Endpoint, {
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: 30_000,
          allowedContentTypes: ALLOWED_REMOTE_IMAGE_TYPES,
        });
        mimeType = response.contentType;
        bytes = response.buffer;
      } else {
        const response = await safeFetch(sourceUrl!, {
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: 30_000,
          allowedContentTypes: ALLOWED_REMOTE_IMAGE_TYPES,
          trustedHostnames: TRUSTED_GENERATED_IMAGE_HOSTS,
        });
        mimeType = response.contentType;
        bytes = response.buffer;
      }
      extension = extensionFromMimeType(mimeType);
    }

    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "图片超过 25MB，无法入库" }, { status: 400 });
    }
    stage = "validate_image";
    try {
      validateImageFile(bytes, mimeType);
    } catch (error) {
      if (error instanceof InvalidImageFileError) {
        console.warn(`[ImageWorkbench/Persist] rejected corrupt image: ${error.message}`);
        return NextResponse.json({ error: error.message, code: error.code }, { status: 422 });
      }
      throw error;
    }

    if (body?.transform === "first_storyboard_panel") {
      stage = "transform_image";
      const targetAspectRatio = String(body.targetAspectRatio || "").trim();
      if (!["16:9", "9:16", "1:1"].includes(targetAspectRatio)) {
        return NextResponse.json({ error: "故事板目标画幅无效", code: "STORYBOARD_TARGET_RATIO_INVALID" }, { status: 400 });
      }
      const normalized = await sharp(bytes, { failOn: "error", limitInputPixels: 80_000_000 })
        .rotate()
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      const panelWidth = Math.floor(normalized.info.width / 2);
      const panelHeight = Math.floor(normalized.info.height / 2);
      if (!panelWidth || !panelHeight) {
        return NextResponse.json({ error: "故事板第一格尺寸无效", code: "STORYBOARD_PANEL_INVALID" }, { status: 422 });
      }
      const target = cropDimensionsForAspectRatio(panelWidth, panelHeight, targetAspectRatio);
      if (!target) {
        return NextResponse.json({ error: "故事板第一格无法匹配目标画幅", code: "STORYBOARD_PANEL_RATIO_INVALID" }, { status: 422 });
      }
      bytes = await sharp(normalized.data, { failOn: "error", limitInputPixels: 80_000_000 })
        .extract({ left: 0, top: 0, width: panelWidth, height: panelHeight })
        .resize(target.width, target.height, { fit: "cover", position: "attention", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      mimeType = "image/png";
      extension = "png";
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "裁取后的故事板超过 25MB", code: "STORYBOARD_PANEL_TOO_LARGE" }, { status: 422 });
      }
      validateImageFile(bytes, mimeType);
    }

    const outputMetadata = await sharp(bytes, { failOn: "error", limitInputPixels: 80_000_000 }).metadata();
    const outputWidth = Number(outputMetadata.width || 0);
    const outputHeight = Number(outputMetadata.height || 0);
    if (!outputWidth || !outputHeight) {
      return NextResponse.json({ error: "入库图片尺寸无法验明", code: "IMAGE_DIMENSIONS_INVALID" }, { status: 422 });
    }
    if (body?.transform === "first_storyboard_panel"
      && !imageDimensionsMatchAspectRatio(outputWidth, outputHeight, String(body.targetAspectRatio || ""))) {
      return NextResponse.json({ error: "裁取后的故事板画幅与当前设置不一致", code: "STORYBOARD_PANEL_RATIO_MISMATCH" }, { status: 422 });
    }

    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const sequence = Math.max(1, Number(body?.index || 1));
    const stableName = clientTraceId
      ? createHash("sha256").update(`${payload.userId}\0${clientTraceId}`, "utf8").digest("hex").slice(0, 48)
      : `${Date.now()}`;
    const key = clientTraceId
      ? `image-workbench/by-trace/${stableName}-${sequence}.${extension}`
      : `image-workbench/${date}/${stableName}-${sequence}.${extension}`;
    // Video providers fetch the image themselves. A local /uploads URL works in
    // the browser but is unreachable from the provider, so keep bridge assets on COS.
    stage = "upload_image";
    let stored: { key: string; provider: StorageProviderType; contentType: string; size: number } | null = null;
    if (clientTraceId) {
      const db = getSupabaseClient();
      const existing = await db
        .from("user_files")
        .select("storage_key, storage_provider, content_type, file_size")
        .eq("user_id", payload.userId)
        .eq("storage_key", key)
        .eq("storage_provider", VIDEO_READY_IMAGE_PROVIDER)
        .eq("file_category", "image")
        .eq("source", "image-workbench")
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data?.storage_key && await storageManager.exists(key, VIDEO_READY_IMAGE_PROVIDER)) {
        stored = {
          key,
          provider: VIDEO_READY_IMAGE_PROVIDER,
          contentType: String(existing.data.content_type || mimeType),
          size: Number(existing.data.file_size || bytes.byteLength),
        };
      }
    }
    if (!stored) {
      stored = await storageManager.upload(bytes, key, mimeType, {
        providerType: VIDEO_READY_IMAGE_PROVIDER,
        strictProvider: true,
        category: "image",
        userId: payload.userId,
        source: "image-workbench",
        meta: { index: String(sequence), clientTraceId },
        requireOwnershipRecord: true,
      });
    }
    if (stored.provider !== VIDEO_READY_IMAGE_PROVIDER) {
      throw new Error("图片未能保存到视频可访问的对象存储");
    }
    stage = "sign_image";
    const signedUrl = await storageManager.getSignedUrl(
      stored.key,
      { expireTime: VIDEO_READY_IMAGE_URL_TTL },
      VIDEO_READY_IMAGE_PROVIDER,
    );
    const history = await ensureImageWorkbenchHistory({
      userId: payload.userId,
      storageKey: stored.key,
      signedUrl,
      index: sequence,
    });

    return NextResponse.json({
      success: true,
      status: "completed",
      persisted: true,
      key: stored.key,
      url: signedUrl,
      mimeType,
      size: bytes.byteLength,
      width: outputWidth,
      height: outputHeight,
      assetId: history.assetId,
      historyRecorded: history.historyRecorded,
      ...(history.historyRecordId ? { historyRecordId: history.historyRecordId } : {}),
    });
  } catch (error) {
    if (error instanceof ImageHistoryProjectionPendingError) {
      return NextResponse.json({
        error: "图片已保存，账号历史正在自动同步",
        code: "IMAGE_HISTORY_INDEX_PENDING",
        assetId: error.assetId,
        persisted: false,
      }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "2" } });
    }
    if (error instanceof SafeFetchError) {
      return NextResponse.json(
        { error: "无法安全导入图片", code: error.code },
        { status: error.status },
      );
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[ImageWorkbench/Persist] Error", {
      stage,
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorMessage,
    });
    return NextResponse.json(
      {
        error: persistErrorMessage(stage, error),
        code: "IMAGE_PERSIST_FAILED",
        stage,
        ...(process.env.NODE_ENV !== "production" ? { debug: errorMessage } : {}),
      },
      { status: 500 },
    );
  }
}
