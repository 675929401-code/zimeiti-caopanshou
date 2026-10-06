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

const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 30 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

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
        source: "video-page-reference",
        prefix: category === "audio" ? "video-audio-inputs/" : "video-inputs/",
        providerType: "tencent_cos",
        publicRead: false,
        requireOwnershipRecord: true,
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

    return NextResponse.json({
      success: true,
      file: {
        url: signedUrl,
        asset_ref: createAutodlH3AssetRef(uploaded.provider, uploaded.key),
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
