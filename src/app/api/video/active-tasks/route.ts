/**
 * 视频活跃任务查询 API
 * GET - 返回当前用户所有未完成（pending/queued/processing/generating/finalizing/billing_pending）的视频任务
 *
 * 用途：用户离开视频页面再回来时，从云端恢复正在进行的任务状态，
 * 即使 localStorage 缓存过期或被清除，也能继续跟踪任务进度。
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import { toPublicModelId } from "@/lib/public-model-dto";
import {
  parseAutodlH3AssetRef,
  signAutodlH3OwnedAssetRefForUser,
} from "@/lib/autodl-h3-assets";
import { reconcileStaleVideoSubmissionsForUser } from "@/lib/video-submission-reconciliation";

function belongsToGeneralVideoPage(task: Record<string, unknown>) {
  const taskLabel = String(task.task_label || "");
  return !taskLabel.startsWith("digital-human:")
    && !taskLabel.startsWith("分镜工作台");
}

async function resolveOwnedImagePreview(value: unknown, userId: string) {
  const raw = String(value || "").trim();
  if (!raw || !parseAutodlH3AssetRef(raw)) return raw;
  try {
    return await signAutodlH3OwnedAssetRefForUser({
      userId,
      assetRef: raw,
      category: "image",
    });
  } catch {
    // A durable object ref is never exposed to the browser when ownership,
    // existence, or signing cannot be revalidated for the current user.
    return "";
  }
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const user = authorization.user;

    const supabase = getSupabaseClient();
    const userId = user.userId || user.username || "unknown";
    const reconciliation = await reconcileStaleVideoSubmissionsForUser({ userId, supabase });
    if (reconciliation.expiredCount > 0) {
      console.info("[active-tasks] Closed stale submission confirmations", {
        count: reconciliation.expiredCount,
      });
    }

    // 查询所有未完成的任务，不按提交日期截断；finalizing / billing_pending
    // 表示上游已完成、正在确认播放源或结算，刷新后仍必须恢复。
    const { data, error } = await supabase
      .from("video_tasks")
      .select("id, model_id, task_label, prompt, first_frame_url, last_frame_url, reference_image_url, aspect_ratio, duration_seconds, status, batch_id, batch_topic, card_index, created_at, resolution, provider_progress, provider_status_message, provider_last_polled_at, provider_poll_failures")
      .eq("user_id", userId)
      .is("history_hidden_at", null)
      .in("status", ["pending", "queued", "processing", "generating", "finalizing", "billing_pending"])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "实时视频任务数据暂不可用", code: "REALTIME_DATA_UNAVAILABLE" }, { status: 503 });
    }

    // 同时查询最近2小时内完成的任务（用户可能离开期间任务已完成）
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: recentCompleted, error: completedError } = await supabase
      .from("video_tasks")
      .select("id, model_id, task_label, prompt, first_frame_url, status, thumbnail_url, batch_id, batch_topic, card_index, completed_at, price_charged")
      .eq("user_id", userId)
      .is("history_hidden_at", null)
      .eq("status", "completed")
      .gte("completed_at", twoHoursAgo)
      .order("completed_at", { ascending: false })
      .order("id", { ascending: false });

    if (completedError) {
      console.warn("[active-tasks] 查询最近完成任务失败:", completedError.message);
    }

    // 普通视频页只恢复自己的任务。数字人和分镜任务各有独立的状态、参数与重试语义，
    // 禁止误送到普通视频状态链路，避免模型协议、素材上下文与计费串线。
    const tasks = await Promise.all(
      (data || [])
        .filter((t: Record<string, unknown>) => belongsToGeneralVideoPage(t))
        .map(async (t: Record<string, unknown>) => {
          const [firstFrameUrl, lastFrameUrl, referenceImageUrl] = await Promise.all([
            resolveOwnedImagePreview(t.first_frame_url, userId),
            resolveOwnedImagePreview(t.last_frame_url, userId),
            resolveOwnedImagePreview(t.reference_image_url, userId),
          ]);
          return {
            id: t.id,
            taskId: t.id,
            modelId: toPublicModelId("video", String(t.model_id || "")),
            taskLabel: t.task_label || "",
            prompt: t.prompt || "",
            firstFrameUrl,
            lastFrameUrl,
            referenceImageUrl,
            aspectRatio: t.aspect_ratio || "16:9",
            resolution: t.resolution || "",
            durationSeconds: t.duration_seconds || 5,
            status: t.status,
            batchId: t.batch_id || "",
            batchTopic: t.batch_topic || "",
            cardIndex: t.card_index || 0,
            createdAt: t.created_at,
            progress: Number.isFinite(Number(t.provider_progress)) ? Number(t.provider_progress) : null,
            providerStatusMessage: t.provider_status_message || "",
            providerLastPolledAt: t.provider_last_polled_at || "",
            providerPollFailures: Math.max(0, Number(t.provider_poll_failures) || 0),
          };
        }),
    );

    const recentlyCompleted = await Promise.all(
      (recentCompleted || [])
        .filter((t: Record<string, unknown>) => belongsToGeneralVideoPage(t))
        .map(async (t: Record<string, unknown>) => {
          const safeVideoUrl = await createVideoAccessUrl({
            taskId: String(t.id),
            userId,
            role: user.role,
            scope: "playback",
          });
          const firstFrameUrl = await resolveOwnedImagePreview(t.first_frame_url, userId);
          return {
            id: t.id,
            taskId: t.id,
            modelId: toPublicModelId("video", String(t.model_id || "")),
            taskLabel: t.task_label || "",
            prompt: t.prompt || "",
            firstFrameUrl,
            status: t.status,
            videoUrl: safeVideoUrl,
            thumbnailUrl: t.thumbnail_url || "",
            batchId: t.batch_id || "",
            batchTopic: t.batch_topic || "",
            cardIndex: t.card_index || 0,
            completedAt: t.completed_at || "",
            priceCharged: Number(t.price_charged) || 0,
          };
        }),
    );

    return NextResponse.json({
      activeTasks: tasks,
      recentlyCompleted,
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    console.error("[active-tasks] Realtime query failed:", err);
    return NextResponse.json({ error: "实时视频任务数据暂不可用", code: "REALTIME_DATA_UNAVAILABLE" }, { status: 503 });
  }
}
