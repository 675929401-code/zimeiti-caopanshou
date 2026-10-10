import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { verifyToken } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

type NotificationReadRow = {
  id: string;
  readAt: string;
};

type NotificationQueryResult = {
  data: unknown;
  error: { message?: string } | null;
};

type NotificationCursor = {
  createdAt: string;
  id: string;
};

interface NotificationUpdateQuery extends PromiseLike<NotificationQueryResult> {
  eq(column: string, value: unknown): NotificationUpdateQuery;
  select(columns: string): NotificationUpdateQuery;
}

interface NotificationSelectQuery extends PromiseLike<NotificationQueryResult> {
  eq(column: string, value: unknown): NotificationSelectQuery;
  limit(count: number): NotificationSelectQuery;
}

interface NotificationUpdateDatabase {
  from(table: "user_notifications"): {
    update(values: { is_read: true; read_at: string }): NotificationUpdateQuery;
    select(columns: string): NotificationSelectQuery;
  };
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/u.exec(timestamp);
  if (!match || !Number.isFinite(Date.parse(timestamp))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const calendar = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (
    calendar.getUTCFullYear() !== parts[0]
    || calendar.getUTCMonth() + 1 !== parts[1]
    || calendar.getUTCDate() !== parts[2]
    || calendar.getUTCHours() !== parts[3]
    || calendar.getUTCMinutes() !== parts[4]
    || calendar.getUTCSeconds() !== parts[5]
  ) return false;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

function requestedPageSize(url: URL) {
  const value = url.searchParams.get("limit");
  if (value === null) return DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE ? parsed : null;
}

function decodeCursor(value: string | null): NotificationCursor | null {
  if (value === null) return null;
  if (!value || value.length > 512) throw new Error("NOTIFICATION_CURSOR_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("NOTIFICATION_CURSOR_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NOTIFICATION_CURSOR_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt.trim() : "";
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!validTimestamp(createdAt) || !CURSOR_ID_PATTERN.test(id)) {
    throw new Error("NOTIFICATION_CURSOR_INVALID");
  }
  return { createdAt, id };
}

function encodeCursor(row: Record<string, unknown>) {
  const createdAt = typeof row.created_at === "string" ? row.created_at.trim() : "";
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!validTimestamp(createdAt) || !CURSOR_ID_PATTERN.test(id)) {
    throw new Error("NOTIFICATION_CURSOR_SOURCE_INVALID");
  }
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function notificationReadRows(data: unknown, expectedId: string | null): NotificationReadRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows: NotificationReadRow[] = [];
  for (const value of data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || (expectedId !== null && id !== expectedId) || !validTimestamp(record.read_at)) return null;
    rows.push({ id, readAt: record.read_at.trim() });
  }
  if (expectedId !== null && rows.length > 1) return null;
  return rows;
}

function existingNotificationReadRow(data: unknown, expectedId: string): NotificationReadRow | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  if (data.length !== 1) throw new Error("NOTIFICATION_READ_LOOKUP_RECEIPT_INVALID");
  const [value] = data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NOTIFICATION_READ_LOOKUP_RECEIPT_INVALID");
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id !== expectedId || record.is_read !== true || !validTimestamp(record.read_at)) {
    throw new Error("NOTIFICATION_READ_LOOKUP_RECEIPT_INVALID");
  }
  return { id, readAt: record.read_at.trim() };
}

async function updateUnreadUserNotifications(
  database: NotificationUpdateDatabase,
  userId: string,
  notificationId: string | null,
  readAt: string,
): Promise<{ rows: NotificationReadRow[] | null; error: { message?: string } | null }> {
  let query = database
    .from("user_notifications")
    .update({ is_read: true, read_at: readAt })
    .eq("user_id", userId)
    .eq("is_read", false);
  if (notificationId !== null) query = query.eq("id", notificationId);
  const { data, error } = await query.select("id,read_at");
  if (error) return { rows: null, error };
  const rows = notificationReadRows(data, notificationId);
  if (!rows) throw new Error("NOTIFICATION_READ_UPDATE_RECEIPT_INVALID");
  return { rows: rows.length > 0 ? rows : null, error: null };
}

