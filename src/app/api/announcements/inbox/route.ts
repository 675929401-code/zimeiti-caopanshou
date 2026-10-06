import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import {
  announcementPriorityWeight,
  isAnnouncementActive,
  type AnnouncementInboxRecord,
  type AnnouncementRecord,
} from "@/lib/announcement-domain";
import {
  ANNOUNCEMENT_PRIVATE_HEADERS,
  ANNOUNCEMENT_SELECT,
  announcementBackendError,
  announcementRecordFromRow,
  createAnnouncementInboxCursor,
} from "@/lib/announcement-delivery-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, supabase) => {
    try {
      const { data, error } = await supabase
        .from("announcements")
        .select(ANNOUNCEMENT_SELECT)
        .eq("is_active", true)
        .gt("push_revision", 0)
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) return announcementBackendError(error, "公告收件箱暂时无法读取");

      const visible = (data || [])
        .map((row) => announcementRecordFromRow(row as Record<string, unknown>))
        .filter((announcement) => isAnnouncementActive(
          announcement,
          { userId: user.id, role: user.role },
        ))
        .sort((a, b) => {
          const priority = announcementPriorityWeight(b.priority) - announcementPriorityWeight(a.priority);
          if (priority) return priority;
          if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

      const readByRevision = new Map<string, string>();
      const ids = visible.map((announcement) => announcement.id);
      if (ids.length > 0) {
        const { data: receipts, error: receiptError } = await supabase
          .from("announcement_user_reads")
          .select("announcement_id,revision,read_at")
          .eq("user_id", user.id)
          .in("announcement_id", ids);
        if (receiptError) return announcementBackendError(receiptError, "公告已读状态暂时无法读取");
        const receiptRows = (receipts || []) as unknown as Array<{
          announcement_id: string;
          revision: number;
          read_at: string;
        }>;
        for (const receipt of receiptRows) {
          readByRevision.set(
            `${String(receipt.announcement_id)}:${Number(receipt.revision)}`,
            String(receipt.read_at),
          );
        }
      }

      const announcements: AnnouncementInboxRecord[] = visible.map((announcement: AnnouncementRecord) => {
        const revision = announcement.push_revision;
        const readAt = readByRevision.get(`${announcement.id}:${revision}`) || null;
        return { ...announcement, revision, readAt, isRead: Boolean(readAt) };
      });
      const cursor = createAnnouncementInboxCursor(announcements);
      const requestedCursor = request.nextUrl.searchParams.get("cursor");

      return NextResponse.json(
        {
          announcements,
          cursor,
          serverTime: new Date().toISOString(),
          unchanged: Boolean(requestedCursor && requestedCursor === cursor),
        },
        { headers: ANNOUNCEMENT_PRIVATE_HEADERS },
      );
    } catch (error) {
      console.error("[announcement-inbox] read failed:", error);
      return announcementBackendError(error, "公告收件箱暂时无法读取");
    }
  });
}
