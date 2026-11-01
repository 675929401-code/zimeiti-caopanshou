import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import { authorizeVideoMediaRequest } from "@/lib/video-media-auth";
import { extractVideoThumbnail } from "@/lib/video-postprocess";
import { isStoryboardArchiveExpired, usableStoryboardArchive } from "@/lib/storyboard-video-archive-policy";
import { isVideoHistoryExplicitlyHidden } from "@/lib/video-history-policy";
import {
  readVideoThumbnailCacheFile,
  readVideoThumbnailCachePolicy,
  resolveVideoThumbnailCacheFile,
  scheduleVideoThumbnailCachePrune,
  writeVideoThumbnailCacheFile,
} from "@/lib/video-thumbnail-cache";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function resolveThumbnailDirectory(): string {
  return path.join(/* turbopackIgnore: true */ resolveAppRuntimeDir(), "video-thumbnails");
}
const thumbnailGlobal = globalThis as typeof globalThis & {
  __videoThumbnailJobs?: Map<string, Promise<Buffer>>;
  __videoThumbnailCapacity?: { active: number; waiters: Array<() => void> };
  __videoThumbnailFailures?: Map<string, number>;
};
const thumbnailJobs = thumbnailGlobal.__videoThumbnailJobs
  ?? (thumbnailGlobal.__videoThumbnailJobs = new Map<string, Promise<Buffer>>());
const thumbnailCapacity = thumbnailGlobal.__videoThumbnailCapacity
  ?? (thumbnailGlobal.__videoThumbnailCapacity = { active: 0, waiters: [] });
const thumbnailFailures = thumbnailGlobal.__videoThumbnailFailures
  ?? (thumbnailGlobal.__videoThumbnailFailures = new Map<string, number>());

// One history page must not launch dozens of full downloads and ffmpeg processes.
async function withThumbnailCapacity<T>(run: () => Promise<T>): Promise<T> {
  if (thumbnailCapacity.active >= 2) {
    if (thumbnailCapacity.waiters.length >= 24) throw new Error("VIDEO_THUMBNAIL_BUSY");
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => {
        const index = thumbnailCapacity.waiters.indexOf(ready);
        if (index >= 0) thumbnailCapacity.waiters.splice(index, 1);
        reject(new Error("VIDEO_THUMBNAIL_BUSY"));
      }, 20_000);
      thumbnailCapacity.waiters.push(ready);
    });
  } else thumbnailCapacity.active += 1;
  try { return await run(); }
  finally {
    const next = thumbnailCapacity.waiters.shift();
    if (next) next(); // Transfer the occupied slot; new requests cannot jump the queue.
    else thumbnailCapacity.active -= 1;
  }
}

function thumbnailResponse(buffer: Buffer) {
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, max-age=3600",
      "Referrer-Policy": "no-referrer",
      "Vary": "Cookie, Authorization",
    },
  });
}

