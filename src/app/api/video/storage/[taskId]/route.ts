/**
 * 兼容旧历史播放入口。
 *
 * 新任务不再写入服务器 /tmp。既有平台对象资产仍可重定向，
 * 其他任务一律回到鉴权上游代理实时播放。
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeVideoMediaRequest } from "@/lib/video-media-auth";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isPersistentVideoUri, resolvePersistentVideoUri } from "@/lib/video-persistence";
import { isStoryboardArchiveExpired, usableStoryboardArchive, type StoryboardArchiveTask } from "@/lib/storyboard-video-archive-policy";
import { isVideoHistoryExplicitlyHidden, type VideoHistoryPolicyItem } from "@/lib/video-history-policy";
import {
  createVideoAccessTicket,
  type VideoAccessIdentity,
} from "@/lib/video-access-ticket";

async function redirectToOriginProxy(_req: NextRequest, taskId: string, identity: VideoAccessIdentity) {
  const params = new URLSearchParams({ id: taskId, source: "origin" });
  params.set("media_ticket", await createVideoAccessTicket({
    taskId,
    userId: identity.userId,
    role: identity.role,
    scope: "playback",
  }));
  // Keep the redirect same-origin without trusting Host/X-Forwarded-* input.
  // A relative Location is valid for HTTP redirects and cannot be turned into
  // an attacker-controlled absolute URL by a forged proxy header.
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: `/api/video/proxy?${params.toString()}`,
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
    },
  });
}

type StorageTask = StoryboardArchiveTask & VideoHistoryPolicyItem & {
  id: string;
  user_id: string;
  storage_url?: string | null;
  source_expired_at?: string | null;
};

type AuthorizedStorageTask = { task: StorageTask; identity: VideoAccessIdentity };

async function canAccessVideoTask(req: NextRequest, taskId: string): Promise<AuthorizedStorageTask | Response | null> {
  const authorization = await authorizeVideoMediaRequest(req, taskId, "playback");
  if (!authorization.ok) return authorization.response;
  const identity = authorization.user;

  const supabase = getSupabaseClient();
  const findTask = async (allowCrossMember: boolean): Promise<StorageTask | null> => {
    const fields = "id,user_id,storage_url,task_label,status,completed_at,created_at,source_expired_at,history_hidden_at,storyboard_archive_expires_at,storyboard_archive_state";
    let byLocalQuery = supabase
      .from("video_tasks")
      .select(fields)
      .eq("id", taskId);
    if (!allowCrossMember) byLocalQuery = byLocalQuery.eq("user_id", identity.userId);
    const { data: byLocal, error: byLocalError } = await byLocalQuery.maybeSingle();
    if (byLocalError) throw byLocalError;
    if (byLocal?.id && byLocal.user_id) return byLocal as StorageTask;

    let byExternalQuery = supabase
      .from("video_tasks")
      .select(fields)
      .eq("task_id_external", taskId);
    if (!allowCrossMember) byExternalQuery = byExternalQuery.eq("user_id", identity.userId);
    const { data: byExternal, error: byExternalError } = await byExternalQuery
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(2);
    if (byExternalError) throw byExternalError;
    // An external provider ID is not necessarily unique across attempts or
    // accounts. Refuse ambiguous IDs instead of checking one row's owner and
    // returning a different row's object.
    if ((byExternal?.length || 0) > 1) throw new Error("VIDEO_EXTERNAL_TASK_AMBIGUOUS");
    const task = byExternal?.[0] as StorageTask | undefined;
    return task?.id && task.user_id ? task : null;
  };

  let task: StorageTask | null;
  try {
    task = await findTask(false);
    if (!task && identity.role === "admin") {
      const discovery = await authorizeMemberContentDiscovery(
        req,
        identity,
        { operation: "member_video_storage_discovery" },
      );
      if (!discovery.ok) return discovery.response;
      task = await findTask(true);
    }
  } catch {
    return NextResponse.json({ error: "视频权限暂时无法核验" }, { status: 503 });
  }

  if (!task) return null;
  const contentAccess = await authorizeMemberContentAccess(
    req,
    identity,
    String(task.user_id),
    { operation: "member_video_storage_playback" },
  );
  return contentAccess.ok ? { task, identity: contentAccess.deliveryIdentity } : contentAccess.response;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  // 安全检查：防止路径遍历（允许 UUID 含连字符和点号）
  if (!/^[a-zA-Z0-9_.-]+$/.test(taskId)) {
    return NextResponse.json({ error: "无效的任务 ID" }, { status: 400 });
  }

  const access = await canAccessVideoTask(req, taskId);
  if (access instanceof Response) return access;
  if (!access) {
    return NextResponse.json({ error: "无权访问该视频" }, { status: 403 });
  }
  const { task, identity } = access;
  if (isVideoHistoryExplicitlyHidden(task) || isStoryboardArchiveExpired(task)
    || (task.source_expired_at && !usableStoryboardArchive(task))) {
    return NextResponse.json({ error: isVideoHistoryExplicitlyHidden(task)
      ? "视频记录已从历史中移除，当前不可播放"
      : "视频源已到期，请使用此前下载的文件" }, {
      status: 410,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const storageUrl = String(task.storage_url || "");
  if (isPersistentVideoUri(storageUrl)) {
    const response = NextResponse.redirect(await resolvePersistentVideoUri(storageUrl), 302);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie, Authorization");
    return response;
  }
  return redirectToOriginProxy(req, String(task.id), identity);
}
