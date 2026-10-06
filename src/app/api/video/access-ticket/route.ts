import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { createVideoAccessUrl, type VideoAccessScope } from "@/lib/video-access-ticket";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";

async function findTask(taskId: string, userId: string, isAdmin: boolean) {
  const supabase = getSupabaseClient();
  const fields = "id, user_id, status";
  let localQuery = supabase
    .from("video_tasks")
    .select(fields)
    .eq("id", taskId);
  if (!isAdmin) localQuery = localQuery.eq("user_id", userId);
  const { data: byLocal, error: localError } = await localQuery.maybeSingle();
  if (localError) throw localError;
  if (byLocal) return byLocal as { id: string; user_id: string; status: string };

  let externalQuery = supabase
    .from("video_tasks")
    .select(fields)
    .eq("task_id_external", taskId);
  if (!isAdmin) externalQuery = externalQuery.eq("user_id", userId);
  const { data: byExternal, error: externalError } = await externalQuery
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (externalError) throw externalError;
  return (byExternal?.[0] as { id: string; user_id: string; status: string } | undefined) || null;
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;

  const taskId = request.nextUrl.searchParams.get("taskId") || "";
  const requestedScope = request.nextUrl.searchParams.get("scope");
  const scope: VideoAccessScope = requestedScope === "download" ? "download" : "playback";
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
