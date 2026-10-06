import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

async function currentUserId(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const payload = await verifyToken(authHeader.slice(7));
  return payload?.userId || null;
}

// GET /api/notifications/user — 获取我的账号通知列表
export async function GET(request: Request) {
  try {
    const userId = await currentUserId(request);
    if (!userId) return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    const database = getSupabaseAdminClient();
    const [listResult, unreadResult] = await Promise.all([
      database
        .from("user_notifications")
        .select("id, user_id, type, title, content, cami_code, is_read, created_at, read_at, metadata", { count: "exact" })
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50),
      database
        .from("user_notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_read", false),
    ]);
    if (listResult.error || unreadResult.error) throw listResult.error || unreadResult.error;
    const data = listResult.data;
    const notifications = (data || []).map((row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      type: String(row.type || "system"),
      title: String(row.title || "通知"),
      content: String(row.content || ""),
      // Activation secrets never cross the user API boundary. The browser
      // receives only an account-bound capability flag and redeems by notice id.
      has_cami_code: Boolean(row.cami_code),
      is_read: row.is_read === true,
      created_at: String(row.created_at || ""),
      read_at: row.read_at ? String(row.read_at) : null,
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    }));
    return NextResponse.json({
      success: true,
      notifications,
      total: Number(listResult.count || notifications.length),
      unreadCount: Number(unreadResult.count || 0),
    });
  } catch (error) {
    console.error("[Notifications] GET error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "获取通知失败" }, { status: 500 });
  }
}

// PUT /api/notifications/user — 标记通知已读
export async function PUT(request: Request) {
  try {
    const userId = await currentUserId(request);
    if (!userId) return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    const body = await request.json();
    const database = getSupabaseAdminClient();
    let query = database
      .from("user_notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("is_read", false);
    if (body.markAllRead !== true) {
      if (typeof body.notificationId !== "string" || !body.notificationId.trim()) {
        return NextResponse.json({ error: "缺少通知 ID" }, { status: 400 });
      }
      query = query.eq("id", body.notificationId.trim());
    }
    const { error } = await query;
    if (error) throw error;
    return NextResponse.json({ success: true, message: body.markAllRead === true ? "全部标记已读" : "已标记阅读" });
  } catch (error) {
    console.error("[Notifications] PUT error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