function localMediaOrigin() {
  const port = String(process.env.DEPLOY_RUN_PORT || process.env.PORT || "5000").trim();
  if (!/^\d{2,5}$/u.test(port)) throw new Error("VIDEO_THUMBNAIL_INTERNAL_PORT_INVALID");
  return `http://127.0.0.1:${port}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  if (!/^[a-zA-Z0-9_-]+$/u.test(taskId)) {
    return NextResponse.json({ error: "Invalid taskId" }, { status: 400 });
  }
  const authorization = await authorizeVideoMediaRequest(request, taskId, "thumbnail");
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;

  const db = getSupabaseAdminClient();
  const findTask = async (allowCrossMember: boolean) => {
    let taskQuery = db
      .from("video_tasks")
      .select("id,user_id,status,task_label,completed_at,storage_url,source_expired_at,history_hidden_at,storyboard_archive_expires_at")
      .or(`id.eq.${taskId},task_id_external.eq.${taskId}`);
    if (!allowCrossMember) taskQuery = taskQuery.eq("user_id", user.userId);
    const { data: rows, error } = await taskQuery.limit(2);
    if (error) throw error;
    return (rows || []).find((row: { id: string }) => row.id === taskId) || rows?.[0];
  };

  let task;
  try {
    task = await findTask(false);
    if (!task && user.role === "admin") {
      const discovery = await authorizeMemberContentDiscovery(
        request,
        user,
        { operation: "member_video_thumbnail_discovery" },
      );
      if (!discovery.ok) return discovery.response;
      task = await findTask(true);
    }
  } catch {
    return NextResponse.json({ error: "视频封面暂时无法读取" }, { status: 503 });
  }
  if (!task || task.status !== "completed") {
    return NextResponse.json({ error: "Thumbnail not found" }, { status: 404 });
  }
  const contentAccess = await authorizeMemberContentAccess(
    request,
    { userId: user.userId, role: user.role },
    task.user_id,
    { operation: "member_video_thumbnail" },
  );
  if (!contentAccess.ok) return contentAccess.response;
  if (isVideoHistoryExplicitlyHidden(task) || isStoryboardArchiveExpired(task)
    || (task.source_expired_at && !usableStoryboardArchive(task))) {
    return NextResponse.json({ error: "视频媒体已到期或已移除，任务记录仍保留" }, { status: 410 });
  }

  const thumbnailDirectory = resolveThumbnailDirectory();
  const cachePolicy = readVideoThumbnailCachePolicy();
  const thumbPath = resolveVideoThumbnailCacheFile(thumbnailDirectory, task.id);
  const cachedThumbnail = await readVideoThumbnailCacheFile(
    thumbnailDirectory,
    task.id,
    cachePolicy.ttlMs,
  );
  if (cachedThumbnail) {
    scheduleVideoThumbnailCachePrune({
      cacheRoot: thumbnailDirectory,
      policy: cachePolicy,
      protectedPaths: [thumbPath],
    });
    return thumbnailResponse(cachedThumbnail);
  }

  if ((thumbnailFailures.get(task.id) || 0) > Date.now()) {
    return NextResponse.json({ error: "视频首帧暂不可用，请稍后重试" }, {
      status: 503, headers: { "Retry-After": "30", "Cache-Control": "private, no-store" },
    });
  }

  let job = thumbnailJobs.get(task.id);
  if (!job) {
    job = withThumbnailCapacity(async () => {
      const origin = localMediaOrigin();
      const relativeVideoUrl = await createVideoAccessUrl({
        taskId: task.id,
        userId: contentAccess.deliveryIdentity.userId,
        role: contentAccess.deliveryIdentity.role,
        scope: "playback",
        forCapture: true,
      });
      const thumbnail = await extractVideoThumbnail(new URL(relativeVideoUrl, origin).toString(), {
        trustedInternalOrigin: origin,
        maxBytes: 256 * 1024 * 1024,
        timeoutMs: 120_000,
      });
      try {
        await writeVideoThumbnailCacheFile(thumbnailDirectory, task.id, thumbnail);
      } catch (cacheError) {
        console.warn("[VideoThumbnail] cache write failed", {
          taskId: task.id,
          reason: cacheError instanceof Error ? cacheError.message.split(":", 1)[0] : "UNKNOWN",
        });
      }
      scheduleVideoThumbnailCachePrune({
        cacheRoot: thumbnailDirectory,
        policy: cachePolicy,
        protectedPaths: [thumbPath],
        force: true,
      });
      thumbnailFailures.delete(task.id);
      return thumbnail;
    }).catch(error => {
      // Capacity pressure says nothing about this video's extractability.
      // Only actual capture failures should cool down the individual task.
      if (!(error instanceof Error && error.message === "VIDEO_THUMBNAIL_BUSY")) {
        thumbnailFailures.set(task.id, Date.now() + 30_000);
      }
      if (thumbnailFailures.size > 1000) {
        for (const [id, until] of thumbnailFailures) if (until <= Date.now()) thumbnailFailures.delete(id);
        if (thumbnailFailures.size > 1000) thumbnailFailures.delete(thumbnailFailures.keys().next().value || "");
      }
      throw error;
    }).finally(() => thumbnailJobs.delete(task.id));
    thumbnailJobs.set(task.id, job);
  }

  try {
    return thumbnailResponse(await job);
  } catch (thumbnailError) {
    console.warn("[VideoThumbnail] extraction failed", {
      taskId: task.id,
      reason: thumbnailError instanceof Error ? thumbnailError.message.split(":", 1)[0] : "UNKNOWN",
    });
    return NextResponse.json({ error: "视频首帧暂不可用，请稍后重试；仍可尝试播放视频" }, {
      status: 503, headers: { "Retry-After": "30", "Cache-Control": "private, no-store" },
    });
  }
}
