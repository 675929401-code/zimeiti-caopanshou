import { NextRequest, NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api-middleware";
import {
  ANNOUNCEMENT_PRIVATE_HEADERS,
  announcementBackendError,
  createAnnouncementRevisionCursor,
  requiredPositiveInteger,
} from "@/lib/announcement-delivery-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PushResult {
  success: true;
  announcementId: string;
  previousRevision: number;
  revision: number;
  pushedAt: string;
  runId: string;
  targetCount: number;
}

export async function POST(request: NextRequest, context: RouteContext) {
  return withAdminAuth(request, async (admin, supabase) => {
    const { id: rawId } = await context.params;
    const announcementId = rawId.trim();
    if (!announcementId || announcementId.length > 36) {
      return NextResponse.json(
        { error: "公告标识无效", code: "ANNOUNCEMENT_INPUT_INVALID" },
        { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const expectedRevision = requiredPositiveInteger(body?.expectedRevision);
    if (!expectedRevision) {
      return NextResponse.json(
        { error: "必须提供当前公告版本", code: "ANNOUNCEMENT_INPUT_INVALID" },
        { status: 400, headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    }
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : null;

    try {
      const announcementDb = supabase as unknown as {
        rpc: (name: string, args: Record<string, unknown>) => Promise<{
          data: unknown;
          error: { code?: string; message?: string; details?: string } | null;
        }>;
      };
      const { data, error } = await announcementDb.rpc("repush_announcement_atomic", {
        p_announcement_id: announcementId,
        p_actor_id: admin.id,
        p_expected_revision: expectedRevision,
        p_reason: reason || null,
      });
      if (error) return announcementBackendError(error, "强制推送失败");
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return announcementBackendError(new Error("ANNOUNCEMENT_PUSH_RESULT_INVALID"), "强制推送失败");
      }
      const result = data as unknown as PushResult;
      return NextResponse.json(
        {
          ...result,
          cursor: createAnnouncementRevisionCursor(
            result.announcementId,
            result.revision,
            result.pushedAt,
          ),
        },
        { headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    } catch (error) {
      console.error("[announcement-push] write failed:", error);
      return announcementBackendError(error, "强制推送失败");
    }
  });
}
