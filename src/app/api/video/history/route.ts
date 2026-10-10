import { isCurrentDigitalHumanTask, DIGITAL_HUMAN_TASK_FILTER } from '@/lib/digital-human-task';
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { classifyVideoProviderError, localVideoTaskFailureMessage } from "@/lib/video-error-policy";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import { signAutodlH3OwnedAssetRefForUser } from "@/lib/autodl-h3-assets";
import { publicModelDisplayName, toPublicModelId } from "@/lib/public-model-dto";
import { getVideoInputContract } from "@/lib/video-input-contract";
import { supportsConfirmedVideoCancellation } from "@/lib/video-cancellation";

import { hideMediaHistoryItem } from "@/lib/media-history-visibility";
import { canRetryVideoHistoryTask, sortVideoHistoryBySubmission } from '@/lib/video-history-presentation';
import {
  parseVideoGenerationRequestSnapshot,
  type VideoGenerationRequestSnapshotV1,
  type VideoRequestAssetRef,
} from "@/lib/video-budget-reservation";

interface VideoRetryInputs {
  firstFrameUrl: string;
  lastFrameUrl: string;
  referenceImageUrl: string;
  referenceImageUrls: string[];
  audioUrl: string;
  referenceAudioUrls: string[];
  sourceVideoUrl: string;
}

interface VideoTaskRow {
  canRetry: boolean;
  clientRequestId?: string;
  clientRequestFingerprint?: string;
  id: string;
  modelId: string;
  publicModelId: string;
  supportsRemoteCancel: boolean;
  followsSourceDuration: boolean;
  taskIdExternal: string;
  taskLabel: string;
  modelName: string;
  prompt: string;
  firstFrameUrl: string;
  lastFrameUrl: string;
  referenceImageUrl: string;
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
  status: string;
  videoUrl: string;
  thumbnailUrl: string;
  errorMessage: string;
  priceCharged: number;
  billingState: string;
  createdAt: string;
  completedAt: string;
  batchId: string;
  batchTopic: string;
  cardIndex: number;
  needsProxy: boolean;
  requestSnapshot?: VideoGenerationRequestSnapshotV1;
  retryInputs?: VideoRetryInputs;
  retrySource?: {
    personAssetId: string;
    audioAssetId: string;
    durationChoice?: "" | "preserve_audio" | "trim_audio";
  };
}

/** 灏?Supabase 琛屾槧灏勪负鍓嶇 VideoTask 鏍煎紡 */
function mapTaskRow(t: Record<string, unknown>): VideoTaskRow {
  const model = (t.video_models as Record<string, unknown>) || {};
  const publicModelName = publicModelDisplayName({ ...model, name: model.name || "所选视频模型" });
  const internalPublicModelId = t.model_id ? toPublicModelId("video", String(t.model_id)) : "";
  const rawError = String(t.error_message ?? "");
  const taskId = String(t.id ?? "");
  let requestSnapshot: VideoGenerationRequestSnapshotV1 | undefined;
  if (t.request_snapshot !== null && t.request_snapshot !== undefined) {
    try {
      requestSnapshot = parseVideoGenerationRequestSnapshot(t.request_snapshot);
    } catch {
      console.warn("[VideoHistory] invalid durable request snapshot", { taskId });
    }
  }
  const canRetry = canRetryVideoHistoryTask(t) && (t.request_snapshot == null || Boolean(requestSnapshot));
  return {
    canRetry,
    id: taskId,
    clientRequestId: String(t.client_request_id ?? ""),
    clientRequestFingerprint: String(t.request_fingerprint ?? ""),
    // History is a public workbench contract. Both the primary and explicit
    // alias remain public IDs so old refresh clients cannot fall back to the
    // database model key and accidentally poll or cancel a different binding.
    modelId: requestSnapshot?.publicModelId || internalPublicModelId,
    publicModelId: requestSnapshot?.publicModelId || internalPublicModelId,
    supportsRemoteCancel: supportsConfirmedVideoCancellation(model.protocol_type, model.api_protocol_config),
    followsSourceDuration: getVideoInputContract(model).requiresSourceVideo,
    taskIdExternal: String(t.task_id_external ?? ""),
    taskLabel: String(t.task_label ?? ""),
    modelName: publicModelName,
    prompt: requestSnapshot?.userPrompt ?? String(t.prompt ?? ""),
    firstFrameUrl: String(t.first_frame_url ?? ""),
    lastFrameUrl: String(t.last_frame_url ?? ""),
    referenceImageUrl: String(t.reference_image_url ?? ""),
    aspectRatio: requestSnapshot?.aspectRatio ?? String(t.aspect_ratio ?? ""),
    resolution: requestSnapshot?.resolution ?? String(t.resolution ?? ""),
    durationSeconds: requestSnapshot?.targetDurationSeconds ?? Number(t.duration_seconds ?? 0),
    status: String(t.status ?? ""),
    videoUrl: String(t.video_url ?? ""),
    thumbnailUrl: "",
    errorMessage: rawError && t.status === "failed"
      ? localVideoTaskFailureMessage(t.submission_error_code) || classifyVideoProviderError(rawError, publicModelName).publicMessage
      : "",
    priceCharged: Number(t.price_charged) || 0,
    billingState: String(t.billing_state ?? ""),
    createdAt: String(t.created_at ?? ""),
    completedAt: String(t.completed_at ?? ""),
    batchId: String(t.batch_id ?? ""),
    batchTopic: String(t.batch_topic ?? ""),
    cardIndex: Number(t.card_index ?? 0),
    needsProxy: Boolean(t.needs_proxy ?? false) || String(t.video_url ?? "").includes("/content"),
    ...(requestSnapshot ? { requestSnapshot } : {}),
  };
}

