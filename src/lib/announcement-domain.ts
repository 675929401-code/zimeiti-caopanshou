export type AnnouncementPriority = "normal" | "important" | "urgent";
export type AnnouncementStatus = "draft" | "scheduled" | "published" | "withdrawn";
export type AnnouncementAudience = "all" | "guests" | "authenticated" | "admins" | "selected";
export type AnnouncementEventType = "impression" | "read" | "click" | "close" | "remind_later";

export interface AnnouncementDelivery {
  priority: AnnouncementPriority;
  status: AnnouncementStatus;
  summary: string;
  publish_at: string | null;
  expires_at: string | null;
  target_audience: AnnouncementAudience;
  target_user_ids: string[];
  frequency_hours: number;
  max_impressions: number;
  require_ack: boolean;
}

export interface AnnouncementRecord extends AnnouncementDelivery {
  id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  is_active: boolean;
  created_at: string;
  updated_at?: string | null;
  image_url?: string | null;
  link_url?: string | null;
  link_text?: string | null;
  push_revision: number;
  first_published_at?: string | null;
  last_pushed_at?: string | null;
}

export interface AnnouncementInboxRecord extends AnnouncementRecord {
  revision: number;
  readAt: string | null;
  isRead: boolean;
}

export interface AnnouncementInboxResponse {
  announcements: AnnouncementInboxRecord[];
  cursor: string;
  serverTime: string;
  unchanged: boolean;
}

export interface AnnouncementReadResponse {
  success: true;
  announcementId: string;
  revision: number;
  readAt: string;
  alreadyRead: boolean;
  status: "read";
}

export type AnnouncementDeliveryReadFilter = "all" | "read" | "unread";

export interface AnnouncementDeliveryStatusResponse {
  announcementId: string;
  revision: number;
  pushRun: {
    id: string;
    kind: "initial" | "repush";
    pushedBy: string | null;
    reason: string | null;
    pushedAt: string;
    snapshotTargetCount: number;
  };
  summary: {
    targetCount: number;
    readCount: number;
    unreadCount: number;
    /** Ratio from 0 to 1. */
    readRate: number;
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  recipients: Array<{
    userId: string;
    username: string;
    displayName: string;
    role: string;
    status: "read" | "unread";
    readAt: string | null;
  }>;
}

export interface AnnouncementAnalytics {
  impression: number;
  read: number;
  click: number;
  close: number;
  remind_later: number;
  last_event_at?: string;
}

export const ANNOUNCEMENT_DELIVERY_KEY = "announcement_delivery_v2";
export const ANNOUNCEMENT_ANALYTICS_KEY = "announcement_analytics_v2";

const priorities = new Set<AnnouncementPriority>(["normal", "important", "urgent"]);
const statuses = new Set<AnnouncementStatus>(["draft", "scheduled", "published", "withdrawn"]);
const audiences = new Set<AnnouncementAudience>(["all", "guests", "authenticated", "admins", "selected"]);

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

function nullableIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizePushRevision(value: unknown): number {
  return clampInt(value, 0, 0, Number.MAX_SAFE_INTEGER);
}

export function defaultAnnouncementDelivery(isPinned = false): AnnouncementDelivery {
  return {
    priority: isPinned ? "important" : "normal",
    status: "published",
    summary: "",
    publish_at: null,
    expires_at: null,
    target_audience: "all",
    target_user_ids: [],
    frequency_hours: 24,
    max_impressions: 3,
    require_ack: false,
  };
}

export function normalizeAnnouncementDelivery(
  value: Partial<AnnouncementDelivery> | null | undefined,
  isPinned = false,
): AnnouncementDelivery {
  const fallback = defaultAnnouncementDelivery(isPinned);
  const ids = Array.isArray(value?.target_user_ids)
    ? [...new Set(value.target_user_ids.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 200)
    : fallback.target_user_ids;

  return {
    priority: enumValue(value?.priority, priorities, fallback.priority),
    status: enumValue(value?.status, statuses, fallback.status),
    summary: typeof value?.summary === "string" ? value.summary.trim().slice(0, 300) : "",
    publish_at: nullableIso(value?.publish_at),
    expires_at: nullableIso(value?.expires_at),
    target_audience: enumValue(value?.target_audience, audiences, fallback.target_audience),
    target_user_ids: ids,
    frequency_hours: clampInt(value?.frequency_hours, fallback.frequency_hours, 1, 720),
    max_impressions: clampInt(value?.max_impressions, fallback.max_impressions, 0, 100),
    require_ack: Boolean(value?.require_ack),
  };
}

export function isAnnouncementActive(
  announcement: AnnouncementRecord,
  viewer: { userId?: string; role?: string } | null,
  now = new Date(),
): boolean {
  if (!announcement.is_active) return false;
  if (announcement.status === "draft" || announcement.status === "withdrawn") return false;

  const nowMs = now.getTime();
  if (announcement.publish_at && new Date(announcement.publish_at).getTime() > nowMs) return false;
  if (announcement.expires_at && new Date(announcement.expires_at).getTime() <= nowMs) return false;

  switch (announcement.target_audience) {
    case "guests":
      return !viewer;
    case "authenticated":
      return Boolean(viewer);
    case "admins":
      return viewer?.role === "admin";
    case "selected":
      return Boolean(viewer?.userId && announcement.target_user_ids.includes(viewer.userId));
    default:
      return true;
  }
}

export function announcementPriorityWeight(priority: AnnouncementPriority): number {
  if (priority === "urgent") return 3;
  if (priority === "important") return 2;
  return 1;
}

export function safeAnnouncementUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed.slice(0, 2048);
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed.slice(0, 2048) : "";
  } catch {
    return "";
  }
}

export function parseRecordMap<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, T>;
}
