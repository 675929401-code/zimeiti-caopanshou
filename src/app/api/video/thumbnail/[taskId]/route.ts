import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import { authorizeVideoMediaRequest } from "@/lib/video-media-auth";
import { extractVideoThumbnail } from "@/lib/video-postprocess";
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
  __videoThumbnailJobs?: Map<string, Promise<void>>;
};
const thumbnailJobs = thumbnailGlobal.__videoThumbnailJobs
  ?? (thumbnailGlobal.__videoThumbnailJobs = new Map<string, Promise<void>>());

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
      .select("id,user_id,status")
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

  const thumbnailDirectory = resolveThumbnailDirectory();
  await fs.mkdir(/* turbopackIgnore: true */ thumbnailDirectory, { recursive: true });
  const thumbPath = path.join(/* turbopackIgnore: true */ thumbnailDirectory, `${task.id}.jpg`);
  try {
    return thumbnailResponse(await fs.readFile(/* turbopackIgnore: true */ thumbPath));
  } catch {}

  let job = thumbnailJobs.get(task.id);
  if (!job) {
    job = (async () => {
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
      const pendingPath = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(/* turbopackIgnore: true */ pendingPath, thumbnail, { flag: "wx" });
        await fs.rename(/* turbopackIgnore: true */ pendingPath, thumbPath);
      } finally {
        await fs.rm(/* turbopackIgnore: true */ pendingPath, { force: true });
      }
    })().finally(() => thumbnailJobs.delete(task.id));
    thumbnailJobs.set(task.id, job);
  }

  try {
    await job;
    return thumbnailResponse(await fs.readFile(/* turbopackIgnore: true */ thumbPath));
  } catch (thumbnailError) {
    console.warn("[VideoThumbnail] extraction failed", {
      taskId: task.id,
      reason: thumbnailError instanceof Error ? thumbnailError.message.split(":", 1)[0] : "UNKNOWN",
    });
    return NextResponse.json({ error: "视频封面生成失败" }, { status: 404 });
  }
}