const OWNED_ASSET_ID = /^[0-9a-f-]{36}$/iu;

async function attachDigitalHumanRetrySources(tasks: VideoTaskRow[], userId: string): Promise<VideoTaskRow[]> {
  const retryableTaskIds = tasks.filter((task) => task.canRetry).map((task) => task.id);
  if (retryableTaskIds.length === 0) return tasks;
  const { data, error } = await getSupabaseClient().from("digital_video_dispatch_jobs")
    .select("task_id,inputs")
    .eq("user_id", userId)
    .in("task_id", retryableTaskIds);
  if (error) {
    console.error("[VideoHistory] digital-human retry snapshot query failed:", error.code);
    return tasks.map((task) => task.canRetry ? { ...task, canRetry: false } : task);
  }
  const snapshots = new Map<string, NonNullable<VideoTaskRow["retrySource"]> & { mode: "photo" | "video" }>();
  for (const row of data || []) {
    const inputs = row.inputs && typeof row.inputs === "object" && !Array.isArray(row.inputs)
      ? row.inputs as Record<string, unknown>
      : {};
    const personAssetId = String(inputs.personAssetId || "");
    const audioAssetId = String(inputs.audioAssetId || "");
    const mode = String(inputs.mode || "");
    const durationChoice = String(inputs.durationChoice || "");
    if (!OWNED_ASSET_ID.test(personAssetId) || !OWNED_ASSET_ID.test(audioAssetId)) continue;
    if (!['photo', 'video'].includes(mode) || !['', 'preserve_audio', 'trim_audio'].includes(durationChoice)) continue;
    snapshots.set(String(row.task_id || ""), {
      personAssetId,
      audioAssetId,
      mode: mode as "photo" | "video",
      durationChoice: durationChoice as "" | "preserve_audio" | "trim_audio",
    });
  }
  return tasks.map((task) => {
    if (!task.canRetry) return task;
    const snapshot = snapshots.get(task.id);
    const expectedMode = task.taskLabel === "digital-human:video" ? "video" : "photo";
    if (!snapshot || snapshot.mode !== expectedMode) return { ...task, canRetry: false };
    return { ...task, retrySource: {
      personAssetId: snapshot.personAssetId,
      audioAssetId: snapshot.audioAssetId,
      durationChoice: snapshot.durationChoice,
    } };
  });
}

