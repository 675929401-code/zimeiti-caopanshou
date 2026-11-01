import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { createVideoAccessUrl, type VideoAccessScope } from "@/lib/video-access-ticket";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isVideoHistoryExpired, isVideoHistoryExplicitlyHidden } from "@/lib/video-history-policy";
import { isStoryboardArchiveExpired, isStoryboardVideoTask, usableStoryboardArchive } from "@/lib/storyboard-video-archive-policy";

export const dynamic = "force-dynamic";

async function findTask(taskId: string, userId: string, isAdmin: boolean) {
  const supabase = getSupabaseClient();
  const fields = "id, user_id, status, history_hidden_at, source_expired_at, storage_url, storyboard_archive_expires_at, task_label, billing_state, created_at, completed_at";
  let localQuery = supabase
    .from("video_tasks")
    .select(fields)
    .eq("id", taskId);
  if (!isAdmin) localQuery = localQuery.eq("user_id", userId);
  const { data: byLocal, error: localError } = await localQuery.maybeSingle();
  if (localError) throw localError;
  if (byLocal) return byLocal as TicketTask;

  let externalQuery = supabase
    .from("video_tasks")
    .select(fields)
    .eq("task_id_external", taskId);
  if (!isAdmin) externalQuery = externalQuery.eq("user_id", userId);
  const { data: byExternal, error: externalError } = await externalQuery
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (externalError) throw externalError;
  return (byExternal?.[0] as TicketTask | undefined) || null;
}

type TicketTask = { id: string; user_id: string; status: string; history_hidden_at?: string | null; source_expired_at?: string | null; storage_url?: string | null; storyboard_archive_expires_at?: string | null; task_label?: string | null; billing_state?: string | null; created_at?: string; completed_at?: string | null };

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;

  const taskId = request.nextUrl.searchParams.get("taskId") || "";
  const requestedScope = request.nextUrl.searchParams.get("scope");
  const scope: VideoAccessScope =
    requestedScope === "download" ? "download"
    : requestedScope === "thumbnail" ? "thumbnail"
    : "playback";
  const filename = request.nextUrl.searchParams.get("name") || undefined;
  const source = request.nextUrl.searchParams.get("source") === "origin" ? "origin" : undefined;
  const forCapture = request.nextUrl.searchParams.get("forCapture") === "1";
  if (!taskId) return NextResponse.json({ error: "缺少 taskId" }, { status: 400 });

  let task: Awaited<ReturnType<typeof findTask>>;
  try {
    task = await findTask(taskId, user.userId, false);
    if (!task && user.role === "admin") {
      const discovery = await authorizeMemberContentDiscovery(
        request,
        user,
        {
          requireStepUp: scope === "download",
          operation: scope === "download"
            ? "member_video_download_ticket_discovery"
            : "member_video_playback_ticket_discovery",
        },
      );
      if (!discovery.ok) return discovery.response;
      task = await findTask(taskId, user.userId, true);
    }
  } catch {
    return NextResponse.json({ error: "视频任务暂时无法读取" }, { status: 503 });
  }
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const contentAccess = await authorizeMemberContentAccess(
    request,
    { userId: user.userId, role: user.role },
    task.user_id,
    {
      requireStepUp: scope === "download",
      operation: scope === "download" ? "member_video_download_ticket" : "member_video_playback_ticket",
    },
  );
  if (!contentAccess.ok) return contentAccess.response;
  if (isVideoHistoryExplicitlyHidden(task)) return NextResponse.json({ error: "该视频已从历史移除" }, { status: 404 });
  if (isStoryboardArchiveExpired(task)) {
    return NextResponse.json({ error: "视频的3天保留期已结束，任务和费用记录仍保留" }, { status: 410 });
  }
  if ((task.source_expired_at && (!usableStoryboardArchive(task) || source === "origin")) || (!isStoryboardVideoTask(task) && !String(task.task_label || "").startsWith("digital-human:") && isVideoHistoryExpired(task))) {
    return NextResponse.json({ error: "视频来源或历史保留期已结束；如已缓存，可使用本机副本" }, { status: 410 });
  }
  if (task.status !== "completed") {
    return NextResponse.json({ error: "任务尚未完成" }, { status: 409 });
  }

  const url = await createVideoAccessUrl({
    taskId: task.id,
    userId: contentAccess.deliveryIdentity.userId,
    role: contentAccess.deliveryIdentity.role,
    scope,
    filename,
    source,
    forCapture,
  });
  return NextResponse.json({ url, expiresInSeconds: 15 * 60 });
}
