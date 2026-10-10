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

async function canAccessVideoTask(req: NextRequest, taskId: string): Promise<VideoAccessIdentity | Response | null> {
  const authorization = await authorizeVideoMediaRequest(req, taskId, "playback");
  if (!authorization.ok) return authorization.response;
  const identity = authorization.user;

  const supabase = getSupabaseClient();
  const findOwner = async (allowCrossMember: boolean) => {
    let byLocalQuery = supabase
      .from("video_tasks")
      .select("user_id")
      .eq("id", taskId);
    if (!allowCrossMember) byLocalQuery = byLocalQuery.eq("user_id", identity.userId);
    const { data: byLocal, error: byLocalError } = await byLocalQuery.maybeSingle();
    if (byLocalError) throw byLocalError;
    const localOwnerId = String((byLocal as { user_id?: string } | null)?.user_id || "");
    if (localOwnerId) return localOwnerId;

    let byExternalQuery = supabase
      .from("video_tasks")
      .select("user_id")
      .eq("task_id_external", taskId);
    if (!allowCrossMember) byExternalQuery = byExternalQuery.eq("user_id", identity.userId);
    const { data: byExternal, error: byExternalError } = await byExternalQuery
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (byExternalError) throw byExternalError;
    return String(byExternal?.[0]?.user_id || "");
  };

  let ownerId: string;
  try {
    ownerId = await findOwner(false);
    if (!ownerId && identity.role === "admin") {
      const discovery = await authorizeMemberContentDiscovery(
        req,
        identity,
        { operation: "member_video_storage_discovery" },
      );
      if (!discovery.ok) return discovery.response;
      ownerId = await findOwner(true);
    }
  } catch {
    return NextResponse.json({ error: "视频权限暂时无法核验" }, { status: 503 });
  }

  if (!ownerId) return null;
  const contentAccess = await authorizeMemberContentAccess(
    req,
    identity,
    ownerId,
    { operation: "member_video_storage_playback" },
  );
  return contentAccess.ok ? contentAccess.deliveryIdentity : contentAccess.response;
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

  const identity = await canAccessVideoTask(req, taskId);
  if (identity instanceof Response) return identity;
  if (!identity) {
    return NextResponse.json({ error: "无权访问该视频" }, { status: 403 });
  }

  const supabase = getSupabaseClient();
  const storedByIdQuery = supabase
    .from("video_tasks")
    .select("storage_url")
    .eq("id", taskId);
  const { data: storedById, error: storedByIdError } = identity.role === "admin"
    ? await storedByIdQuery.maybeSingle()
    : await storedByIdQuery.eq("user_id", identity.userId).maybeSingle();
  if (storedByIdError) {
    return NextResponse.json({ error: "视频地址暂时无法读取" }, { status: 503 });
  }
  let storageUrl = (storedById as { storage_url?: string } | null)?.storage_url || "";
  if (!storageUrl) {
    const storedByExternalQuery = supabase
      .from("video_tasks")
      .select("storage_url")
      .eq("task_id_external", taskId)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const { data: storedByExternal, error: storedByExternalError } = identity.role === "admin"
      ? await storedByExternalQuery
      : await storedByExternalQuery.eq("user_id", identity.userId);
    if (storedByExternalError) {
      return NextResponse.json({ error: "视频地址暂时无法读取" }, { status: 503 });
    }
    storageUrl = storedByExternal?.[0]?.storage_url || "";
  }
  if (isPersistentVideoUri(storageUrl)) {
    return NextResponse.redirect(await resolvePersistentVideoUri(storageUrl), 302);
  }
  return redirectToOriginProxy(req, taskId, identity);
}