async function attachPlaybackAccess(
  task: VideoTaskRow,
  userId: string,
): Promise<VideoTaskRow> {
  const signInput = async (assetRef: string, category: "image" | "audio" | "video") => {
    if (!assetRef.startsWith("object://tencent_cos/")) return assetRef;
    try {
      return await signAutodlH3OwnedAssetRefForUser({ userId, assetRef, category });
    } catch {
      return "";
    }
  };
  const [firstFrameUrl, lastFrameUrl, referenceImageUrl, signedSnapshotAssets] = await Promise.all([
    signInput(task.firstFrameUrl, "image"),
    signInput(task.lastFrameUrl, "image"),
    signInput(task.referenceImageUrl, "image"),
    Promise.all((task.requestSnapshot?.referenceAssets || []).map(async (asset) => ({
      ...asset,
      url: await signInput(
        asset.ref,
        asset.role === "reference_audio" || asset.role === "reference_audio_list" || asset.role === "audio_asset"
          ? "audio"
          : asset.role === "source_video" ? "video" : "image",
      ),
    }))),
  ]);
  const byRole = (role: VideoRequestAssetRef["role"]) => signedSnapshotAssets
    .filter((asset) => asset.role === role && asset.url)
    .sort((left, right) => left.index - right.index)
    .map((asset) => asset.url);
  const snapshotFirstFrames = byRole("first_frame");
  const snapshotLastFrames = byRole("last_frame");
  const snapshotReferenceImages = byRole("reference_image");
  const snapshotReferenceImageList = byRole("reference_image_list");
  const snapshotReferenceAudios = byRole("reference_audio");
  const snapshotReferenceAudioList = byRole("reference_audio_list");
  const snapshotSourceVideos = byRole("source_video");
  const retryInputs: VideoRetryInputs | undefined = task.requestSnapshot ? {
    firstFrameUrl: snapshotFirstFrames[0] || firstFrameUrl,
    lastFrameUrl: snapshotLastFrames[0] || lastFrameUrl,
    referenceImageUrl: snapshotReferenceImages[0] || referenceImageUrl,
    referenceImageUrls: snapshotReferenceImageList,
    audioUrl: snapshotReferenceAudios[0] || "",
    referenceAudioUrls: snapshotReferenceAudioList,
    sourceVideoUrl: snapshotSourceVideos[0] || "",
  } : undefined;
  const inputAccess = {
    firstFrameUrl: retryInputs?.firstFrameUrl || firstFrameUrl,
    lastFrameUrl: retryInputs?.lastFrameUrl || lastFrameUrl,
    referenceImageUrl: retryInputs?.referenceImageUrl || referenceImageUrl,
    ...(retryInputs ? { retryInputs } : {}),
  };
  if (task.status !== "completed") return { ...task, ...inputAccess };
  const [videoUrl, thumbnailUrl] = await Promise.all([
    createVideoAccessUrl({
      taskId: task.id,
      userId,
      role: "student",
      scope: "playback",
    }),
    createVideoAccessUrl({
      taskId: task.id,
      userId,
      role: "student",
      scope: "thumbnail",
    }),
  ]);
  return {
    ...task,
    ...inputAccess,
    videoUrl,
    thumbnailUrl,
  };
}

