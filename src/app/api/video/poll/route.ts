/**
 * Legacy compatibility endpoint.
 *
 * All provider polling, persistence, terminal accounting, and billing are
 * delegated to /api/video/status so a task has exactly one settlement path.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import {
  parseAutodlH3AssetRef,
  signAutodlH3OwnedAssetRefForUser,
} from "@/lib/autodl-h3-assets";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { GET as getVideoStatus } from "../status/route";

const AUTODL_H3_LIFECYCLE_TASK_ID = /^h3q_[0-9a-f]{40}$/u;

type LegacyTask = {
  id: string;
  user_id: string;
  model_id: string;
  status: string;
  task_id_external?: string | null;
  content_url?: string | null;
  prompt?: string | null;
  first_frame_url?: string | null;
  batch_id?: string | null;
  batch_topic?: string | null;
  card_index?: number | null;
  duration_seconds?: number | null;
  error_message?: string | null;
  price_charged?: number | null;
};

async function findOwnedTask(taskId: string, userId: string) {
  const db = getSupabaseClient();
  const fields = "id,user_id,model_id,status,task_id_external,content_url,prompt,first_frame_url,batch_id,batch_topic,card_index,duration_seconds,error_message,price_charged";
  const { data: byLocal } = await db
    .from("video_tasks")
    .select(fields)
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (byLocal) return byLocal as LegacyTask;

  const { data: byExternal } = await db
    .from("video_tasks")
    .select(fields)
    .eq("task_id_external", taskId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  return (byExternal?.[0] || null) as LegacyTask | null;
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const payload = authorization.user;

  const legacyTaskId = new URL(request.url).searchParams.get("task_id")?.trim();
  if (!legacyTaskId) return NextResponse.json({ error: "缺少 task_id" }, { status: 400 });

  const task = await findOwnedTask(legacyTaskId, payload.userId);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  if (!task.task_id_external) {
    if (task.status === "completed") {
      return NextResponse.json({
        status: "success",
        video_url: await createVideoAccessUrl({
          taskId: task.id,
          userId: payload.userId,
          role: "student",
          scope: "playback",
        }),
        storage_url: "",
        price_charged: task.price_charged || 0,
      });
    }
    if (task.status === "failed") {
      return NextResponse.json({
        status: "failed",
        error: task.error_message || "生成失败",
        price_charged: 0,
      });
    }
    return NextResponse.json({
      status: task.status === "queued" ? "queued" : "processing",
      error: "原任务结果暂待确认，追踪记录已保留，请稍后查询",
    });
  }

  const statusUrl = new URL("/api/video/status", request.url);
  statusUrl.searchParams.set("taskId", task.task_id_external);
  statusUrl.searchParams.set("modelId", task.model_id);
  if (task.content_url) statusUrl.searchParams.set("contentUrl", task.content_url);
  if (task.prompt) statusUrl.searchParams.set("prompt", task.prompt);
  // Lifecycle jobs already carry their tenant-owned asset refs in the durable
  // queue. Never copy those refs (or an old signed URL) into a status URL.
  if (task.first_frame_url && !AUTODL_H3_LIFECYCLE_TASK_ID.test(task.task_id_external)) {
    const storedImage = String(task.first_frame_url).trim();
    let imageUrl = storedImage;
    if (parseAutodlH3AssetRef(storedImage)) {
      try {
        imageUrl = await signAutodlH3OwnedAssetRefForUser({
          userId: payload.userId,
          assetRef: storedImage,
          category: "image",
        });
      } catch {
        imageUrl = "";
      }
    }
    if (imageUrl) statusUrl.searchParams.set("imageUrl", imageUrl);
  }
  if (task.batch_id) statusUrl.searchParams.set("batchId", task.batch_id);
  if (task.batch_topic) statusUrl.searchParams.set("batchTopic", task.batch_topic);
  if (task.card_index != null) statusUrl.searchParams.set("cardIndex", String(task.card_index));
  if (task.duration_seconds) statusUrl.searchParams.set("targetDuration", String(task.duration_seconds));

  const statusResponse = await getVideoStatus(new NextRequest(statusUrl, {
    method: "GET",
    headers: request.headers,
  }));
  const result = await statusResponse.json() as Record<string, unknown>;
  if (!statusResponse.ok) return NextResponse.json(result, { status: statusResponse.status });

  const status = String(result.status || "processing");
  return NextResponse.json({
    ...result,
    status: status === "completed" ? "success" : status,
    video_url: result.videoUrl || "",
    storage_url: "",
    error: result.errorMessage || result.error || "",
    price_charged: result.priceCharged || 0,
  });
}
