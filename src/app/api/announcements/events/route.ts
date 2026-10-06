import { NextResponse } from "next/server";
import { authorizeToken, getTokenFromHeaders } from "@/lib/auth";
import type { AnnouncementEventType } from "@/lib/announcement-domain";
import {
  ANNOUNCEMENT_PRIVATE_HEADERS,
  announcementBackendError,
  requiredPositiveInteger,
} from "@/lib/announcement-delivery-server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowedEvents = new Set<AnnouncementEventType>([
  "impression",
  "read",
  "click",
  "close",
  "remind_later",
]);

function authorizationFailure(status: 401 | 403 | 503, code: string, error: string) {
  return NextResponse.json(
    { error, code },
    { status, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
  );
}

export async function POST(request: Request) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    return authorizationFailure(401, "AUTH_REQUIRED", "请先登录");
  }
  const authorization = await authorizeToken(token);
  if (!authorization.ok) {
    return authorizationFailure(
      authorization.status,
      authorization.code,
      authorization.error,
    );
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const announcementId = typeof body?.id === "string" ? body.id.trim() : "";
  const event = typeof body?.event === "string"
    ? body.event as AnnouncementEventType
    : null;
  const revision = requiredPositiveInteger(body?.revision ?? body?.pushRevision);
  const eventKey = typeof body?.eventKey === "string" ? body.eventKey.trim() : "";
  if (
    !announcementId
    || announcementId.length > 36
    || !event
    || !allowedEvents.has(event)
    || !revision
    || !eventKey
    || eventKey.length > 160
  ) {
    return NextResponse.json(
      { error: "无效的公告事件", code: "ANNOUNCEMENT_EVENT_INPUT_INVALID" },
      { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
    );
  }

  try {
    const announcementDb = getSupabaseAdminClient() as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<{
        data: unknown;
        error: { code?: string; message?: string; details?: string } | null;
      }>;
    };
    const { data, error } = await announcementDb.rpc("record_announcement_delivery_event", {
      p_announcement_id: announcementId,
      p_user_id: authorization.actor.userId,
      p_revision: revision,
      p_event_type: event,
      p_event_key: eventKey,
    });
    if (error) return announcementBackendError(error, "公告事件保存失败");
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return announcementBackendError(
        new Error("ANNOUNCEMENT_EVENT_RESULT_INVALID"),
        "公告事件保存失败",
      );
    }
    return NextResponse.json(data, { headers: ANNOUNCEMENT_PRIVATE_HEADERS });
  } catch (error) {
    console.error("[announcement-events] write failed:", error);
    return announcementBackendError(error, "公告事件保存失败");
  }
}