async function attachPlaybackAccessSafe(
  task: VideoTaskRow,
  userId: string,
): Promise<VideoTaskRow> {
  try {
    return await attachPlaybackAccess(task, userId);
  } catch (error) {
    console.warn("[VideoHistory] media ticket creation failed", {
      taskId: task.id,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      ...task,
      // Never leak the stored provider URL when ticket generation fails. One
      // broken media row must also not make every other history card disappear.
      videoUrl: "",
      thumbnailUrl: "",
      errorMessage: task.errorMessage || "视频已完成，播放凭据暂时不可用，请稍后刷新",
    };
  }
}

/**
 * 鎵规鍐呭幓閲嶏細鍚屼竴 batch_id + card_index 鍙繚鐣欐渶鏂颁竴鏉¤褰?
 * 浼樺厛淇濈暀 completed > processing/queued/pending > failed > cancelled
 * 鍚岀姸鎬佹椂鎸?created_at DESC 鍙栨渶鏂?
 */
function dedupeByCardIndex(tasks: VideoTaskRow[]) {
  const map = new Map<string, VideoTaskRow>();

  const statusPriority: Record<string, number> = {
    generating: 7,
    finalizing: 6,
    processing: 5,
    queued: 4,
    pending: 3,
    completed: 2,
    failed: 1,
    cancelled: 0,
    expired: -1,
  };

  for (const t of tasks) {
    if (!t.batchId) {
      const key = `__no_batch__${t.id}`;
      if (!map.has(key)) map.set(key, t);
      continue;
    }
    if (!t.cardIndex || t.cardIndex === 0) {
      const key = `${t.batchId}__no_idx__${t.id}`;
      if (!map.has(key)) map.set(key, t);
      continue;
    }

    const key = `${t.batchId}__${t.cardIndex}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, t);
      continue;
    }

    const existingCreatedAt = new Date(existing.createdAt).getTime();
    const nextCreatedAt = new Date(t.createdAt).getTime();

    if (nextCreatedAt > existingCreatedAt) {
      map.set(key, t);
      continue;
    }

    if (nextCreatedAt === existingCreatedAt) {
      const pExisting = statusPriority[String(existing.status)] ?? -2;
      const pNew = statusPriority[String(t.status)] ?? -2;
      if (pNew > pExisting) {
        map.set(key, t);
      }
    }
  }

  return Array.from(map.values());
}

// GET /api/video/history?limit=50&offset=0
// 杩斿洖鎵€鏈夌姸鎬侊紙completed/failed/cancelled/active锛夌殑浠诲姟锛?0澶╃獥鍙?
// 鍚屾壒娆″悓搴忓彿鑷姩鍘婚噸锛堜繚鐣欐渶楂樼姸鎬?鏈€鏂帮級
export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const user = authorization.user;

    const { searchParams } = new URL(request.url);
    const rawLimit = Number(searchParams.get("limit") || 100);
    const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;
    const rawOffset = Number(searchParams.get("offset") || 0);
    const offset = Number.isSafeInteger(rawOffset) ? Math.min(Math.max(rawOffset, 0), 10000) : 0;
    const requestedSurface = searchParams.get("surface");
    const digitalHuman = requestedSurface === "digital-human";
    const storyboard = requestedSurface === "storyboard-workbench";
    // Ordinary video history owns legacy unlabeled submissions, but never
    // storyboard or digital-human tasks. Scope both the database window and
    // the final predicate so unrelated rows cannot occupy a page or be retried.
    const surfaceFilter = digitalHuman
      ? DIGITAL_HUMAN_TASK_FILTER
      : storyboard
        ? "task_label.like.分镜工作台%"
        : "task_label.is.null,and(task_label.not.like.digital-human:%,task_label.not.like.分镜工作台%)";
    const belongsToSurface = (task: Record<string, unknown>) => digitalHuman
      ? isCurrentDigitalHumanTask(task)
      : storyboard
        ? String(task.task_label || "").startsWith("分镜工作台")
        : !isCurrentDigitalHumanTask(task) && !String(task.task_label || "").startsWith("分镜工作台");
    const statusFilter = searchParams.get("status"); // "active" = 鍙繑鍥炶繘琛屼腑鐨?

    const supabase = getSupabaseClient();
    const userId = user.userId || user.username || "unknown";

    const selectFields = "id, client_request_id, request_fingerprint, request_snapshot, model_id, task_id_external, task_label, prompt, first_frame_url, last_frame_url, reference_image_url, aspect_ratio, resolution, duration_seconds, status, video_url, thumbnail_url, error_message, submission_error_code, billing_state, provider_result_url, source_expired_at, price_charged, created_at, completed_at, batch_id, batch_topic, card_index, video_models(name,model_name,protocol_type,api_protocol_config)";

    // 濡傛灉鍙煡杩涜涓殑浠诲姟锛堥〉闈㈡仮澶嶇敤锛?
    const requestedTaskId = searchParams.get("taskId");
    if (requestedTaskId) {
      const requestedTaskQuery = supabase.from("video_tasks").select(selectFields).eq("user_id", userId).eq("id", requestedTaskId).is("history_hidden_at", null).is("source_expired_at", null);
      const found = await requestedTaskQuery.maybeSingle();
      if (found.error) return NextResponse.json({ error: "原任务暂时无法读取" }, { status: 503 });
      if (!found.data || !belongsToSurface(found.data)) return NextResponse.json({ error: "原任务不存在或无权访问" }, { status: 404 });
      const mapped = mapTaskRow(found.data);
      const [retryReady] = digitalHuman ? await attachDigitalHumanRetrySources([mapped], userId) : [mapped];
      return NextResponse.json({ tasks: [await attachPlaybackAccessSafe(retryReady, userId)], total: 1 });
    }

    if (statusFilter === "active") {
      const activeQuery = supabase
        .from("video_tasks")
        .select(selectFields)
        .eq("user_id", userId)
        .is("history_hidden_at", null)
        .is("source_expired_at", null)
        .or(surfaceFilter)
        .in("status", ["pending", "queued", "processing", "generating", "finalizing", "billing_pending"])
        .order("created_at", { ascending: false })
        .order("card_index", { ascending: true, nullsFirst: false });
      const { data, error } = await activeQuery;

      if (error) {
        console.error("[VideoHistory] active query failed:", error);
        return NextResponse.json({ error: "视频历史暂时无法读取，请稍后重试" }, { status: 500 });
      }

      const tasks = (data || []).filter(belongsToSurface).map(mapTaskRow);
      return NextResponse.json({ tasks, total: tasks.length });
    }

    // Active and terminal tasks remain visible while their upstream source is
    // deliverable. A definitive 404/410 marks source_expired_at and hides the
    // row; transient network/5xx errors never shorten history.
    const terminalStatuses = ["completed", "failed", "cancelled", "expired"];
    const terminalQuery = supabase.from("video_tasks").select(selectFields, { count: "exact" })
      .eq("user_id", userId).is("history_hidden_at", null).is("source_expired_at", null).or(surfaceFilter)
      .in("status", terminalStatuses);
    const activeHistoryQuery = supabase
      .from("video_tasks")
      .select(selectFields)
      .eq("user_id", userId)
      .is("history_hidden_at", null)
      .is("source_expired_at", null)
      .or(surfaceFilter)
      .in("status", ["pending", "queued", "processing", "generating", "finalizing", "billing_pending"]);
    const [activeResult, terminalResult] = await Promise.all([
      activeHistoryQuery
        .order("created_at", { ascending: false }),
      terminalQuery.order("created_at", { ascending: false })
        .order("id", { ascending: false }).range(offset, offset + limit - 1),
    ]);

    const rawTasks = [
      ...(activeResult.data || []).filter(belongsToSurface).map(mapTaskRow),
      ...(terminalResult.data || []).filter(belongsToSurface).map(mapTaskRow),
    ];
    const error = activeResult.error || terminalResult.error;

    if (error) {
      console.error("[VideoHistory] query failed:", error);
      return NextResponse.json({ error: "视频历史暂时无法读取，请稍后重试" }, { status: 500 });
    }

    // 鎵规鍐呭悓搴忓彿鍘婚噸锛堜繚鐣欐渶楂樼姸鎬?鏈€鏂拌褰曪級
    // Each submission has its own result and billing record, including failures.
    const tasks = sortVideoHistoryBySubmission(digitalHuman ? dedupeByCardIndex(rawTasks) : rawTasks);

    const retryReadyTasks = digitalHuman ? await attachDigitalHumanRetrySources(tasks, userId) : tasks;
    const safeTasks = await Promise.all(
      retryReadyTasks.map((task) => attachPlaybackAccessSafe(task, userId)),
    );
    const count = terminalResult.count || 0;

    return NextResponse.json({ tasks: safeTasks, total: count + (activeResult.data?.length || 0), nextOffset: offset + limit < count ? offset + limit : null });
  } catch (err) {
    console.error("[VideoHistory] unexpected failure:", err);
    return NextResponse.json({ error: "视频历史暂时无法读取，请稍后重试" }, { status: 500 });
  }
}

// Removing history preserves the task, result and billing evidence.
export async function DELETE(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "请选择要移除的历史记录" }, { status: 400 });
  return hideMediaHistoryItem(authorization.user.userId, "video", taskId);
}
