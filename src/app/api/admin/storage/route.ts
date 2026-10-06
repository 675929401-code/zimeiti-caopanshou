/**
 * 管理后台 — 存储管理 API
 * GET  /api/admin/storage — 全局存储统计
 * POST /api/admin/storage — 更新存储配置
 * DELETE /api/admin/storage — 清理孤立文件（数据库有记录但存储已不存在的）
 */
import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { storageManager } from "@/storage/object";
import { getSupabaseClient } from "@/storage/database/supabase-client";

function isSensitiveStorageKey(key: string): boolean {
  return /secret|token|password|access[_-]?key/iu.test(key);
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 401 });
    }
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    // 并行获取：存储状态 + 全局统计 + 数据库配置
    const [status, stats] = await Promise.all([
      storageManager.getStatus(),
      storageManager.getGlobalStats(),
    ]);

    const db = getSupabaseClient();
    const { data: settings } = await db
      .from("platform_settings")
      .select("setting_key, setting_value")
      .like("setting_key", "storage_%");

    const config: Record<string, string> = {};
    for (const row of settings || []) {
      config[row.setting_key] = isSensitiveStorageKey(row.setting_key)
        ? row.setting_value
          ? "<configured>"
          : ""
        : row.setting_value;
    }

    return NextResponse.json({ status, stats, config });
  } catch (error) {
    console.error("[Admin/Storage] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 401 });
    }
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const body = await request.json();
    const { settings } = body as { settings: Record<string, string> };

    if (!settings || typeof settings !== "object") {
      return NextResponse.json({ error: "无效的配置数据" }, { status: 400 });
    }

    const db = getSupabaseClient();

    // 更新或插入配置
    for (const [key, value] of Object.entries(settings)) {
      if (!key.startsWith("storage_")) continue; // 安全过滤
      if (typeof value !== "string") continue;
      // 管理界面回传掩码时保留原密钥，避免把占位符写入数据库。
      if (isSensitiveStorageKey(key) && value === "<configured>") continue;

      const { error } = await db
        .from("platform_settings")
        .upsert(
          { setting_key: key, setting_value: value, updated_at: new Date().toISOString() },
          { onConflict: "setting_key" }
        );

      if (error) {
        console.error(`[Admin/Storage] 写入 ${key} 失败:`, error);
      }
    }

    // 重新加载存储配置
    await storageManager.reloadConfig();

    const status = await storageManager.getStatus();
    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error("[Admin/Storage] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 401 });
    }
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    // 清理孤立记录：数据库有记录但存储文件不存在的
    const db = getSupabaseClient();
    const { data: allFiles } = await db
      .from("user_files")
      .select("id, storage_key, storage_provider");

    const orphanedKeys: string[] = [];
    for (const file of allFiles || []) {
      const exists = await storageManager.exists(file.storage_key, file.storage_provider).catch(() => false);
      if (!exists) {
        orphanedKeys.push(file.id);
      }
    }

    if (orphanedKeys.length > 0) {
      await db.from("user_files").delete().in("id", orphanedKeys);
    }

    return NextResponse.json({
      success: true,
      cleaned: orphanedKeys.length,
      message: `已清理 ${orphanedKeys.length} 条孤立记录`,
    });
  } catch (error) {
    console.error("[Admin/Storage] DELETE error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "清理失败" },
      { status: 500 }
    );
  }
}
