import { NextRequest, NextResponse } from "next/server";
import { uploadFile, getSignedUrl } from "@/lib/storage";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import {
  safeUploadFileName,
  UploadValidationError,
  validateUploadBuffer,
} from "@/lib/file-upload-security";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: "登录已过期" }, { status: 401 });

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return NextResponse.json({ error: "缺少有效的请求大小" }, { status: 411 });
    }
    if (contentLength > MAX_IMAGE_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请选择文件" }, { status: 400 });
    }

    // Reject by metadata before allocating a full in-memory buffer.
    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "文件大小必须在 5MB 以内" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const validated = validateUploadBuffer(buffer, file.type);
    if (!validated.contentType.startsWith("image/")) {
      return NextResponse.json({ error: "仅支持安全的图片格式" }, { status: 400 });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    const fileName = `images/${dateStr}/${safeUploadFileName(validated.extension)}`;
    const actualKey = await uploadFile(buffer, fileName, validated.contentType);
    const url = await getSignedUrl(actualKey, 2592000);

    return NextResponse.json({
      success: true,
      key: actualKey,
      url,
      name: file.name,
      size: file.size,
      type: validated.contentType,
    });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json(
        { error: "文件内容或格式无效", code: error.code },
        { status: 400 },
      );
    }
    console.error("[upload] failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "上传失败" }, { status: 500 });
  }
}
