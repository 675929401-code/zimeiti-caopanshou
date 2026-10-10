import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import {
  safeUploadFileName,
  UploadValidationError,
  validateUploadBuffer,
} from "@/lib/file-upload-security";
import { isPublicHttpsVideoAssetUrl } from "@/lib/video-public-url";
import { storageManager } from "@/storage/object";
import { createAutodlH3AssetRef } from "@/lib/autodl-h3-assets";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  cleanupVideoReferenceAsset,
  VIDEO_REFERENCE_UPLOAD_SOURCE,
  VideoReferenceCleanupError,
  type VideoReferenceAssetRow,
  type VideoReferenceCategory,
} from "@/lib/video-reference-asset-cleanup";

const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 30 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;
const UPLOAD_SESSION_PATTERN = /^[a-zA-Z0-9_-]{16,96}$/u;

function cleanupRpcPayload(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function cleanupRpcError(error: unknown): never {
  const detail = error && typeof error === "object"
    ? String((error as { message?: unknown; details?: unknown }).message || (error as { details?: unknown }).details || "")
    : String(error || "");
  if (detail.includes("VIDEO_REFERENCE_DELETE_ACTIVE_TASK")) {
    throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_ACTIVE_TASK", "参考素材已绑定进行中的任务，不能删除", 409);
  }
  if (detail.includes("VIDEO_REFERENCE_DELETE_AMBIGUOUS")) {
    throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_AMBIGUOUS", "参考素材记录不唯一，已停止删除", 409);
  }
  if (detail.includes("VIDEO_REFERENCE_DELETE_FORBIDDEN") || detail.includes("VIDEO_REFERENCE_DELETE_IDENTITY_MISMATCH")) {
    throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_FORBIDDEN", "无权删除该参考素材", 403);
  }
  throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_CLAIM_FAILED", "参考素材清理事务暂时不可用", 503);
}

export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const user = authorization.user;

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return NextResponse.json({ error: "缺少有效的请求大小" }, { status: 411 });
    }
    if (contentLength > MAX_REFERENCE_AUDIO_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: "参考素材不能超过 30MB" }, { status: 413 });
    }

    const formData = await request.formData();
    const category = formData.get("category") === "audio" ? "audio" : "image";
    const uploadSession = String(formData.get("upload_session") || "").trim();
    if (!UPLOAD_SESSION_PATTERN.test(uploadSession)) {
      return NextResponse.json({ error: "上传会话无效" }, { status: 400 });
    }
    const maxBytes = category === "audio" ? MAX_REFERENCE_AUDIO_BYTES : MAX_REFERENCE_IMAGE_BYTES;
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: `请选择参考${category === "audio" ? "音频" : "图片"}` }, { status: 400 });
    }
    if (file.size <= 0 || file.size > maxBytes) {
      return NextResponse.json({ error: `参考${category === "audio" ? "音频" : "图"}大小必须在 ${maxBytes / 1024 / 1024}MB 以内` }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const validated = validateUploadBuffer(buffer, file.type || "application/octet-stream");
    const validCategory = category === "audio"
      ? validated.contentType.startsWith("audio/") || validated.contentType === "video/mp4"
      : validated.contentType.startsWith("image/");
    if (!validCategory) {
      return NextResponse.json({ error: category === "audio" ? "仅支持 MP3、WAV、MP4、FLAC 等安全音频格式" : "仅支持安全的图片格式" }, { status: 415 });
    }

    const uploaded = await storageManager.upload(
      buffer,
      safeUploadFileName(validated.extension),
      validated.contentType,
      {
        category,
        userId: user.userId,
        source: VIDEO_REFERENCE_UPLOAD_SOURCE,
        prefix: category === "audio" ? "video-audio-inputs/" : "video-inputs/",
        providerType: "tencent_cos",
        strictProvider: true,
        publicRead: false,
        requireOwnershipRecord: true,
        meta: { videoPageUploadSession: uploadSession },
      },
    );

    const signedUrl = await storageManager.getSignedUrl(
      uploaded.key,
      { expireTime: SIGNED_URL_TTL_SECONDS },
      uploaded.provider,
    );
    if (!isPublicHttpsVideoAssetUrl(signedUrl)) {
      throw new Error("Public HTTPS reference URL was not produced");
    }

    const assetRef = createAutodlH3AssetRef(uploaded.provider, uploaded.key);
    const db = getSupabaseClient();
    let ownershipRowId = "";
    try {
      const ownership = await db.from("user_files")
        .select("id,user_id,storage_key,storage_provider,file_category,source,meta")
        .eq("storage_key", uploaded.key)
        .eq("storage_provider", uploaded.provider)
        .limit(2);
      if (ownership.error) throw ownership.error;
      const rows = (ownership.data || []) as VideoReferenceAssetRow[];
      if (rows.length !== 1) throw new Error(rows.length > 1 ? "VIDEO_REFERENCE_DELETE_AMBIGUOUS" : "VIDEO_REFERENCE_GUARD_ROW_NOT_FOUND");
      const row = rows[0];
      ownershipRowId = row.id;
      if (row.user_id !== user.userId || row.source !== VIDEO_REFERENCE_UPLOAD_SOURCE
        || row.file_category !== category || row.meta?.videoPageUploadSession !== uploadSession) {
        throw new Error("VIDEO_REFERENCE_GUARD_IDENTITY_MISMATCH");
      }
      const registered = await db.rpc("register_video_reference_asset_guard_v1", {
        p_asset_ref: assetRef,
        p_user_file_id: row.id,
        p_storage_key: uploaded.key,
        p_storage_provider: uploaded.provider,
        p_user_id: user.userId,
        p_source: VIDEO_REFERENCE_UPLOAD_SOURCE,
        p_file_category: category,
        p_upload_session: uploadSession,
      });
      if (registered.error || String(cleanupRpcPayload(registered.data).state || "") !== "available") {
        throw registered.error || new Error("VIDEO_REFERENCE_GUARD_REGISTRATION_FAILED");
      }
    } catch (registrationError) {
      // A reference upload is not usable until its reservation/cleanup guard is
      // durable. Compensate this just-created object and its exact ownership row.
      const objectRemoved = await storageManager.deleteObjectOnly(uploaded.key, "tencent_cos").catch(() => false);
      if (ownershipRowId && objectRemoved) {
        await db.from("user_files").delete()
          .eq("id", ownershipRowId)
          .eq("storage_key", uploaded.key)
          .eq("storage_provider", uploaded.provider)
          .eq("user_id", user.userId)
          .eq("source", VIDEO_REFERENCE_UPLOAD_SOURCE)
          .eq("file_category", category);
      }
      throw registrationError;
    }

    return NextResponse.json({
      success: true,
      file: {
        url: signedUrl,
        asset_ref: assetRef,
        size: uploaded.size,
        type: uploaded.contentType,
        expiresIn: SIGNED_URL_TTL_SECONDS,
      },
    });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: "文件内容或格式无效", code: error.code }, { status: 415 });
    }
    console.error("[VideoReferenceUpload] Public reference upload failed", error instanceof Error ? error.message : "UnknownError");
    return NextResponse.json(
      { error: "公网参考图存储暂不可用，请联系管理员检查腾讯云 COS 配置" },
      { status: 503 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.category !== "image" && body?.category !== "audio") {
      return NextResponse.json({ error: "参考素材类别无效" }, { status: 400 });
    }
    const category: VideoReferenceCategory = body.category;
    const db = getSupabaseClient();

    const result = await cleanupVideoReferenceAsset({
      userId: authorization.user.userId,
      assetRef: String(body?.asset_ref || ""),
      candidateUrl: String(body?.url || ""),
      category,
      uploadSession: String(body?.upload_session || ""),
    }, {
      async findAssetsByKey(input) {
        const lookup = await db.from("user_files")
          .select("id,user_id,storage_key,storage_provider,file_category,source,meta")
          .eq("storage_key", input.key)
          .eq("storage_provider", input.provider)
          .limit(2);
        if (lookup.error) throw lookup.error;
        return (lookup.data || []) as VideoReferenceAssetRow[];
      },
      async claimCleanup(input) {
        const claim = await db.rpc("claim_video_reference_asset_cleanup_v1", {
          p_asset_ref: input.assetRef,
          p_user_file_id: input.rowId,
          p_storage_key: input.key,
          p_storage_provider: input.provider,
          p_user_id: input.userId,
          p_source: input.source,
          p_file_category: input.category,
          p_upload_session: input.uploadSession,
        });
        if (claim.error) cleanupRpcError(claim.error);
        const state = String(cleanupRpcPayload(claim.data).state || "");
        if (state === "claimed" || state === "object_deleted" || state === "completed") return state;
        cleanupRpcError("VIDEO_REFERENCE_DELETE_CLAIM_STATE_INVALID");
      },
      deleteObjectOnly(key, provider) {
        return storageManager.deleteObjectOnly(key, provider);
      },
      async markObjectDeleted(input) {
        const marked = await db.rpc("mark_video_reference_asset_object_deleted_v1", {
          p_asset_ref: input.assetRef,
          p_user_id: input.userId,
        });
        if (marked.error) cleanupRpcError(marked.error);
        return String(cleanupRpcPayload(marked.data).state || "") === "object_deleted";
      },
      async completeMetadataCleanup(input) {
        const completed = await db.rpc("complete_video_reference_asset_cleanup_v1", {
          p_asset_ref: input.assetRef,
          p_user_file_id: input.rowId,
          p_storage_key: input.key,
          p_storage_provider: input.provider,
          p_user_id: input.userId,
          p_source: input.source,
        });
        if (completed.error) cleanupRpcError(completed.error);
        return String(cleanupRpcPayload(completed.data).state || "") === "completed";
      },
      async recordCleanupFailure(input, errorCode) {
        const recorded = await db.rpc("record_video_reference_asset_cleanup_failure_v1", {
          p_asset_ref: input.assetRef,
          p_user_id: input.userId,
          p_error_code: errorCode,
        });
        if (recorded.error) throw recorded.error;
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof VideoReferenceCleanupError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[VideoReferenceUpload] Cleanup failed", error instanceof Error ? error.message : "UnknownError");
    return NextResponse.json({ error: "参考素材暂时无法清理" }, { status: 503 });
  }
}
