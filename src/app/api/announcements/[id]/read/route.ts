import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import type { AnnouncementReadResponse } from "@/lib/announcement-domain";
import {
  ANNOUNCEMENT_PRIVATE_HEADERS,
  announcementBackendError,
  requiredPositiveInteger,
} from "@/lib/announcement-delivery-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function recordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function validReadAt(value: unknown): value is string {
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

function announcementReadReceipt(
  data: unknown,
  expectedAnnouncementId: string,
  expectedRevision: number,
): AnnouncementReadResponse | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.success !== true || record.status !== "read") return null;

  const idValue = recordValue(record, "announcementId", "announcement_id", "id");
  const revisionValue = recordValue(record, "revision", "pushRevision", "push_revision");
  const readAtValue = recordValue(record, "readAt", "read_at");
  const alreadyReadValue = recordValue(record, "alreadyRead", "already_read");
  const announcementId = typeof idValue === "string" ? idValue.trim() : "";
  const revision = requiredPositiveInteger(revisionValue);
  if (
    announcementId !== expectedAnnouncementId
    || revision !== expectedRevision
    || !validReadAt(readAtValue)
    || typeof alreadyReadValue !== "boolean"
  ) return null;

  return {
    success: true,
    announcementId,
    revision,
    readAt: readAtValue.trim(),
    alreadyRead: alreadyReadValue,
    status: "read",
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  return withAuth(request, async (user, supabase) => {
    const { id: rawId } = await context.params;
    const announcementId = rawId.trim();
    if (!announcementId || announcementId.length > 36) {
      return NextResponse.json(
        { error: "公告标识无效", code: "ANNOUNCEMENT_INPUT_INVALID" },
        { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const revision = requiredPositiveInteger(body?.revision ?? body?.pushRevision);
    if (!revision) {
      return NextResponse.json(
        { error: "公告版本无效", code: "ANNOUNCEMENT_INPUT_INVALID" },
        { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    }

    try {
      const announcementDb = supabase as unknown as {
        rpc: (name: string, args: Record<string, unknown>) => Promise<{
          data: unknown;
          error: { code?: string; message?: string; details?: string } | null;
        }>;
      };
      const { data, error } = await announcementDb.rpc("mark_announcement_read", {
        p_announcement_id: announcementId,
        p_user_id: user.id,
        p_revision: revision,
      });
      if (error) return announcementBackendError(error, "已读状态保存失败");
      const receipt = announcementReadReceipt(data, announcementId, revision);
      if (!receipt) {
        return announcementBackendError(new Error("ANNOUNCEMENT_READ_RESULT_INVALID"), "已读状态保存失败");
      }
      return NextResponse.json(receipt, { headers: ANNOUNCEMENT_PRIVATE_HEADERS });
    } catch (error) {
      console.error("[announcement-read] write failed:", error);
      return announcementBackendError(error, "已读状态保存失败");
    }
  });
}
