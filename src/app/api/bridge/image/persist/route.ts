import { z } from "zod";
import { createHash } from "node:crypto";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { safeUploadFileName, UploadValidationError, validateUploadBuffer } from "@/lib/file-upload-security";
import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const MAX_DATA_URL_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_BYTES = 36 * 1024 * 1024;
const RequestSchema = z.object({
  url: z.string().min(1),
  clientTraceId: z.string().uuid().optional(),
  mediaKind: z.enum(["image", "audio", "music"]).default("image"),
  title: z.string().trim().min(1).max(240).optional(),
  modelId: z.string().trim().max(160).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  cashCharged: z.number().nonnegative().optional(),
  cashRemaining: z.number().nonnegative().nullable().optional(),
});

function parseDataUrl(
  value: string,
  mediaKind: "image" | "audio" | "music",
): { bytes: Buffer; mimeType: string; fileName: string } | null {
  if (!value.startsWith("data:")) return null;
  const separator = value.indexOf(",");
  if (separator <= 5) return null;
  const header = value.slice(5, separator);
  const headerMatch = /^([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64$/u.exec(header);
  if (!headerMatch) return null;
  const declaredType = headerMatch[1].toLowerCase();
  const expectedPrefix = mediaKind === "image" ? "image/" : "audio/";
  if (!declaredType.startsWith(expectedPrefix)) return null;
  const estimatedBytes = Math.floor((value.length - separator - 1) * 0.75);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_DATA_URL_BYTES) throw new Error("图片 data URL 超过 25MB 限制");
  const bytes = Buffer.from(value.slice(separator + 1), "base64");
  const validated = validateUploadBuffer(bytes, declaredType);
  if (!validated.contentType.startsWith(expectedPrefix)) throw new Error("data URL 媒体类型不匹配");
  return {
    bytes,
    mimeType: validated.contentType,
    fileName: safeUploadFileName(validated.extension),
  };
}

function parseExistingMedia(content: unknown) {
  if (typeof content !== "string") return null;
  try {
    const payload = JSON.parse(content) as {
      type?: string;
      images?: Array<{ url?: string; assetId?: string; storageKey?: string }>;
      audios?: Array<{ url?: string; assetId?: string; storageKey?: string }>;
    };
    const entry = payload.type === "image_gallery"
      ? payload.images?.[0]
      : payload.type === "audio_gallery"
        ? payload.audios?.[0]
        : undefined;
    return entry?.assetId && entry.storageKey ? entry : null;
  } catch {
    return null;
  }
}

async function signedAssetUrl(storageKey: string, provider: StorageProviderType): Promise<string> {
  const url = await storageManager.getSignedUrl(storageKey, { expireTime: 24 * 60 * 60 }, provider);
  if (!url) throw new Error("CANVAS_MEDIA_ACCESS_URL_MISSING");
  return url;
}

export async function GET(request: Request) {
  const token = getTokenFromHeaders(request.headers);
  const user = token ? await verifyToken(token) : null;
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });

  const assetId = new URL(request.url).searchParams.get("assetId")?.trim() || "";
  if (!assetId || assetId.length > 160) {
    return Response.json({ error: "永久资产参数无效" }, { status: 400 });
  }

  try {
    const db = getSupabaseClient();
    const asset = await db
      .from("user_files")
      .select("id,storage_key,storage_provider")
      .eq("id", assetId)
      .eq("user_id", user.userId)
      .maybeSingle();
    if (asset.error) throw asset.error;
    if (!asset.data?.id || !asset.data.storage_key || !asset.data.storage_provider) {
      return Response.json({ error: "永久资产不存在或无权访问" }, { status: 404 });
    }
    const url = await signedAssetUrl(
      String(asset.data.storage_key),
      asset.data.storage_provider as StorageProviderType,
    );
    return Response.json({
      success: true,
      url,
      assetId: String(asset.data.id),
      storageKey: String(asset.data.storage_key),
      expiresInSeconds: 24 * 60 * 60,
    });
  } catch (error) {
    console.error("[canvas/media/access] failed", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "永久资产访问地址刷新失败" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const token = getTokenFromHeaders(request.headers);
  const user = token ? await verifyToken(token) : null;
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "图片持久化请求体过大" }, { status: 413 });
  }
  const rawBody = await request.text().catch(() => "");
  if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
    return Response.json({ error: "图片持久化请求体过大" }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "图片持久化参数无效" }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "图片持久化参数无效" }, { status: 400 });

  const clientTraceId = parsed.data.clientTraceId || crypto.randomUUID();
  const mediaKind = parsed.data.mediaKind;
  const scopedTraceHash = createHash("sha256")
    .update(`${user.userId}\0${clientTraceId}`, "utf8")
    .digest("hex");
  const historyRecordId = `canvas_${mediaKind}_${scopedTraceHash}`;
  const conversationId = `canvas_${scopedTraceHash}`;
  const db = getSupabaseClient();

  try {
    const existing = await db
      .from("conversation_messages")
      .select("id, content, created_at")
      .eq("id", historyRecordId)
      .eq("user_id", user.userId)
      .maybeSingle();
    if (existing.error) throw existing.error;
    const existingMedia = parseExistingMedia(existing.data?.content);
    if (existingMedia) {
      const existingAsset = await db
        .from("user_files")
        .select("id,storage_key,storage_provider")
        .eq("id", existingMedia.assetId)
        .eq("user_id", user.userId)
        .maybeSingle();
      if (existingAsset.error) throw existingAsset.error;
      if (!existingAsset.data?.id || !existingAsset.data.storage_key || !existingAsset.data.storage_provider) {
        return Response.json({ error: "图片的保存记录不完整，暂时无法恢复。请联系管理员检查这条记录。" }, { status: 409 });
      }
      const replayUrl = await signedAssetUrl(
        String(existingAsset.data.storage_key),
        existingAsset.data.storage_provider as StorageProviderType,
      );
      return Response.json({
        success: true,
        persisted: true,
        temporary: false,
        idempotentReplay: true,
        mediaKind,
        url: replayUrl,
        assetId: String(existingAsset.data.id),
        storageKey: String(existingAsset.data.storage_key),
        historyRecordId,
        createdAt: existing.data?.created_at || null,
      });
    }

    const sourceUrl = parsed.data.url;
    const dataUrl = parseDataUrl(sourceUrl, mediaKind);
    let stored;
    const storageOptions = {
      category: mediaKind === "image" ? "image" as const : "audio" as const,
      providerType: "tencent_cos" as const,
      strictProvider: true,
      userId: user.userId,
      source: "漫剧画布",
      meta: {
        surface: "free-canvas",
        clientTraceId,
        modelId: parsed.data.modelId || "",
        mediaKind,
      },
      requireOwnershipRecord: true,
    };
    if (dataUrl) {
      stored = await storageManager.upload(dataUrl.bytes, dataUrl.fileName, dataUrl.mimeType, {
        ...storageOptions,
        fileName: dataUrl.fileName,
      });
    } else {
      const parsedUrl = new URL(sourceUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return Response.json({ error: "图片必须是 HTTP 地址或 data URL" }, { status: 400 });
      }
      const downloaded = await safeFetch(parsedUrl, {
        maxBytes: MAX_DATA_URL_BYTES,
        timeoutMs: 30_000,
        allowedContentTypes: [mediaKind === "image" ? "image/*" : "audio/*"],
      });
      const validated = validateUploadBuffer(downloaded.buffer, downloaded.contentType);
      const expectedPrefix = mediaKind === "image" ? "image/" : "audio/";
      if (!validated.contentType.startsWith(expectedPrefix)) {
        return Response.json({ error: "远程内容不是安全媒体", code: "MEDIA_TYPE_MISMATCH" }, { status: 415 });
      }
      const fileName = safeUploadFileName(validated.extension);
      stored = await storageManager.upload(downloaded.buffer, fileName, validated.contentType, {
        ...storageOptions,
        fileName,
      });
    }

    const assetLookup = await db
      .from("user_files")
      .select("id, created_at, storage_key, storage_provider")
      .eq("user_id", user.userId)
      .eq("storage_key", stored.key)
      .maybeSingle();
    if (assetLookup.error) throw assetLookup.error;
    if (!assetLookup.data?.id) {
      throw new Error("CANVAS_IMAGE_ASSET_RECORD_MISSING");
    }
    const assetId = String(assetLookup.data.id);
    const createdAt = String(assetLookup.data?.created_at || new Date().toISOString());
    const accessUrl = await signedAssetUrl(
      String(assetLookup.data.storage_key || stored.key),
      (assetLookup.data.storage_provider || stored.provider) as StorageProviderType,
    );
    const title = parsed.data.title || (mediaKind === "image" ? "漫剧画布图片" : mediaKind === "music" ? "漫剧画布音乐" : "漫剧画布音频");
    const persistedEntry = {
      url: accessUrl,
      title,
      label: title,
      width: parsed.data.width,
      height: parsed.data.height,
      assetId,
      storageKey: stored.key,
    };
    const content = JSON.stringify({
      type: mediaKind === "image" ? "image_gallery" : "audio_gallery",
      source: "free-canvas",
      mediaKind,
      clientTraceId,
      billing: {
        modelId: parsed.data.modelId || "",
        cashCharged: parsed.data.cashCharged ?? null,
        cashRemaining: parsed.data.cashRemaining ?? null,
      },
      ...(mediaKind === "image" ? { images: [persistedEntry] } : { audios: [persistedEntry] }),
    });

    const conversation = await db.from("conversations").upsert({
      id: conversationId,
      user_id: user.userId,
      agent_id: "free-canvas",
      title,
      source: "漫剧画布",
      updated_at: createdAt,
    }, { onConflict: "id" });
    if (conversation.error) throw conversation.error;
    const message = await db.from("conversation_messages").insert({
      id: historyRecordId,
      conversation_id: conversationId,
      user_id: user.userId,
      agent_id: "free-canvas",
      role: "assistant",
      content,
      created_at: createdAt,
    });
    if (message.error) throw message.error;

    return Response.json({
      success: true,
      persisted: true,
      temporary: false,
      idempotentReplay: false,
      mediaKind,
      url: accessUrl,
      assetId,
      storageKey: stored.key,
      historyRecordId,
      createdAt,
    });
  } catch (error) {
    console.error("[canvas/image/persist] failed", error instanceof Error ? error.name : "UnknownError");
    if (error instanceof UploadValidationError) {
      return Response.json({ error: "图片内容或格式无效", code: error.code }, { status: 415 });
    }
    if (error instanceof SafeFetchError) {
      return Response.json({ error: "无法安全转存图片地址", code: error.code }, { status: error.status });
    }
    if (error instanceof Error && error.message === "CANVAS_IMAGE_ASSET_RECORD_MISSING") {
      return Response.json({ error: "图片已上传但永久资产记录缺失，请勿重复生成并联系管理员" }, { status: 502 });
    }
    return Response.json({
      error: "生成图片持久化失败",
    }, { status: 502 });
  }
}