async function findExistingUserNotificationRead(
  database: NotificationUpdateDatabase,
  userId: string,
  notificationId: string,
): Promise<{ row: NotificationReadRow | null; error: { message?: string } | null }> {
  const { data, error } = await database
    .from("user_notifications")
    .select("id,is_read,read_at")
    .eq("user_id", userId)
    .eq("id", notificationId)
    .limit(1);
  if (error) return { row: null, error };
  return { row: existingNotificationReadRow(data, notificationId), error: null };
}

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
    const url = new URL(request.url);
    const pageSize = requestedPageSize(url);
    if (pageSize === null) {
      return NextResponse.json({ error: `limit 必须是 1-${MAX_PAGE_SIZE} 的整数` }, { status: 400 });
    }
    let cursor: NotificationCursor | null;
    try {
      cursor = decodeCursor(url.searchParams.get("cursor"));
    } catch {
      return NextResponse.json({ error: "分页游标无效" }, { status: 400 });
    }
    const unreadOnly = ["1", "true"].includes(url.searchParams.get("unreadOnly") || "");
    const database = getSupabaseAdminClient();
    let listQuery = database
      .from("user_notifications")
      .select("id, user_id, type, title, content, cami_code, is_read, created_at, read_at, metadata", { count: "exact" })
      .eq("user_id", userId);
    if (unreadOnly) listQuery = listQuery.eq("is_read", false);
    if (cursor) {
      listQuery = listQuery.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }
    const [listResult, unreadResult] = await Promise.all([
      listQuery
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(pageSize + 1),
      database
        .from("user_notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_read", false),
    ]);
    if (listResult.error || unreadResult.error) throw listResult.error || unreadResult.error;
    const data = (listResult.data || []) as Record<string, unknown>[];
    const hasMore = data.length > pageSize;
    const page = hasMore ? data.slice(0, pageSize) : data;
    const notifications = page.map((row) => ({
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
    const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
    return NextResponse.json({
      success: true,
      notifications,
      total: Number(listResult.count || notifications.length),
      unreadCount: Number(unreadResult.count || 0),
      pageSize,
      hasMore,
      nextCursor,
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
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body)) {
      return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
    }
    const markAllRead = body.markAllRead === true;
    let notificationId: string | null = null;
    if (!markAllRead) {
      if (typeof body.notificationId !== "string" || !body.notificationId.trim()) {
        return NextResponse.json({ error: "缺少通知 ID" }, { status: 400 });
      }
      notificationId = body.notificationId.trim();
    }

    const requestedReadAt = new Date().toISOString();
    const database = getSupabaseAdminClient() as unknown as NotificationUpdateDatabase;
    const updateResult = await updateUnreadUserNotifications(
      database,
      userId,
      notificationId,
      requestedReadAt,
    );
    let { rows } = updateResult;
    const { error } = updateResult;
    if (error) throw error;
    let alreadyRead = false;
    if (!rows && notificationId !== null) {
      const existing = await findExistingUserNotificationRead(database, userId, notificationId);
      if (existing.error) throw existing.error;
      if (existing.row) {
        rows = [existing.row];
        alreadyRead = true;
      }
    }
    if (!rows) {
      return NextResponse.json(
        {
          success: false,
          status: "not_found",
          notificationId,
          readAt: null,
          error: markAllRead ? "没有可标记的未读通知" : "通知不存在、无权访问或已失效",
        },
        { status: 404 },
      );
    }

    const receipt = rows[0];
    return NextResponse.json({
      success: true,
      status: "read",
      notificationId: markAllRead ? null : receipt.id,
      readAt: receipt.readAt,
      alreadyRead,
      ...(markAllRead ? { updatedCount: rows.length, notificationIds: rows.map((row) => row.id) } : {}),
      message: markAllRead ? "全部标记已读" : "已标记阅读",
    });
  } catch (error) {
    console.error("[Notifications] PUT error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
