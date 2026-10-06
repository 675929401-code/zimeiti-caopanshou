/**
 * 存储状态 API
 * GET /api/storage/status — 获取当前存储配置（管理员）
 * POST /api/storage/status — 重载配置（管理后台切换供应商后调用）
 * DELETE /api/storage/status?key=xxx — 删除文件
 */
import { NextRequest, NextResponse } from "next/server";
import { storageManager } from "@/storage/object";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

async function authorizeStorageManagement(
  request: NextRequest,
  operation: string,
  requireStepUp: boolean,
) {
  return authorizeAdminCapability(request, "backups.manage", {
    operation,
    requireStepUp,
  });
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeStorageManagement(request, "storage_status_read", false);
    if (!authorization.ok) return authorization.response;

    const status = await storageManager.getStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("[Storage] Status error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeStorageManagement(request, "storage_configuration_reload", true);
    if (!authorization.ok) return authorization.response;

    await storageManager.reloadConfig();
    const status = await storageManager.getStatus();
    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error("[Storage] Reload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "重载失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authorization = await authorizeStorageManagement(request, "storage_object_delete", true);
    if (!authorization.ok) return authorization.response;

    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    if (!key) {
      return NextResponse.json({ error: "缺少文件 key" }, { status: 400 });
    }

    const ok = await storageManager.delete(key);
    return NextResponse.json({ success: ok });
  } catch (error) {
    console.error("[Storage] Delete error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除失败" },
      { status: 500 }
    );
  }
}
