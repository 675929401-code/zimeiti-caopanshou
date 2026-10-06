import { createReadStream, promises as fs } from "fs";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { downloadAndTrimVideo, removeVideoTempDir } from "@/lib/video-postprocess";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { getSupabaseClient } from "@/storage/database/supabase-client";

type ExportRequest = {
  taskId?: string;
  targetDurationSeconds?: number;
};

export async function POST(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const payload = authorization.user;

  const body = await request.json() as ExportRequest;
  const taskId = String(body.taskId || "").trim();
  const targetDurationSeconds = Math.round(Number(body.targetDurationSeconds || 0) * 10) / 10;
  if (!/^[a-zA-Z0-9_.-]+$/.test(taskId)) {
    return NextResponse.json({ error: "无效的视频任务" }, { status: 400 });
  }
  if (targetDurationSeconds < 0.5 || targetDurationSeconds > 60) {
    return NextResponse.json({ error: "目标时长必须在 0.5 到 60 秒之间" }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const fields = "id, user_id, status, task_id_external";
  const readTask = async (allowCrossMember: boolean) => {
    let externalQuery = supabase
      .from("video_tasks")
      .select(fields)
      .eq("task_id_external", taskId)
      .eq("status", "completed");
    if (!allowCrossMember) externalQuery = externalQuery.eq("user_id", payload.userId);
    const { data: byExternal, error: byExternalError } = await externalQuery
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (byExternalError) throw byExternalError;
    const externalTask = byExternal?.[0] as { id: string; user_id: string; status: string; task_id_external?: string } | undefined;
    if (externalTask) return externalTask;

    let localQuery = supabase
      .from("video_tasks")
      .select(fields)
      .eq("id", taskId)
      .eq("status", "completed");
    if (!allowCrossMember) localQuery = localQuery.eq("user_id", payload.userId);
    const { data: byLocal, error: byLocalError } = await localQuery.maybeSingle();
    if (byLocalError) throw byLocalError;
    return byLocal as typeof externalTask;
  };

  let task;
  try {
    task = await readTask(false);
    if (!task && payload.role === "admin") {
      const discovery = await authorizeMemberContentDiscovery(
        request,
        payload,
        { requireStepUp: true, operation: "member_video_export_discovery" },
      );
      if (!discovery.ok) return discovery.response;
      task = await readTask(true);
    }
  } catch {
    return NextResponse.json({ error: "视频任务暂时无法读取" }, { status: 503 });
  }
  if (!task) return NextResponse.json({ error: "视频任务不存在或尚未完成" }, { status: 404 });
  const contentAccess = await authorizeMemberContentAccess(
    request,
    { userId: payload.userId, role: payload.role },
    task.user_id,
    { requireStepUp: true, operation: "member_video_export" },
  );
  if (!contentAccess.ok) return contentAccess.response;

  try {
    const playbackPath = await createVideoAccessUrl({
      taskId: task.id,
      userId: contentAccess.deliveryIdentity.userId,
      role: contentAccess.deliveryIdentity.role,
      scope: "playback",
    });
    const internalPort = String(process.env.DEPLOY_RUN_PORT || process.env.PORT || "5000").trim();
    if (!/^\d{2,5}$/u.test(internalPort)) throw new Error("VIDEO_EXPORT_INTERNAL_PORT_INVALID");
    const internalOrigin = `http://127.0.0.1:${internalPort}`;
    const playbackUrl = new URL(playbackPath, internalOrigin);
    const { outputPath, tempDir } = await downloadAndTrimVideo(
      playbackUrl.toString(),
      targetDurationSeconds,
      { trustedInternalOrigin: internalOrigin },
    );
    try {
      const outputStat = await fs.stat(outputPath);
      const nodeStream = createReadStream(outputPath);
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void removeVideoTempDir(tempDir).catch((cleanupError) => {
          console.warn("[video-export] temporary file cleanup failed", cleanupError);
        });
      };
      nodeStream.once("close", cleanup);
      nodeStream.once("error", cleanup);
      return new NextResponse(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(outputStat.size),
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${task.id}-${targetDurationSeconds}s.mp4"`,
        },
      });
    } catch (streamError) {
      await removeVideoTempDir(tempDir).catch(() => undefined);
      throw streamError;
    }
  } catch (error) {
    console.error("[video-export] trim failed", {
      taskId,
      targetDurationSeconds,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "裁剪导出失败，可下载原片后在剪辑软件中截取" }, { status: 500 });
  }
}
