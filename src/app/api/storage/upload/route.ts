/**
 * 文件上传 API
 * POST /api/storage/upload
 *
 * 支持 multipart/form-data 上传和 URL 转存
 * 自动记录文件元数据到 user_files 表
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyToken, getTokenFromHeaders } from "@/lib/auth";
import { storageManager } from "@/storage/object";
import type { FileCategory } from "@/storage/object";
import { safeUploadFileName, UploadValidationError, validateUploadBuffer } from "@/lib/file-upload-security";
import { SafeFetchError } from "@/lib/safe-fetch";

const MAX_SIZE = 100 * 1024 * 1024;
const VALID_CATEGORIES = new Set<FileCategory>(["image", "video", "document", "audio", "archive", "other"]);

export async function POST(request: NextRequest) {
  try {
    // ── 认证 ──
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    }
    const userId = payload.userId;

    const contentType = request.headers.get("content-type") || "";
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return NextResponse.json({ error: "缺少有效的请求大小" }, { status: 411 });
    }
    const requestLimit = contentType.includes("multipart/form-data") ? MAX_SIZE + 1024 * 1024 : 32 * 1024;
    if (contentLength > requestLimit) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }

    let result;

    if (contentType.includes("multipart/form-data")) {
      // ── 文件上传模式 ──
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      const requestedCategory = (formData.get("category") as FileCategory) || "other";
      const category = VALID_CATEGORIES.has(requestedCategory) ? requestedCategory : "other";
      const source = formData.get("source") as string || null;
      const fromUrl = formData.get("url") as string | null;

      if (!file && !fromUrl) {
        return NextResponse.json({ error: "请提供文件或URL" }, { status: 400 });
      }

      if (fromUrl) {
        if (fromUrl.length > 2_048) {
          return NextResponse.json({ error: "URL 无效" }, { status: 400 });
        }
        // URL 转存模式
        result = await storageManager.uploadFromUrl(fromUrl, {
          category,
          userId,
          source: source || undefined,
        });
      } else {
        // 文件上传模式
        if (file!.size <= 0 || file!.size > MAX_SIZE) {
          return NextResponse.json(
            { error: `文件大小超过限制（最大 ${MAX_SIZE / 1024 / 1024}MB）` },
            { status: 413 }
          );
        }
        const buffer = Buffer.from(await file!.arrayBuffer());
        const fileContentType = file!.type || "application/octet-stream";
        const validated = validateUploadBuffer(buffer, fileContentType);
        const fileName = safeUploadFileName(validated.extension);

        result = await storageManager.upload(buffer, fileName, validated.contentType, {
          category,
          userId,
          source: source || undefined,
          fileName,
        });
      }
    } else {
      // ── JSON 模式（URL 转存） ──
      let body: { url?: string; category?: FileCategory; source?: string; fileName?: string };
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "请提供有效的请求体" }, { status: 400 });
      }
      const { url, category, source } = body;

      if (!url) {
        return NextResponse.json({ error: "请提供URL" }, { status: 400 });
      }

      if (url.length > 2_048) {
        return NextResponse.json({ error: "URL 无效" }, { status: 400 });
      }

      result = await storageManager.uploadFromUrl(url, {
        category: category && VALID_CATEGORIES.has(category) ? category : "other",
        userId,
        source: source || undefined,
      });
    }

    return NextResponse.json({ success: true, file: result });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: "文件内容或格式无效", code: error.code }, { status: 415 });
    }
    if (error instanceof SafeFetchError) {
      return NextResponse.json({ error: "无法安全转存该地址", code: error.code }, { status: error.status });
    }
    console.error("[Storage] Upload failed");
    return NextResponse.json(
      { error: "上传失败" },
      { status: 500 }
    );
  }
}
