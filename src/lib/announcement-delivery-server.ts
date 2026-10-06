import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  normalizeAnnouncementDelivery,
  normalizePushRevision,
  type AnnouncementInboxRecord,
  type AnnouncementRecord,
} from "@/lib/announcement-domain";

export const ANNOUNCEMENT_SELECT = [
  "id",
  "title",
  "content",
  "is_pinned",
  "is_active",
  "created_at",
  "updated_at",
  "image_url",
  "link_url",
  "link_text",
  "priority",
  "status",
  "summary",
  "publish_at",
  "expires_at",
  "target_audience",
  "target_user_ids",
  "frequency_hours",
  "max_impressions",
  "require_ack",
  "push_revision",
  "first_published_at",
  "last_pushed_at",
].join(",");

export const ANNOUNCEMENT_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Authorization, Cookie",
};

type DatabaseError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function announcementRecordFromRow(row: Record<string, unknown>): AnnouncementRecord {
  const isPinned = row.is_pinned === true;
  const delivery = normalizeAnnouncementDelivery({
    priority: row.priority as never,
    status: row.status as never,
    summary: row.summary as never,
    publish_at: row.publish_at as never,
    expires_at: row.expires_at as never,
    target_audience: row.target_audience as never,
    target_user_ids: Array.isArray(row.target_user_ids) ? row.target_user_ids as string[] : [],
    frequency_hours: row.frequency_hours as never,
    max_impressions: row.max_impressions as never,
    require_ack: row.require_ack as never,
  }, isPinned);

  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    content: String(row.content || ""),
    is_pinned: isPinned,
    is_active: row.is_active === true,
    created_at: String(row.created_at || ""),
    updated_at: stringOrNull(row.updated_at),
    image_url: stringOrNull(row.image_url),
    link_url: stringOrNull(row.link_url),
    link_text: stringOrNull(row.link_text),
    push_revision: normalizePushRevision(row.push_revision),
    first_published_at: stringOrNull(row.first_published_at),
    last_pushed_at: stringOrNull(row.last_pushed_at),
    ...delivery,
  };
}

export function createAnnouncementInboxCursor(records: AnnouncementInboxRecord[]): string {
  const source = records
    .map((record) => [
      record.id,
      record.revision,
      record.updated_at || record.created_at,
      record.last_pushed_at || "",
      record.readAt || "",
    ].join(":"))
    .sort()
    .join("|");
  return `ann_${createHash("sha256").update(source).digest("base64url").slice(0, 32)}`;
}

export function createAnnouncementRevisionCursor(
  announcementId: string,
  revision: number,
  pushedAt: string,
): string {
  const source = `${announcementId}:${revision}:${pushedAt}`;
  return `ann_${createHash("sha256").update(source).digest("base64url").slice(0, 32)}`;
}

export function announcementSchemaUnavailable(error: DatabaseError | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code || "");
  const message = `${error.message || ""} ${error.details || ""}`;
  return ["42P01", "42703", "PGRST202", "PGRST204"].includes(code)
    || /announcement_(?:user_reads|push_runs|delivery_events)|push_revision|mark_announcement_read|repush_announcement_atomic|get_announcement_delivery_status|record_announcement_delivery_event|get_announcement_event_totals/iu.test(message);
}

export function announcementBackendError(
  error: DatabaseError | Error | unknown,
  fallback: string,
): NextResponse {
  const value = (error && typeof error === "object" ? error : {}) as DatabaseError;
  const message = String(value.message || (error instanceof Error ? error.message : ""));
  if (announcementSchemaUnavailable(value)) {
    return NextResponse.json(
      { error: "公告投递数据库迁移尚未完成", code: "ANNOUNCEMENT_SCHEMA_REQUIRED" },
      { status: 503, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
    );
  }
  const known: Array<[RegExp, number, string, string]> = [
    [/ANNOUNCEMENT_(?:READ|PUSH|EVENT)_INPUT_INVALID|ANNOUNCEMENT_EVENT_KEY_INVALID|ANNOUNCEMENT_DELIVERY_FILTER_INVALID/u, 400, "ANNOUNCEMENT_INPUT_INVALID", "公告请求参数无效"],
    [/ANNOUNCEMENT_READ_RECEIPT_REQUIRED/u, 409, "ANNOUNCEMENT_READ_RECEIPT_REQUIRED", "请先保存公告已读状态"],
    [/ANNOUNCEMENT_REVISION_CONFLICT/u, 409, "ANNOUNCEMENT_REVISION_CONFLICT", "公告已被更新，请刷新后重试"],
    [/ANNOUNCEMENT_NOT_PUSHABLE/u, 409, "ANNOUNCEMENT_NOT_PUSHABLE", "当前公告不在可推送状态"],
    [/ANNOUNCEMENT_(?:NOT_FOUND|NOT_VISIBLE|NOT_TARGETED|PUSH_RUN_NOT_FOUND)/u, 404, "ANNOUNCEMENT_NOT_FOUND", "公告不存在或当前不可见"],
    [/ANNOUNCEMENT_(?:ACCOUNT_NOT_ACTIVE|ADMIN_REQUIRED)/u, 403, "ANNOUNCEMENT_ACCESS_DENIED", "当前账号无权执行此操作"],
  ];
  const matched = known.find(([pattern]) => pattern.test(message));
  if (matched) {
    return NextResponse.json(
      { error: matched[3], code: matched[2] },
      { status: matched[1], headers: ANNOUNCEMENT_PRIVATE_HEADERS },
    );
  }
  return NextResponse.json(
    { error: fallback, code: "ANNOUNCEMENT_BACKEND_UNAVAILABLE" },
    { status: 503, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
  );
}

export function requiredPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function pageInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}
