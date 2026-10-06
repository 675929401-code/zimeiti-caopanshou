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
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return announcementBackendError(new Error("ANNOUNCEMENT_READ_RESULT_INVALID"), "已读状态保存失败");
      }
      return NextResponse.json(data as AnnouncementReadResponse, { headers: ANNOUNCEMENT_PRIVATE_HEADERS });
    } catch (error) {
      console.error("[announcement-read] write failed:", error);
      return announcementBackendError(error, "已读状态保存失败");
    }
  });
}
