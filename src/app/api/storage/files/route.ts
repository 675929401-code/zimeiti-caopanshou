/**
 * 用户文件列表 API
 * GET /api/storage/files?category=image&limit=20&offset=0
 *
 * 查询当前用户的文件记录，含配额统计
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyToken, getTokenFromHeaders } from "@/lib/auth";
import { storageManager } from "@/storage/object";
import type { FileCategory } from "@/storage/object";

const FILE_CATEGORIES = new Set<FileCategory>(["image", "video", "document", "audio", "archive", "other"]);

function safeInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const requestedCategory = searchParams.get("category");
    const category = requestedCategory && FILE_CATEGORIES.has(requestedCategory as FileCategory)
      ? requestedCategory as FileCategory
      : undefined;
    if (requestedCategory && !category) {
      return NextResponse.json({ error: "文件分类无效" }, { status: 400 });
    }
    const limit = safeInteger(searchParams.get("limit"), 50, 1, 100);
    const offset = safeInteger(searchParams.get("offset"), 0, 0, 1_000_000);
    const withQuota = searchParams.get("quota") === "true";

    const [records, total, quota] = await Promise.all([
      storageManager.listUserFiles(payload.userId, { category, limit, offset }),
      storageManager.countUserFiles(payload.userId, category),
      withQuota ? storageManager.getUserQuota(payload.userId) : Promise.resolve(null),
    ]);

    // 客户端只获得展示字段与记录 id。storage_key、user_id 和任意内部 meta
    // 均留在服务端；内容访问必须再按 id + 当前 user_id 验权。
    const files = records.map((file) => ({
      id: file.id,
      file_name: file.file_name,
      file_category: file.file_category,
      file_size: file.file_size,
      content_type: file.content_type,
      source: file.source,
      is_public: file.is_public,
      created_at: file.created_at,
    }));
    const nextOffset = offset + files.length;
    const hasMore = nextOffset < total;

    const result: Record<string, unknown> = {
      files,
      pagination: {
        offset,
        limit,
        returned: files.length,
        total,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
      },
    };

    // 可选：同时返回配额统计
    if (withQuota) {
      result.quota = quota;
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[Storage] List files error:", error);
    return NextResponse.json(
      { error: "个人文件暂时无法读取" },
      { status: 500 }
    );
  }
}
