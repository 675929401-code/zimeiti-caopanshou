import { NextRequest, NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api-middleware";
import type {
  AnnouncementDeliveryReadFilter,
  AnnouncementDeliveryStatusResponse,
} from "@/lib/announcement-domain";
import {
  ANNOUNCEMENT_PRIVATE_HEADERS,
  announcementBackendError,
  pageInteger,
  requiredPositiveInteger,
} from "@/lib/announcement-delivery-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const READ_FILTERS = new Set<AnnouncementDeliveryReadFilter>(["all", "read", "unread"]);

export async function GET(request: NextRequest, context: RouteContext) {
  return withAdminAuth(request, async (_admin, supabase) => {
    const { id: rawId } = await context.params;
    const announcementId = rawId.trim();
    if (!announcementId || announcementId.length > 36) {
      return NextResponse.json(
        { error: "公告标识无效", code: "ANNOUNCEMENT_INPUT_INVALID" },
        { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    }

    const revisionValue = request.nextUrl.searchParams.get("revision");
    const revision = revisionValue === null ? null : requiredPositiveInteger(revisionValue);
    if (revisionValue !== null && !revision) {
      return NextResponse.json(
        { error: "公告版本无效", code: "ANNOUNCEMENT_INPUT_INVALID" },
        { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    }
    const page = pageInteger(request.nextUrl.searchParams.get("page"), 1, 1_000_000);
    const pageSize = pageInteger(request.nextUrl.searchParams.get("pageSize"), 20, 100);
    const statusValue = request.nextUrl.searchParams.get("status") || "all";
    if (!READ_FILTERS.has(statusValue as AnnouncementDeliveryReadFilter)) {
      return NextResponse.json(
        { error: "已读筛选条件无效", code: "ANNOUNCEMENT_INPUT_INVALID" },
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
      const { data, error } = await announcementDb.rpc("get_announcement_delivery_status", {
        p_announcement_id: announcementId,
        p_revision: revision,
        p_page: page,
        p_page_size: pageSize,
        p_read_state: statusValue,
      });
      if (error) return announcementBackendError(error, "公告送达统计暂时无法读取");
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return announcementBackendError(
          new Error("ANNOUNCEMENT_DELIVERY_RESULT_INVALID"),
          "公告送达统计暂时无法读取",
        );
      }
      return NextResponse.json(
        data as AnnouncementDeliveryStatusResponse,
        { headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    } catch (error) {
      console.error("[announcement-delivery-status] read failed:", error);
      return announcementBackendError(error, "公告送达统计暂时无法读取");
    }
  });
}
